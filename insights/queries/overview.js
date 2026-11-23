// The Overview page: the morning check.
const { DAY, HOUR, MINUTE, utcDay, dayStart, daysOf, median, share, sum, platformOf } = require('./common');

const DAY_SQL = (column) => `strftime('%Y-%m-%d', ${column} / 1000, 'unixepoch')`;
const PLATFORM_ORDER = ['windows', 'mac', 'deck', 'other'];
const MODE_ORDER = ['unpack', 'design', 'creative', 'community'];

// Crash-free sessions are defined once, by the Stability page, so both pages
// show the same number. Should that file fail to load, the same rule is applied here.
function crashFreeRate(q, span) {
    try {
        return require('./stability').crashFree(q, span).rate;
    } catch (error) {
        const where = q.sessionWhere('s', span);
        const sessions = Number(q.db.get(`SELECT COUNT(*) AS n FROM sessions s WHERE ${where.sql}`, ...where.args).n);
        const crashed = new Set(crashesIn(q, span.from, span.to).map((crash) => crash.session)).size;
        return sessions > 0 ? Math.max(0, 1 - crashed / sessions) : null;
    }
}

// The title of an issue as the Stability page words it.
function titleOf(group) {
    try {
        return require('./stability').issueTitle(group);
    } catch (error) {
        return group.title || '';
    }
}

// What the status pill shows: New only for seven days, then Open.
function shownStatus(group, now) {
    if (group.status === 'new') return Number(group.first_seen) >= now - 7 * DAY ? 'new' : 'open';
    return group.status;
}

// The six numbers of one period. A session is crash-free when no crash report
// of the period belongs to it.
function periodNumbers(q, period) {
    const where = q.sessionWhere('s', period);
    const span = period === 'previous' ? { from: q.range.prevFrom, to: q.range.prevTo } : { from: q.range.from, to: q.range.to };
    const row = q.db.get(
        `SELECT COUNT(*) AS sessions,
                COUNT(DISTINCT s.install_id) AS players,
                COUNT(DISTINCT CASE WHEN ${q.platformSql('s')} = 'mac' THEN s.install_id END) AS mac_players,
                SUM(CASE WHEN ${q.platformSql('s')} = 'mac' THEN 1 ELSE 0 END) AS mac_sessions
         FROM sessions s WHERE ${where.sql}`, ...where.args);
    const fresh = q.db.get(
        `SELECT COUNT(DISTINCT s.install_id) AS n FROM sessions s JOIN installs i ON i.install_id = s.install_id
         WHERE ${where.sql} AND i.first_seen >= ? AND i.first_seen < ? AND COALESCE(i.existing_player, 0) = 0`,
        ...where.args, span.from, span.to);
    const lengths = q.db.all(
        `SELECT s.duration_s AS d FROM sessions s WHERE ${where.sql} AND s.end_reason = 'clean' AND s.duration_s IS NOT NULL`, ...where.args)
        .map((entry) => Number(entry.d));
    const sessions = Number(row.sessions);
    const players = Number(row.players);
    // Before the update there are no installs: nothing to count players with.
    const tracked = q.tracking.since !== null && span.to > q.tracking.since;
    return {
        players: tracked ? players : null,
        new_players: tracked ? Number(fresh.n) : null,
        sessions,
        median_session_s: lengths.length > 0 ? median(lengths) : null,
        median_session_based_on: lengths.length,
        crash_free: crashFreeRate(q, span),
        mac_share: tracked && players > 0 ? Number(row.mac_players) / players : share(Number(row.mac_sessions), sessions),
        mac_share_of: tracked && players > 0 ? 'players' : 'sessions'
    };
}

