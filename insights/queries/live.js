// The Live page: what is going on right now, from what the game already sends.
//
// What arrives when (the released game of November 2026, TD-TELEMETRY-528):
// a launch is reported at once; what happens in a room mostly arrives when the
// player quits, or up to half an hour later. So the number of people playing is
// an ESTIMATE (`playing()` below), and everything about rooms is "as reported".
//
// Parameters of every card except the feed: `w` = 1h | 6h | 24h (default 6h),
// `platform` as everywhere. The date range and build filters do not apply.
const { MINUTE, HOUR, DAY, median, percentile, share, sum, countBy, topList, histogram, platformOf } = require('./common');
const hardware = require('./players');
const { designIndex, designFacts } = require('./_community');

const WINDOWS = { '1h': HOUR, '6h': 6 * HOUR, '24h': DAY };
const BINS = 24;
const MODES = ['unpack', 'design', 'creative', 'community'];
const PLATFORMS = ['windows', 'mac', 'deck', 'other'];
const LONGEST = 12 * 60;        // minutes: a session without an end is forgotten after this
const HEARD = 10 * MINUTE;      // "heard from just now"
const SAMPLES_NEEDED = 30;      // finished sessions needed before their lengths are used
const DEFAULT_MEDIAN_MIN = 25;  // until then: half of the sessions last this long
const SETTLED = 3 * HOUR;       // an end that has not arrived by now may come days later
const CURVE_STEP = 10 * MINUTE;
const MEMO_MS = 8 * 1000;
const SETTLED_MEMO_MS = 30 * 1000;   // sessions nobody heard from for an hour are read again this often
const EVENTS_MEMO_MS = 5 * MINUTE;   // events are only added to in between; then all are read again

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const numberOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const word = (value, max = 80) => (typeof value === 'string' && value !== '' ? value.slice(0, max) : null);
const parse = (text) => {
    try {
        const value = JSON.parse(text);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (error) {
        return {};
    }
};

// ---------------------------------------------------------------------------
// One reading of the database for all cards of a page load
// ---------------------------------------------------------------------------

const memo = new Map(); // key -> { at, db, value }
function remembered(q, key, make, keep = MEMO_MS) {
    const hit = memo.get(key);
    if (hit && hit.db === q.db && q.now >= hit.at && q.now - hit.at < keep) return hit.value;
    const value = make();
    if (memo.size > 24) memo.clear();
    memo.set(key, { at: q.now, db: q.db, value });
    return value;
}

const EVENTS = ['room_enter', 'room_ready', 'room_exit', 'room_load_failed', 'room_perf', 'catalog_usage', 'star_earned', 'menu_shown',
    'save_failed', 'save_recovery', 'gallery_open', 'design_upload', 'design_download', 'design_like', 'image_upload'];
const COLUMNS = `s.session_id AS id, s.install_id AS install, s.legacy AS legacy, s.started_at AS started, s.last_seen_at AS seen, s.ended_at AS ended,
    s.end_reason AS reason, s.duration_s AS duration, s.build AS build, s.platform AS platform, s.device AS device, s.country AS country,
    s.launch_count AS launch_count, s.existing_player AS existing_player`;
const DEVICE_COLUMNS = `s.session_id AS id, s.os_version AS os_version, s.cpu_cores AS cpu_cores, s.ram_gb AS ram_gb, s.gpu AS gpu, s.rhi AS rhi, s.screen_w AS screen_w, s.screen_h AS screen_h,
    s.res_scale AS res_scale, s.language AS language, s.quality_preset AS quality_preset, s.upscaler AS upscaler, s.window_mode AS window_mode`;

function sessionOf(row) {
    return { ...row, legacy: Number(row.legacy) === 1, started: Number(row.started), seen: Number(row.seen), ended: row.ended === null ? null : Number(row.ended),
        platform: platformOf(row.platform, row.device), wire: row.platform, who: row.install || row.id };
}

function windowOf(q) {
    const key = Object.prototype.hasOwnProperty.call(WINDOWS, q.params.w) ? q.params.w : '6h';
    const length = WINDOWS[key];
    return { key, length, from: q.now - length, to: q.now + MINUTE, prevFrom: q.now - 2 * length, bin: length / BINS };
}

// The sessions of the last two days, whatever the window: the estimate and the
// curve need them. Platform filter applied. The thousands nobody heard from for
// an hour are read every half minute, the few others on every reading.
function recentSessions(q) {
    return remembered(q, `sessions|${q.platform}`, () => {
        const settled = remembered(q, 'settled', () => ({
            cut: q.now - HOUR,
            rows: q.db.all(`SELECT ${COLUMNS} FROM sessions s WHERE s.last_seen_at >= ? AND s.last_seen_at < ?`, q.now - 2 * DAY, q.now - HOUR).map(sessionOf)
        }), SETTLED_MEMO_MS);
        const all = new Map(settled.rows.map((session) => [session.id, session]));
        for (const row of q.db.all(`SELECT ${COLUMNS} FROM sessions s WHERE s.last_seen_at >= ?`, settled.cut)) all.set(row.id, sessionOf(row));
        return [...all.values()].filter((session) => q.platform === 'all' || session.platform === q.platform).sort((a, b) => a.started - b.started);
    });
}

// The events of the window and of the one before it, with their session's
// platform and country. Events are only ever added, in the order of their id, so
// after the first reading only the new ones are asked for.
function recentEvents(q) {
    const w = windowOf(q);
    return remembered(q, `events|${w.key}|${q.platform}`, () => {
        const read = (after) => q.db.all(
            `SELECT e.id AS id, e.session_id AS session, e.install_id AS install, e.name AS ev, e.t AS t, e.props AS props,
                    s.platform AS platform, s.device AS device
             FROM events e LEFT JOIN sessions s ON s.session_id = e.session_id
             WHERE ${after === null ? '' : 'e.id > ? AND e.id <= ? AND '}${after === null ? 'e.name' : '+e.name'} IN (${EVENTS.map(() => '?').join(', ')})
               AND ${after === null ? 'e.t' : '+e.t'} >= ? AND e.t < ? AND e.legacy = 0`,
            ...(after === null ? [] : [after.from, after.to]), ...EVENTS, w.prevFrom, w.to)
            .map((row) => ({ id: Number(row.id), session: row.session, ev: row.ev, t: Number(row.t), platform: platformOf(row.platform, row.device), props: parse(row.props), who: row.install || row.session }));
        const top = Number((q.db.get('SELECT MAX(id) AS id FROM events') || {}).id) || 0;
        const list = remembered(q, `events|${w.key}`, () => ({ top, rows: read(null).filter((event) => event.id <= top) }), EVENTS_MEMO_MS);
        if (top > list.top) {
            list.rows.push(...read({ from: list.top, to: top }));
            list.top = top;
        }
        list.rows = list.rows.filter((event) => event.t >= w.prevFrom).sort((a, b) => a.t - b.t);
        return list.rows.filter((event) => q.platform === 'all' || event.platform === q.platform);
    });
}

// Players (by install) heard from in the window, each with its latest session.
function playersOf(q) {
    const w = windowOf(q);
    const latest = new Map();
    for (const session of recentSessions(q)) {
        if (session.seen >= w.from && session.started < w.to) latest.set(session.who, session);
    }
    return [...latest.values()];
}

// ---------------------------------------------------------------------------
// How many people are playing: an estimate
// ---------------------------------------------------------------------------
//
// Nobody tells the server "I am still here" often enough, so it is worked out
// from launches and from how long sessions last:
//
// S(x) is the share of finished sessions longer than x. A session that began
// x ago, was last heard of at age a and has sent no end is still running with
//
//     S(x) / ( S(x) + lost * (S(a) - S(x)) )
//
// `lost` is the share of ends that never arrive (or arrive much later):
// had the session ended in between, we would usually have been told. A session
// heard from in the last ten minutes counts whole; an old build reports no ends
// (lost = 1); a session is over when its player started another one.

function survival(q) {
    return remembered(q, 'survival', () => {
        const rows = q.db.all(
            `SELECT duration_s AS d FROM sessions WHERE legacy = 0 AND end_reason = 'clean' AND duration_s IS NOT NULL AND duration_s >= 0
             AND started_at >= ? ORDER BY started_at DESC LIMIT 6000`, q.now - 21 * DAY).map((row) => Number(row.d) / 60).sort((a, b) => a - b);
        const measured = rows.length >= SAMPLES_NEEDED;
        const table = new Float64Array(LONGEST + 2);
        let index = 0;
        for (let minute = 0; minute <= LONGEST; minute++) {
            while (index < rows.length && rows[index] <= minute) index++;
            // Half a session more than counted, so the tail never reaches zero at once.
            table[minute] = measured ? (rows.length - index + 0.5) / (rows.length + 1) : Math.pow(0.5, minute / DEFAULT_MEDIAN_MIN);
        }
        table[0] = 1;
        const settled = q.db.get(
            `SELECT COUNT(*) AS n, SUM(CASE WHEN end_reason IS NOT NULL THEN 1 ELSE 0 END) AS told FROM sessions
             WHERE legacy = 0 AND started_at >= ? AND started_at < ?`, q.now - 2 * DAY, q.now - SETTLED);
        const told = Number(settled.n) >= SAMPLES_NEEDED ? Number(settled.told) / Number(settled.n) : 0.7;
        return { table, measured, samples: rows.length, median_min: measured ? median(rows) : DEFAULT_MEDIAN_MIN, lost: Math.min(1, Math.max(0.02, 1 - told)) };
    });
}
function longerThan(model, ms) {
    const minutes = Math.max(0, ms / MINUTE);
    if (minutes >= LONGEST) return 0;
    const low = Math.floor(minutes);
    return model.table[low] + (model.table[low + 1] - model.table[low]) * (minutes - low);
}

// Chance that `session` was running at `at`, with what is known now.
function aliveAt(session, at, now, model) {
    if (at < session.started) return 0;
    if (session.next !== undefined && at >= session.next) return 0;
    const end = endOf(session);
    if (end !== null) return at < end ? 1 : 0;
    if (at <= session.seen) return 1;
    if (now - session.seen <= HEARD) return 1;
    const lost = session.legacy ? 1 : model.lost;
    const heard = longerThan(model, session.seen - session.started);
    const present = longerThan(model, now - session.started);
    const then = longerThan(model, at - session.started);
    const whole = present + lost * (heard - present);
    return whole > 0 ? Math.min(1, (present + lost * (then - present)) / whole) : 0;
}
function endOf(session) {
    if (session.ended !== null) return session.ended;
    if (session.reason === 'abnormal') return Math.max(session.seen, session.started + number(session.duration) * 1000);
    return null;
}

function playing(q) {
    return remembered(q, `playing|${q.platform}`, () => {
        const model = survival(q);
        const sessions = recentSessions(q).map((session) => ({ ...session }));
        const last = new Map();
        for (const session of sessions) {
            if (!session.install) continue;
            const before = last.get(session.install);
            if (before && session.started > before.started) before.next = session.started;
            last.set(session.install, session);
        }
        for (const session of sessions) session.alive = aliveAt(session, q.now, q.now, model);
        return { model, sessions, now: sessions.filter((session) => session.alive > 0.01) };
    });
}

function nowCard(q) {
    const state = playing(q);
    const value = sum(state.now.map((session) => session.alive));
    const spread = Math.sqrt(sum(state.now.map((session) => session.alive * (1 - session.alive))) + (0.12 * value) ** 2) * 1.28;
    const heard = state.sessions.filter((session) => session.alive > 0 && endOf(session) === null && q.now - session.seen <= HEARD).length;

    // The last 24 hours as a curve, by platform.
    const steps = Math.round(DAY / CURVE_STEP);
    const start = q.now - steps * CURVE_STEP;
    const times = [];
    const curve = Object.fromEntries(PLATFORMS.map((platform) => [platform, new Array(steps + 1).fill(0)]));
    for (let i = 0; i <= steps; i++) times.push(start + i * CURVE_STEP);
    for (const session of state.sessions) {
        const end = endOf(session);
        const stop = Math.min(end === null ? session.started + LONGEST * MINUTE : end, session.next === undefined ? Infinity : session.next);
        const from = Math.max(0, Math.ceil((session.started - start) / CURVE_STEP));
        const to = Math.min(steps, Math.floor((stop - start) / CURVE_STEP));
        for (let i = from; i <= to; i++) curve[session.platform][i] += aliveAt(session, times[i], q.now, state.model);
    }
    for (const platform of PLATFORMS) curve[platform] = curve[platform].map((n) => Math.round(n * 10) / 10);
    const totals = times.map((time, i) => sum(PLATFORMS.map((platform) => curve[platform][i])));
    let peak = 0;
    totals.forEach((total, i) => { if (total > totals[peak]) peak = i; });

    const launches = (from, to) => state.sessions.filter((session) => session.started >= from && session.started < to).length;
    const perPlatform = PLATFORMS.map((platform) => ({ platform, value: sum(state.now.filter((session) => session.platform === platform).map((session) => session.alive)) }))
        .filter((entry) => entry.value > 0.05);
    const lastEvent = q.db.get('SELECT MAX(t) AS t FROM events WHERE t <= ?', q.now + MINUTE);
    return {
        estimate: Math.round(value), low: Math.max(heard, Math.round(value - spread)), high: Math.max(heard, Math.round(value + spread)), heard,
        by_platform: perPlatform,
        old_builds: sum(state.now.filter((session) => session.legacy).map((session) => session.alive)),
        curve: { times, ...curve }, peak: { t: times[peak], value: Math.round(totals[peak]) },
        // Before the first session of the update only launches of old builds are known.
        collected_since: q.tracking.since,
        launches: { last_5_min: launches(q.now - 5 * MINUTE, q.now + MINUTE), last_hour: launches(q.now - HOUR, q.now + MINUTE), hour_before: launches(q.now - 2 * HOUR, q.now - HOUR),
            last_15: Array.from({ length: 60 }, (_, i) => launches(q.now - (60 - i) * MINUTE, q.now - (59 - i) * MINUTE + (i === 59 ? MINUTE : 0))) },
        last_event_at: lastEvent && lastEvent.t !== null ? Number(lastEvent.t) : null,
        basis: { measured: state.model.measured, sessions: state.model.samples, median_min: Math.round(state.model.median_min), ends_heard: 1 - state.model.lost }
    };
}

// ---------------------------------------------------------------------------
// Pulse: the numbers of the window
// ---------------------------------------------------------------------------

function pulseCard(q) {
    const w = windowOf(q);
    const sessions = recentSessions(q);
    const events = recentEvents(q);
    const bin = (t) => Math.min(BINS - 1, Math.max(0, Math.floor((t - w.from) / w.bin)));
    const inNow = (t) => t >= w.from && t < w.to;
    const inBefore = (t) => t >= w.prevFrom && t < w.from;
    // A window that was not collected from its start has nothing to compare with.
    const compare = q.tracking.since !== null && q.tracking.since <= w.prevFrom && 2 * w.length <= 2 * DAY;
    const tiles = [];
    const tile = (key, list, valueOf, unit = 'count') => {
        const series = new Array(BINS).fill(0);
        let value = 0;
        let before = 0;
        for (const entry of list) {
            const n = valueOf(entry);
            if (!n) continue;
            if (inNow(entry.t)) { value += n; series[bin(entry.t)] += n; } else if (inBefore(entry.t)) before += n;
        }
        tiles.push({ key, value, previous: compare ? before : null, series, unit });
    };
    const named = (name) => events.filter((event) => event.ev === name);
    const distinct = (key, list, test = () => true) => {
        const now = new Set();
        const before = new Set();
        const bins = Array.from({ length: BINS }, () => new Set());
        for (const entry of list) {
            if (!test(entry)) continue;
            if (inNow(entry.t)) { now.add(entry.who); bins[bin(entry.t)].add(entry.who); } else if (inBefore(entry.t)) before.add(entry.who);
        }
        tiles.push({ key, value: now.size, previous: compare ? before.size : null, series: bins.map((set) => set.size), unit: 'count' });
    };
    const starts = sessions.map((session) => ({ ...session, t: session.started }));
    const exits = named('room_exit');

    tile('launches', starts, () => 1);
    distinct('players', starts, (session) => !session.legacy);
    // First launch of an install, and no save from before tracking.
    distinct('new_players', starts, (session) => !session.legacy && Number(session.launch_count) === 1 && Number(session.existing_player) !== 1);
    tile('hours', exits, (event) => (numberOrNull(event.props.active_s) ?? number(event.props.duration_s)) / 3600, 'hours');
    tile('rooms', named('room_enter'), () => 1);
    tile('items', exits, (event) => number(event.props.items_placed));
    tile('moves', exits, (event) => number(event.props.items_moved));
    tile('materials', exits, (event) => number(event.props.materials_applied));
    tile('saves', exits, (event) => number(event.props.saves));
    tile('stars', named('star_earned'), () => 1);
    tile('undo', exits, (event) => number(event.props.undo_count) + number(event.props.redo_count));
    const uploads = designIndex(q).list.map((design) => ({ t: Date.parse(design && design.upload_date) })).filter((entry) => Number.isFinite(entry.t));
    tile('uploads', uploads, () => 1);
    return { window: w.key, bin_ms: w.bin, from: w.from, tiles, partial: q.tracking.since !== null && q.tracking.since > w.from };
}

// ---------------------------------------------------------------------------
// What people are playing
// ---------------------------------------------------------------------------

// Where the people playing now were last reported to be.
function placesNow(q) {
    const state = playing(q);
    const ids = state.now.filter((session) => !session.legacy).map((session) => session.id);
    const last = new Map();
    for (let i = 0; i < ids.length; i += 400) {
        const part = ids.slice(i, i + 400);
        const rows = q.db.all(
            `SELECT e.session_id AS session, e.name AS ev, e.t AS t, e.seq AS seq, e.props AS props FROM events e
             WHERE e.session_id IN (${part.map(() => '?').join(', ')}) AND e.name IN ('menu_shown', 'room_enter', 'room_ready', 'room_exit', 'room_load_failed')`, ...part);
        for (const row of rows) {
            const before = last.get(row.session);
            const key = [Number(row.t), Number(row.seq) || 0];
            if (!before || key[0] > before.key[0] || (key[0] === before.key[0] && key[1] > before.key[1])) last.set(row.session, { ...row, key });
        }
    }
    const places = new Map();
    const levels = new Map();
    const add = (key, weight) => places.set(key, (places.get(key) || 0) + weight);
    for (const session of state.now) {
        const event = last.get(session.id);
        const props = event ? parse(event.props) : {};
        if (event && (event.ev === 'room_enter' || event.ev === 'room_ready')) {
            const mode = MODES.includes(props.mode) ? props.mode : 'design';
            add(mode, session.alive);
            const level = word(props.level_id);
            if (level) {
                const key = `${mode}|${level}`;
                levels.set(key, (levels.get(key) || 0) + session.alive);
            }
        } else if (q.now - Math.max(session.started, event ? Number(event.t) : 0) < 4 * MINUTE) {
            add('menu', session.alive);
        } else {
            add('unknown', session.alive);
        }
    }
    return {
        places: [...MODES, 'menu', 'unknown'].map((key) => ({ key, value: places.get(key) || 0 })),
        levels: [...levels.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([key, value]) => ({ mode: key.split('|')[0], level: key.slice(key.indexOf('|') + 1), value }))
    };
}

function playCard(q) {
    const w = windowOf(q);
    const events = recentEvents(q).filter((event) => event.t >= w.from);
    const modes = MODES.map((mode) => ({ mode, rooms: 0, players: new Set(), seconds: 0 }));
    const byMode = new Map(modes.map((entry) => [entry.mode, entry]));
    const levels = new Map();
    const items = new Map();
    const placers = new Map();
    const lengths = [];
    for (const event of events) {
        const mode = byMode.get(event.props.mode);
        const level = word(event.props.level_id);
        if (event.ev === 'room_enter' && mode) {
            mode.rooms++;
            mode.players.add(event.who);
            if (level) {
                const entry = levels.get(level) || { level, rooms: 0, players: new Set(), seconds: 0, items: 0, modes: new Map() };
                entry.rooms++;
                entry.players.add(event.who);
                entry.modes.set(mode.mode, (entry.modes.get(mode.mode) || 0) + 1);
                levels.set(level, entry);
            }
        } else if (event.ev === 'room_exit') {
            const played = numberOrNull(event.props.active_s) ?? number(event.props.duration_s);
            if (mode) mode.seconds += played;
            if (event.props.ready !== false && played > 0) lengths.push(played);
            const entry = level ? levels.get(level) : null;
            if (entry) {
                entry.seconds += played;
                entry.items += number(event.props.items_placed);
            }
        } else if (event.ev === 'catalog_usage' && typeof event.props.items === 'string') {
            for (const part of event.props.items.split(',')) {
                const at = part.lastIndexOf(':');
                const name = part.slice(0, at).trim();
                const count = Number(part.slice(at + 1));
                // A list that was cut off can end in half a name: such a part has no count.
                if (at < 1 || !Number.isFinite(count) || count <= 0) continue;
                items.set(name, (items.get(name) || 0) + count);
                if (!placers.has(name)) placers.set(name, new Set());
                placers.get(name).add(event.who);
            }
        }
    }
    const topItems = [...items.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12)
        .map(([item, count]) => ({ item, count, players: placers.get(item).size }));
    const topLevels = [...levels.values()].sort((a, b) => b.players.size - a.players.size || b.rooms - a.rooms || a.level.localeCompare(b.level)).slice(0, 8)
        .map((entry) => ({ level: entry.level, rooms: entry.rooms, players: entry.players.size, seconds: entry.seconds, items: entry.items,
            mode: [...entry.modes.entries()].sort((a, b) => b[1] - a[1])[0][0] }));
    return {
        window: w.key,
        now: placesNow(q),
        modes: modes.map((entry) => ({ mode: entry.mode, rooms: entry.rooms, players: entry.players.size, seconds: entry.seconds })),
        levels: topLevels, level_count: levels.size,
        items: topItems, item_kinds: items.size, items_total: sum([...items.values()]),
        room_median_s: lengths.length >= 5 ? median(lengths) : null, rooms_left: lengths.length
    };
}

// ---------------------------------------------------------------------------
// Where people are
// ---------------------------------------------------------------------------

function regionCard(q) {
    const w = windowOf(q);
    const players = playersOf(q);
    const state = playing(q);
    const byCountry = new Map();
    const entry = (code) => {
        if (!byCountry.has(code)) byCountry.set(code, { code, players: 0, playing: 0, windows: 0, mac: 0, deck: 0, other: 0 });
        return byCountry.get(code);
    };
    for (const player of players) {
        if (!player.country) continue;
        const row = entry(player.country);
        row.players++;
        row[player.platform]++;
    }
    for (const session of state.now) if (session.country) entry(session.country).playing += session.alive;
    const known = players.filter((player) => player.country).length;
    // No country is older than tracking: without that bound years of old sessions would be walked through.
    const first = q.db.get('SELECT started_at AS t FROM sessions WHERE started_at >= ? AND country IS NOT NULL ORDER BY started_at LIMIT 1', q.tracking.since === null ? q.now : q.tracking.since);
    return {
        window: w.key,
        countries: [...byCountry.values()].sort((a, b) => b.players - a.players || b.playing - a.playing || a.code.localeCompare(b.code)),
        players: players.length, known, known_share: share(known, players.length), playing_known: sum(state.now.filter((session) => session.country).map((session) => session.alive)),
        since: first ? Number(first.t) : null
    };
}

// ---------------------------------------------------------------------------
// Their devices
// ---------------------------------------------------------------------------

const PRESETS = ['Low', 'Medium', 'High', 'Epic', 'Cinematic'];
const UPSCALERS = { dlss: 'DLSS', fsr: 'FSR', xess: 'XeSS', tsr: 'TSR', metalfx: 'MetalFX', none: 'None', off: 'None', native: 'None' };
const DEVICES = { pc: 'Windows PC', proton: 'Linux (Proton)', steam_deck: 'Steam Deck', apple_silicon: 'Mac, Apple chip', intel_mac: 'Mac, Intel' };
const WINDOW_MODES = { fullscreen: 'Fullscreen', borderless: 'Borderless', windowed: 'Window' };

function devicesCard(q) {
    const w = windowOf(q);
    const all = playersOf(q);
    const players = all.filter((player) => !player.legacy).map((player) => ({ ...player }));
    const byId = new Map(players.map((player) => [player.id, player]));
    for (let i = 0; i < players.length; i += 400) {
        const ids = players.slice(i, i + 400).map((player) => player.id);
        for (const row of q.db.all(`SELECT ${DEVICE_COLUMNS} FROM sessions s WHERE s.session_id IN (${ids.map(() => '?').join(', ')})`, ...ids)) Object.assign(byId.get(row.id), row);
    }
    const dim = (labelOf, limit = 6, order = null) => {
        const counts = new Map();
        let unknown = 0;
        for (const player of players) {
            const label = labelOf(player);
            if (label === null || label === undefined || label === '') unknown++;
            else counts.set(label, (counts.get(label) || 0) + 1);
        }
        const rows = topList(counts, limit);
        if (order) rows.sort((a, b) => (a.other ? 1 : b.other ? -1 : order(a.key) - order(b.key)));
        return { rows, unknown };
    };
    const platforms = PLATFORMS.map((platform) => ({ platform, players: all.filter((player) => player.platform === platform).length })).filter((row) => row.players > 0);
    return {
        window: w.key, players: players.length, old_builds: all.length - players.length, platforms,
        dims: {
            device: dim((p) => DEVICES[p.device] || null),
            os: dim((p) => { const os = hardware.osFamily(p.wire, p.os_version, p.device); return os ? os.label : null; }),
            gpu: dim((p) => (word(p.gpu, 200) || p.device === 'steam_deck' ? hardware.gpuFamily(p.gpu, p.device).label : null), 8),
            memory: dim((p) => { const bin = hardware.memoryBin(p.ram_gb); return bin ? `${bin.open === 'below' ? 'under ' : ''}${bin.gb} GB${bin.open === 'above' ? ' or more' : ''}` : null; }),
            screen: dim((p) => { const size = hardware.resolution(p.screen_w, p.screen_h); return size ? `${size.w} × ${size.h}` : null; }),
            quality: dim((p) => { const level = Number(p.quality_preset); return p.quality_preset === null || p.quality_preset === undefined ? null : level < 0 ? 'Custom' : PRESETS[level] || null; },
                6, (key) => (key === 'Custom' ? 9 : PRESETS.indexOf(key))),
            upscaler: dim((p) => (word(p.upscaler) ? UPSCALERS[String(p.upscaler).toLowerCase()] || p.upscaler : null)),
            window_mode: dim((p) => (word(p.window_mode) ? WINDOW_MODES[p.window_mode] || p.window_mode : null)),
            rhi: dim((p) => word(p.rhi)),
            language: dim((p) => word(p.language), 8),
            launches: dim((p) => { const n = Number(p.launch_count); return !Number.isFinite(n) || n < 1 ? null : n === 1 ? (Number(p.existing_player) === 1 ? 'First since the update' : 'First launch ever') : n <= 5 ? '2 to 5 launches' : 'More than 5'; },
                6, (key) => ['First launch ever', 'First since the update', '2 to 5 launches', 'More than 5'].indexOf(key))
        },
        builds: topList(countBy(all, (player) => (player.legacy ? 'Before the update' : player.build || 'unknown')), 5)
    };
}

// ---------------------------------------------------------------------------
// How it runs
// ---------------------------------------------------------------------------

function healthCard(q) {
    const w = windowOf(q);
    const events = recentEvents(q).filter((event) => event.t >= w.from);
    const named = (name) => events.filter((event) => event.ev === name);
    const fps = named('room_perf').map((event) => ({ ...event, value: numberOrNull(event.props.fps_avg) })).filter((event) => event.value !== null && event.value > 0);
    const loads = named('room_ready').map((event) => numberOrNull(event.props.load_s)).filter((value) => value !== null);
    const startups = named('menu_shown').map((event) => numberOrNull(event.props.startup_s)).filter((value) => value !== null);
    const spanNow = { from: w.from, to: w.to };
    const crashFree = require('./stability').crashFree(q, spanNow);
    const issueTitle = require('./stability').issueTitle;

    const crashes = q.db.all(
        `SELECT c.id AS id, c.group_id AS group_id, c.occurred_at AS t, c.platform AS platform, c.build AS build, c.category AS category, c.session_id AS session,
                s.platform AS s_platform, s.device AS s_device, s.country AS country,
                g.title AS title, g.error_message AS error_message, g.status AS status, g.first_seen AS first_seen, g.count AS total
         FROM crashes c LEFT JOIN crash_groups g ON g.id = c.group_id LEFT JOIN sessions s ON s.session_id = c.session_id
         WHERE c.occurred_at >= ? AND c.occurred_at < ? AND c.legacy = 0 ORDER BY c.occurred_at DESC LIMIT 2000`, w.from, w.to)
        .map((row) => ({ ...row, t: Number(row.t), platform: platformOf(row.platform || row.s_platform, row.s_device) }))
        .filter((crash) => q.platform === 'all' || crash.platform === q.platform);
    const issues = new Map();
    for (const crash of crashes) {
        const key = crash.group_id === null ? `r${crash.id}` : crash.group_id;
        const issue = issues.get(key) || {
            id: crash.group_id === null ? null : `SS-${crash.group_id}`, title: crash.group_id === null ? 'Being read' : issueTitle(crash), count: 0, last: crash.t,
            platforms: new Set(), fresh: crash.status === 'new' && Number(crash.first_seen) >= w.from
        };
        issue.count++;
        issue.platforms.add(crash.platform);
        issues.set(key, issue);
    }

    // Failed saves by player: one broken PC can send thousands.
    const failed = new Map();
    for (const event of named('save_failed')) {
        const entry = failed.get(event.who) || { count: 0, session: event.session, platform: event.platform, outcomes: new Map(), level: null, last: 0 };
        entry.count++;
        entry.last = Math.max(entry.last, event.t);
        entry.session = event.session;
        entry.level = word(event.props.level_id) || entry.level;
        const outcome = word(event.props.outcome, 40) || 'unknown';
        entry.outcomes.set(outcome, (entry.outcomes.get(outcome) || 0) + 1);
        failed.set(event.who, entry);
    }
    const saveRows = [...failed.values()].sort((a, b) => b.count - a.count).slice(0, 5).map((entry) => ({
        count: entry.count, session: entry.session, platform: entry.platform, level: entry.level, last: entry.last,
        outcome: [...entry.outcomes.entries()].sort((a, b) => b[1] - a[1])[0][0]
    }));
    const saves = sum(named('room_exit').map((event) => number(event.props.saves)));
    const loadFailed = named('room_load_failed').filter((event) => event.props.canceled !== true);
    const abnormal = recentSessions(q).filter((session) => session.reason === 'abnormal' && session.seen >= w.from).length;
    const ended = recentSessions(q).filter((session) => session.reason !== null && session.seen >= w.from).length;

    const alerts = [];
    const alert = (level, kind, extra) => alerts.push({ level, kind, ...extra });
    const last = q.db.get('SELECT MAX(last_seen_at) AS t FROM sessions WHERE legacy = 0');
    const lastHeard = last && last.t !== null ? Number(last.t) : null;
    if (lastHeard !== null && q.now - lastHeard > 30 * MINUTE) alert('bad', 'silent', { since: lastHeard });
    if (saveRows.length > 0 && saveRows[0].count >= 20) alert('bad', 'save_loop', { count: saveRows[0].count, session: saveRows[0].session, outcome: saveRows[0].outcome, players: [...failed.values()].filter((entry) => entry.count >= 20).length });
    else if (failed.size >= 3) alert('warn', 'save_failed', { players: failed.size });
    const fresh = [...issues.values()].filter((issue) => issue.fresh);
    if (fresh.length > 0) alert('warn', 'new_issue', { count: fresh.length, issue: fresh[0].id, title: fresh[0].title });
    if (crashFree.sessions >= 50 && crashFree.rate !== null && crashFree.rate < 0.95) alert('bad', 'crash_free', { rate: crashFree.rate });
    if (loadFailed.length >= 3) alert('warn', 'load_failed', { count: loadFailed.length, players: new Set(loadFailed.map((event) => event.who)).size });
    if (fps.length >= 20 && share(fps.filter((event) => event.value < 30).length, fps.length) > 0.3) alert('warn', 'slow', { share: share(fps.filter((event) => event.value < 30).length, fps.length) });

    const values = fps.map((event) => event.value);
    return {
        window: w.key, alerts,
        crash_free: crashFree, crashes: crashes.length, abnormal, ended,
        issues: [...issues.values()].sort((a, b) => b.last - a.last).slice(0, 6).map((issue) => ({ ...issue, platforms: [...issue.platforms] })), issue_count: issues.size,
        fps: { rooms: values.length, median: values.length >= 5 ? median(values) : null, low: values.length >= 5 ? percentile(values, 0.1) : null,
            under_30: share(values.filter((value) => value < 30).length, values.length), bins: histogram(values, [0, 20, 30, 45, 60, 90, 120]),
            by_platform: PLATFORMS.map((platform) => { const list = fps.filter((event) => event.platform === platform).map((event) => event.value); return { platform, rooms: list.length, median: list.length >= 5 ? median(list) : null }; }).filter((row) => row.rooms > 0) },
        load: { rooms: loads.length, median: loads.length >= 5 ? median(loads) : null, slow: loads.length >= 5 ? percentile(loads, 0.9) : null, failed: loadFailed.length },
        startup: { launches: startups.length, median: startups.length >= 5 ? median(startups) : null },
        saves: { ok: saves, failed: named('save_failed').length, failed_players: failed.size, rows: saveRows, recoveries: named('save_recovery').length }
    };
}

// ---------------------------------------------------------------------------
// Community
// ---------------------------------------------------------------------------

function communityCard(q) {
    const w = windowOf(q);
    const events = recentEvents(q).filter((event) => event.t >= w.from);
    const index = designIndex(q);
    const dated = index.list.map((design) => ({ design, t: Date.parse(design && design.upload_date) })).filter((entry) => Number.isFinite(entry.t));
    const uploads = dated.filter((entry) => entry.t >= w.from);
    const newest = dated.sort((a, b) => b.t - a.t).slice(0, 8).map((entry) => {
        const facts = designFacts(entry.design);
        return { id: facts.id, title: facts.title, author: facts.author, level: facts.level, thumb: facts.thumb, uploaded_at: facts.uploaded_at, all_time: facts.all_time };
    });
    const ok = (event) => event.props.ok !== false;
    const downloads = events.filter((event) => event.ev === 'design_download' && ok(event));
    const likes = events.filter((event) => event.ev === 'design_like' && event.props.like !== false);
    const opened = events.filter((event) => event.ev === 'gallery_open' && ok(event));
    const clicks = q.file('artist_clicks.json', []);
    const human = (Array.isArray(clicks) ? clicks : []).filter((click) => click && !click.bot && Date.parse(click.timestamp) >= w.from);
    const artists = q.file('artists.json', []);
    const nameOf = new Map((Array.isArray(artists) ? artists : []).filter((artist) => artist && artist.slug).map((artist) => [artist.slug, artist.name || artist.slug]));
    const wanted = topList(countBy(downloads.filter((event) => word(event.props.design_id)), (event) => String(event.props.design_id).toLowerCase().replace(/-/g, '')), 5)
        .filter((row) => !row.other).map((row) => {
            const design = index.byKey.get(row.key);
            const facts = design ? designFacts(design) : null;
            return { id: row.key, downloads: row.count, title: facts ? facts.title : null, author: facts ? facts.author : null, thumb: facts ? facts.thumb : null };
        });
    return {
        window: w.key, total_designs: index.list.length,
        uploads: uploads.length, newest, gallery_visits: opened.length, gallery_players: new Set(opened.map((event) => event.who)).size,
        downloads: downloads.length, likes: likes.length, photos: events.filter((event) => event.ev === 'image_upload' && ok(event)).length,
        wanted, artist_clicks: topList(countBy(human, (click) => nameOf.get(click.slug) || click.slug), 5), artist_total: human.length
    };
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

const FEED_EVENTS = ['session_start', 'room_enter', 'room_exit', 'room_load_failed', 'star_earned', 'gallery_open', 'design_upload', 'design_download', 'design_like',
    'image_upload', 'save_failed', 'save_recovery', 'session_end', 'session_abnormal_end'];
const FEED_PROPS = ['mode', 'level_id', 'duration_s', 'active_s', 'items_placed', 'materials_applied', 'ok', 'like', 'stars_total', 'outcome', 'choice', 'design_id'];
const FEED_FIRST = 60;
const FEED_SCAN = 4000;

// The newest events in the order they arrived, the same thing said again by one
// session folded into one entry. `since` is the cursor of the previous answer.
function feedCard(q) {
    const top = Number((q.db.get('SELECT MAX(id) AS id FROM events') || {}).id) || 0;
    const asked = Number(q.params.since);
    const since = q.params.since !== undefined && Number.isInteger(asked) && asked >= 0 ? asked : null;
    const floor = Math.max(since === null ? 0 : since, top - FEED_SCAN);
    const rows = q.db.all(
        `SELECT e.id AS id, e.t AS t, e.name AS ev, e.session_id AS session, e.props AS props, s.platform AS platform, s.device AS device, s.country AS country, s.launch_count AS launches
         FROM events e LEFT JOIN sessions s ON s.session_id = e.session_id
         WHERE e.id > ? AND e.id <= ? AND e.legacy = 0 AND e.name IN (${FEED_EVENTS.map(() => '?').join(', ')}) ORDER BY e.id DESC LIMIT ${FEED_SCAN}`,
        floor, top, ...FEED_EVENTS);
    const entries = [];
    const folded = new Map();
    for (const row of rows) {
        const platform = platformOf(row.platform, row.device);
        if (q.platform !== 'all' && platform !== q.platform) continue;
        const key = `${row.session}|${row.ev}`;
        const repeats = row.ev === 'save_failed' || row.ev === 'design_like' || row.ev === 'gallery_open';
        if (repeats && folded.has(key)) {
            folded.get(key).count++;
            continue;
        }
        if (entries.length >= FEED_FIRST) continue; // only still counting repeats
        const all = parse(row.props);
        const props = Object.fromEntries(FEED_PROPS.filter((name) => all[name] !== undefined && typeof all[name] !== 'object')
            .map((name) => [name, typeof all[name] === 'string' ? all[name].slice(0, 80) : all[name]]));
        const entry = { id: Number(row.id), t: Number(row.t), name: row.ev, session: row.session, platform, country: row.country || null, first_launch: Number(row.launches) === 1, count: 1, props };
        if (repeats) folded.set(key, entry);
        entries.push(entry);
    }
    const perMinute = Number(q.db.get('SELECT COUNT(*) AS n FROM events WHERE id > ? AND t >= ?', Math.max(0, top - FEED_SCAN), q.now - 10 * MINUTE).n) / 10;
    return { data: { entries, cursor: top, per_minute: perMinute, now: q.now }, cache: false };
}

// Polled every few seconds by every open page: kept out of the 20 second cache
// and remembered here for a moment instead.
const live = (card) => (q) => ({ data: card(q), cache: false });

module.exports = {
    cards: {
        'live.now': live(nowCard),
        'live.pulse': live(pulseCard),
        'live.play': live(playCard),
        'live.region': live(regionCard),
        'live.devices': live(devicesCard),
        'live.health': live(healthCard),
        'live.community': live(communityCard),
        'live.feed': feedCard
    },
    // For scripts/check-insights-live.js.
    survival, longerThan, aliveAt
};
