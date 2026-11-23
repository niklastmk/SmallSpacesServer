// Gallery page: what players upload, download, like and open in the community
// gallery. Read only.
//
// Where the numbers come from:
//   metadata.json               the designs that are in the gallery now (main server)
//   moderation_rejections.json  uploads the image check refused, newest 500 (main server)
//   events                      design_upload, design_download, design_like, gallery_open
//                               (builds of the new protocol), design_view (second wave)
//
// The helpers shared with featured.js and artists.js are in _community.js.
const { DAY, utcDay, dayStart, daysOf, sum, share, change } = require('./common');
const {
    designKey, designIndex, factsFor, timeOf, spanOf, eventSql, DAY_SQL, eventTotal, eventDaily, eventByDesign,
    collection, metaOf, seriesOf, total, filtered, countBelow
} = require('./_community');

const MODERATION_LOG = 'moderation_rejections.json';
const MODERATION_LOG_MAX = 500; // server.js keeps the newest 500 entries
const EXPORT_MAX = 5000;

// ---------------------------------------------------------------------------
// Uploads and rejections
// ---------------------------------------------------------------------------


// Upload times of the designs in the gallery, sorted.
function uploadTimes(q) {
    const times = [];
    for (const design of designIndex(q).list) {
        const at = design ? timeOf(design.upload_date) : null;
        if (at !== null) times.push(at);
    }
    return times.sort((a, b) => a - b);
}
const countIn = (sorted, span) => countBelow(sorted, span.to) - countBelow(sorted, span.from);
function countPerDay(sorted, days) {
    return days.map((day) => {
        const from = Date.parse(`${day}T00:00:00Z`);
        return countIn(sorted, { from, to: from + DAY });
    });
}

// The image check's rejection log. The only rejection the main server
// records: a title that is too long, a file that is too large or a save that
// cannot be read are answered with an error and written nowhere.
function rejectionLog(q) {
    const loaded = q.file(MODERATION_LOG, null);
    let configured = false;
    try { configured = Boolean(process.env.AZURE_CONTENT_SAFETY_ENDPOINT && process.env.AZURE_CONTENT_SAFETY_KEY); } catch (error) { configured = false; }
    const threshold = Number.parseInt(process.env.MODERATION_SEVERITY_THRESHOLD || '2', 10) || 2;
    const entries = [];
    if (Array.isArray(loaded)) {
        for (const entry of loaded) {
            const at = entry ? timeOf(entry.date) : null;
            if (at === null) continue;
            const categories = Array.isArray(entry.categories)
                ? entry.categories.filter((item) => item && typeof item.category === 'string' && Number(item.severity) >= threshold)
                    .map((item) => String(item.category).slice(0, 40))
                : [];
            entries.push({
                t: at,
                design_id: typeof entry.design_id === 'string' ? entry.design_id : null,
                title: typeof entry.title === 'string' ? entry.title.slice(0, 200) : '',
                author: typeof entry.author_name === 'string' ? entry.author_name.slice(0, 100) : '',
                reason: 'image_check',
                categories
            });
        }
        entries.sort((a, b) => a.t - b.t);
    }
    return {
        // Recorded at all: the log exists, or the check is switched on and has refused nothing yet.
        recorded: Array.isArray(loaded) || configured,
        check_enabled: configured,
        entries,
        // The first rejection on record. What happened before it is not known: the log starts with its first entry.
        recorded_since: entries.length > 0 ? entries[0].t : null,
        // The log keeps 500 entries; older ones are gone, so counts before this are too low.
        complete_since: Array.isArray(loaded) && loaded.length >= MODERATION_LOG_MAX && entries.length > 0 ? entries[0].t : null
    };
}
const rejectedIn = (log, span) => log.entries.filter((entry) => entry.t >= span.from && entry.t < span.to);

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

const tile = (value, previous, kind) => ({
    value,
    previous,
    // A count changes by a share of itself, a share by points (both as fractions).
    change: typeof value !== 'number' || typeof previous !== 'number' ? null : kind === 'share' ? value - previous : change(value, previous)
});

