// What the Gallery, Featured and Artist links sections share: the designs of
// metadata.json, events with the request's filters as SQL, and how far an
// event is collected. The loader skips this file (its name starts with an
// underscore); gallery.js, featured.js and artists.js require it.
const { DAY, utcDay, dayStart, compareBuilds, sum } = require('./common');

// ---------------------------------------------------------------------------
// Designs (metadata.json)
// ---------------------------------------------------------------------------

// The game sends design IDs as it got them; compare without case and dashes.
const designKey = (id) => String(id === null || id === undefined ? '' : id).toLowerCase().replace(/-/g, '');

const indexes = new WeakMap(); // the parsed metadata array -> { list, byKey }
function designIndex(q) {
    const loaded = q.file('metadata.json', []);
    const list = Array.isArray(loaded) ? loaded : [];
    let index = indexes.get(list);
    if (!index) {
        index = { list, byKey: new Map() };
        for (const design of list) {
            if (design && typeof design.id === 'string') index.byKey.set(designKey(design.id), design);
        }
        indexes.set(list, index);
    }
    return index;
}

const timeOf = (text) => {
    const ms = typeof text === 'string' ? Date.parse(text) : NaN;
    return Number.isFinite(ms) ? ms : null;
};

// The address of a thumbnail on the dashboard's own route, or null.
function thumbOf(design) {
    const url = design && typeof design.thumbnail_url === 'string' ? design.thumbnail_url : '';
    const file = url.slice(url.lastIndexOf('/') + 1);
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(file) ? `/api/admin/v2/thumb/${file}` : null;
}

