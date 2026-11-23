// Artist links page: one short link per artist (/go/<slug>), how often the
// game showed it and how often it was pressed.
//
// Two sources:
//   artist_clicks.json   every visit of /go/<slug>, written by the main server
//                        (all builds; automated visits are marked `bot`; no
//                        platform or build). This is what "clicks" means.
//   events               artist_link_shown and artist_link_click (second
//                        wave). Needed for "times shown" and the click rate,
//                        and used for clicks when a platform or build is chosen.
//
// The list itself is artists.json; the page saves it whole with
// POST /api/artists/admin. Checking a destination is the main action
// artists.check_destination (../main-actions/community.js).
const { DAY, utcDay, daysOf, sum, share } = require('./common');
const { spanOf, eventSql, prop, DAY_SQL, collection, metaOf, filtered, timeOf } = require('./_community');

const MAX_ARTISTS = 100; // the main server's limit
const slugOf = (value) => String(value === null || value === undefined ? '' : value).trim().toLowerCase();
const placementOf = (value) => {
    const text = String(value === null || value === undefined ? '' : value).trim().toLowerCase().slice(0, 40);
    return text === '' ? 'unknown' : text;
};

function artistList(q) {
    const loaded = q.file('artists.json', []);
    return (Array.isArray(loaded) ? loaded : []).filter((artist) => artist && typeof artist === 'object' && typeof artist.slug === 'string');
}

// The redirect's click log in a span: { human: [{ t, slug, placement, unique }], bots }.
function redirectClicks(q, span) {
    const loaded = q.file('artist_clicks.json', []);
    const human = [];
    let bots = 0;
    for (const click of Array.isArray(loaded) ? loaded : []) {
        const at = click ? timeOf(click.timestamp) : null;
        if (at === null || at < span.from || at >= span.to) continue;
        if (click.bot) { bots++; continue; }
        human.push({ t: at, slug: slugOf(click.slug), placement: placementOf(click.placement), unique: click.unique === true });
    }
    return { human, bots };
}

// The game's own reports in a span: [{ event, slug, placement, day, n, players }].
function reported(q, span) {
    const sql = eventSql(q, ['artist_link_shown', 'artist_link_click'], span);
    return q.db.all(
        `SELECT e.name AS ev, ${prop('slug')} AS sl, ${prop('placement')} AS pl, ${DAY_SQL} AS d, COUNT(*) AS n
         FROM ${sql.from} WHERE ${sql.where} GROUP BY e.name, sl, pl, d`, ...sql.args)
        .map((row) => ({ event: row.ev, slug: slugOf(row.sl), placement: placementOf(row.pl), day: utcDay(Number(row.d) * DAY), n: Number(row.n) || 0 }));
}
// Players (installs) who pressed a link, per artist.
function reportedPlayers(q, span) {
    const sql = eventSql(q, 'artist_link_click', span);
    return new Map(q.db.all(
        `SELECT ${prop('slug')} AS sl, COUNT(DISTINCT e.install_id) AS n FROM ${sql.from} WHERE ${sql.where} AND e.install_id IS NOT NULL GROUP BY sl`, ...sql.args)
        .map((row) => [slugOf(row.sl), Number(row.n) || 0]));
}

// Everything the three cards need for one span. `oneArtist`: honour the
// `slug` parameter of the address (the chart and the placements; not the list).
function gather(q, period, oneArtist = true) {
    const span = spanOf(q, period);
    const byFilter = filtered(q);
    const rows = reported(q, span);
    const only = oneArtist ? slugOf(q.params.slug) : '';
    const wanted = (slug) => only === '' || slug === only;
    const shown = rows.filter((row) => row.event === 'artist_link_shown' && wanted(row.slug));
    const pressed = rows.filter((row) => row.event === 'artist_link_click' && wanted(row.slug));
    // Clicks: the redirect's log, or the game's reports when a platform or build is chosen.
    const log = byFilter ? { human: [], bots: null } : redirectClicks(q, span);
    const clicks = byFilter
        ? pressed.map((row) => ({ slug: row.slug, placement: row.placement, day: row.day, n: row.n, unique: 0 }))
        : log.human.filter((click) => wanted(click.slug)).map((click) => ({ slug: click.slug, placement: click.placement, day: utcDay(click.t), n: 1, unique: click.unique ? 1 : 0, t: click.t }));
    return { span, source: byFilter ? 'events' : 'redirects', shown, pressed, clicks, bots: log.bots, only: only === '' ? null : only };
}
const addTo = (map, key, n) => map.set(key, (map.get(key) || 0) + n);
const sumBy = (rows, keyOf, valueOf = (row) => row.n) => {
    const totals = new Map();
    for (const row of rows) addTo(totals, keyOf(row), valueOf(row));
    return totals;
};

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

