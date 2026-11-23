// The Gameplay pages: modes, unpacking levels, the catalogue and onboarding.
//
// Everything here comes from the room events (`room_enter`, `room_ready`,
// `room_exit`, `room_load_failed`, `catalog_usage`, `star_earned`) and, once a
// build sends them, the second wave (`level_complete`, `onboarding_step`).
// A value the data cannot give yet is `null`, and `missing` says why.
const { DAY, utcDay, dayStart, daysOf, compareBuilds, median, share } = require('./common');

const MODES = ['unpack', 'design', 'creative', 'community'];
const COMPLETIONS_NEEDED = 100; // per level, before a median or a star average is shown
const DAY_SQL = (column) => `strftime('%Y-%m-%d', ${column} / 1000, 'unixepoch')`;
const P = (key) => `json_extract(e.props, '$.${key}')`;
const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0);

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function spanOf(q, period) {
    if (period === 'previous') return { from: q.range.prevFrom, to: q.range.prevTo };
    if (period === 'current' || period === undefined) return { from: q.range.from, to: q.range.to };
    return period;
}

// Where a period starts for data of the new protocol: not before its first
// session (an event is never older than its session). The end, when there is none.
const trackedFrom = (q, span) => (q.tracking.since === null ? span.to : Math.min(span.to, Math.max(span.from, q.tracking.since)));

// FROM and WHERE for events of some names in a period, with the platform and
// build filters. The sessions table is joined only when the platform is asked for.
function eventsOf(q, names, period, options = {}) {
    const list = Array.isArray(names) ? names : [names];
    const span = spanOf(q, period);
    const parts = [list.length === 1 ? 'e.name = ?' : `e.name IN (${list.map(() => '?').join(', ')})`, 'e.t >= ? AND e.t < ?'];
    // Without the old builds' events there is nothing before the first session
    // of the new protocol, so the index is not walked through the months before it.
    const start = options.legacy === false ? trackedFrom(q, span) : span.from;
    const args = [...list, start, span.to];
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
    if (options.legacy === false) parts.push('e.legacy = 0');
    return { from, where: parts.join(' AND '), args };
}

// The first UTC day with data of the new protocol; days before it are "not collected".
const firstTrackedDay = (q) => (q.tracking.since === null ? null : utcDay(q.tracking.since));

// Whether the period before the range was collected: 'none' when it ended
// before the new protocol started, 'partial' when it started before it.
function previousCollected(q) {
    if (q.tracking.since === null || q.range.prevTo <= q.tracking.since) return 'none';
    return q.range.prevFrom < dayStart(q.tracking.since) ? 'partial' : 'full';
}

// One value per day of `days`; days before `firstDay` (or all, when it is null) are null.
function series(days, firstDay, valueOf) {
    return days.map((day) => (firstDay !== null && day >= firstDay ? valueOf(day) : null));
}

// A second-wave event: whether any build sends it yet, since when and from which build.
function eventInfo(q, name) {
    const first = q.db.get('SELECT t, build FROM events WHERE name = ? AND legacy = 0 ORDER BY t LIMIT 1', name);
    if (!first) return { event: name, received: false, first_seen: null, first_build: null };
    return { event: name, received: true, first_seen: Number(first.t), first_build: first.build || null };
}

// Share of the sessions in the period that come from `firstBuild` or a newer build.
function coverageFrom(q, firstBuild, period = 'current') {
    if (!firstBuild) return null;
    const where = q.sessionWhere('s', period);
    const rows = q.db.all(`SELECT s.build AS b, s.legacy AS old, COUNT(*) AS n FROM sessions s WHERE ${where.sql} GROUP BY b, old`, ...where.args);
    let total = 0;
    let sending = 0;
    for (const row of rows) {
        total += Number(row.n);
        if (Number(row.old) === 0 && compareBuilds(row.b, firstBuild) >= 0) sending += Number(row.n);
    }
    return total > 0 ? sending / total : null;
}

// The meta of a card that depends on a second-wave event.
function waveMeta(q, info) {
    if (!info.received) return { collected_since: null, first_build: null, coverage: null };
    return { collected_since: info.first_seen, first_build: info.first_build, coverage: coverageFrom(q, info.first_build) };
}

// "berlin-02" before "berlin-10" before "newyork-01": text by text, number by number.
function naturalCompare(a, b) {
    const chunks = (value) => String(value).toLowerCase().match(/\d+|\D+/g) || [];
    const left = chunks(a);
    const right = chunks(b);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        if (left[i] === undefined) return -1;
        if (right[i] === undefined) return 1;
        const bothNumbers = /^\d/.test(left[i]) && /^\d/.test(right[i]);
        const difference = bothNumbers ? Number(left[i]) - Number(right[i]) : left[i].localeCompare(right[i]);
        if (difference !== 0) return difference;
    }
    return 0;
}
// The collection of a level is the word its id starts with ("berlin" of "berlin-02").
const collectionOf = (levelId) => {
    const match = /^[a-z]+/i.exec(String(levelId));
    return match ? match[0].toLowerCase() : '';
};

// A small memory for the catalogue, whose four cards read the same events.
const remembered = new Map(); // key -> { at, value }
function remember(key, ms, now, make) {
    const hit = remembered.get(key);
    if (hit && now - hit.at < ms) return hit.value;
    const value = make();
    if (remembered.size >= 24) remembered.clear();
    remembered.set(key, { at: now, value });
    return value;
}

