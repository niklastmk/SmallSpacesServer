// Featured page: the row of designs players see first, what it achieves, and
// its change history.
//
// The row itself is featured.json of the main server; the page saves it with
// POST /api/featured/admin and then calls the action featured.log_publish, so
// that admin_log (kind 'featured.publish') knows which design was featured
// when. Results come from events: featured_shown (the row was received),
// design_view with list = featured (second wave), design_download and
// design_like of designs while they were in the row.
const fs = require('fs');
const path = require('path');
const { DAY, utcDay, daysOf, compareBuilds, sum, share } = require('./common');
const {
    designKey, designIndex, designFacts, factsFor, spanOf, eventSql, prop, DAY_SQL, DESIGN_SQL,
    eventByDesign, collection, metaOf, seriesOf, total, countBelow
} = require('./_community');

const ROW_MAX = 8;        // the design: at most eight designs in the row
const ROUTE_MAX = 200;    // what POST /api/featured/admin accepts
const LOG_READ_MAX = 2000;
const ID_MAX = 80;

const refuse = (code, message) => Object.assign(new Error(message), { code });

// ---------------------------------------------------------------------------
// The row and its history
// ---------------------------------------------------------------------------

function publishedIds(q) {
    const loaded = q.file('featured.json', []);
    return Array.isArray(loaded) ? loaded.filter((id) => typeof id === 'string' && id !== '') : [];
}
function fileTime(q) {
    try { return Math.floor(fs.statSync(path.join(q.storageDir, 'featured.json')).mtimeMs); } catch (error) { return null; }
}
const idList = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id !== '') : []);
const sameList = (a, b) => a.length === b.length && a.every((id, index) => designKey(id) === designKey(b[index]));

// The logged publishes, oldest first.
function publishLog(q) {
    const rows = q.db.all(`SELECT id, t, detail FROM admin_log WHERE kind = 'featured.publish' ORDER BY t DESC, id DESC LIMIT ${LOG_READ_MAX}`);
    const entries = [];
    for (const row of rows.reverse()) {
        let detail = null;
        try { detail = JSON.parse(row.detail); } catch (error) { detail = null; }
        if (!detail || typeof detail !== 'object') continue;
        entries.push({
            id: Number(row.id), t: Number(row.t), before: idList(detail.before), after: idList(detail.after),
            by: typeof detail.by === 'string' && detail.by !== '' ? detail.by : null,
            titles: detail.titles && typeof detail.titles === 'object' ? detail.titles : {},
            missing: idList(detail.missing)
        });
    }
    return entries;
}

// What the row was over time: [{ t, ids }] oldest first, the first from before
// the history began (t = -Infinity). A change made without the dashboard
// (a script) is not in the log; it shows as a last state
// dated by the file's own time.
function timeline(q) {
    const entries = publishLog(q);
    const current = publishedIds(q);
    const states = [];
    if (entries.length > 0) {
        states.push({ t: -Infinity, ids: entries[0].before });
        for (const entry of entries) states.push({ t: entry.t, ids: entry.after });
    } else {
        states.push({ t: -Infinity, ids: current });
    }
    const last = states[states.length - 1];
    let unlogged = false;
    if (!sameList(last.ids, current)) {
        unlogged = true;
        states.push({ t: Math.max(fileTime(q) || q.now, Number.isFinite(last.t) ? last.t + 1 : 0), ids: current });
    }
    return { entries, states, current, unlogged, known_since: entries.length > 0 ? entries[0].t : null };
}

// Map of design key -> [{ from, to }]: when the design was in the row.
function stretches(states) {
    const byKey = new Map();
    states.forEach((state, index) => {
        const to = index + 1 < states.length ? states[index + 1].t : Infinity;
        for (const key of new Set(state.ids.map(designKey))) {
            const list = byKey.get(key) || [];
            const previous = list[list.length - 1];
            if (previous && previous.to === state.t) previous.to = to; else list.push({ from: state.t, to });
            byKey.set(key, list);
        }
    });
    return byKey;
}
const inStretch = (list, t) => Boolean(list) && list.some((stretch) => t >= stretch.from && t < stretch.to);

const countIn = (sorted, from, to) => (sorted ? countBelow(sorted, to) - countBelow(sorted, from) : 0);