// Artists: one row per artist in the order of artists.json (the page sends
// the list back whole, so the order is kept).
function list(q) {
    const artists = artistList(q);
    const found = gather(q, 'current', false);
    const shownInfo = collection(q, 'artist_link_shown');
    const days = q.range.days;
    const collected = shownInfo.sent;

    const clicks = sumBy(found.clicks, (row) => row.slug);
    const unique = found.source === 'events' ? reportedPlayers(q, found.span) : sumBy(found.clicks, (row) => row.slug, (row) => row.unique);
    const shown = sumBy(found.shown, (row) => row.slug);
    const pressed = sumBy(found.pressed, (row) => row.slug);
    const perDay = sumBy(found.clicks, (row) => `${row.slug}|${row.day}`);
    const lastClick = new Map();
    for (const click of found.clicks) {
        if (click.t !== undefined && click.t > (lastClick.get(click.slug) || 0)) lastClick.set(click.slug, click.t);
    }
    // With a platform or build chosen, clicks are the game's reports: unknown for a build that does not send them.
    const known = found.source === 'redirects' || collection(q, 'artist_link_click').sent;
    const numbers = (slug) => ({
        clicks: known ? clicks.get(slug) || 0 : null,
        // First visit of a visitor in 30 minutes (redirects), or players who pressed (events).
        unique_visitors: known ? unique.get(slug) || 0 : null,
        shown: collected ? shown.get(slug) || 0 : null,
        // The click rate is the game's own count of presses over its count of
        // showings, so both come from the same builds.
        reported_clicks: collected ? pressed.get(slug) || 0 : null,
        click_rate: collected ? share(pressed.get(slug) || 0, shown.get(slug) || 0) : null,
        trend: known ? days.map((day) => perDay.get(`${slug}|${day}`) || 0) : null,
        last_click_at: lastClick.get(slug) || null
    });
    const listed = new Set(artists.map((artist) => slugOf(artist.slug)));
    return {
        data: {
            source: found.source,
            count: artists.length,
            max: MAX_ARTISTS,
            days,
            artists: artists.map((artist) => ({
                slug: artist.slug,
                name: typeof artist.name === 'string' ? artist.name : '',
                destination: typeof artist.destination === 'string' ? artist.destination : '',
                active: artist.active !== false,
                utm_campaign: typeof artist.utm_campaign === 'string' ? artist.utm_campaign : '',
                ...numbers(slugOf(artist.slug))
            })),
            // Links that were pressed in the range but are no longer in the list.
            removed: [...clicks.keys()].filter((slug) => !listed.has(slug)).sort()
                .map((slug) => ({ slug, clicks: clicks.get(slug) || 0, unique_visitors: unique.get(slug) || 0 })),
            totals: { clicks: known ? sum([...clicks.values()]) : null, shown: collected ? sum([...shown.values()]) : null },
            // Automated visits (link previews, crawlers) left out of every number. null with a platform or build filter.
            bots_filtered: found.bots,
            shown_collection: shownInfo
        },
        meta: metaOf(shownInfo)
    };
}