// The same six numbers per UTC day for the last 14 days (the trend lines).
function trends(q) {
    const from = dayStart(q.now) - 13 * DAY;
    const days = daysOf(from, q.now);
    const where = q.sessionWhere('s', { from, to: q.now });
    const rows = q.db.all(
        `SELECT ${DAY_SQL('s.started_at')} AS day, COUNT(*) AS sessions, COUNT(DISTINCT s.install_id) AS players,
                COUNT(DISTINCT CASE WHEN ${q.platformSql('s')} = 'mac' THEN s.install_id END) AS mac_players,
                SUM(CASE WHEN ${q.platformSql('s')} = 'mac' THEN 1 ELSE 0 END) AS mac_sessions
         FROM sessions s WHERE ${where.sql} GROUP BY day`, ...where.args);
    const dayOf = (day) => Date.parse(`${day}T00:00:00Z`);
    const byDay = new Map(rows.map((row) => [row.day, row]));
    const fresh = new Map(q.db.all(
        `SELECT ${DAY_SQL('i.first_seen')} AS day, COUNT(DISTINCT s.install_id) AS n FROM sessions s JOIN installs i ON i.install_id = s.install_id
         WHERE ${where.sql} AND i.first_seen >= ? AND COALESCE(i.existing_player, 0) = 0 GROUP BY day`, ...where.args, from)
        .map((row) => [row.day, Number(row.n)]));
    const lengths = new Map();
    for (const row of q.db.all(
        `SELECT ${DAY_SQL('s.started_at')} AS day, s.duration_s AS d FROM sessions s
         WHERE ${where.sql} AND s.end_reason = 'clean' AND s.duration_s IS NOT NULL`, ...where.args)) {
        if (!lengths.has(row.day)) lengths.set(row.day, []);
        lengths.get(row.day).push(Number(row.d));
    }
    const firstTracked = q.tracking.since === null ? null : utcDay(q.tracking.since);
    const tracked = (day) => firstTracked !== null && day >= firstTracked;
    const of = (pick) => days.map((day) => pick(byDay.get(day), day));
    return {
        days,
        players: of((row, day) => (tracked(day) ? Number(row ? row.players : 0) : null)),
        new_players: of((row, day) => (tracked(day) ? fresh.get(day) || 0 : null)),
        sessions: of((row) => Number(row ? row.sessions : 0)),
        median_session_s: of((row, day) => (lengths.has(day) ? median(lengths.get(day)) : null)),
        crash_free: of((row, day) => crashFreeRate(q, { from: dayOf(day), to: Math.min(q.now, dayOf(day) + DAY) })),
        mac_share: of((row, day) => {
            if (!row) return null;
            return tracked(day) && Number(row.players) > 0 ? Number(row.mac_players) / Number(row.players) : share(Number(row.mac_sessions), Number(row.sessions));
        })
    };
}

function stats(q) {
    return {
        data: { current: periodNumbers(q, 'current'), previous: periodNumbers(q, 'previous'), trend: trends(q),
            previous_period: { from: q.range.prevFrom, to: q.range.prevTo } }
    };
}

// Players per day for the last 30 days, by platform. Days before tracking
// began have no players to count (null, drawn as "not collected").
function playersDaily(q) {
    const from = dayStart(q.now) - 29 * DAY;
    const days = daysOf(from, q.now);
    const where = q.sessionWhere('s', { from, to: q.now });
    const rows = q.db.all(
        `SELECT ${DAY_SQL('s.started_at')} AS day, ${q.platformSql('s')} AS plat, COUNT(DISTINCT s.install_id) AS players, COUNT(*) AS sessions
         FROM sessions s WHERE ${where.sql} GROUP BY day, plat`, ...where.args)
        .map((row) => ({ ...row, platform: row.plat }));
    const firstTracked = q.tracking.since === null ? null : utcDay(q.tracking.since);
    const cell = new Map(rows.map((row) => [`${row.day}|${row.platform}`, row]));
    const platforms = PLATFORM_ORDER.filter((platform) => (q.platform === 'all' || platform === q.platform)
        && (platform !== 'other' || rows.some((row) => row.platform === 'other' && Number(row.players) > 0)));
    return {
        data: {
            days,
            series: platforms.map((platform) => ({
                key: platform,
                values: days.map((day) => (firstTracked !== null && day >= firstTracked ? Number((cell.get(`${day}|${platform}`) || {}).players || 0) : null)),
                sessions: days.map((day) => Number((cell.get(`${day}|${platform}`) || {}).sessions || 0))
            })),
            not_collected_before: firstTracked !== null && firstTracked > days[0] ? firstTracked : (firstTracked === null ? utcDay(q.now + DAY) : null),
            partial_last_day: true
        }
    };
}