// Map of design key -> sorted times of one event, for some designs only.
function designEventTimes(q, name, span, keys, extraWhere = '') {
    const times = new Map();
    const wanted = [...new Set(keys)];
    for (let start = 0; start < wanted.length; start += 100) {
        const chunk = wanted.slice(start, start + 100);
        const sql = eventSql(q, name, span);
        const rows = q.db.all(
            `SELECT ${DESIGN_SQL} AS design, e.t AS at FROM ${sql.from}
             WHERE ${sql.where}${extraWhere ? ` AND ${extraWhere}` : ''} AND ${DESIGN_SQL} IN (${chunk.map(() => '?').join(', ')}) ORDER BY e.t`,
            ...sql.args, ...chunk);
        for (const row of rows) {
            const list = times.get(row.design) || [];
            list.push(Number(row.at));
            times.set(row.design, list);
        }
    }
    return times;
}
const OK = `(${prop('ok')} IS NULL OR ${prop('ok')} <> 0)`;
const LIKED = `${prop('like')} = 1`;
const FROM_ROW = `${prop('list')} = 'featured'`;

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

// Featured now: the published row in order, with each design's facts and its
// results since it was featured (inside the date range).
function row(q) {
    const index = designIndex(q);
    const line = timeline(q);
    const when = stretches(line.states);
    const span = spanOf(q, 'current');
    const shownInfo = collection(q, 'featured_shown');
    const viewInfo = collection(q, 'design_view');

    const since = (key) => {
        const list = when.get(key);
        const last = list ? list[list.length - 1] : null;
        return last && last.to === Infinity && Number.isFinite(last.from) ? last.from : null;
    };
    const keys = line.current.map(designKey);
    const sql = eventSql(q, 'featured_shown', span);
    const shownTimes = q.db.all(`SELECT e.t AS at FROM ${sql.from} WHERE ${sql.where} AND ${OK} ORDER BY e.t`, ...sql.args).map((item) => Number(item.at));
    const opens = designEventTimes(q, 'design_view', span, keys, FROM_ROW);
    const downloads = designEventTimes(q, 'design_download', span, keys, OK);
    const likes = designEventTimes(q, 'design_like', span, keys, LIKED);

    const seen = new Set();
    const items = line.current.map((id, position) => {
        const key = designKey(id);
        const featuredSince = since(key);
        const from = Math.max(span.from, featuredSince === null ? -Infinity : featuredSince);
        const item = {
            position: position + 1,
            ...factsFor(index, id),
            duplicate: seen.has(key),
            // null: in the row since before the change history began.
            featured_since: featuredSince,
            results: {
                from,
                shown: shownInfo.sent ? countIn(shownTimes, from, span.to) : null,
                opens: viewInfo.sent ? countIn(opens.get(key), from, span.to) : null,
                downloads: shownInfo.sent ? countIn(downloads.get(key), from, span.to) : null,
                likes: shownInfo.sent ? countIn(likes.get(key), from, span.to) : null
            }
        };
        seen.add(key);
        return item;
    });
    const lastEntry = line.entries[line.entries.length - 1];
    // When the row was last saved: the last logged publish, or the file's own time when the last change was not logged.
    const fromLog = Boolean(lastEntry) && !line.unlogged;
    const publishedAt = fromLog ? lastEntry.t : fileTime(q);
    return {
        data: {
            max: ROW_MAX,
            route_max: ROUTE_MAX,
            count: items.length,
            // More than the design allows: saved before the limit existed. The page keeps them until someone removes them.
            over_limit: items.length > ROW_MAX,
            missing: items.filter((item) => item.missing).length,
            published_at: publishedAt,
            published_at_source: publishedAt === null ? null : fromLog ? 'log' : 'file',
            history_since: line.known_since,
            unlogged_change: line.unlogged,
            items,
            opens_collection: viewInfo
        },
        meta: metaOf(shownInfo)
    };
}