// The statistics strip. Each tile: value and previous for the range and the
// period before it, and a trend over the last 14 UTC days whatever the range.
function summary(q) {
    const current = spanOf(q, 'current');
    const previous = spanOf(q, 'previous');
    const trendSpan = { from: dayStart(q.now) - 13 * DAY, to: q.now };
    const trendDays = daysOf(trendSpan.from, trendSpan.to);
    const byFilter = filtered(q);
    const uploadInfo = collection(q, 'design_upload');
    const trackedDay = uploadInfo.series_from;

    const times = uploadTimes(q);
    const log = rejectionLog(q);
    const uploadsNow = eventTotal(q, 'design_upload', current, 'ok');
    const uploadsBefore = eventTotal(q, 'design_upload', previous, 'ok');
    const uploadsDaily = eventDaily(q, 'design_upload', trendSpan, 'ok');

    // Uploads: the gallery's own dates, or the game's reports when a platform
    // or build is chosen (the gallery does not know either).
    const uploads = byFilter
        ? { ...tile(uploadsNow.yes, uploadsBefore.yes, 'count'), source: 'events',
            trend: { days: trendDays, values: seriesOf(trendDays, (day) => (uploadsDaily.get(day) || {}).yes, trackedDay) } }
        : { ...tile(countIn(times, current), countIn(times, previous), 'count'), source: 'gallery',
            trend: { days: trendDays, values: countPerDay(times, trendDays) } };

    // Rejected: only what the image check refused is recorded, and without a platform or build.
    let rejected = { value: null, previous: null, change: null, rejected: null, uploads: null, trend: null, recorded: log.recorded && !byFilter };
    if (log.recorded && !byFilter) {
        const shareIn = (span) => {
            if (log.recorded_since !== null && span.to <= log.recorded_since) return null; // before the first rejection on record
            const refused = rejectedIn(log, span).length;
            return share(refused, refused + countIn(times, span));
        };
        const refusedNow = rejectedIn(log, current).length;
        rejected = {
            ...tile(shareIn(current), log.recorded_since !== null && previous.from < log.recorded_since ? null : shareIn(previous), 'share'),
            rejected: refusedNow,
            uploads: refusedNow + countIn(times, current),
            trend: { days: trendDays, values: trendDays.map((day) => {
                const from = Date.parse(`${day}T00:00:00Z`);
                return shareIn({ from, to: from + DAY });
            }) },
            recorded: true
        };
    }
    // What the game reports instead: uploads that did not finish, for any reason.
    const failedShare = (counts) => share(counts.no, counts.yes + counts.no);
    const failed = {
        ...tile(failedShare(uploadsNow), failedShare(uploadsBefore), 'share'),
        failed: uploadsNow.no,
        attempts: uploadsNow.yes + uploadsNow.no,
        // A day without an upload has no share.
        trend: { days: trendDays, values: trendDays.map((day) => (uploadsDaily.has(day) ? failedShare(uploadsDaily.get(day)) : null)) }
    };

    const countTile = (name, flag) => {
        const daily = eventDaily(q, name, trendSpan, flag);
        return {
            ...tile(eventTotal(q, name, current, flag).yes, eventTotal(q, name, previous, flag).yes, 'count'),
            trend: { days: trendDays, values: seriesOf(trendDays, (day) => (daily.get(day) || {}).yes, trackedDay) }
        };
    };
    // A previous period that began before tracking did is not a fair comparison.
    const beforeTracking = !uploadInfo.sent || previous.from < dayStart(uploadInfo.since);
    const downloads = countTile('design_download', 'ok');
    const likes = countTile('design_like', 'like');
    if (beforeTracking) {
        for (const item of [downloads, likes, failed]) { item.previous = null; item.change = null; }
        if (byFilter) { uploads.previous = null; uploads.change = null; }
    }

    // Designs in the gallery at the end of the range and at its start. A
    // deleted design is gone from both; an updated one counts from its update.
    const designs = {
        ...tile(countBelow(times, current.to), countBelow(times, current.from), 'count'),
        now: designIndex(q).list.length,
        trend: { days: trendDays, values: trendDays.map((day) => countBelow(times, Date.parse(`${day}T00:00:00Z`) + DAY)) }
    };

    // Players who opened the gallery, of the players the new builds report.
    const playersIn = (span) => {
        const where = q.sessionWhere('s', span);
        const players = Number(q.db.get(`SELECT COUNT(DISTINCT s.install_id) AS n FROM sessions s
                                         WHERE ${where.sql} AND s.legacy = 0 AND s.install_id IS NOT NULL`, ...where.args).n) || 0;
        const sql = eventSql(q, 'gallery_open', span);
        const openers = Number(q.db.get(`SELECT COUNT(DISTINCT e.install_id) AS n FROM ${sql.from} WHERE ${sql.where} AND e.install_id IS NOT NULL`, ...sql.args).n) || 0;
        return { players, openers: Math.min(openers, players), share: players > 0 ? Math.min(1, openers / players) : null };
    };
    const playersNow = playersIn(current);
    const playersBefore = beforeTracking ? { share: null } : playersIn(previous);
    const whereTrend = q.sessionWhere('s', trendSpan);
    const activePerDay = new Map(q.db.all(
        `SELECT CAST(s.started_at / ${DAY} AS INTEGER) AS d, COUNT(DISTINCT s.install_id) AS n FROM sessions s
         WHERE ${whereTrend.sql} AND s.legacy = 0 AND s.install_id IS NOT NULL GROUP BY d`, ...whereTrend.args)
        .map((row) => [utcDay(Number(row.d) * DAY), Number(row.n)]));
    const openSql = eventSql(q, 'gallery_open', trendSpan);
    const openersPerDay = new Map(q.db.all(
        `SELECT ${DAY_SQL} AS d, COUNT(DISTINCT e.install_id) AS n FROM ${openSql.from} WHERE ${openSql.where} AND e.install_id IS NOT NULL GROUP BY d`, ...openSql.args)
        .map((row) => [utcDay(Number(row.d) * DAY), Number(row.n)]));
    const galleryPlayers = {
        ...tile(playersNow.share, playersBefore.share, 'share'),
        players: playersNow.players,
        openers: playersNow.openers,
        trend: { days: trendDays, values: trendDays.map((day) => {
            const active = activePerDay.get(day) || 0;
            return active > 0 ? Math.min(1, (openersPerDay.get(day) || 0) / active) : null;
        }) }
    };

    // A build from before the update reports none of this.
    if (!uploadInfo.sent) {
        for (const item of [downloads, likes, failed, galleryPlayers, ...(byFilter ? [uploads] : [])]) { item.value = null; item.previous = null; item.change = null; }
    }
    return {
        data: {
            range: { from: current.from, to: current.to, prev_from: previous.from, prev_to: previous.to },
            uploads, rejected, upload_failures: failed, downloads, likes, designs, gallery_players: galleryPlayers,
            rejections_recorded_since: log.recorded_since,
            rejections_complete_since: log.complete_since
        },
        meta: metaOf(uploadInfo)
    };
}