// Clicks per day. Address: slug (optional, one artist).
function clicksDaily(q) {
    const build = (period) => {
        const found = gather(q, period);
        const days = period === 'previous' ? daysOf(found.span.from, found.span.to) : q.range.days;
        const clicks = sumBy(found.clicks, (row) => row.day);
        const unique = sumBy(found.clicks, (row) => row.day, (row) => row.unique);
        return {
            found,
            series: {
                days,
                clicks: days.map((day) => clicks.get(day) || 0),
                unique_visitors: found.source === 'events' ? null : days.map((day) => unique.get(day) || 0)
            }
        };
    };
    const now = build('current');
    const info = collection(q, 'artist_link_click');
    // The game's own reports begin with the build that sends them; the redirect's log has no such start.
    const byEvents = now.found.source === 'events';
    const nullBefore = (series) => {
        if (byEvents) series.clicks = series.clicks.map((value, index) => (info.series_from === null || series.days[index] < info.series_from ? null : value));
        return series;
    };
    nullBefore(now.series);
    const data = {
        source: now.found.source,
        slug: now.found.only,
        ...now.series,
        total: now.series.clicks.every((value) => value === null) ? null : sum(now.series.clicks),
        bots_filtered: now.found.bots,
        not_collected_before: byEvents ? info.first_day : null,
        last_day_is_partial: now.series.days.length > 0 && now.series.days[now.series.days.length - 1] === utcDay(q.now) && q.range.to >= q.now
    };
    if (q.compare) data.previous = nullBefore(build('previous').series);
    return { data, meta: byEvents ? metaOf(info) : { coverage: null, collecting: null } };
}

// Clicks by placement, with the click rate where the game reports showings.
// Address: slug (optional, one artist).
function placements(q) {
    const found = gather(q, 'current');
    const shownInfo = collection(q, 'artist_link_shown');
    const collected = shownInfo.sent;
    const clicks = sumBy(found.clicks, (row) => row.placement);
    const shown = sumBy(found.shown, (row) => row.placement);
    const pressed = sumBy(found.pressed, (row) => row.placement);
    const all = sum([...clicks.values()]);
    const names = new Set([...clicks.keys(), ...(collected ? shown.keys() : [])]);
    const known = found.source === 'redirects' || collection(q, 'artist_link_click').sent;
    const rows = [...names].map((placement) => ({
        placement,
        clicks: known ? clicks.get(placement) || 0 : null,
        share: share(clicks.get(placement) || 0, all),
        shown: collected ? shown.get(placement) || 0 : null,
        reported_clicks: collected ? pressed.get(placement) || 0 : null,
        click_rate: collected ? share(pressed.get(placement) || 0, shown.get(placement) || 0) : null
    })).sort((a, b) => b.clicks - a.clicks || (b.shown || 0) - (a.shown || 0) || a.placement.localeCompare(b.placement));
    return {
        data: { source: found.source, slug: found.only, total: known ? all : null, rows, shown_collection: shownInfo },
        meta: metaOf(shownInfo)
    };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const CHANGES = ['add', 'edit', 'remove', 'active'];

// The page calls this after POST /api/artists/admin succeeded. It notes the
// change in admin_log (kind 'artists.save') and, like every action, clears the
// cached card answers, so the list shows the saved state at once.
// Body: { change: 'add' | 'edit' | 'remove' | 'active', slug }.
function logSave(q, body) {
    const kind = CHANGES.includes(body.change) ? body.change : null;
    const slug = slugOf(body.slug);
    if (!kind) throw Object.assign(new Error(`change must be one of ${CHANGES.join(', ')}`), { code: 'invalid' });
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(slug)) throw Object.assign(new Error('slug is not a short link name'), { code: 'invalid' });
    const artist = artistList(q).find((entry) => slugOf(entry.slug) === slug);
    if (kind === 'remove' ? Boolean(artist) : !artist) {
        throw Object.assign(new Error('The artist list on the server does not show this change. Reload the page.'), { code: 'conflict' });
    }
    q.log('artists.save', {
        change: kind, slug, count: artistList(q).length,
        destination: artist && typeof artist.destination === 'string' ? artist.destination.slice(0, 300) : null,
        active: artist ? artist.active !== false : null
    });
    return { logged: true, count: artistList(q).length };
}

module.exports = {
    cards: {
        'artists.list': list,
        'artists.clicks_daily': clicksDaily,
        'artists.placements': placements
    },
    actions: {
        'artists.log_save': logSave
    }
};