// Featured row results per day: how often the row was received, and the
// opens, downloads and likes of the designs that were in it at the time.
function results(q) {
    const line = timeline(q);
    const when = stretches(line.states);
    const shownInfo = collection(q, 'featured_shown');
    const viewInfo = collection(q, 'design_view');
    const today = utcDay(q.now);

    const build = (period) => {
        const span = spanOf(q, period);
        const days = period === 'previous' ? daysOf(span.from, span.to) : q.range.days;
        const keys = [...when.entries()].filter(([, list]) => list.some((stretch) => stretch.from < span.to && stretch.to > span.from)).map(([key]) => key);

        // Row views per day, and those from builds that also report opens.
        const sql = eventSql(q, 'featured_shown', span);
        const shownRows = q.db.all(
            `SELECT ${DAY_SQL} AS d, e.build AS b, COUNT(*) AS n FROM ${sql.from} WHERE ${sql.where} AND ${OK} GROUP BY d, e.build`, ...sql.args);
        const shown = new Map();
        let shownWithOpens = 0;
        for (const item of shownRows) {
            const day = utcDay(Number(item.d) * DAY);
            shown.set(day, (shown.get(day) || 0) + Number(item.n));
            if (viewInfo.first_build && compareBuilds(item.b, viewInfo.first_build) >= 0) shownWithOpens += Number(item.n);
        }
        const viewSql = eventSql(q, 'design_view', span);
        const opens = new Map(q.db.all(`SELECT ${DAY_SQL} AS d, COUNT(*) AS n FROM ${viewSql.from} WHERE ${viewSql.where} AND ${FROM_ROW} GROUP BY d`, ...viewSql.args)
            .map((item) => [utcDay(Number(item.d) * DAY), Number(item.n)]));
        const perDay = (name, extra) => {
            const counts = new Map();
            for (const [key, times] of designEventTimes(q, name, span, keys, extra)) {
                for (const at of times) {
                    if (inStretch(when.get(key), at)) counts.set(utcDay(at), (counts.get(utcDay(at)) || 0) + 1);
                }
            }
            return counts;
        };
        const downloads = perDay('design_download', OK);
        const likes = perDay('design_like', LIKED);

        const series = {
            days,
            shown: seriesOf(days, (day) => shown.get(day), shownInfo.series_from),
            opens: seriesOf(days, (day) => opens.get(day), viewInfo.series_from),
            downloads: seriesOf(days, (day) => downloads.get(day), shownInfo.series_from),
            likes: seriesOf(days, (day) => likes.get(day), shownInfo.series_from)
        };
        // The average leaves out today and the days before tracking.
        const finished = days.filter((day) => shownInfo.series_from !== null && day >= shownInfo.series_from && day < today);
        const opensTotal = total(series.opens);
        series.totals = {
            shown: total(series.shown), opens: opensTotal, downloads: total(series.downloads), likes: total(series.likes),
            shown_per_day: finished.length > 0 ? sum(finished.map((day) => shown.get(day) || 0)) / finished.length : null,
            finished_days: finished.length,
            // Opens of the row's designs per row view, both from the builds that report opens.
            open_rate: opensTotal === null ? null : share(opensTotal, shownWithOpens),
            open_rate_views: opensTotal === null ? null : shownWithOpens
        };
        return series;
    };

    const data = {
        ...build('current'),
        not_collected_before: shownInfo.first_day,
        opens_collection: viewInfo,
        // Before this the row is taken to be what the first logged change found.
        history_since: line.known_since,
        last_day_is_partial: q.range.days.length > 0 && q.range.days[q.range.days.length - 1] === today && q.range.to >= q.now
    };
    if (q.compare) data.previous = build('previous');
    return { data, meta: metaOf(shownInfo) };
}

// Longest run of the kept designs that is still in the old order; the rest moved.
function movedCount(before, after) {
    const place = new Map(before.map((key, index) => [key, index]));
    const order = after.filter((key) => place.has(key)).map((key) => place.get(key));
    const tails = [];
    for (const value of order) {
        let low = 0;
        let high = tails.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (tails[middle] < value) low = middle + 1; else high = middle;
        }
        tails[low] = value;
    }
    return order.length - tails.length;
}

