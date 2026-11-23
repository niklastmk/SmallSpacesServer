// What every dashboard query shares: the filters of a request, the SQL pieces
// for them, and small statistics helpers. Runs in the worker thread only.
//
// A card or action function receives one object, `q` (see makeContext below).
const fs = require('fs');
const path = require('path');
const registry = require('../events.json');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayStart = (ms) => Math.floor(ms / DAY) * DAY;
const parseDay = (text) => {
    if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const ms = Date.parse(`${text}T00:00:00Z`);
    // Date.parse turns 31 February into 3 March; only a day that exists counts.
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === text ? ms : null;
};

// Every UTC day from the one holding `from` to the one holding `to - 1`.
function daysOf(from, to) {
    const days = [];
    for (let day = dayStart(from); day < to && days.length < 800; day += DAY) days.push(utcDay(day));
    return days;
}

// ---------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------

// "1.4.10" against "1.4.9": by number, part by part. Anything unreadable sorts first.
function compareBuilds(a, b) {
    const parts = (value) => String(value || '').split(/[^0-9]+/).filter((part) => part !== '').map(Number);
    const left = parts(a);
    const right = parts(b);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const difference = (left[i] || 0) - (right[i] || 0);
        if (difference !== 0) return difference;
    }
    return 0;
}

// Build markers from Settings, plus builds of the new protocol that have no
// marker yet (their first session stands in for the release date). Newest first.
function listBuilds(db) {
    const builds = new Map();
    for (const row of db.all('SELECT name, released_at, note FROM build_markers')) {
        builds.set(row.name, { name: row.name, released_at: Number(row.released_at), note: row.note || '', marker: true });
    }
    const seen = db.all(`SELECT build AS name, MIN(started_at) AS first_seen, COUNT(*) AS sessions FROM sessions
                         WHERE legacy = 0 AND build IS NOT NULL AND build <> '' GROUP BY build`);
    for (const row of seen) {
        if (builds.has(row.name)) {
            builds.get(row.name).first_seen = Number(row.first_seen);
        } else {
            builds.set(row.name, { name: row.name, released_at: Number(row.first_seen), note: '', marker: false, first_seen: Number(row.first_seen) });
        }
    }
    return [...builds.values()].sort((a, b) => b.released_at - a.released_at || compareBuilds(b.name, a.name));
}

