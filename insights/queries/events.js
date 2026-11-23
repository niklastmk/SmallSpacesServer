// The Events pages: is the data arriving? The registry of every event, the
// live feed, and one session as a timeline.
//
// The registry file (`../events.json`) says what the game can send; the
// `events` table says what arrived. Install ids never leave this file except
// shortened on a session's own page.
const { DAY, MINUTE, median, percentile, share, histogram } = require('./common');

const SILENT_AFTER = DAY; // "not seen for 24 hours"
const WINDOW_MAX = 7 * DAY; // the registry counts over at most the last 7 days of the range
const SAMPLE = 5000; // events behind a row's property details
const LIVE_MAX = 500;
const LIVE_SCAN = 20000; // how far back the feed looks for matches of a filter
const TIMELINE_MAX = 2000;
const RUNNING_WITHIN = 5 * MINUTE; // the game says it is alive every two minutes
const RECENT_DAYS = 30;

const fail = (code, message) => {
    const error = new Error(message);
    error.code = code;
    return error;
};
const parseProps = (text) => {
    try {
        const value = JSON.parse(text);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (error) {
        return {};
    }
};
const clip = (value, length) => (typeof value === 'string' && value.length > length ? `${value.slice(0, length)}…` : value);
// Properties for a list: long texts shortened, nothing nested.
function shortProps(props, length = 120) {
    const out = {};
    for (const [key, value] of Object.entries(props).slice(0, 40)) {
        out[key] = value !== null && typeof value === 'object' ? clip(JSON.stringify(value), length) : clip(value, length);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

// The properties of a registered event as { key: 's' | 'n' | 'b' }.
function propsOf(registry, name) {
    const entry = (registry.events || {})[name];
    if (!entry) return null;
    if (entry.props === 'session_fields') return { ...(registry.session_fields || {}) };
    return entry.props && typeof entry.props === 'object' ? { ...entry.props } : {};
}

// Every event name in the table, one index seek per name instead of a scan.
function namesReceived(db) {
    return db.all(
        `WITH RECURSIVE found(n) AS (
             SELECT MIN(name) FROM events
             UNION ALL
             SELECT (SELECT MIN(name) FROM events WHERE name > found.n) FROM found WHERE found.n IS NOT NULL
         ) SELECT n FROM found WHERE n IS NOT NULL LIMIT 500`).map((row) => row.n);
}

// When an event was first and last received, and from which build first.
function seen(q, name) {
    const first = q.db.get('SELECT t, build, legacy FROM events WHERE name = ? ORDER BY t LIMIT 1', name);
    if (!first) return { first_seen: null, last_seen: null, first_build: null, older_builds: false };
    const last = q.db.get('SELECT t FROM events WHERE name = ? ORDER BY t DESC LIMIT 1', name);
    let firstBuild = first.build || null;
    const older = Number(first.legacy) === 1;
    if (older) {
        // Old builds carry a build name the old game hard-coded: the first build
        // is the first one of the new protocol, if any sends this event.
        const tracked = q.tracking.since === null ? null
            : q.db.get('SELECT build FROM events WHERE name = ? AND t >= ? AND legacy = 0 ORDER BY t LIMIT 1', name, q.tracking.since);
        firstBuild = tracked ? tracked.build || null : null;
    }
    return { first_seen: Number(first.t), last_seen: Number(last.t), first_build: firstBuild, older_builds: older };
}

// The part of the range the counts are taken over: all of it up to seven days,
// otherwise its last seven days (counting needs every event row of the window).
function countWindow(q) {
    const from = Math.max(q.range.from, q.range.to - WINDOW_MAX);
    return { from, to: q.range.to, capped: from > q.range.from };
}

function registryRows(q) {
    const registry = q.registry;
    const registered = Object.keys(registry.events || {});
    const names = [...registered, ...namesReceived(q.db).filter((name) => !registered.includes(name)).sort()];

    const window = countWindow(q);
    const parts = ['e.t >= ? AND e.t < ?'];
    const args = [window.from, window.to];
    let from = 'events e';
    if (q.platform !== 'all') {
        from += ' JOIN sessions s ON s.session_id = e.session_id';
        parts.push(`${q.platformSql('s')} = ?`);
        args.push(q.platform);
    }
    if (q.build !== 'all') {
        parts.push('e.build = ?');
        args.push(q.build);
    }
    const counted = new Map(q.db.all(
        `SELECT e.name AS ev, COUNT(*) AS n, COUNT(DISTINCT CASE WHEN e.legacy = 0 THEN e.session_id END) AS sessions
         FROM ${from} WHERE ${parts.join(' AND ')} GROUP BY ev`, ...args).map((row) => [row.ev, row]));
    // Sessions of the new protocol that were running in the window: what a share is a share of.
    const running = q.sessionWhere('s', 'any');
    const sessions = Number(q.db.get(
        `SELECT COUNT(*) AS n FROM sessions s WHERE s.last_seen_at >= ? AND s.started_at < ? AND s.legacy = 0 AND ${running.sql}`,
        window.from, window.to, ...running.args).n);

    const rows = names.map((name, index) => {
        const entry = (registry.events || {})[name] || null;
        const when = seen(q, name);
        const count = counted.get(name);
        let state;
        if (!entry) state = 'unregistered';
        else if (when.last_seen === null) state = 'never';
        else state = when.last_seen >= q.now - SILENT_AFTER ? 'ok' : 'silent';
        return {
            name,
            order: index + 1,
            registered: entry !== null,
            about: entry ? entry.about || '' : null,
            wave: entry ? Number(entry.wave) || 1 : null,
            props: propsOf(registry, name),
            ...when,
            count: count ? Number(count.n) : 0,
            sessions: count ? Number(count.sessions) : 0,
            sessions_share: share(count ? Number(count.sessions) : 0, sessions),
            state,
            // Registered for a later wave and not sent by any build yet: missing as planned.
            expected_missing: state === 'never' && entry !== null && Number(entry.wave) > 1
        };
    });
    return { rows, window, sessions };
}

function eventRegistry(q) {
    const { rows, window, sessions } = registryRows(q);
    const counts = { all: rows.length, ok: 0, silent: 0, never: 0, unregistered: 0 };
    for (const row of rows) counts[row.state]++;

    const search = typeof q.params.q === 'string' ? q.params.q.trim().toLowerCase() : '';
    const state = ['ok', 'silent', 'never', 'unregistered'].includes(q.params.state) ? q.params.state : 'all';
    const matching = rows.filter((row) => (state === 'all' || row.state === state)
        && (search === '' || row.name.toLowerCase().includes(search) || (row.about || '').toLowerCase().includes(search)));

    const paging = q.paging({ order: 'order', count: 'count', sessions: 'sessions', last_seen: 'last_seen', name: 'name' });
    // The registry's own order unless a column is asked for.
    const dir = q.params.dir === 'asc' || q.params.dir === 'desc' ? q.params.dir : (paging.sort === 'order' || paging.sort === 'name' ? 'asc' : 'desc');
    const factor = dir === 'asc' ? 1 : -1;
    const valueOf = paging.sort === 'sessions' ? (row) => row.sessions_share : (row) => row[paging.sort];
    matching.sort((a, b) => {
        const left = valueOf(a);
        const right = valueOf(b);
        if (left === null || left === undefined) return right === null || right === undefined ? a.order - b.order : 1;
        if (right === null || right === undefined) return -1;
        const difference = typeof left === 'string' ? left.localeCompare(right) : left - right;
        return difference !== 0 ? factor * difference : a.order - b.order;
    });
    return {
        data: {
            rows: matching.slice(paging.offset, paging.offset + paging.per),
            total: matching.length,
            page: paging.page, per: paging.per, sort: paging.sort, dir,
            state,
            counts, // per state, before search and state filter
            window, // what `count` and `sessions` are counted over
            sessions_in_window: sessions
        },
        meta: { coverage: q.coverage(window) }
    };
}

// Five bins with round edges over the bulk of the values; the last is open-ended.
function roundBins(values) {
    const low = Math.min(...values);
    const high = percentile(values, 0.95);
    if (!(high > low)) return [{ from: low, to: null, count: values.length, share: 1 }];
    const raw = (high - low) / 4;
    const power = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= raw) || 10 * power;
    const start = Math.floor(low / step) * step;
    const edges = [0, 1, 2, 3, 4].map((index) => Number((start + index * step).toPrecision(12)));
    return histogram(values, edges).map((bin) => ({ ...bin, share: share(bin.count, values.length) }));
}

// What one property looked like in the sample.
function describeProperty(key, kind, registered, values, sampleSize) {
    const present = values.filter((value) => value !== null && value !== undefined);
    const base = { key, type: kind, registered, present: present.length, absent: sampleSize - present.length };
    if (kind === 'n') {
        const numbers = present.filter((value) => typeof value === 'number' && Number.isFinite(value));
        return {
            ...base, other_type: present.length - numbers.length,
            median: numbers.length > 0 ? median(numbers) : null,
            p90: numbers.length > 0 ? percentile(numbers, 0.9) : null, // the slowest 10 % start here
            min: numbers.length > 0 ? Math.min(...numbers) : null,
            max: numbers.length > 0 ? Math.max(...numbers) : null,
            bins: numbers.length > 0 ? roundBins(numbers) : []
        };
    }
    if (kind === 'b') {
        const flags = present.filter((value) => typeof value === 'boolean');
        const yes = flags.filter(Boolean).length;
        return { ...base, other_type: present.length - flags.length, true: yes, false: flags.length - yes, true_share: share(yes, flags.length) };
    }
    const counts = new Map();
    for (const value of present) {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        counts.set(text, (counts.get(text) || 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const top = sorted.slice(0, 5);
    const shown = top.reduce((sum, entry) => sum + entry[1], 0);
    return {
        ...base, other_type: present.filter((value) => typeof value !== 'string').length,
        distinct: sorted.length,
        values: top.map(([value, count]) => ({ value: clip(value, 80), count, share: share(count, present.length) })),
        more: { values: sorted.length - top.length, count: present.length - shown, share: share(present.length - shown, present.length) }
    };
}

// The properties of one event, from its latest events in the range.
function registryEvent(q) {
    const name = typeof q.params.name === 'string' ? q.params.name : '';
    if (name === '' || name.length > 200) throw fail('invalid', 'name is required');
    const spec = propsOf(q.registry, name);
    const entry = (q.registry.events || {})[name] || null;

    const parts = ['e.name = ?', 'e.t >= ? AND e.t < ?'];
    const args = [name, q.range.from, q.range.to];
    let from = 'events e';
    if (q.platform !== 'all') {
        from += ' JOIN sessions s ON s.session_id = e.session_id';
        parts.push(`${q.platformSql('s')} = ?`);
        args.push(q.platform);
    }
    if (q.build !== 'all') {
        parts.push('e.build = ?');
        args.push(q.build);
    }
    const sample = q.db.all(`SELECT e.t AS at, e.props AS props FROM ${from} WHERE ${parts.join(' AND ')} ORDER BY e.t DESC LIMIT ${SAMPLE}`, ...args);
    if (sample.length === 0 && !entry && !q.db.get('SELECT 1 AS found FROM events WHERE name = ? LIMIT 1', name)) {
        throw fail('not_found', `no event named ${name}`);
    }

    const columns = new Map(Object.keys(spec || {}).map((key) => [key, []]));
    sample.forEach((row, index) => {
        for (const [key, value] of Object.entries(parseProps(row.props))) {
            if (!columns.has(key)) {
                if (columns.size >= 60) continue;
                columns.set(key, new Array(index).fill(null));
            }
            columns.get(key)[index] = value;
        }
    });
    const kindOf = (key, values) => {
        if (spec && spec[key]) return spec[key];
        const first = values.find((value) => value !== null && value !== undefined);
        return typeof first === 'number' ? 'n' : typeof first === 'boolean' ? 'b' : 's';
    };
    const properties = [...columns.entries()].map(([key, values]) => {
        const filled = Array.from({ length: sample.length }, (unused, index) => (values[index] === undefined ? null : values[index]));
        return describeProperty(key, kindOf(key, filled), Boolean(spec && spec[key]), filled, sample.length);
    });
    return {
        data: {
            name,
            registered: entry !== null,
            about: entry ? entry.about || '' : null,
            wave: entry ? Number(entry.wave) || 1 : null,
            sample: sample.length, // events the numbers below are from: the latest in the range
            sample_limit: SAMPLE,
            sample_from: sample.length > 0 ? Number(sample[sample.length - 1].at) : null,
            sample_to: sample.length > 0 ? Number(sample[0].at) : null,
            properties
        }
    };
}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

// The newest events, by the order they arrived in (`id`). `since` is the
// cursor of the previous answer: only newer events come back. The filters of
// the top bar do not apply here.
function liveFeed(q) {
    const top = Number((q.db.get('SELECT MAX(id) AS id FROM events') || {}).id) || 0;
    const sinceParam = Number(q.params.since);
    const since = q.params.since !== undefined && Number.isInteger(sinceParam) && sinceParam >= 0 ? sinceParam : null;
    const tokens = (typeof q.params.q === 'string' ? q.params.q : '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    const eventName = typeof q.params.event === 'string' && q.params.event !== '' ? q.params.event : null;
    const session = typeof q.params.session === 'string' && q.params.session !== '' ? q.params.session : null;
    const filtered = tokens.length > 0;

    const floor = Math.max(since === null ? 0 : since, top - LIVE_SCAN);
    const parts = ['e.id > ?', 'e.id <= ?'];
    const args = [floor, top];
    if (eventName) {
        parts.push('e.name = ?');
        args.push(eventName);
    }
    if (session) {
        parts.push('e.session_id = ?');
        args.push(session);
    }
    const rows = q.db.all(
        `SELECT e.id AS id, e.t AS at, e.name AS ev, e.build AS b, e.platform AS wire, e.session_id AS sid, e.legacy AS old,
                e.registered AS known, e.props AS props, s.platform AS s_platform, s.device AS s_device
         FROM events e LEFT JOIN sessions s ON s.session_id = e.session_id
         WHERE ${parts.join(' AND ')} ORDER BY e.id DESC LIMIT ${filtered ? LIVE_SCAN : LIVE_MAX + 1}`, ...args);

    const events = [];
    let more = false;
    for (const row of rows) {
        const props = parseProps(row.props);
        if (filtered) {
            // The text a row shows: its name, its session and "key: value" of each property.
            const text = `${row.ev} ${row.sid} ${Object.entries(props).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join(', ')}`.toLowerCase();
            if (!tokens.every((token) => text.includes(token))) continue;
        }
        if (events.length >= LIVE_MAX) {
            more = true;
            break;
        }
        events.push({
            id: Number(row.id), t: Number(row.at), name: row.ev, build: row.b || null,
            platform: q.platformOf(row.s_platform || row.wire, row.s_device),
            session_id: row.sid, legacy: Number(row.old) === 1, registered: Number(row.known) === 1,
            props: shortProps(props)
        });
    }
    const lastMinute = Number(q.db.get('SELECT COUNT(*) AS n FROM events WHERE t >= ?', q.now - MINUTE).n);
    return {
        data: {
            events, // newest first
            cursor: top, // pass as `since` on the next poll
            since,
            more, // older matches exist beyond the 500 returned
            per_second: lastMinute / 60, // events of the last minute, by their own time
            limit: LIVE_MAX
        },
        cache: false // polled for what is new: an answer must never be a remembered one
    };
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

function reportsOf(q, sessionId) {
    return q.db.all(
        `SELECT c.id AS id, c.group_id AS group_id, c.occurred_at AS occurred_at, c.received_at AS received_at, c.category AS category,
                c.crash_type AS crash_type, c.error_message AS error_message, g.title AS title, g.status AS status
         FROM crashes c LEFT JOIN crash_groups g ON g.id = c.group_id WHERE c.session_id = ? ORDER BY c.occurred_at, c.id`, sessionId)
        .map((row) => ({
            report: `R-${row.id}`,
            issue: row.group_id === null || row.group_id === undefined ? null : `SS-${row.group_id}`,
            title: row.title || null,
            category: row.category || null,
            crash_type: row.crash_type || null,
            error_message: clip(row.error_message || null, 200),
            status: row.status || null,
            occurred_at: Math.round(Number(row.occurred_at)),
            received_at: Math.round(Number(row.received_at))
        }));
}

// How a session ended, in one word.
function endOf(row, crashed, now) {
    if (crashed) return 'crashed';
    if (row.end_reason === 'clean') return 'clean';
    if (row.end_reason === 'abnormal') return 'abnormal';
    if (Number(row.legacy) === 1) return 'unknown'; // old builds never say how they ended
    return Number(row.last_seen_at) >= now - RUNNING_WITHIN ? 'running' : 'unknown';
}

// The session an id names: the whole id, or the start of one when only one session starts so.
function findSession(q, raw) {
    const candidates = [raw, raw.replace(/^s-/i, '')].filter((value, index, list) => value !== '' && list.indexOf(value) === index);
    for (const id of candidates) {
        const row = q.db.get('SELECT * FROM sessions WHERE session_id = ?', id);
        if (row) return row;
    }
    for (const id of candidates) {
        if (id.length < 6) continue;
        const rows = q.db.all('SELECT * FROM sessions WHERE session_id >= ? AND session_id < ? LIMIT 2', id, `${id}￿`);
        if (rows.length === 1) return rows[0];
        if (rows.length > 1) throw fail('not_found', 'more than one session starts with that id');
    }
    throw fail('not_found', 'no session with that id');
}

function sessionPage(q) {
    const raw = typeof q.params.id === 'string' ? q.params.id.trim() : '';
    if (raw === '' || raw.length > 100) throw fail('not_found', 'no session id given');
    const row = findSession(q, raw);
    const reports = reportsOf(q, row.session_id);

    // Every column of the session except the install id; the two yes/no fields as booleans.
    const session = {};
    for (const [key, value] of Object.entries(row)) {
        if (key === 'install_id') continue;
        const kind = (q.registry.session_fields || {})[key];
        session[key] = kind === 'b' && value !== null ? Number(value) === 1 : typeof value === 'bigint' ? Number(value) : value;
    }
    session.legacy = Number(row.legacy) === 1;
    session.install = row.install_id ? `${String(row.install_id).slice(0, 8)}…` : null; // enough to tell two players apart
    session.platform_wire = row.platform || null;
    session.platform = q.platformOf(row.platform, row.device);
    session.ended = endOf(row, reports.length > 0, q.now);
    // The length the game reported, or what was seen of it when it never said.
    session.seen_s = Math.max(0, (Number(row.last_seen_at) - Number(row.started_at)) / 1000);

    const rows = q.db.all(
        `SELECT e.id AS id, e.t AS at, e.name AS ev, e.registered AS known, e.props AS props
         FROM events e WHERE e.session_id = ? ORDER BY e.t, e.seq, e.id LIMIT ${TIMELINE_MAX + 1}`, row.session_id);
    const timeline = rows.slice(0, TIMELINE_MAX).map((event) => ({
        kind: 'event', id: Number(event.id), t: Number(event.at), name: event.ev, registered: Number(event.known) === 1,
        props: shortProps(parseProps(event.props), 500)
    }));
    const lastEvent = timeline.length > 0 ? timeline[timeline.length - 1].t : null;
    // A crash report of this session ends the timeline, whatever its own clock says.
    for (const report of reports) {
        timeline.push({
            kind: 'crash', t: report.occurred_at, name: 'crash', report: report.report, issue: report.issue,
            title: report.title, category: report.category, received_at: report.received_at,
            after_last_event_s: lastEvent === null ? null : (report.received_at - lastEvent) / 1000
        });
    }
    return {
        data: {
            session,
            reports,
            timeline,
            events: Math.min(rows.length, TIMELINE_MAX),
            truncated: rows.length > TIMELINE_MAX,
            first_event_at: timeline.length > 0 ? timeline[0].t : null,
            last_event_at: lastEvent,
            clean_end: rows.some((event) => event.ev === 'session_end')
        }
    };
}

// Recent sessions of the new protocol, newest first: what the Session page
// offers when no id is given. `ended` narrows it to one way of ending.
function recentSessions(q) {
    const ended = ['clean', 'abnormal', 'crashed', 'open'].includes(q.params.ended) ? q.params.ended : 'all';
    const prefix = typeof q.params.q === 'string' ? q.params.q.trim().replace(/^s-/i, '') : '';
    const paging = q.paging({ started: 's.started_at' });
    const where = q.sessionWhere('s', { from: q.now - RECENT_DAYS * DAY, to: q.now + DAY });
    const parts = [where.sql, 's.legacy = 0'];
    const args = [...where.args];
    const crashed = 'EXISTS (SELECT 1 FROM crashes c WHERE c.session_id = s.session_id)';
    if (ended === 'crashed') parts.push(crashed);
    else if (ended === 'clean') parts.push(`s.end_reason = 'clean' AND NOT ${crashed}`);
    else if (ended === 'abnormal') parts.push(`s.end_reason = 'abnormal' AND NOT ${crashed}`);
    else if (ended === 'open') parts.push(`s.end_reason IS NULL AND NOT ${crashed}`);
    if (prefix !== '') {
        parts.push('s.session_id >= ? AND s.session_id < ?');
        args.push(prefix, `${prefix}￿`);
    }
    const rows = q.db.all(
        `SELECT s.session_id AS session_id, s.started_at AS started_at, s.last_seen_at AS last_seen_at, s.build AS b, s.platform AS wire,
                s.device AS device, s.duration_s AS duration_s, s.event_count AS event_count, s.end_reason AS end_reason,
                s.last_stage AS last_stage, s.legacy AS legacy,
                (SELECT c.id FROM crashes c WHERE c.session_id = s.session_id ORDER BY c.occurred_at DESC, c.id DESC LIMIT 1) AS crash_id
         FROM sessions s WHERE ${parts.join(' AND ')} ORDER BY s.started_at DESC LIMIT ? OFFSET ?`, ...args, paging.per + 1, paging.offset);
    const groupOf = (crashId) => {
        const found = q.db.get('SELECT group_id FROM crashes WHERE id = ?', crashId);
        return found && found.group_id !== null && found.group_id !== undefined ? `SS-${found.group_id}` : null;
    };
    return {
        data: {
            rows: rows.slice(0, paging.per).map((row) => ({
                session_id: row.session_id,
                started_at: Number(row.started_at),
                last_seen_at: Number(row.last_seen_at),
                build: row.b || null,
                platform: q.platformOf(row.wire, row.device),
                duration_s: row.duration_s === null || row.duration_s === undefined ? null : Number(row.duration_s),
                seen_s: Math.max(0, (Number(row.last_seen_at) - Number(row.started_at)) / 1000),
                event_count: Number(row.event_count),
                ended: endOf(row, row.crash_id !== null && row.crash_id !== undefined, q.now),
                last_stage: row.last_stage || null,
                report: row.crash_id === null || row.crash_id === undefined ? null : `R-${row.crash_id}`,
                issue: row.crash_id === null || row.crash_id === undefined ? null : groupOf(row.crash_id)
            })),
            page: paging.page, per: paging.per,
            more: rows.length > paging.per, // no total: counting would read every session
            ended,
            window_days: RECENT_DAYS
        }
    };
}

module.exports = {
    cards: {
        'events.registry': eventRegistry,
        'events.registry_event': registryEvent,
        'events.live': liveFeed,
        'events.session': sessionPage,
        'events.sessions_recent': recentSessions
    }
};