// Share of the range's sessions per build. Sessions of builds from before the
// update carry no real build name and are summed as older builds.
function buildAdoption(q) {
    const where = q.sessionWhere('s', 'current');
    const rows = q.db.all(
        `SELECT CASE WHEN s.legacy = 1 OR s.build IS NULL OR s.build = '' THEN '' ELSE s.build END AS build, COUNT(*) AS sessions
         FROM sessions s WHERE ${where.sql} GROUP BY 1`, ...where.args);
    const total = sum(rows.map((row) => Number(row.sessions)));
    const order = new Map(q.builds.map((build, index) => [build.name, index]));
    const named = rows.filter((row) => row.build !== '').map((row) => {
        const known = q.builds.find((build) => build.name === row.build);
        return { build: row.build, older: false, sessions: Number(row.sessions), share: share(Number(row.sessions), total), released_at: known ? known.released_at : null };
    }).sort((a, b) => (order.has(a.build) ? order.get(a.build) : 999) - (order.has(b.build) ? order.get(b.build) : 999));
    const older = rows.find((row) => row.build === '');
    if (older) named.push({ build: null, older: true, sessions: Number(older.sessions), share: share(Number(older.sessions), total), released_at: null });
    return { data: { total, rows: named }, meta: { coverage: q.coverage() } };
}

function modeTime(q) {
    const seconds = new Map(MODE_ORDER.map((mode) => [mode, 0]));
    for (const event of q.events('room_exit', 'current', { legacy: false })) {
        const mode = MODE_ORDER.includes(event.props.mode) ? event.props.mode : null;
        if (!mode) continue;
        const played = typeof event.props.active_s === 'number' ? event.props.active_s : Number(event.props.duration_s) || 0;
        seconds.set(mode, seconds.get(mode) + played);
    }
    const total = sum([...seconds.values()]);
    return {
        data: { total_s: total, rows: MODE_ORDER.map((mode) => ({ mode, seconds: seconds.get(mode), share: share(seconds.get(mode), total) })) },
        meta: { coverage: q.coverage() }
    };
}

function community(q) {
    const everSeen = (name) => Boolean(q.db.get('SELECT 1 AS x FROM events WHERE name = ? LIMIT 1', name));
    const count = (period) => {
        const span = period === 'previous' ? { from: q.range.prevFrom, to: q.range.prevTo } : { from: q.range.from, to: q.range.to };
        // A period that ended before the update has no usage events to count: not zero, unknown.
        const tracked = q.tracking.since !== null && span.to > q.tracking.since;
        const events = tracked ? q.events(['design_download', 'design_like', 'design_view', 'artist_link_click'], period, { legacy: false }) : [];
        const designs = q.file('metadata.json', []);
        const clicks = q.file('artist_clicks.json', []);
        const inSpan = (text) => {
            const at = Date.parse(text);
            return Number.isFinite(at) && at >= span.from && at < span.to;
        };
        return {
            uploads: Array.isArray(designs) ? designs.filter((design) => design && inSpan(design.upload_date)).length : null,
            downloads: tracked && everSeen('design_download') ? events.filter((event) => event.name === 'design_download' && event.props.ok !== false).length : null,
            likes: tracked && everSeen('design_like') ? events.filter((event) => event.name === 'design_like' && event.props.like !== false).length : null,
            featured_opened: tracked && everSeen('design_view') ? events.filter((event) => event.name === 'design_view' && event.props.list === 'featured').length : null,
            artist_clicks: Array.isArray(clicks) ? clicks.filter((click) => click && !click.bot && inSpan(click.timestamp)).length : null
        };
    };
    return { data: { current: count('current'), previous: count('previous') }, meta: { coverage: q.coverage() } };
}

// Crashes of a span with the dashboard's platform, the filters applied.
function crashesIn(q, from, to) {
    const rows = q.db.all(
        `SELECT c.id, c.group_id, c.occurred_at, c.install_id, c.session_id, c.crash_guid, c.build, c.platform AS c_platform,
                s.platform AS s_platform, s.device AS s_device
         FROM crashes c LEFT JOIN sessions s ON s.session_id = c.session_id
         WHERE c.occurred_at >= ? AND c.occurred_at < ?`, from, to);
    return rows.map((row) => ({
        id: Number(row.id), group_id: row.group_id === null ? null : Number(row.group_id), t: Number(row.occurred_at), build: row.build,
        who: row.install_id || row.session_id || row.crash_guid,
        // The session the report belongs to. Reports of old builds often name none: each then stands for one session.
        session: row.session_id || `report:${row.id}`,
        platform: platformOf(row.c_platform || row.s_platform, row.s_device)
    })).filter((crash) => (q.platform === 'all' || crash.platform === q.platform) && (q.build === 'all' || crash.build === q.build));
}