// Change history, newest first. Address: page, per (up to 50).
function history(q) {
    const index = designIndex(q);
    const entries = publishLog(q).reverse();
    const per = Math.min(Math.max(Number.parseInt(q.params.per, 10) || 10, 1), 50);
    const page = Math.max(Number.parseInt(q.params.page, 10) || 1, 1);
    const named = (entry, id) => {
        const design = index.byKey.get(designKey(id));
        const title = typeof entry.titles[id] === 'string' ? entry.titles[id] : design ? String(design.title || '') : null;
        return { id, title };
    };
    return {
        total: entries.length,
        page,
        per,
        rows: entries.slice((page - 1) * per, page * per).map((entry) => {
            const before = [...new Set(entry.before.map(designKey))];
            const after = [...new Set(entry.after.map(designKey))];
            const gone = new Set(entry.missing.map(designKey));
            return {
                id: entry.id,
                t: entry.t,
                // Who published: the dashboard has one shared key, so only what the page sent along.
                by: entry.by,
                added: entry.after.filter((id) => !before.includes(designKey(id))).map((id) => named(entry, id)),
                // was_missing: the design no longer existed when it was removed.
                removed: entry.before.filter((id) => !after.includes(designKey(id))).map((id) => ({ ...named(entry, id), was_missing: gone.has(designKey(id)) })),
                moved: movedCount(before, after),
                count_before: entry.before.length,
                count_after: entry.after.length
            };
        })
    };
}

// Search by name or ID over the gallery. Address: q (the text), page, per (up to 50).
function search(q) {
    const index = designIndex(q);
    const text = String(q.params.q === undefined ? q.params.term || '' : q.params.q).trim().slice(0, 100);
    const per = Math.min(Math.max(Number.parseInt(q.params.per, 10) || 8, 1), 50);
    const page = Math.max(Number.parseInt(q.params.page, 10) || 1, 1);
    if (text === '') return { text, total: 0, page: 1, per, rows: [] };

    const needle = text.toLowerCase();
    const idNeedle = /^[0-9a-f-]{3,}$/i.test(text) ? designKey(text) : null;
    const featured = new Set(publishedIds(q).map(designKey));
    const found = [];
    for (const design of index.list) {
        if (!design || typeof design.id !== 'string') continue;
        const key = designKey(design.id);
        const title = String(design.title || '').toLowerCase();
        let rank = null;
        if (idNeedle && key === idNeedle) rank = 0;
        else if (title === needle) rank = 1;
        else if (title.startsWith(needle)) rank = 2;
        else if (idNeedle && key.startsWith(idNeedle)) rank = 3;
        else if (title.includes(needle)) rank = 4;
        else if (idNeedle && idNeedle.length >= 6 && key.includes(idNeedle)) rank = 5;
        if (rank !== null) found.push({ rank, design });
    }
    found.sort((a, b) => a.rank - b.rank || (Number(b.design.download_count) || 0) - (Number(a.design.download_count) || 0)
        || String(b.design.upload_date || '').localeCompare(String(a.design.upload_date || '')) || String(a.design.id).localeCompare(String(b.design.id)));
    return {
        text,
        total: found.length,
        page,
        per,
        rows: found.slice((page - 1) * per, page * per).map((item) => ({ ...designFacts(item.design), featured: featured.has(designKey(item.design.id)) }))
    };
}