function sortRows(rows, valueOf, dir) {
    const factor = dir === 'asc' ? 1 : -1;
    return rows.sort((a, b) => {
        const left = valueOf(a);
        const right = valueOf(b);
        if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1; // no value: always last
        if (right === null || right === undefined) return -1;
        if (typeof left === 'string' || typeof right === 'string') return factor * naturalCompare(left, right);
        return factor * (left - right);
    });
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

// Per day: the players who entered each mode, as a share of the day's players.
function playersPerMode(q, period) {
    const span = spanOf(q, period);
    const days = daysOf(span.from, span.to);
    const active = new Map(); // day -> the day's players
    const everyone = new Set();
    const inMode = new Map(); // "day|mode" -> players
    const perMode = new Map(MODES.map((mode) => [mode, new Set()]));
    const seenOn = (day, player) => {
        if (!active.has(day)) active.set(day, new Set());
        active.get(day).add(player);
        everyone.add(player);
    };
    // Each player once per day and mode.
    const ev = eventsOf(q, 'room_enter', span, { legacy: false });
    for (const row of q.db.all(
        `SELECT ${DAY_SQL('e.t')} AS day, ${P('mode')} AS mode, e.install_id AS iid
         FROM ${ev.from} WHERE ${ev.where} AND e.install_id IS NOT NULL GROUP BY day, mode, iid`, ...ev.args)) {
        seenOn(row.day, row.iid);
        if (!perMode.has(row.mode)) continue;
        inMode.set(`${row.day}|${row.mode}`, (inMode.get(`${row.day}|${row.mode}`) || 0) + 1);
        perMode.get(row.mode).add(row.iid);
    }
    // A day's players: everyone who entered a room or started a session that day.
    const sessions = q.sessionWhere('s', { from: trackedFrom(q, span), to: span.to });
    for (const row of q.db.all(
        `SELECT DISTINCT ${DAY_SQL('s.started_at')} AS day, s.install_id AS iid FROM sessions s
         WHERE ${sessions.sql} AND s.legacy = 0 AND s.install_id IS NOT NULL`, ...sessions.args)) {
        seenOn(row.day, row.iid);
    }

    const first = firstTrackedDay(q);
    const players = series(days, first, (day) => (active.has(day) ? active.get(day).size : 0));
    const counts = {};
    const shares = {};
    for (const mode of MODES) {
        counts[mode] = series(days, first, (day) => inMode.get(`${day}|${mode}`) || 0);
        shares[mode] = counts[mode].map((count, index) => (count === null || !players[index] ? null : count / players[index]));
    }
    // The whole period: a player counts once per mode, however many days they played.
    const total = { players: everyone.size, modes: {} };
    for (const mode of MODES) total.modes[mode] = { players: perMode.get(mode).size, share: share(perMode.get(mode).size, everyone.size) };
    return { days, players, counts, shares, total };
}

function modesPlayersDaily(q) {
    const data = { modes: MODES, not_collected_before: firstTrackedDay(q), ...playersPerMode(q, 'current') };
    if (q.compare) {
        data.previous = playersPerMode(q, 'previous');
        data.previous_collected = previousCollected(q);
    }
    return { data, meta: { coverage: q.coverage(), collecting: q.collecting(0) } };
}

// Visits and time per mode in one period.
function visitNumbers(q, period) {
    const exits = eventsOf(q, 'room_exit', period, { legacy: false });
    const lengths = new Map(MODES.map((mode) => [mode, []]));
    for (const row of q.db.all(`SELECT ${P('mode')} AS mode, ${P('active_s')} AS active FROM ${exits.from} WHERE ${exits.where}`, ...exits.args)) {
        if (lengths.has(row.mode) && typeof row.active === 'number') lengths.get(row.mode).push(row.active);
    }
    // Old builds only said which mode a room was started in: a visit, no time.
    const enters = eventsOf(q, 'room_enter', period);
    const visits = new Map();
    for (const row of q.db.all(`SELECT ${P('mode')} AS mode, e.legacy AS old, COUNT(*) AS n FROM ${enters.from} WHERE ${enters.where} GROUP BY mode, old`, ...enters.args)) {
        const entry = visits.get(row.mode) || { tracked: 0, older: 0 };
        if (Number(row.old) === 1) entry.older += Number(row.n); else entry.tracked += Number(row.n);
        visits.set(row.mode, entry);
    }
    return MODES.map((mode) => {
        const values = lengths.get(mode);
        const entry = visits.get(mode) || { tracked: 0, older: 0 };
        const total = values.reduce((sum, value) => sum + value, 0);
        return {
            mode,
            median_s: values.length > 0 ? median(values) : null,
            mean_s: values.length > 0 ? total / values.length : null,
            total_s: total,
            based_on: values.length, // visits that ended with a room_exit
            visits: entry.tracked + entry.older,
            visits_older_builds: entry.older
        };
    });
}

function modesVisitLength(q) {
    const rows = visitNumbers(q, 'current');
    if (q.compare) {
        const before = new Map(visitNumbers(q, 'previous').map((row) => [row.mode, row]));
        for (const row of rows) {
            row.previous = { median_s: before.get(row.mode).median_s, based_on: before.get(row.mode).based_on, visits: before.get(row.mode).visits };
        }
    }
    return { data: { rows, ...(q.compare ? { previous_collected: previousCollected(q) } : {}) }, meta: { coverage: q.coverage() } };
}

// Per day: seconds played per mode (new builds) and room visits per mode (every build).
function timePerMode(q, period) {
    const span = spanOf(q, period);
    const days = daysOf(span.from, span.to);
    const first = firstTrackedDay(q);
    const exits = eventsOf(q, 'room_exit', span, { legacy: false });
    const played = new Map();
    for (const row of q.db.all(
        `SELECT ${DAY_SQL('e.t')} AS day, ${P('mode')} AS mode, SUM(${P('active_s')}) AS seconds
         FROM ${exits.from} WHERE ${exits.where} GROUP BY day, mode`, ...exits.args)) {
        played.set(`${row.day}|${row.mode}`, number(row.seconds));
    }
    const enters = eventsOf(q, 'room_enter', span);
    const entered = new Map();
    for (const row of q.db.all(
        `SELECT ${DAY_SQL('e.t')} AS day, ${P('mode')} AS mode, COUNT(*) AS n FROM ${enters.from} WHERE ${enters.where} GROUP BY day, mode`, ...enters.args)) {
        entered.set(`${row.day}|${row.mode}`, Number(row.n));
    }
    const seconds = {};
    const visits = {};
    for (const mode of MODES) {
        seconds[mode] = series(days, first, (day) => played.get(`${day}|${mode}`) || 0);
        visits[mode] = days.map((day) => entered.get(`${day}|${mode}`) || 0);
    }
    return { days, seconds, visits };
}

function modesTimeDaily(q) {
    const data = { modes: MODES, not_collected_before: firstTrackedDay(q), ...timePerMode(q, 'current') };
    if (q.compare) {
        data.previous = timePerMode(q, 'previous');
        data.previous_collected = previousCollected(q);
    }
    return { data, meta: { coverage: q.coverage(), collecting: q.collecting(0) } };
}

// The mode of the first room a session entered.
function firstModes(q, period) {
    const ev = eventsOf(q, 'room_enter', period);
    // SQLite gives the other columns of the row that holds the MIN.
    const rows = q.db.all(
        `SELECT mode, old, COUNT(*) AS n FROM (
             SELECT ${P('mode')} AS mode, e.legacy AS old, MIN(e.t) AS first_t FROM ${ev.from} WHERE ${ev.where} GROUP BY e.session_id
         ) GROUP BY mode, old`, ...ev.args);
    const pick = (old) => {
        const counts = new Map(rows.filter((row) => Number(row.old) === old).map((row) => [row.mode, Number(row.n)]));
        const sessions = MODES.reduce((sum, mode) => sum + (counts.get(mode) || 0), 0);
        return { sessions, rows: MODES.map((mode) => ({ mode, sessions: counts.get(mode) || 0, share: share(counts.get(mode) || 0, sessions) })) };
    };
    const where = q.sessionWhere('s', period);
    const all = Number(q.db.get(`SELECT COUNT(*) AS n FROM sessions s WHERE ${where.sql} AND s.legacy = 0`, ...where.args).n);
    const tracked = pick(0);
    return {
        rows: tracked.rows,
        sessions_with_room: tracked.sessions,
        sessions_without_room: Math.max(0, all - tracked.sessions),
        // Old builds name no community rooms, so their split is kept apart.
        older_builds: pick(1)
    };
}

function modesFirst(q) {
    const data = firstModes(q, 'current');
    if (q.compare) {
        const before = firstModes(q, 'previous');
        data.previous_collected = previousCollected(q);
        data.previous = data.previous_collected === 'none' ? null : { rows: before.rows, sessions_with_room: before.sessions_with_room };
    }
    return { data, meta: { coverage: q.coverage() } };
}

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

function completedPerDay(q, period, info) {
    const span = spanOf(q, period);
    const days = daysOf(span.from, span.to);
    const count = (name) => {
        const ev = eventsOf(q, name, span, { legacy: false });
        return new Map(q.db.all(`SELECT ${DAY_SQL('e.t')} AS day, COUNT(*) AS n FROM ${ev.from} WHERE ${ev.where} GROUP BY day`, ...ev.args)
            .map((row) => [row.day, Number(row.n)]));
    };
    const stars = count('star_earned');
    const completed = info.received ? count('level_complete') : new Map();
    return {
        days,
        completed: series(days, info.received ? utcDay(info.first_seen) : null, (day) => completed.get(day) || 0),
        stars: series(days, firstTrackedDay(q), (day) => stars.get(day) || 0)
    };
}

function levelsCompletedDaily(q) {
    const info = eventInfo(q, 'level_complete');
    // With these filters, does any session come from a build that sends level_complete?
    const coverage = info.received ? coverageFrom(q, info.first_build) : null;
    const counted = info.received && coverage !== null && coverage > 0;
    const days = completedPerDay(q, 'current', info);
    // No zeros for builds that cannot report a completion.
    if (!counted) days.completed = days.completed.map(() => null);
    const data = {
        level_complete: info,
        // `completed` is null on every day before a build sent level_complete;
        // `stars` (star_earned, one per star granted) stands in until then.
        not_collected_before: info.received ? utcDay(info.first_seen) : null,
        stars_not_collected_before: firstTrackedDay(q),
        missing: counted ? {} : {
            completed: info.received
                ? { reason: 'build_does_not_send', event: 'level_complete', first_build: info.first_build }
                : { reason: 'event_not_sent', event: 'level_complete' }
        },
        ...days
    };
    if (q.compare) {
        data.previous = completedPerDay(q, 'previous', info);
        data.previous_collected = previousCollected(q);
    }
    // Without completions the card shows stars, which every build of the new protocol sends.
    const meta = counted ? { collected_since: info.first_seen, first_build: info.first_build, coverage } : { coverage: q.coverage() };
    return { data, meta: { ...meta, collecting: q.collecting(0) } };
}

// Everything the levels cards know about the unpacking levels in the range.
function unpackLevels(q) {
    const info = eventInfo(q, 'level_complete');
    const levels = new Map();
    const level = (id) => {
        const key = typeof id === 'string' && id !== '' ? id : '(unknown)';
        if (!levels.has(key)) {
            levels.set(key, {
                level_id: key, collection: collectionOf(key), visits: 0, starters: new Set(), starters_sending: new Set(),
                completions: [], completed_by: new Set(), stars_earned: 0, failed_loads: 0, canceled_loads: 0,
                visit_lengths: [], ends: { menu: 0, room: 0, quit: 0, abnormal: 0 }, furthest_here: 0
            });
        }
        return levels.get(key);
    };

    // Who entered which level, per build: a completion can only be counted
    // against the players of builds that send level_complete.
    const sends = (build) => info.received && compareBuilds(build, info.first_build) >= 0;
    const enters = eventsOf(q, 'room_enter', 'current', { legacy: false });
    const reached = q.db.all(
        `SELECT ${P('level_id')} AS level, e.build AS b, e.install_id AS iid, COUNT(*) AS visits
         FROM ${enters.from} WHERE ${enters.where} AND ${P('mode')} = 'unpack' GROUP BY level, b, iid`, ...enters.args);
    for (const row of reached) {
        const entry = level(row.level);
        entry.visits += Number(row.visits);
        if (!row.iid) continue;
        entry.starters.add(row.iid);
        if (sends(row.b)) entry.starters_sending.add(row.iid);
    }

    if (info.received) {
        const done = eventsOf(q, 'level_complete', 'current', { legacy: false });
        for (const row of q.db.all(
            `SELECT ${P('level_id')} AS level, ${P('stars')} AS stars, ${P('duration_s')} AS seconds, e.install_id AS iid, e.t AS at
             FROM ${done.from} WHERE ${done.where}`, ...done.args)) {
            const entry = level(row.level);
            entry.completions.push({ stars: typeof row.stars === 'number' ? row.stars : null, seconds: typeof row.seconds === 'number' ? row.seconds : null, t: Number(row.at) });
            if (row.iid) entry.completed_by.add(row.iid);
        }
    }

    const stars = eventsOf(q, 'star_earned', 'current', { legacy: false });
    for (const row of q.db.all(`SELECT ${P('level_id')} AS level, COUNT(*) AS n FROM ${stars.from} WHERE ${stars.where} GROUP BY level`, ...stars.args)) {
        level(row.level).stars_earned = Number(row.n);
    }

    const failed = eventsOf(q, 'room_load_failed', 'current', { legacy: false });
    for (const row of q.db.all(
        `SELECT ${P('level_id')} AS level, COUNT(*) AS n, SUM(CASE WHEN ${P('canceled')} THEN 1 ELSE 0 END) AS canceled
         FROM ${failed.from} WHERE ${failed.where} AND ${P('mode')} = 'unpack' GROUP BY level`, ...failed.args)) {
        const entry = level(row.level);
        entry.failed_loads = Number(row.n) - Number(row.canceled);
        entry.canceled_loads = Number(row.canceled);
    }

    const exits = eventsOf(q, 'room_exit', 'current', { legacy: false });
    for (const row of q.db.all(
        `SELECT ${P('level_id')} AS level, ${P('exit_to')} AS exit_to, ${P('active_s')} AS active
         FROM ${exits.from} WHERE ${exits.where} AND ${P('mode')} = 'unpack'`, ...exits.args)) {
        const entry = level(row.level);
        if (typeof row.active === 'number') entry.visit_lengths.push(row.active);
        if (Object.prototype.hasOwnProperty.call(entry.ends, row.exit_to) && row.exit_to !== 'abnormal') entry.ends[row.exit_to]++;
    }

    // Sessions that died in a level: the next launch reported the stage they were in.
    const where = q.sessionWhere('s', 'current');
    for (const row of q.db.all(
        `SELECT s.last_stage AS stage, COUNT(*) AS n FROM sessions s
         WHERE ${where.sql} AND s.end_reason = 'abnormal' AND (s.last_stage LIKE 'room:unpack:%' OR s.last_stage LIKE 'loading:unpack:%')
         GROUP BY stage`, ...where.args)) {
        const id = String(row.stage).split(':').slice(2).join(':');
        if (levels.has(id)) levels.get(id).ends.abnormal += Number(row.n);
    }

    const ordered = [...levels.values()].sort((a, b) => naturalCompare(a.level_id, b.level_id));
    ordered.forEach((entry, index) => { entry.order = index + 1; });
    const orderOf = new Map(ordered.map((entry) => [entry.level_id, entry.order]));
    const furthest = new Map(); // install -> the highest order it started
    for (const row of reached) {
        const order = orderOf.get(typeof row.level === 'string' && row.level !== '' ? row.level : '(unknown)');
        if (row.iid && order !== undefined && order > (furthest.get(row.iid) || 0)) furthest.set(row.iid, order);
    }
    for (const order of furthest.values()) ordered[order - 1].furthest_here++;
    return { info, levels: ordered };
}

function levelsTable(q) {
    const { info, levels } = unpackLevels(q);
    const weekAgo = q.now - 7 * DAY;
    // How many days of level_complete the last week holds (fewer right after its first build).
    const rateDays = info.received ? Math.max(1 / 24, Math.min(7 * DAY, q.now - info.first_seen) / DAY) : null;
    // With these filters, does any session come from a build that sends level_complete?
    const coverage = info.received ? coverageFrom(q, info.first_build) : null;
    const counted = info.received && coverage !== null && coverage > 0;
    const rows = levels.map((entry) => {
        const completions = entry.completions.length;
        const enough = completions >= COMPLETIONS_NEEDED;
        const stars = entry.completions.map((item) => item.stars).filter((value) => value !== null);
        const seconds = entry.completions.map((item) => item.seconds).filter((value) => value !== null);
        const recent = entry.completions.filter((item) => item.t >= weekAgo).length;
        // Not measured for this level when nobody entered it on a build that reports completions.
        const measured = counted && entry.starters_sending.size > 0;
        const ended = entry.ends.menu + entry.ends.room + entry.ends.quit + entry.ends.abnormal;
        const stop = Object.entries(entry.ends).sort((a, b) => b[1] - a[1])[0];
        return {
            level_id: entry.level_id,
            collection: entry.collection,
            order: entry.order,
            started: entry.starters.size, // players who entered the level
            visits: entry.visits,
            // Completions exist only for builds that send level_complete, so the
            // rate is counted on the players of those builds (`started_counted`).
            started_counted: counted ? entry.starters_sending.size : null,
            completed: measured ? entry.completed_by.size : null, // players who finished it
            completions: measured ? completions : null,
            completion: measured ? share(entry.completed_by.size, entry.starters_sending.size) : null,
            stars_avg: measured && enough && stars.length > 0 ? stars.reduce((sum, value) => sum + value, 0) / stars.length : null,
            median_s: measured && enough && seconds.length > 0 ? median(seconds) : null,
            // While a level has fewer completions than needed: how many it has, and
            // when it gets there at the pace of the last seven days.
            collecting: measured && !enough ? {
                have: completions, needed: COMPLETIONS_NEEDED,
                due: recent > 0 ? Math.round(q.now + ((COMPLETIONS_NEEDED - completions) / (recent / rateDays)) * DAY) : null
            } : null,
            stars_earned: entry.stars_earned,
            median_visit_s: entry.visit_lengths.length > 0 ? median(entry.visit_lengths) : null,
            visits_ended: ended,
            ends: entry.ends, // how visits to the level ended: to the menu, to another room, quit, or the game died
            stop: ended > 0 && stop[1] > 0 ? { key: stop[0], count: stop[1], share: stop[1] / ended } : null,
            abnormal_share: share(entry.ends.abnormal, ended),
            furthest_here: entry.furthest_here, // players who started no later level in the range
            furthest_share: share(entry.furthest_here, entry.starters.size),
            failed_loads: entry.failed_loads,
            canceled_loads: entry.canceled_loads
        };
    });

    const sortable = {
        order: (row) => row.order, started: (row) => row.started, completed: (row) => row.completed, completion: (row) => row.completion,
        stars: (row) => (row.stars_avg !== null ? row.stars_avg : null), median: (row) => row.median_s, failed: (row) => row.failed_loads,
        stars_earned: (row) => row.stars_earned, visit: (row) => row.median_visit_s, furthest: (row) => row.furthest_share
    };
    const sort = Object.prototype.hasOwnProperty.call(sortable, q.params.sort) ? q.params.sort : 'order';
    const dir = q.params.dir === 'asc' || q.params.dir === 'desc' ? q.params.dir : (sort === 'order' ? 'asc' : 'desc');
    sortRows(rows, sortable[sort], dir);

    const notSent = info.received
        ? { reason: 'build_does_not_send', event: 'level_complete', first_build: info.first_build }
        : { reason: 'event_not_sent', event: 'level_complete' };
    const data = {
        rows: rows.slice(0, 200),
        total: rows.length,
        sort, dir,
        level_complete: info,
        completions_needed: COMPLETIONS_NEEDED,
        // The server has no list of levels: the order is by name and number, and
        // only levels somebody entered in the range are listed.
        order_from: 'name',
        // Columns the data cannot fill yet. The name of the spot inside a level
        // where players give up is not collected at all; `ends` and `furthest_here` stand in.
        missing: {
            ...(counted ? {} : { completed: notSent, completion: notSent, stars_avg: notSent, median_s: notSent }),
            stop_name: { reason: 'not_collected' }
        }
    };
    // Without completions the table shows first-wave columns only.
    const meta = counted ? { collected_since: info.first_seen, first_build: info.first_build, coverage } : { coverage: q.coverage() };
    return { data, meta };
}

function levelsStory(q) {
    const info = eventInfo(q, 'level_complete');
    // Who entered which unpacking level first when, per build: the list of
    // levels and the players who started the story come from the same rows.
    const enters = eventsOf(q, 'room_enter', 'current', { legacy: false });
    const entered = q.db.all(
        `SELECT ${P('level_id')} AS level, e.install_id AS iid, e.build AS b, MIN(e.t) AS at FROM ${enters.from}
         WHERE ${enters.where} AND ${P('mode')} = 'unpack' GROUP BY level, iid, b`, ...enters.args);
    const known = [...new Set(entered.map((row) => row.level).filter((id) => typeof id === 'string' && id !== ''))].sort(naturalCompare);
    const base = {
        level_complete: info,
        first_level: known.length > 0 ? known[0] : null,
        last_level: known.length > 0 ? known[known.length - 1] : null,
        levels_known: known.length,
        started: null, finished: null, rate: null, median_days: null, based_on: 0
    };
    if (!info.received) {
        return {
            data: { ...base, collecting: { since: null, due: null, reason: 'event_not_sent', event: 'level_complete' } },
            meta: { coverage: q.coverage() }
        };
    }
    const coverage = coverageFrom(q, info.first_build);
    if (!(coverage > 0)) {
        // Every session in view is from a build that cannot report a completion.
        return {
            data: { ...base, collecting: { since: null, due: null, reason: 'build_does_not_send', event: 'level_complete', first_build: info.first_build } },
            meta: { coverage: q.coverage() }
        };
    }
    if (known.length < 2) {
        return { data: { ...base, collecting: { since: info.first_seen, due: null, reason: 'no_levels' } }, meta: waveMeta(q, info) };
    }
    // Players who started the first level in the range, and those of them who
    // finished the last one afterwards. Which level is last is read from the names.
    const starters = new Map();
    for (const row of entered) {
        if (row.level !== base.first_level || !row.iid) continue;
        // Only on builds that report completions: an older build would finish the story unseen.
        if (compareBuilds(row.b, info.first_build) < 0) continue;
        if (!starters.has(row.iid) || Number(row.at) < starters.get(row.iid)) starters.set(row.iid, Number(row.at));
    }
    const done = eventsOf(q, 'level_complete', 'current', { legacy: false });
    const days = [];
    for (const row of q.db.all(
        `SELECT e.install_id AS iid, MIN(e.t) AS at FROM ${done.from}
         WHERE ${done.where} AND ${P('level_id')} = ? AND e.install_id IS NOT NULL GROUP BY iid`, ...done.args, base.last_level)) {
        const began = starters.get(row.iid);
        if (began !== undefined && Number(row.at) >= began) days.push((Number(row.at) - began) / DAY);
    }
    const data = {
        ...base,
        started: starters.size,
        finished: days.length,
        rate: days.length > 0 && starters.size > 0 ? days.length / starters.size : null,
        median_days: days.length > 0 ? median(days) : null,
        based_on: days.length,
        // Nothing to show until the first player who started the story in the range reaches the last level.
        collecting: days.length > 0 ? null : { since: info.first_seen, due: null, reason: 'nobody_finished' }
    };
    return { data, meta: waveMeta(q, info) };
}

function designRooms(q, period) {
    const enters = eventsOf(q, 'room_enter', period, { legacy: false });
    const rooms = new Map();
    for (const row of q.db.all(
        `SELECT ${P('level_id')} AS level, COUNT(*) AS visits, COUNT(DISTINCT e.install_id) AS players
         FROM ${enters.from} WHERE ${enters.where} AND ${P('mode')} = 'design' GROUP BY level`, ...enters.args)) {
        if (typeof row.level !== 'string' || row.level === '') continue;
        rooms.set(row.level, { level_id: row.level, collection: collectionOf(row.level), visits: Number(row.visits), players: Number(row.players), lengths: [] });
    }
    const exits = eventsOf(q, 'room_exit', period, { legacy: false });
    for (const row of q.db.all(
        `SELECT ${P('level_id')} AS level, ${P('active_s')} AS active FROM ${exits.from} WHERE ${exits.where} AND ${P('mode')} = 'design'`, ...exits.args)) {
        if (rooms.has(row.level) && typeof row.active === 'number') rooms.get(row.level).lengths.push(row.active);
    }
    return [...rooms.values()].map((room) => ({
        level_id: room.level_id, collection: room.collection, visits: room.visits, players: room.players,
        median_s: room.lengths.length > 0 ? median(room.lengths) : null, based_on: room.lengths.length
    })).sort((a, b) => b.visits - a.visits || naturalCompare(a.level_id, b.level_id));
}

function levelsDesignRooms(q) {
    const rows = designRooms(q, 'current');
    if (q.compare) {
        const before = new Map(designRooms(q, 'previous').map((row) => [row.level_id, row]));
        const collected = previousCollected(q) !== 'none';
        for (const row of rows) row.previous_visits = !collected ? null : before.has(row.level_id) ? before.get(row.level_id).visits : 0;
    }
    return {
        data: { rows: rows.slice(0, 50), total: rows.length, ...(q.compare ? { previous_collected: previousCollected(q) } : {}) },
        meta: { coverage: q.coverage() }
    };
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

// A category from the class name, where the name follows the catalogue's
// convention `BP_<group>_<kind>_<number>`. The first word that names a group
// decides; a class with none is "other".
const CATEGORY_WORDS = {
    seating: ['seating', 'sofa', 'chair', 'armchair', 'stool', 'barstool', 'bench', 'benches', 'lounge', 'pouf'],
    tables: ['table', 'tables', 'desk'],
    beds: ['bed', 'beds'],
    storage: ['storage', 'shelf', 'shelves', 'cabinet', 'sideboard', 'console', 'wardrobe', 'dresser', 'basket'],
    lighting: ['lighting', 'lamp', 'ceilinglamp', 'pendant', 'light', 'candle'],
    plants: ['plant', 'plants', 'planter'],
    textiles: ['rug', 'carpet', 'curtain', 'throw', 'blanket', 'pillow'],
    wall: ['poster', 'mirror', 'clock', 'painting', 'frame'],
    decor: ['deco', 'decor', 'vase', 'books'],
    hobbies: ['hobbies', 'gaming', 'pottery', 'record', 'records'],
    kids: ['kids'],
    seasonal: ['xmas', 'christmas', 'lunaryear', 'hanukkah'],
    magic: ['magic'],
    kits: ['kits', 'kit']
};
const CATEGORY_OF_WORD = new Map(Object.entries(CATEGORY_WORDS).flatMap(([category, words]) => words.map((word) => [word, category])));
const categoryCache = new Map();
function categoryOf(item) {
    if (categoryCache.has(item)) return categoryCache.get(item);
    const words = String(item).replace(/^BP_/i, '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
    const found = words.map((word) => CATEGORY_OF_WORD.get(word)).find(Boolean) || 'other';
    if (categoryCache.size > 5000) categoryCache.clear();
    categoryCache.set(item, found);
    return found;
}
// "BP_seating_sofa_04" reads "seating sofa 04".
const labelOf = (item) => String(item).replace(/^BP_/i, '').replace(/_+/g, ' ').trim();

// `Class:count,Class:count` of one room visit, as [name, count] pairs. The
// game cuts the text at 500 characters, so the last pair of a full text may be
// incomplete and is dropped.
const ITEM_NAME = /^[A-Za-z0-9_.-]{1,80}$/;
function eachItem(text, use) {
    if (typeof text !== 'string' || text === '') return 0;
    const full = text.length >= 500;
    let start = 0;
    let found = 0;
    while (start < text.length) {
        let end = text.indexOf(',', start);
        if (end === -1) {
            if (full) break;
            end = text.length;
        }
        const colon = text.lastIndexOf(':', end - 1);
        if (colon > start) {
            const count = Number(text.slice(colon + 1, end));
            if (Number.isInteger(count) && count > 0 && use(text.slice(start, colon), count)) found++;
        }
        start = end + 1;
    }
    return found;
}
function parseItems(text) {
    const items = [];
    eachItem(text, (name, count) => ITEM_NAME.test(name) && items.push([name, count]) > 0);
    return items;
}

// What was placed between two times: per item the placements, the room visits
// that used it, the last time and the placements per UTC day. Remembered for
// `keepMs`, because the cards of the page ask for the same span one after another.
function usage(q, span, keepMs = 20 * 1000) {
    // A span that ends now moves with the clock: to the minute is the same span.
    const minute = (ms) => Math.floor(ms / 60000);
    const key = `${minute(span.from)}|${span.to === q.now ? 'now' : minute(span.to)}|${q.platform}|${q.build}`;
    return remember(key, keepMs, q.now, () => {
        const ev = eventsOf(q, 'catalog_usage', span, { legacy: false });
        const items = new Map();
        let placed = 0;
        let visits = 0;
        let first = null;
        let at = 0;
        let day = 0;
        const add = (name, count) => {
            let entry = items.get(name);
            if (entry === undefined) {
                if (!ITEM_NAME.test(name)) return false;
                entry = { item: name, placed: 0, rooms: 0, last: 0, daily: new Map() };
                items.set(name, entry);
            }
            entry.placed += count;
            entry.rooms++;
            if (at > entry.last) entry.last = at;
            entry.daily.set(day, (entry.daily.get(day) || 0) + count);
            placed += count;
            return true;
        };
        for (const row of q.db.all(`SELECT e.t AS at, ${P('items')} AS items FROM ${ev.from} WHERE ${ev.where}`, ...ev.args)) {
            at = Number(row.at);
            day = Math.floor(at / DAY); // days since 1970, the key of `daily`
            if (eachItem(row.items, add) === 0) continue;
            visits++;
            if (first === null || at < first) first = at;
        }
        return { items, placed, visits, first };
    });
}

function roomVisits(q, period) {
    const ev = eventsOf(q, 'room_exit', period, { legacy: false });
    return Number(q.db.get(`SELECT COUNT(*) AS n FROM ${ev.from} WHERE ${ev.where}`, ...ev.args).n);
}

// The 30 UTC days that end with the last day of the range: the trend column.
function trendSpan(q) {
    const from = dayStart(q.range.to - 1) - 29 * DAY;
    return { from, to: q.range.to, days: daysOf(from, q.range.to) };
}

function catalogueItems(q) {
    const current = usage(q, spanOf(q, 'current'));
    const trend = trendSpan(q);
    const recent = usage(q, trend);
    const before = q.compare ? usage(q, spanOf(q, 'previous')) : null;
    const beforeCollected = before !== null && previousCollected(q) !== 'none';
    const visits = roomVisits(q, 'current');
    const firstDay = firstTrackedDay(q);

    const search = typeof q.params.q === 'string' ? q.params.q.trim().toLowerCase() : '';
    const category = typeof q.params.category === 'string' && q.params.category !== '' && q.params.category !== 'all' ? q.params.category : null;
    const all = [...current.items.values()].map((entry) => {
        const days = recent.items.get(entry.item);
        // Placements per day; null on days before placements were recorded.
        const line = series(trend.days, firstDay, (day) => (days ? days.daily.get(Date.parse(day) / DAY) || 0 : 0));
        return {
            item: entry.item, label: labelOf(entry.item), category: categoryOf(entry.item),
            placed: entry.placed,
            rooms: entry.rooms, // room visits in which it was placed
            rooms_share: share(entry.rooms, visits),
            trend: line,
            recent: line.reduce((sum, value) => sum + (value || 0), 0),
            last_placed: entry.last,
            ...(before ? { placed_previous: !beforeCollected ? null : before.items.has(entry.item) ? before.items.get(entry.item).placed : 0 } : {})
        };
    });
    const categories = new Map();
    for (const row of all) categories.set(row.category, (categories.get(row.category) || 0) + 1);
    const matching = all.filter((row) => (!category || row.category === category)
        && (search === '' || row.item.toLowerCase().includes(search) || row.label.toLowerCase().includes(search)));

    const paging = q.paging({ placed: 'placed', rooms: 'rooms', recent: 'recent', name: 'name' });
    const valueOf = paging.sort === 'name' ? (row) => row.label : (row) => row[paging.sort];
    // Equal values keep the order of the class names, so pages do not shuffle.
    matching.sort((a, b) => a.item.localeCompare(b.item));
    sortRows(matching, valueOf, paging.dir);
    const rows = matching.slice(paging.offset, paging.offset + paging.per);
    return {
        data: {
            rows,
            total: matching.length,
            page: paging.page, per: paging.per, sort: paging.sort, dir: paging.dir,
            items_total: all.length, // items placed at least once in the range, before search and category
            categories: [...categories.entries()].map(([key, items]) => ({ key, items })).sort((a, b) => b.items - a.items || a.key.localeCompare(b.key)),
            trend_days: trend.days,
            room_visits: visits, // every room visit in the range: what `rooms_share` is a share of
            room_visits_with_items: current.visits,
            placed_total: current.placed,
            // A room visit reports its 30 most placed items, so rarely placed items are undercounted.
            top_per_visit: 30,
            category_from: 'class_name',
            ...(q.compare ? { previous_collected: previousCollected(q) } : {})
        },
        meta: { coverage: q.coverage() }
    };
}

function catalogueCategories(q) {
    const current = usage(q, spanOf(q, 'current'));
    const before = q.compare ? usage(q, spanOf(q, 'previous')) : null;
    const sumBy = (source) => {
        const groups = new Map();
        for (const entry of source.items.values()) {
            const key = categoryOf(entry.item);
            const group = groups.get(key) || { key, placed: 0, items: 0 };
            group.placed += entry.placed;
            group.items++;
            groups.set(key, group);
        }
        return groups;
    };
    const groups = sumBy(current);
    const previous = before ? sumBy(before) : null;
    const rows = [...groups.values()].map((group) => ({
        key: group.key, placed: group.placed, items: group.items, share: share(group.placed, current.placed),
        ...(previous ? { share_previous: share(previous.has(group.key) ? previous.get(group.key).placed : 0, before.placed) } : {})
    })).sort((a, b) => (a.key === 'other') - (b.key === 'other') || b.placed - a.placed || a.key.localeCompare(b.key));
    return {
        data: {
            rows, // "other" last: classes whose name names no group
            placed_total: current.placed,
            other_share: share(groups.has('other') ? groups.get('other').placed : 0, current.placed),
            category_from: 'class_name',
            ...(q.compare ? { previous_collected: previousCollected(q) } : {})
        },
        meta: { coverage: q.coverage() }
    };
}

// Items seen before but not placed in the last 30 days. The server has no list
// of the catalogue, so an item nobody ever placed cannot appear here.
function catalogueUnused(q) {
    const windowDays = 30;
    // The last 30 UTC days (the same span as the trend of a range that ends now)
    // and, read once an hour, what was placed in the four months before them.
    const edge = dayStart(q.now) - (windowDays - 1) * DAY;
    const recent = usage(q, { from: edge, to: q.now });
    const older = usage(q, { from: edge - 120 * DAY, to: edge }, 60 * 60 * 1000);
    const unused = [...older.items.values()].filter((entry) => !recent.items.has(entry.item))
        .map((entry) => ({ item: entry.item, label: labelOf(entry.item), category: categoryOf(entry.item), last_placed: entry.last, placed: entry.placed }))
        .sort((a, b) => a.last_placed - b.last_placed || a.item.localeCompare(b.item));
    let known = recent.items.size;
    for (const name of older.items.keys()) if (!recent.items.has(name)) known++;
    return {
        data: {
            rows: unused.slice(0, 100),
            count: unused.length,
            items_known: known,
            window_days: windowDays,
            window_from: edge,
            known_since: older.first !== null ? older.first : recent.first, // the first placement on record with these filters
            master_list: false
        },
        // Until placements have been recorded for 30 days, every known item was placed within them.
        meta: { coverage: q.coverage(), collecting: q.collecting(windowDays) }
    };
}

function materialNumbers(q, period) {
    const ev = eventsOf(q, 'room_exit', period, { legacy: false });
    const rows = q.db.all(
        `SELECT ${P('mode')} AS mode, COUNT(*) AS visits, SUM(${P('materials_applied')}) AS applied,
                SUM(CASE WHEN ${P('materials_applied')} > 0 THEN 1 ELSE 0 END) AS visits_with
         FROM ${ev.from} WHERE ${ev.where} GROUP BY mode`, ...ev.args);
    const byMode = new Map(rows.map((row) => [row.mode, row]));
    const modes = MODES.map((mode) => {
        const row = byMode.get(mode);
        return { mode, applied: row ? number(row.applied) : 0, visits: row ? Number(row.visits) : 0, visits_with: row ? number(row.visits_with) : 0 };
    });
    const applied = modes.reduce((sum, row) => sum + row.applied, 0);
    const visits = modes.reduce((sum, row) => sum + row.visits, 0);
    const visitsWith = modes.reduce((sum, row) => sum + row.visits_with, 0);
    return {
        applied, visits, visits_with: visitsWith,
        visits_share: share(visitsWith, visits), // room visits in which a material was changed
        per_visit: share(applied, visitsWith), // changes per such visit
        by_mode: modes.map((row) => ({ ...row, share: share(row.applied, applied), per_visit: share(row.applied, row.visits_with) }))
    };
}

function catalogueMaterials(q) {
    const data = {
        // The game counts material changes per room visit and does not say which material.
        materials: null,
        missing: { materials: { reason: 'not_collected' } },
        ...materialNumbers(q, 'current')
    };
    if (q.compare) {
        const before = materialNumbers(q, 'previous');
        data.previous_collected = previousCollected(q);
        data.previous = data.previous_collected === 'none' ? null
            : { applied: before.applied, visits: before.visits, visits_with: before.visits_with, visits_share: before.visits_share, per_visit: before.per_visit };
    }
    return { data, meta: { coverage: q.coverage() } };
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

function onboardingFlows(q, period) {
    const ev = eventsOf(q, 'onboarding_step', period, { legacy: false });
    const rows = q.db.all(
        `SELECT e.session_id AS sid, e.install_id AS iid, ${P('flow')} AS flow, ${P('step')} AS step, ${P('action')} AS action
         FROM ${ev.from} WHERE ${ev.where} ORDER BY e.t, e.seq, e.id LIMIT 500000`, ...ev.args);
    const flows = new Map();
    const seen = new Map(); // "session|flow" -> steps in the order they first appeared
    for (const row of rows) {
        const flowKey = typeof row.flow === 'string' && row.flow !== '' ? row.flow : '(none)';
        const stepKey = typeof row.step === 'string' && row.step !== '' ? row.step : '(none)';
        const action = typeof row.action === 'string' ? row.action : '';
        const who = row.iid || row.sid;
        if (!flows.has(flowKey)) flows.set(flowKey, new Map());
        const steps = flows.get(flowKey);
        if (!steps.has(stepKey)) steps.set(stepKey, { step: stepKey, shown: new Set(), done: new Set(), skipped: new Set(), other: new Map(), positions: [] });
        const entry = steps.get(stepKey);
        // A step a player saw at all: any action counts, since builds may not send "shown".
        entry.shown.add(who);
        if (action === 'done') entry.done.add(who);
        else if (action === 'skipped' || action === 'closed') entry.skipped.add(who);
        else if (action !== 'shown') entry.other.set(action, (entry.other.get(action) || 0) + 1);

        const sessionKey = `${row.sid}|${flowKey}`;
        if (!seen.has(sessionKey)) seen.set(sessionKey, []);
        const order = seen.get(sessionKey);
        if (!order.includes(stepKey)) {
            entry.positions.push(order.length);
            order.push(stepKey);
        }
    }
    return [...flows.entries()].map(([flow, steps]) => {
        // The order of a flow: where each step first appears in a session, on average.
        const ordered = [...steps.values()].map((entry) => ({
            ...entry, position: entry.positions.reduce((sum, value) => sum + value, 0) / Math.max(1, entry.positions.length)
        })).sort((a, b) => a.position - b.position || b.shown.size - a.shown.size || a.step.localeCompare(b.step));
        const list = ordered.map((entry, index) => {
            // A player who skipped a step and did it later counts as done.
            const skipped = [...entry.skipped].filter((who) => !entry.done.has(who)).length;
            return {
                step: entry.step, order: index + 1,
                shown: entry.shown.size, done: entry.done.size, skipped,
                done_share: share(entry.done.size, entry.shown.size)
            };
        });
        const started = list.length > 0 ? list[0].shown : 0;
        const finished = list.length > 0 ? list[list.length - 1].done : 0;
        return { flow, steps: list, started, finished, finish_rate: share(finished, started) };
    }).sort((a, b) => b.started - a.started || a.flow.localeCompare(b.flow));
}

function onboarding(q) {
    const info = eventInfo(q, 'onboarding_step');
    if (!info.received) {
        return {
            data: { onboarding_step: info, flows: [], counted: 'players', missing: { flows: { reason: 'event_not_sent', event: 'onboarding_step' } } },
            meta: { coverage: null }
        };
    }
    const flows = onboardingFlows(q, 'current');
    if (q.compare) {
        const before = new Map(onboardingFlows(q, 'previous').map((flow) => [flow.flow, flow]));
        for (const flow of flows) {
            const old = before.get(flow.flow);
            flow.previous = old ? { started: old.started, finished: old.finished, finish_rate: old.finish_rate } : null;
        }
    }
    return {
        data: { onboarding_step: info, flows, counted: 'players', missing: {}, ...(q.compare ? { previous_collected: previousCollected(q) } : {}) },
        meta: waveMeta(q, info)
    };
}

// Every card says which span it covers, so a page can tell "since the first
// tracked day" from the start of the range.
const withRange = (card) => (q) => {
    const answer = card(q);
    answer.data.range = { from: q.range.from, to: q.range.to };
    return answer;
};

module.exports = {
    cards: Object.fromEntries(Object.entries({
        'gameplay.modes_players_daily': modesPlayersDaily,
        'gameplay.modes_visit_length': modesVisitLength,
        'gameplay.modes_time_daily': modesTimeDaily,
        'gameplay.modes_first': modesFirst,
        'gameplay.levels_completed_daily': levelsCompletedDaily,
        'gameplay.levels_story': levelsStory,
        'gameplay.levels_table': levelsTable,
        'gameplay.levels_design_rooms': levelsDesignRooms,
        'gameplay.catalogue_items': catalogueItems,
        'gameplay.catalogue_categories': catalogueCategories,
        'gameplay.catalogue_unused': catalogueUnused,
        'gameplay.catalogue_materials': catalogueMaterials,
        'gameplay.onboarding': onboarding
    }).map(([name, card]) => [name, withRange(card)])),
    // Exposed for tests of the text formats only.
    parseItems, naturalCompare, categoryOf
};