// The five issues that affected the most players in the last 30 days.
function topIssues(q) {
    const from = dayStart(q.now) - 29 * DAY;
    const days = daysOf(from, q.now);
    const groups = new Map();
    for (const crash of crashesIn(q, from, q.now)) {
        if (crash.group_id === null) continue;
        if (!groups.has(crash.group_id)) groups.set(crash.group_id, { reports: 0, who: new Set(), platforms: new Set(), perDay: new Map() });
        const group = groups.get(crash.group_id);
        group.reports++;
        group.who.add(crash.who);
        if (crash.platform !== 'other') group.platforms.add(crash.platform);
        const day = utcDay(crash.t);
        group.perDay.set(day, (group.perDay.get(day) || 0) + 1);
    }
    const top = [...groups.entries()].sort((a, b) => b[1].who.size - a[1].who.size || b[1].reports - a[1].reports).slice(0, 5);
    const rows = top.map(([id, group]) => {
        const row = q.db.get('SELECT * FROM crash_groups WHERE id = ?', id);
        return {
            id: `SS-${id}`, title: row ? titleOf(row) : '', category: row ? row.category : null,
            status: row ? shownStatus(row, q.now) : 'open', fixed_build: row ? row.fixed_build : null,
            players: group.who.size, reports: group.reports, platforms: PLATFORM_ORDER.filter((platform) => group.platforms.has(platform)),
            trend: days.map((day) => group.perDay.get(day) || 0)
        };
    });
    return { data: { rows, total_issues: groups.size, days } };
}