// Uploads per day: accepted and rejected.
function uploadsDaily(q) {
    const days = q.range.days;
    const byFilter = filtered(q);
    const info = collection(q, 'design_upload');
    const times = uploadTimes(q);
    const log = rejectionLog(q);
    const shownRejections = log.recorded && !byFilter;

    const build = (period) => {
        const span = spanOf(q, period);
        const list = period === 'previous' ? daysOf(span.from, span.to) : days;
        const reports = eventDaily(q, 'design_upload', span, 'ok');
        const refused = new Map();
        for (const entry of rejectedIn(log, span)) refused.set(utcDay(entry.t), (refused.get(utcDay(entry.t)) || 0) + 1);
        const sent = seriesOf(list, (day) => (reports.get(day) || {}).yes, info.series_from);
        return {
            days: list,
            // Designs that are in the gallery, by the day of their last upload.
            accepted: byFilter ? sent : countPerDay(times, list),
            // Refused by the image check. null: not recorded (or not known per platform and build).
            // Days before the first rejection on record are null as well.
            rejected: shownRejections ? list.map((day) => (log.recorded_since !== null && day < utcDay(log.recorded_since) ? null : refused.get(day) || 0)) : null,
            // What the game reports: uploads that finished and uploads that did not (for any reason).
            reported_ok: sent,
            reported_failed: seriesOf(list, (day) => (reports.get(day) || {}).no, info.series_from)
        };
    };
    const now = build('current');
    const data = {
        ...now,
        source: byFilter ? 'events' : 'gallery',
        totals: {
            accepted: total(now.accepted), rejected: now.rejected ? sum(now.rejected) : null,
            reported_ok: total(now.reported_ok), reported_failed: total(now.reported_failed)
        },
        rejections: { recorded: shownRejections, check_enabled: log.check_enabled, recorded_since: log.recorded_since, complete_since: log.complete_since },
        // The first day the game's own reports exist for (reported_* and, with a filter, accepted).
        reports_not_collected_before: info.first_day,
        last_day_is_partial: days.length > 0 && days[days.length - 1] === utcDay(q.now) && q.range.to >= q.now
    };
    if (q.compare) data.previous = build('previous');
    // The gallery's own dates need no tracking; only the game's reports do.
    return { data, meta: byFilter ? metaOf(info) : { coverage: null, collecting: null } };
}