// When the new protocol started arriving, and from which build.
function trackingStart(db) {
    const row = db.get(`SELECT started_at, build FROM sessions WHERE legacy = 0 ORDER BY started_at LIMIT 1`);
    return row ? { since: Number(row.started_at), first_build: row.build || null } : { since: null, first_build: null };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const PLATFORMS = ['all', 'windows', 'mac', 'deck'];

// 'windows' | 'mac' | 'deck' | 'other' for a sessions row. The Steam Deck is a
// device, whatever the platform under it says.
function platformSql(alias) {
    const a = alias ? `${alias}.` : '';
    return `(CASE WHEN ${a}device = 'steam_deck' THEN 'deck'
                  WHEN lower(${a}platform) LIKE 'mac%' THEN 'mac'
                  WHEN lower(${a}platform) LIKE 'win%' THEN 'windows'
                  WHEN lower(${a}platform) LIKE 'linux%' THEN 'deck'
                  ELSE 'other' END)`;
}
function platformOf(platform, device) {
    if (device === 'steam_deck') return 'deck';
    const lower = String(platform || '').toLowerCase();
    if (lower.startsWith('mac')) return 'mac';
    if (lower.startsWith('win')) return 'windows';
    if (lower.startsWith('linux')) return 'deck';
    return 'other';
}

// The request's date range. `today` is the last 24 hours and is compared with
// the same 24 hours a week earlier; every other range is compared with the
// period of the same length directly before it.
function resolveRange(params, now, builds, fallback = '30d') {
    let key = typeof params.range === 'string' ? params.range : fallback;
    let from = null;
    let to = now;
    const days = /^(\d{1,3})d$/.exec(key);
    if (key === 'today') {
        from = now - DAY;
    } else if (days && [7, 30, 90].includes(Number(days[1]))) {
        from = dayStart(now) - (Number(days[1]) - 1) * DAY;
    } else if (key === 'custom' && parseDay(params.from) !== null && parseDay(params.to) !== null && parseDay(params.from) <= parseDay(params.to)) {
        from = parseDay(params.from);
        to = Math.min(now, parseDay(params.to) + DAY);
    } else if (key.startsWith('since:')) {
        const build = builds.find((entry) => entry.name === key.slice(6));
        if (build) from = dayStart(build.released_at);
    }
    if (from === null) {
        key = '30d';
        from = dayStart(now) - 29 * DAY;
    }
    const length = to - from;
    const prevTo = key === 'today' ? to - 7 * DAY : from;
    return { key, from, to, prevFrom: prevTo - length, prevTo, days: daysOf(from, to), length };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

const sum = (values) => values.reduce((total, value) => total + (Number(value) || 0), 0);
function percentile(values, p) {
    const sorted = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const position = (sorted.length - 1) * p;
    const low = Math.floor(position);
    const high = Math.ceil(position);
    return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}
const median = (values) => percentile(values, 0.5);
const share = (part, whole) => (whole > 0 ? part / whole : null);
// Relative change of `now` against `before`; null when there is nothing to compare with.
const change = (now, before) => (typeof now === 'number' && typeof before === 'number' && before !== 0 ? (now - before) / Math.abs(before) : null);
const round = (value, digits = 0) => (typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
function countBy(rows, keyOf) {
    const counts = new Map();
    for (const row of rows) {
        const key = keyOf(row);
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
}
function groupBy(rows, keyOf) {
    const groups = new Map();
    for (const row of rows) {
        const key = keyOf(row);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }
    return groups;
}
// [{ key, count, share }] largest first, the rest summed as `other` past `limit`.
function topList(counts, limit = 10) {
    const entries = [...counts.entries()].filter(([key]) => key !== null && key !== undefined && key !== '')
        .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
    const total = sum(entries.map((entry) => entry[1]));
    const head = entries.slice(0, limit).map(([key, count]) => ({ key, count, share: share(count, total) }));
    const rest = sum(entries.slice(limit).map((entry) => entry[1]));
    if (rest > 0) head.push({ key: 'other', count: rest, share: share(rest, total), other: true });
    return head;
}
// A histogram over fixed edges: [{ from, to, count }], the last bin open-ended.
function histogram(values, edges) {
    const bins = edges.map((edge, index) => ({ from: edge, to: index + 1 < edges.length ? edges[index + 1] : null, count: 0 }));
    for (const value of values) {
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        let index = bins.length - 1;
        while (index > 0 && value < bins[index].from) index--;
        if (value >= bins[0].from) bins[index].count++;
    }
    return bins;
}

// ---------------------------------------------------------------------------
// Files the main server owns (read-only here)
// ---------------------------------------------------------------------------

const fileCache = new Map(); // name -> { mtimeMs, size, value }
function readJsonFile(storageDir, name, fallback) {
    const file = path.join(storageDir, name);
    let stat;
    try { stat = fs.statSync(file); } catch (error) { return fallback; }
    const cached = fileCache.get(name);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;
    try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        fileCache.set(name, { mtimeMs: stat.mtimeMs, size: stat.size, value });
        return value;
    } catch (error) {
        return fallback;
    }
}

// ---------------------------------------------------------------------------
// The context of one request
// ---------------------------------------------------------------------------

const SHARED_MS = 5 * 1000;
let shared = null;
const forgetShared = () => { shared = null; };

// params: the query string of the request (strings). options.defaultRange: the
// page's default date range when the request names none.
function makeContext(db, storageDir, params, now = Date.now()) {
    // Builds and the tracking start are the same for every card of a page load:
    // read them at most every five seconds (and again after any action).
    if (!shared || shared.db !== db || now - shared.at > SHARED_MS || now < shared.at) {
        shared = { db, at: now, builds: listBuilds(db), tracking: trackingStart(db) };
    }
    const builds = shared.builds;
    const tracking = shared.tracking;
    const range = resolveRange(params, now, builds, typeof params.default_range === 'string' ? params.default_range : '30d');
    const platform = PLATFORMS.includes(params.platform) ? params.platform : 'all';
    let build = typeof params.build === 'string' && params.build !== '' ? params.build : 'all';
    if (build === 'newest') build = builds.length > 0 ? builds[0].name : 'all';
    if (build !== 'all' && !/^[A-Za-z0-9._+-]{1,50}$/.test(build)) build = 'all';

    // WHERE pieces for a sessions row under `alias`, for the range and the
    // platform and build filters. period: 'current' | 'previous' | { from, to } | 'any'.
    function sessionWhere(alias = 's', period = 'current') {
        const a = alias ? `${alias}.` : '';
        const parts = [];
        const args = [];
        const span = period === 'previous' ? { from: range.prevFrom, to: range.prevTo }
            : period === 'current' ? { from: range.from, to: range.to }
            : period === 'any' ? null : period;
        if (span) {
            parts.push(`${a}started_at >= ? AND ${a}started_at < ?`);
            args.push(span.from, span.to);
        }
        if (platform !== 'all') {
            parts.push(`${platformSql(alias)} = ?`);
            args.push(platform);
        }
        if (build !== 'all') {
            parts.push(`${a}build = ?`);
            args.push(build);
        }
        return { sql: parts.length > 0 ? parts.join(' AND ') : '1 = 1', args };
    }

    // Events of one name (or several) in the period, with the platform and
    // build filters applied through their session. Each row: { t, session_id,
    // install_id, build, platform ('windows'|'mac'|'deck'|'other'), day, props }.
    function events(names, period = 'current', extra = {}) {
        const list = Array.isArray(names) ? names : [names];
        const span = period === 'previous' ? { from: range.prevFrom, to: range.prevTo }
            : period === 'current' ? { from: range.from, to: range.to } : period;
        const parts = [`e.name IN (${list.map(() => '?').join(', ')})`, 'e.t >= ? AND e.t < ?'];
        const args = [...list, span.from, span.to];
        if (platform !== 'all') {
            parts.push(`${platformSql('s')} = ?`);
            args.push(platform);
        }
        if (build !== 'all') {
            parts.push('e.build = ?');
            args.push(build);
        }
        if (extra.legacy === false) parts.push('e.legacy = 0');
        const rows = db.all(
            `SELECT e.name, e.t, e.session_id, e.install_id, e.build, e.props, s.platform AS s_platform, s.device AS s_device,
                    e.platform AS e_platform
             FROM events e LEFT JOIN sessions s ON s.session_id = e.session_id
             WHERE ${parts.join(' AND ')} ORDER BY e.t LIMIT ${Number(extra.limit) > 0 ? Math.floor(extra.limit) : 2000000}`, ...args);
        return rows.map((row) => {
            let props = {};
            try { props = JSON.parse(row.props) || {}; } catch (error) { props = {}; }
            return {
                name: row.name, t: Number(row.t), session_id: row.session_id, install_id: row.install_id, build: row.build,
                platform: platformOf(row.s_platform || row.e_platform, row.s_device), day: utcDay(Number(row.t)), props
            };
        });
    }

    // Share of the sessions in the range that come from builds speaking the new
    // protocol (0..1), or null when the range has no sessions.
    function coverage(period = 'current') {
        const where = sessionWhere('s', period);
        const row = db.get(`SELECT COUNT(*) AS total, SUM(CASE WHEN s.legacy = 0 THEN 1 ELSE 0 END) AS tracked
                            FROM sessions s WHERE ${where.sql}`, ...where.args);
        return row && Number(row.total) > 0 ? Number(row.tracked) / Number(row.total) : null;
    }

    // Sorting and paging of a table from the address. `sortable` maps the
    // names the address may use to SQL expressions; the first is the default.
    function paging(sortable, defaultDir = 'desc') {
        const names = Object.keys(sortable);
        const sort = names.includes(params.sort) ? params.sort : names[0];
        const dir = params.dir === 'asc' || params.dir === 'desc' ? params.dir : defaultDir;
        const per = [25, 50, 100].includes(Number(params.per)) ? Number(params.per) : 25;
        const page = Number.isInteger(Number(params.page)) && Number(params.page) >= 1 ? Number(params.page) : 1;
        return { sort, dir, per, page, offset: (page - 1) * per, orderBy: `${sortable[sort]} ${dir === 'asc' ? 'ASC' : 'DESC'}` };
    }

    return {
        db, now, params, range, platform, build, compare: params.compare === '1', builds, tracking, registry, storageDir,
        sessionWhere, events, coverage, paging,
        platformSql, platformOf,
        // A metric that needs `days` finished days after tracking began: null
        // when it has them, otherwise { since, due } for the collecting state.
        collecting(days) {
            if (tracking.since === null) return { since: null, due: null };
            const due = dayStart(tracking.since) + (days + 1) * DAY;
            return now >= due ? null : { since: tracking.since, due };
        },
        file: (name, fallback) => readJsonFile(storageDir, name, fallback),
        log(kind, detail) {
            db.run('INSERT INTO admin_log (t, kind, detail) VALUES (?, ?, ?)', now, kind, JSON.stringify(detail === undefined ? null : detail));
        }
    };
}

module.exports = {
    MINUTE, HOUR, DAY, utcDay, dayStart, parseDay, daysOf, compareBuilds, listBuilds, trackingStart,
    platformSql, platformOf, resolveRange, sum, percentile, median, share, change, round, countBy, groupBy, topList,
    histogram, readJsonFile, makeContext, forgetShared
};