// What every list of designs shows. `all_time` is the main server's
// download_count, which likes add to as well: there is no separate like count.
function designFacts(design) {
    return {
        id: design.id,
        missing: false,
        title: typeof design.title === 'string' ? design.title : '',
        author: typeof design.author_name === 'string' ? design.author_name : '',
        level: typeof design.level === 'string' ? design.level : '',
        thumb: thumbOf(design),
        uploaded_at: timeOf(design.upload_date),
        all_time: Number.isFinite(Number(design.download_count)) ? Number(design.download_count) : null
    };
}
const missingFacts = (id) => ({ id: String(id), missing: true, title: null, author: null, level: null, thumb: null, uploaded_at: null, all_time: null });
const factsFor = (index, id) => {
    const design = index.byKey.get(designKey(id));
    return design ? designFacts(design) : missingFacts(id);
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const spanOf = (q, period) => (period === 'previous' ? { from: q.range.prevFrom, to: q.range.prevTo }
    : period === 'current' || period === undefined ? { from: q.range.from, to: q.range.to } : period);

// FROM and WHERE for events of some names in a span, with the platform and
// build filters of the request (the same rules as q.events).
function eventSql(q, names, period) {
    const list = Array.isArray(names) ? names : [names];
    const span = spanOf(q, period);
    const parts = [`e.name IN (${list.map(() => '?').join(', ')})`, 'e.t >= ? AND e.t < ?'];
    const args = [...list, span.from, span.to];
    let from = 'events e';
    if (q.platform !== 'all') {
        from += ' LEFT JOIN sessions s ON s.session_id = e.session_id';
        parts.push(`${q.platformSql('s')} = ?`);
        args.push(q.platform);
    }
    if (q.build !== 'all') {
        parts.push('e.build = ?');
        args.push(q.build);
    }
    return { from, where: parts.join(' AND '), args };
}

// One property of an event as SQL. `name` is always a literal of this code.
function prop(name) {
    if (!/^[a-z_]+$/.test(name)) throw new Error(`bad property name ${name}`);
    return `(CASE WHEN json_valid(e.props) THEN json_extract(e.props, '$.${name}') END)`;
}
const DAY_SQL = `CAST(e.t / ${DAY} AS INTEGER)`;
// A design ID property in the form designKey() gives.
const DESIGN_SQL = `replace(lower(${prop('design_id')}), '-', '')`;

// { n, yes, no } for one event name in a span; `flag` is a boolean property.
function eventTotal(q, name, period, flag) {
    const sql = eventSql(q, name, period);
    const flagSql = flag ? prop(flag) : 'NULL';
    const row = q.db.get(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN ${flagSql} = 1 THEN 1 ELSE 0 END) AS yes, SUM(CASE WHEN ${flagSql} = 0 THEN 1 ELSE 0 END) AS no
         FROM ${sql.from} WHERE ${sql.where}`, ...sql.args);
    return { n: Number(row.n) || 0, yes: Number(row.yes) || 0, no: Number(row.no) || 0 };
}

// Map of UTC day -> { n, yes, no } for one event name in a span.
function eventDaily(q, name, period, flag, extraWhere = '') {
    const sql = eventSql(q, name, period);
    const flagSql = flag ? prop(flag) : 'NULL';
    const rows = q.db.all(
        `SELECT ${DAY_SQL} AS d, COUNT(*) AS n, SUM(CASE WHEN ${flagSql} = 1 THEN 1 ELSE 0 END) AS yes, SUM(CASE WHEN ${flagSql} = 0 THEN 1 ELSE 0 END) AS no
         FROM ${sql.from} WHERE ${sql.where}${extraWhere ? ` AND ${extraWhere}` : ''} GROUP BY d`, ...sql.args);
    const days = new Map();
    for (const row of rows) days.set(utcDay(Number(row.d) * DAY), { n: Number(row.n) || 0, yes: Number(row.yes) || 0, no: Number(row.no) || 0 });
    return days;
}

// Map of design key -> { n, yes, no } for one event name in a span.
function eventByDesign(q, name, period, flag, extraWhere = '') {
    const sql = eventSql(q, name, period);
    const flagSql = flag ? prop(flag) : 'NULL';
    const rows = q.db.all(
        `SELECT ${DESIGN_SQL} AS design, MIN(${prop('design_id')}) AS sent_as, COUNT(*) AS n,
                SUM(CASE WHEN ${flagSql} = 1 THEN 1 ELSE 0 END) AS yes, SUM(CASE WHEN ${flagSql} = 0 THEN 1 ELSE 0 END) AS no
         FROM ${sql.from} WHERE ${sql.where}${extraWhere ? ` AND ${extraWhere}` : ''} GROUP BY design`, ...sql.args);
    const designs = new Map();
    for (const row of rows) {
        if (typeof row.design !== 'string' || row.design === '') continue;
        designs.set(row.design, { id: String(row.sent_as), n: Number(row.n) || 0, yes: Number(row.yes) || 0, no: Number(row.no) || 0 });
    }
    return designs;
}

// One request asks the same thing several times (how far an event is
// collected, the sessions per build); each is worked out once per request.
const remembered = new WeakMap(); // q -> Map(key -> value)
function once(q, key, work) {
    let known = remembered.get(q);
    if (!known) remembered.set(q, known = new Map());
    if (!known.has(key)) known.set(key, work());
    return known.get(key);
}

// When an event name first arrived and from which build.
function firstSeen(q, name) {
    return once(q, `first:${name}`, () => {
        const row = q.db.get('SELECT t, build FROM events WHERE name = ? ORDER BY t LIMIT 1', name);
        return row ? { since: Number(row.t), first_build: row.build || null } : { since: null, first_build: null };
    });
}

// Share of the sessions in the range that come from `firstBuild` or a newer
// build of the new protocol. null when the range has no sessions.
function coverageFrom(q, firstBuild, period = 'current') {
    if (!firstBuild) return null;
    const rows = once(q, `sessions:${JSON.stringify(period)}`, () => {
        const where = q.sessionWhere('s', period);
        return q.db.all(`SELECT s.build AS b, s.legacy AS old, COUNT(*) AS n FROM sessions s WHERE ${where.sql} GROUP BY s.build, s.legacy`, ...where.args);
    });
    const total = sum(rows.map((row) => row.n));
    const tracked = sum(rows.filter((row) => Number(row.old) === 0 && compareBuilds(row.b, firstBuild) >= 0).map((row) => row.n));
    return total > 0 ? tracked / total : null;
}

// How far one event is collected: { event, wave, since, first_build, first_day,
// sent, series_from, coverage, collecting }. `sent` is false while no build
// sends it, and when the build filter names a build from before it; then
// `series_from` is null and every value is null (not collected, not zero).
// `collecting` is { since, due } until its first UTC day has finished
// ({ since: null, due: null } while no build sends it).
function collection(q, name, period = 'current') {
    const seen = firstSeen(q, name);
    const registered = q.registry && q.registry.events ? q.registry.events[name] : null;
    const due = seen.since === null ? null : dayStart(seen.since) + DAY;
    const sent = seen.since !== null && (q.build === 'all' || !seen.first_build || compareBuilds(q.build, seen.first_build) >= 0);
    return {
        event: name,
        wave: registered ? registered.wave : null,
        since: seen.since,
        first_build: seen.first_build,
        first_day: seen.since === null ? null : utcDay(seen.since),
        sent,
        series_from: sent ? utcDay(seen.since) : null,
        coverage: coverageFrom(q, seen.first_build, period),
        collecting: seen.since === null ? { since: null, due: null } : q.now >= due ? null : { since: seen.since, due }
    };
}
const metaOf = (info) => ({ collected_since: info.since, first_build: info.first_build, coverage: info.coverage, collecting: info.collecting });

// Values for a list of days from a Map of day -> number. Days before
// `firstDay` (or all of them when it is null) are null: not collected, not zero.
function seriesOf(days, valueOf, firstDay) {
    return days.map((day) => (firstDay === null || firstDay === undefined || day < firstDay ? null : valueOf(day) || 0));
}
const total = (values) => (values.every((value) => value === null) ? null : sum(values));

// A platform or build is chosen: the main server's files know neither.
const filtered = (q) => q.platform !== 'all' || q.build !== 'all';

// How many sorted values are below `limit`.
function countBelow(sorted, limit) {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (sorted[middle] < limit) low = middle + 1; else high = middle;
    }
    return low;
}

module.exports = {
    designKey, designIndex, designFacts, missingFacts, factsFor, timeOf, spanOf, eventSql, prop, DAY_SQL, DESIGN_SQL,
    eventTotal, eventDaily, eventByDesign, firstSeen, coverageFrom, collection, metaOf, seriesOf, total, filtered, countBelow
};