// Rejection reasons and the most recent rejections.
function rejections(q) {
    const log = rejectionLog(q);
    const byFilter = filtered(q);
    const span = spanOf(q, 'current');
    const reports = eventTotal(q, 'design_upload', span, 'ok');
    const info = collection(q, 'design_upload');
    const base = {
        recorded: log.recorded && !byFilter,
        check_enabled: log.check_enabled,
        recorded_since: log.recorded_since,
        complete_since: log.complete_since,
        // Reasons the design names that the server does not record anywhere.
        not_recorded: ['name_not_allowed', 'file_too_large', 'room_data_unreadable', 'duplicate'],
        // What the game reports instead: uploads that did not finish, whatever the reason.
        reported_failed: info.sent ? reports.no : null,
        reported_attempts: info.sent ? reports.yes + reports.no : null
    };
    if (!base.recorded) {
        return { data: { ...base, total: null, reasons: [], categories: [], recent: [] }, meta: metaOf(info) };
    }
    const inRange = rejectedIn(log, span);
    const counts = new Map();
    for (const entry of inRange) {
        for (const category of entry.categories.length > 0 ? entry.categories : ['unknown']) counts.set(category, (counts.get(category) || 0) + 1);
    }
    const limit = Math.min(Math.max(Number.parseInt(q.params.limit, 10) || 6, 1), 50);
    return {
        data: {
            ...base,
            total: inRange.length,
            reasons: inRange.length > 0 ? [{ key: 'image_check', count: inRange.length, share: 1 }] : [],
            // What the image check found (one upload can have several).
            categories: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .map(([key, count]) => ({ key, count, share: share(count, inRange.length) })),
            // Newest first, whatever the range.
            recent: log.entries.slice(-limit).reverse()
                .map((entry) => ({ t: entry.t, title: entry.title, author: entry.author, design_id: entry.design_id, reason: entry.reason, categories: entry.categories }))
        },
        meta: { coverage: null, collecting: null }
    };
}

// Downloads and likes per day (and opens, once the second wave sends them).
function activityDaily(q) {
    const info = collection(q, 'design_download');
    const views = collection(q, 'design_view');
    const build = (period) => {
        const span = spanOf(q, period);
        const list = period === 'previous' ? daysOf(span.from, span.to) : q.range.days;
        const downloads = eventDaily(q, 'design_download', span, 'ok');
        const likes = eventDaily(q, 'design_like', span, 'like');
        const opens = eventDaily(q, 'design_view', span, null);
        return {
            days: list,
            downloads: seriesOf(list, (day) => (downloads.get(day) || {}).yes, info.series_from),
            downloads_failed: seriesOf(list, (day) => (downloads.get(day) || {}).no, info.series_from),
            likes: seriesOf(list, (day) => (likes.get(day) || {}).yes, info.series_from),
            unlikes: seriesOf(list, (day) => (likes.get(day) || {}).no, info.series_from),
            opens: seriesOf(list, (day) => (opens.get(day) || {}).n, views.series_from)
        };
    };
    const now = build('current');
    const data = {
        ...now,
        totals: {
            downloads: total(now.downloads), downloads_failed: total(now.downloads_failed),
            likes: total(now.likes), unlikes: total(now.unlikes), opens: total(now.opens)
        },
        not_collected_before: info.first_day,
        opens_collection: views,
        last_day_is_partial: now.days.length > 0 && now.days[now.days.length - 1] === utcDay(q.now) && q.range.to >= q.now
    };
    if (q.compare) data.previous = build('previous');
    return { data, meta: metaOf(info) };
}