// Suggestions: the most downloaded designs of the last seven days (from the
// game's reports) and the newest uploads. Address: limit (up to 25).
function suggestions(q) {
    const index = designIndex(q);
    const limit = Math.min(Math.max(Number.parseInt(q.params.limit, 10) || 8, 1), 25);
    const featured = new Set(publishedIds(q).map(designKey));
    const week = { from: q.now - 7 * DAY, to: q.now };
    const info = collection(q, 'design_download', week);
    const withFlag = (design, extra = {}) => ({ ...designFacts(design), featured: featured.has(designKey(design.id)), ...extra });

    const topWeek = [...eventByDesign(q, 'design_download', week, 'ok').entries()]
        .filter(([key, counts]) => index.byKey.has(key) && counts.yes > 0)
        .sort((a, b) => b[1].yes - a[1].yes || a[0].localeCompare(b[0]))
        .slice(0, limit)
        .map(([key, counts]) => withFlag(index.byKey.get(key), { downloads_week: counts.yes }));
    const designs = index.list.filter((design) => design && typeof design.id === 'string');
    const newest = designs.map((design) => ({ design, at: Date.parse(design.upload_date) || 0 }))
        .sort((a, b) => b.at - a.at || String(a.design.id).localeCompare(String(b.design.id)))
        .slice(0, limit).map((item) => withFlag(item.design));
    // For the time before the new builds have reported a week of downloads.
    const topAllTime = designs.slice()
        .sort((a, b) => (Number(b.download_count) || 0) - (Number(a.download_count) || 0) || String(a.id).localeCompare(String(b.id)))
        .slice(0, limit).map((design) => withFlag(design));
    return {
        data: { week_from: week.from, week_to: week.to, top_week: topWeek, newest, top_all_time: topAllTime },
        meta: metaOf(info)
    };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function checkedIds(value, what) {
    if (!Array.isArray(value)) throw refuse('invalid', `${what} must be a list of design IDs`);
    if (value.length > ROUTE_MAX) throw refuse('invalid', `${what} has more than ${ROUTE_MAX} IDs`);
    for (const id of value) {
        if (typeof id !== 'string' || id === '' || id.length > ID_MAX) throw refuse('invalid', `${what} holds something that is not a design ID`);
    }
    return value;
}

// Sorts a pasted list of IDs into added, already in the row, and not found.
// Body: { text: 'id, id ...' } or { ids: [...] }, and { current: [...] }: the
// row as the page has it, unpublished changes included. Changes nothing.
function resolveIds(q, body) {
    const index = designIndex(q);
    const tokens = Array.isArray(body.ids) ? body.ids : typeof body.text === 'string' ? body.text.split(/[\s,;]+/) : null;
    if (!tokens) throw refuse('invalid', 'send the pasted text as text, or the IDs as ids');
    const wanted = tokens.filter((token) => typeof token === 'string').map((token) => token.trim()).filter((token) => token !== '');
    if (wanted.length > ROUTE_MAX) throw refuse('invalid', `more than ${ROUTE_MAX} IDs at once`);
    const current = body.current === undefined ? publishedIds(q) : checkedIds(body.current, 'current');
    const inRow = new Set(current.map(designKey));
    const handled = new Set();
    const result = { added: [], already: [], not_found: [] };
    for (const token of wanted) {
        const key = designKey(token);
        if (handled.has(key)) continue; // the same ID twice in one paste counts once
        handled.add(key);
        const design = token.length <= ID_MAX ? index.byKey.get(key) : null;
        if (!design) result.not_found.push(token.slice(0, ID_MAX));
        else if (inRow.has(key)) result.already.push(design.id);
        else result.added.push(designFacts(design));
    }
    return result;
}

// Records a publish in the change history. The page calls it after
// POST /api/featured/admin succeeded. Body: { before: [...], after: [...],
// by?: 'name' }. Refuses (conflict) when `after` is not the row on the server.
function logPublish(q, body) {
    const before = checkedIds(body.before, 'before');
    const after = checkedIds(body.after, 'after');
    const by = typeof body.by === 'string' ? body.by.trim().slice(0, 40) : '';
    if (!sameList(after, publishedIds(q))) {
        throw refuse('conflict', 'The featured row on the server is not the row this change describes. Reload the page.');
    }
    if (sameList(before, after)) return { logged: false, count: after.length };

    const index = designIndex(q);
    const beforeKeys = new Set(before.map(designKey));
    const afterKeys = new Set(after.map(designKey));
    const changed = [...after.filter((id) => !beforeKeys.has(designKey(id))), ...before.filter((id) => !afterKeys.has(designKey(id)))];
    const titles = {};
    for (const id of changed) {
        const design = index.byKey.get(designKey(id));
        if (design) titles[id] = String(design.title || '').slice(0, 200);
    }
    const missing = before.filter((id) => !afterKeys.has(designKey(id)) && !index.byKey.has(designKey(id)));
    q.log('featured.publish', { before, after, by: by || null, titles, missing });
    return { logged: true, t: q.now, count: after.length };
}

module.exports = {
    cards: {
        'featured.row': row,
        'featured.results': results,
        'featured.history': history,
        'featured.search': search,
        'featured.suggestions': suggestions
    },
    actions: {
        'featured.resolve_ids': resolveIds,
        'featured.log_publish': logPublish
    }
};