// The short list of things that changed (handoff README, section 9).
function attention(q) {
    const now = q.now;
    const rows = [];

    // New issues with at least ten players, and regressed ones.
    const fresh = q.db.all(`SELECT * FROM crash_groups
                            WHERE (status = 'new' AND first_seen >= ?) OR status = 'regressed'`, now - 7 * DAY);
    for (const group of fresh) {
        const who = q.db.get(`SELECT COUNT(DISTINCT COALESCE(install_id, session_id, crash_guid)) AS n FROM crashes WHERE group_id = ?`, group.id);
        const latest = q.db.get('SELECT build FROM crashes WHERE group_id = ? AND build IS NOT NULL ORDER BY occurred_at DESC LIMIT 1', group.id);
        if (group.status === 'regressed') {
            rows.push({ kind: 'issue_regressed', level: 'bad', at: Number(group.status_at || group.last_seen), to: `/stability/issues/SS-${group.id}`,
                issue: `SS-${group.id}`, title: titleOf(group), build: latest ? latest.build : null });
        } else if (Number(who.n) >= 10) {
            rows.push({ kind: 'new_issue', level: 'bad', at: Number(group.first_seen), to: `/stability/issues/SS-${group.id}`,
                issue: `SS-${group.id}`, title: titleOf(group), build: latest ? latest.build : null, players: Number(who.n) });
        }
    }

    // A platform whose crash rate doubled against the day before (at least 20 crashes).
    const sessionsBy = (from, to) => new Map(q.db.all(
        `SELECT ${q.platformSql('s')} AS plat, COUNT(*) AS n FROM sessions s WHERE s.started_at >= ? AND s.started_at < ? GROUP BY plat`, from, to)
        .map((row) => [row.plat, Number(row.n)]));
    const crashesBy = (from, to) => {
        const counts = new Map();
        for (const row of q.db.all(
            `SELECT c.platform AS c_platform, s.platform AS s_platform, s.device AS s_device FROM crashes c
             LEFT JOIN sessions s ON s.session_id = c.session_id WHERE c.occurred_at >= ? AND c.occurred_at < ?`, from, to)) {
            const platform = platformOf(row.c_platform || row.s_platform, row.s_device);
            counts.set(platform, (counts.get(platform) || 0) + 1);
        }
        return counts;
    };
    const [sessionsNow, sessionsBefore] = [sessionsBy(now - DAY, now), sessionsBy(now - 2 * DAY, now - DAY)];
    const [crashesNow, crashesBefore] = [crashesBy(now - DAY, now), crashesBy(now - 2 * DAY, now - DAY)];
    for (const platform of ['windows', 'mac', 'deck']) {
        const after = share(crashesNow.get(platform) || 0, sessionsNow.get(platform) || 0);
        const before = share(crashesBefore.get(platform) || 0, sessionsBefore.get(platform) || 0);
        if ((crashesNow.get(platform) || 0) >= 20 && after !== null && before !== null && before > 0 && after >= before * 2) {
            rows.push({ kind: 'crash_rate_doubled', level: 'bad', at: now - HOUR, to: '/stability/hardware', platform, before: before * 1000, after: after * 1000 });
        }
    }

    // Crash uploads the game abandoned (counted per UTC day: today and yesterday).
    const counters = new Map(q.db.all(`SELECT key, SUM(n) AS n FROM counters WHERE day >= ? GROUP BY key`, utcDay(now - DAY)).map((row) => [row.key, Number(row.n)]));
    const abandoned = counters.get('crash_upload_abandoned') || 0;
    const uploads = abandoned + (counters.get('crash_upload_stored') || 0) + (counters.get('crash_upload_duplicate') || 0);
    if (uploads >= 10 && abandoned / uploads > 0.3) {
        rows.push({ kind: 'uploads_abandoned', level: 'warn', at: now - 2 * HOUR, to: '/stability/pipeline', share: abandoned / uploads, abandoned, uploads });
    }

    // A registered event that arrived regularly and has been silent for 24 hours.
    const registered = Object.keys(q.registry.events || {});
    if (registered.length > 0) {
        const seen = q.db.all(
            `SELECT name, MAX(t) AS last_seen, SUM(CASE WHEN t >= ? THEN 1 ELSE 0 END) AS week FROM events
             WHERE t >= ? AND legacy = 0 GROUP BY name`, now - 8 * DAY, now - 8 * DAY);
        for (const row of seen) {
            if (!registered.includes(row.name) || Number(row.week) < 10 || Number(row.last_seen) >= now - DAY) continue;
            const last = q.db.get('SELECT build FROM events WHERE name = ? AND t = ? LIMIT 1', row.name, row.last_seen);
            rows.push({ kind: 'event_silent', level: 'warn', at: Number(row.last_seen) + DAY, to: `/events/registry?q=${encodeURIComponent(row.name)}`,
                event: row.name, last_seen: Number(row.last_seen), build: last ? last.build : null });
        }
    }

    // A retention figure that got its first value in the last 24 hours.
    if (q.tracking.since !== null) {
        for (const day of [1, 3, 7, 14, 30]) {
            const due = dayStart(q.tracking.since) + (day + 1) * DAY;
            if (due <= now && due > now - DAY) {
                rows.push({ kind: 'first_value', level: 'good', at: due, to: '/players/retention', metric: 'retention', day });
            }
        }
    }

    // Reports waiting to be read.
    const waiting = q.db.get('SELECT COUNT(*) AS n, MIN(received_at) AS oldest FROM crashes WHERE parsed = 0');
    if (Number(waiting.n) > 100 || (Number(waiting.n) > 0 && Number(waiting.oldest) < now - 30 * MINUTE)) {
        rows.push({ kind: 'reports_waiting', level: 'warn', at: Number(waiting.oldest), to: '/stability/pipeline', waiting: Number(waiting.n), oldest_at: Number(waiting.oldest) });
    }

    rows.sort((a, b) => b.at - a.at);
    const shown = rows.slice(0, 6);
    return { data: { rows: shown, more: rows.length - shown.length, counts: { bad: rows.filter((row) => row.level === 'bad').length, warn: rows.filter((row) => row.level === 'warn').length } } };
}

module.exports = {
    cards: {
        'overview.stats': stats,
        'overview.players_daily': playersDaily,
        'overview.attention': attention,
        'overview.top_issues': topIssues,
        'overview.build_adoption': buildAdoption,
        'overview.mode_time': modeTime,
        'overview.community': community
    },
    shownStatus
};