// Opens, downloads and likes per design in the range, joined to the gallery.
function designResults(q, period = 'current') {
    const opens = eventByDesign(q, 'design_view', period, null);
    const downloads = eventByDesign(q, 'design_download', period, 'ok');
    const likes = eventByDesign(q, 'design_like', period, 'like');
    const index = designIndex(q);
    const viewsSeen = collection(q, 'design_view').sent;
    const rows = [];
    for (const key of new Set([...opens.keys(), ...downloads.keys(), ...likes.keys()])) {
        const sentAs = (opens.get(key) || downloads.get(key) || likes.get(key)).id;
        rows.push({
            ...factsFor(index, sentAs),
            opens: viewsSeen ? (opens.get(key) || { n: 0 }).n : null,
            downloads: (downloads.get(key) || { yes: 0 }).yes,
            likes: (likes.get(key) || { yes: 0 }).yes,
            unlikes: (likes.get(key) || { no: 0 }).no
        });
    }
    return { rows, viewsSeen };
}

const SORTS = ['opens', 'downloads', 'likes'];
function sortResults(rows, sort, dir) {
    const sign = dir === 'asc' ? 1 : -1;
    const others = SORTS.filter((name) => name !== sort);
    return rows.sort((a, b) => sign * ((a[sort] || 0) - (b[sort] || 0))
        || (b[others[0]] || 0) - (a[others[0]] || 0) || (b[others[1]] || 0) - (a[others[1]] || 0) || String(a.id).localeCompare(String(b.id)));
}

// Top designs: thumbnail, opens, downloads and likes in the range.
// Address: sort = opens | downloads | likes, dir, page, per.
function topDesigns(q) {
    const { rows, viewsSeen } = designResults(q);
    // Opens first, as designed, once any build sends them; downloads until then.
    const sortable = viewsSeen ? { opens: '', downloads: '', likes: '' } : { downloads: '', likes: '', opens: '' };
    const paging = q.paging(sortable);
    // A page past the end shows the last page.
    const page = Math.min(paging.page, Math.max(1, Math.ceil(rows.length / paging.per)));
    sortResults(rows, paging.sort, paging.dir);
    const info = collection(q, 'design_download');
    return {
        data: {
            total: rows.length,
            page,
            per: paging.per,
            sort: paging.sort,
            dir: paging.dir,
            rows: rows.slice((page - 1) * paging.per, page * paging.per),
            opens_collection: collection(q, 'design_view')
        },
        meta: metaOf(info)
    };
}

// "Gallery and featured results" of the export on Settings: one row per design
// with activity in the range. The same shape as maintenance.export.
function exportResults(q) {
    const { rows } = designResults(q);
    sortResults(rows, 'downloads', 'desc');
    const loaded = q.file('featured.json', []);
    const featured = new Set((Array.isArray(loaded) ? loaded : []).map(designKey));
    return {
        columns: ['design_id', 'title', 'author', 'level', 'uploaded', 'in_gallery', 'featured', 'opens', 'downloads', 'likes', 'unlikes'],
        rows: rows.slice(0, EXPORT_MAX).map((row) => [
            row.id, row.title, row.author, row.level, row.uploaded_at === null ? null : new Date(row.uploaded_at).toISOString(),
            row.missing ? 0 : 1, featured.has(designKey(row.id)) ? 1 : 0, row.opens, row.downloads, row.likes, row.unlikes
        ]),
        truncated: rows.length > EXPORT_MAX
    };
}

module.exports = {
    cards: {
        'gallery.summary': summary,
        'gallery.uploads_daily': uploadsDaily,
        'gallery.rejections': rejections,
        'gallery.activity_daily': activityDaily,
        'gallery.top_designs': topDesigns,
        'gallery.export': exportResults
    },
    actions: {}
};
