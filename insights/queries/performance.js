// The Performance pages: Frame rate, Loading, By hardware.
//
// Frame rate comes from `room_perf`, one event per room visit that was
// playable for more than 30 seconds: `fps_avg` is the visit's average frame
// rate, `fps_p1` the rate its slowest 1 % of frames ran at. Startup time is
// `menu_shown.startup_s`, room load time `room_ready.load_s`. None of it
// exists for builds from before the update.
//
// Frame rates are frames per second, times are milliseconds, shares are 0..1.
// `state` next to a value: 'ok', 'low' (fewer than 30 behind it) or 'none'
// (fewer than 5: the value is null).
const { percentile, share, utcDay } = require('./common');
const {
    gpuFamily, LOW_PLAYERS, PLATFORM_ORDER, sampleState, medianOf, shareOf, firstTrackedDay, notCollectedBefore, partialLastDay, chartSpan, previousDays,
    trackedWhere, eventRows, sortedPage, crashReportsWithoutSession
} = require('./players');

const SLOW_FPS = 30;
const FPS_EDGES = [0, 20, 30, 45, 60, 90, 120];
const LEVEL_MODES = ['unpack', 'design']; // rooms with a level of their own; the other modes are shown as one row each

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const label = (value) => {
    const key = String(value === null || value === undefined ? '' : value).trim().toLowerCase();
    return key === '' ? 'unknown' : key;
};
function groupOf(rows, keyOf) {
    const groups = new Map();
    for (const row of rows) {
        const key = keyOf(row);
        if (key === null || key === undefined) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }
    return groups;
}
// The 90th percentile with the same low-sample rule as a median.
const p90Of = (values) => (sampleState(values.length) === 'none' ? null : percentile(values, 0.9));

// ---------------------------------------------------------------------------
// Frame rate
// ---------------------------------------------------------------------------

// Room visits with a frame rate, in a period, the filters applied. `props`
// names what else a card reads of a visit.
const VISIT_PROPS = { mode: 'mode', level: 'level_id', preset: 'quality_preset', upscaler: 'upscaler' };
function visits(q, period, props = [], options = {}) {
    const wanted = { fps: 'fps_avg', p1: 'fps_p1' };
    for (const name of props) wanted[name] = VISIT_PROPS[name];
    return eventRows(q, 'room_perf', period, wanted, options).filter((row) => number(row.fps) !== null && row.fps > 0);
}

// Visits, median frame rate, slowest 1 % and share under 30 fps of some visits.
function frameNumbers(list) {
    const fps = medianOf(list.map((row) => row.fps));
    const slow = list.reduce((count, row) => count + (row.fps < SLOW_FPS ? 1 : 0), 0);
    const under = shareOf(slow, list.length);
    return {
        visits: list.length, median_fps: fps.value, p1_fps: medianOf(list.map((row) => number(row.p1)).filter((value) => value !== null)).value,
        under_30: under.value, under_30_visits: slow, state: fps.state
    };
}

function fpsDistribution(q) {
    const list = visits(q, 'current');
    const bins = FPS_EDGES.map((edge, index) => ({
        from: edge, to: index + 1 < FPS_EDGES.length ? FPS_EDGES[index + 1] : null, count: 0, share: null,
        slow: index + 1 < FPS_EDGES.length && FPS_EDGES[index + 1] <= SLOW_FPS
    }));
    for (const row of list) {
        let index = bins.length - 1;
        while (index > 0 && row.fps < bins[index].from) index--;
        bins[index].count++;
    }
    for (const bin of bins) bin.share = share(bin.count, list.length);
    const numbers = frameNumbers(list);
    const before = q.compare ? frameNumbers(visits(q, 'previous')) : null;
    return {
        data: {
            bins, ...numbers, enough: list.length >= 100,
            collected_since: firstTrackedDay(q),
            previous: before ? { visits: before.visits, median_fps: before.median_fps, under_30: before.under_30 } : null
        },
        meta: { coverage: q.coverage() }
    };
}

// Share of room visits under 30 fps: over the range, and per day.
function under30(q) {
    const days = q.range.days;
    const seriesOf = (list, dayList) => {
        const byDay = groupOf(list, (row) => utcDay(row.t));
        const counts = dayList.map((day) => (byDay.get(day) || []).length);
        const slow = dayList.map((day) => (byDay.get(day) || []).reduce((count, row) => count + (row.fps < SLOW_FPS ? 1 : 0), 0));
        return {
            visits: counts, under: slow,
            // A day with fewer than five visits has no value; `visits` tells how much is behind each day.
            share: dayList.map((day, index) => shareOf(slow[index], counts[index]).value)
        };
    };
    const daily = visits(q, chartSpan(q));
    const now = daily.filter((row) => row.t >= q.range.from);
    const earlier = previousDays(q);
    const wholeDays = visits(q, earlier.span);
    const before = wholeDays.filter((row) => row.t >= q.range.prevFrom);
    const numbers = frameNumbers(now);
    return {
        data: {
            value: numbers.under_30, visits_total: numbers.visits, under_total: numbers.under_30_visits, state: sampleState(numbers.visits),
            previous: frameNumbers(before).under_30, previous_visits: before.length,
            days, ...seriesOf(daily, days),
            not_collected_before: notCollectedBefore(q, days), partial_last_day: partialLastDay(q, days),
            previous_series: q.compare ? { days: earlier.days, ...seriesOf(wholeDays, earlier.days) } : null
        },
        meta: { coverage: q.coverage(), collecting: q.collecting(1) }
    };
}

const FPS_DIMS = {
    quality_preset: { props: ['preset'], keyOf: (row) => label(row.preset), natural: true },
    upscaler: { props: ['upscaler'], keyOf: (row) => label(row.upscaler), natural: false },
    platform: { props: [], options: { platform: true }, keyOf: (row) => row.plat, natural: false },
    mode: { props: ['mode'], keyOf: (row) => label(row.mode), natural: false }
};

// Frame rate split by a setting: dim = quality_preset | upscaler | platform | mode.
function fpsBy(q) {
    const dim = Object.prototype.hasOwnProperty.call(FPS_DIMS, q.params.dim) ? q.params.dim : 'quality_preset';
    const spec = FPS_DIMS[dim];
    const groups = groupOf(visits(q, 'current', spec.props, spec.options), spec.keyOf);
    const before = q.compare ? groupOf(visits(q, 'previous', spec.props, spec.options), spec.keyOf) : null;
    const rows = [...groups.entries()].map(([key, list]) => {
        const row = { key, ...frameNumbers(list) };
        if (before) {
            const old = frameNumbers(before.get(key) || []);
            row.previous = { visits: old.visits, median_fps: old.median_fps, under_30: old.under_30 };
        }
        return row;
    });
    const columns = {
        visits: (row) => row.visits, median: (row) => row.median_fps, p1: (row) => row.p1_fps, under_30: (row) => row.under_30,
        key: (row) => (/^\d+$/.test(row.key) ? Number(row.key) : row.key)
    };
    // Quality presets read low to high; everything else largest first.
    const sortable = spec.natural ? { key: columns.key, ...columns } : columns;
    return { data: { dim, ...sortedPage(q, rows, sortable, spec.natural ? 'asc' : 'desc', false) }, meta: { coverage: q.coverage() } };
}

// A visit's room: its level for Unpacking and Design, the mode for the others.
function roomOf(row) {
    const mode = label(row.mode);
    const level = typeof row.level === 'string' && row.level.trim() !== '' ? row.level.trim() : null;
    if (LEVEL_MODES.includes(mode) && level !== null) return { key: level, kind: 'level', level_id: level, mode: null };
    return { key: `mode:${mode}`, kind: 'mode', level_id: null, mode };
}

// The rooms with the largest share of visits under 30 fps. Levels with at
// least 30 visits come first; `limit` of them are returned (default 5), then
// Creative Mode and community rooms as one row each.
function slowestRooms(q) {
    const limit = [5, 10, 25, 50].includes(Number(q.params.limit)) ? Number(q.params.limit) : 5;
    const groups = groupOf(visits(q, 'current', ['mode', 'level']), (row) => roomOf(row).key);
    const rows = [...groups.values()].map((list) => ({ ...roomOf(list[0]), ...frameNumbers(list) }));
    const order = (a, b) => (a.state === 'ok' ? 0 : 1) - (b.state === 'ok' ? 0 : 1)
        || (b.under_30 === null ? -1 : b.under_30) - (a.under_30 === null ? -1 : a.under_30)
        || (a.median_fps === null ? Infinity : a.median_fps) - (b.median_fps === null ? Infinity : b.median_fps) || a.key.localeCompare(b.key);
    const levels = rows.filter((row) => row.kind === 'level').sort(order);
    return {
        data: { rows: levels.slice(0, limit), modes: rows.filter((row) => row.kind === 'mode').sort(order), levels: levels.length },
        meta: { coverage: q.coverage() }
    };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function timed(rows) {
    const kept = rows.filter((row) => number(row.seconds) !== null && row.seconds >= 0);
    for (const row of kept) row.ms = row.seconds * 1000;
    return kept;
}
const startups = (q, period, options) => timed(eventRows(q, 'menu_shown', period, { seconds: 'startup_s' }, options));
// `rooms`: also read which room each load was for.
const roomLoads = (q, period, options, rooms = false) => timed(eventRows(q, 'room_ready', period,
    rooms ? { mode: 'mode', level: 'level_id', seconds: 'load_s' } : { seconds: 'load_s' }, options));
// Room loads that gave up. A load the player cancelled is not a failure.
const failedLoads = (q, period) => eventRows(q, 'room_load_failed', period, { mode: 'mode', level: 'level_id', canceled: 'canceled' }, { columns: ['build'] })
    .map((row) => ({ ...row, canceled: row.canceled === 1 || row.canceled === true }));

// Share of room loads that failed, of the loads that ended one way or another:
// playable, failed or cancelled. (A game that died while loading is an
// abnormal end, counted on the Stability pages.)
function failedShare(ready, failures) {
    const failed = failures.filter((row) => !row.canceled).length;
    const canceled = failures.length - failed;
    const loads = ready + failures.length;
    const result = shareOf(failed, loads);
    return { value: result.value, failed, canceled, loads, state: result.state };
}

// The five tiles. `previous` is the period before; `builds` gives the same
// number for the newest builds in the range (newest first), for "vs 1.4.0".
function loadingStats(q) {
    const data = (period) => ({
        startup: startups(q, period, { columns: ['build'] }), room: roomLoads(q, period, { columns: ['build'] }), failures: failedLoads(q, period)
    });
    const now = data('current');
    const before = data('previous');
    const seen = new Set([...now.startup, ...now.room].map((row) => row.build));
    const names = q.builds.map((build) => build.name).filter((name) => seen.has(name)).slice(0, 3);
    const timeTile = (pick, measure) => {
        const of = (list) => {
            const values = list.map((row) => row.ms);
            return { value: measure(values), sample: values.length, state: sampleState(values.length) };
        };
        const old = of(pick(before));
        return {
            ...of(pick(now)), previous: old.value, previous_sample: old.sample,
            builds: names.map((name) => ({ build: name, ...of(pick(now).filter((row) => row.build === name)) }))
        };
    };
    const failedOf = (set, name) => failedShare(
        set.room.filter((row) => name === null || row.build === name).length, set.failures.filter((row) => name === null || row.build === name));
    const failedBefore = failedOf(before, null);
    const medianValue = (values) => medianOf(values).value;
    return {
        data: {
            builds: names,
            startup_median_ms: timeTile((set) => set.startup, medianValue),
            startup_p90_ms: timeTile((set) => set.startup, p90Of),
            room_median_ms: timeTile((set) => set.room, medianValue),
            room_p90_ms: timeTile((set) => set.room, p90Of),
            failed_loads: {
                ...failedOf(now, null), previous: failedBefore.value, previous_loads: failedBefore.loads,
                builds: names.map((name) => ({ build: name, ...failedOf(now, name) }))
            }
        },
        meta: { coverage: q.coverage() }
    };
}

// Room load time per day: median and 90th percentile.
function roomLoadDaily(q) {
    const days = q.range.days;
    const seriesOf = (list, dayList) => {
        const byDay = groupOf(list, (row) => utcDay(row.t));
        const values = dayList.map((day) => (byDay.get(day) || []).map((row) => row.ms));
        return {
            loads: values.map((entry) => entry.length),
            // A day with fewer than five loads has no value.
            median_ms: values.map((entry) => medianOf(entry).value), p90_ms: values.map((entry) => p90Of(entry))
        };
    };
    const before = previousDays(q);
    return {
        data: {
            days, ...seriesOf(roomLoads(q, chartSpan(q)), days),
            not_collected_before: notCollectedBefore(q, days), partial_last_day: partialLastDay(q, days),
            previous: q.compare ? { days: before.days, ...seriesOf(roomLoads(q, before.span), before.days) } : null
        },
        meta: { coverage: q.coverage(), collecting: q.collecting(1) }
    };
}

// Startup and room load time per platform.
function loadingByPlatform(q) {
    const numbers = (period) => {
        const startup = groupOf(startups(q, period, { platform: true }), (row) => row.plat);
        const room = groupOf(roomLoads(q, period, { platform: true }), (row) => row.plat);
        const seen = PLATFORM_ORDER.filter((platform) => (q.platform === 'all' ? platform !== 'other' : platform === q.platform) || startup.has(platform) || room.has(platform));
        if (startup.size === 0 && room.size === 0) return [];
        return seen.map((platform) => {
            const starts = (startup.get(platform) || []).map((row) => row.ms);
            const loads = (room.get(platform) || []).map((row) => row.ms);
            return {
                platform,
                startup_median_ms: medianOf(starts).value, startup_p90_ms: p90Of(starts), startups: starts.length, startup_state: sampleState(starts.length),
                room_median_ms: medianOf(loads).value, room_p90_ms: p90Of(loads), room_loads: loads.length, room_state: sampleState(loads.length)
            };
        });
    };
    const rows = numbers('current');
    if (q.compare) {
        const before = new Map(numbers('previous').map((row) => [row.platform, row]));
        for (const row of rows) {
            const old = before.get(row.platform);
            row.previous = old ? { startup_median_ms: old.startup_median_ms, startup_p90_ms: old.startup_p90_ms, room_median_ms: old.room_median_ms, room_p90_ms: old.room_p90_ms } : null;
        }
    }
    const table = sortedPage(q, rows, {
        platform: (row) => PLATFORM_ORDER.indexOf(row.platform), startup: (row) => row.startup_median_ms, startup_p90: (row) => row.startup_p90_ms,
        room: (row) => row.room_median_ms, room_p90: (row) => row.room_p90_ms
    }, 'asc', false);
    return { data: table, meta: { coverage: q.coverage() } };
}

// Load time per room: a row per level (Unpacking and Design), one each for
// Creative Mode and community rooms. With the loads that failed.
function loadingByRoom(q) {
    const groups = groupOf(roomLoads(q, 'current', {}, true), (row) => roomOf(row).key);
    const failures = groupOf(failedLoads(q, 'current'), (row) => roomOf(row).key);
    const rows = [...new Set([...groups.keys(), ...failures.keys()])].map((key) => {
        const list = groups.get(key) || [];
        const failed = failures.get(key) || [];
        const values = list.map((row) => row.ms);
        const outcome = failedShare(list.length, failed);
        return {
            ...roomOf(list.length > 0 ? list[0] : failed[0]), loads: values.length, median_ms: medianOf(values).value, p90_ms: p90Of(values), state: sampleState(values.length),
            failed: outcome.failed, canceled: outcome.canceled, failed_share: outcome.value
        };
    });
    const table = sortedPage(q, rows, {
        // Levels by name, then the mode rows.
        room: (row) => `${row.kind === 'level' ? '0' : '1'}${row.key}`, median: (row) => row.median_ms, p90: (row) => row.p90_ms,
        loads: (row) => row.loads, failed: (row) => row.failed
    }, 'asc', false);
    return { data: table, meta: { coverage: q.coverage() } };
}

// ---------------------------------------------------------------------------
// By hardware
// ---------------------------------------------------------------------------

// One row per graphics card family: players, median frame rate, slowest 1 %
// and crash-free sessions. Tracked sessions only; a crash report that names no
// session (old builds) is left out.
function hardwareNumbers(q, period) {
    const where = trackedWhere(q, 's', period);
    const sessions = q.db.all(
        `SELECT s.install_id AS id, s.gpu AS gpu, s.device AS device,
                EXISTS (SELECT 1 FROM crashes c WHERE c.session_id = s.session_id) AS crashed
         FROM sessions s WHERE ${where.sql}`, ...where.args);
    const names = new Map(); // 'gpu|device' -> family
    const familyOf = (gpu, device) => {
        const key = `${gpu}|${device}`;
        if (!names.has(key)) names.set(key, gpuFamily(gpu, device));
        return names.get(key);
    };
    const families = new Map();
    const entryOf = (family) => {
        if (!families.has(family.key)) families.set(family.key, { ...family, players: new Set(), sessions: 0, crashed: 0, visits: [] });
        return families.get(family.key);
    };
    for (const row of sessions) {
        const entry = entryOf(familyOf(row.gpu, row.device));
        entry.sessions++;
        if (Number(row.crashed) === 1) entry.crashed++;
        if (row.id !== null) entry.players.add(row.id);
    }
    for (const row of visits(q, period, [], { session: ['gpu', 'device'] })) entryOf(familyOf(row.s_gpu, row.s_device)).visits.push(row);
    return [...families.values()].map((entry) => {
        const frames = frameNumbers(entry.visits);
        const crashFree = shareOf(entry.sessions - entry.crashed, entry.sessions);
        return {
            key: entry.key, label: entry.label, vendor: entry.vendor, platform: entry.platform,
            players: entry.players.size, low_players: entry.players.size < LOW_PLAYERS, sessions: entry.sessions,
            median_fps: frames.median_fps, p1_fps: frames.p1_fps, under_30: frames.under_30, fps_visits: frames.visits, fps_state: frames.state,
            crash_free: crashFree.value, crashed_sessions: entry.crashed, crash_free_state: crashFree.state
        };
    });
}

function hardware(q) {
    const rows = hardwareNumbers(q, 'current');
    if (q.compare) {
        const before = new Map(hardwareNumbers(q, 'previous').map((row) => [row.key, row]));
        for (const row of rows) {
            const old = before.get(row.key);
            row.previous = old ? { players: old.players, median_fps: old.median_fps, p1_fps: old.p1_fps, crash_free: old.crash_free } : null;
        }
    }
    const table = sortedPage(q, rows, {
        players: (row) => row.players, median_fps: (row) => row.median_fps, p1: (row) => row.p1_fps, crash_free: (row) => row.crash_free,
        sessions: (row) => row.sessions, hardware: (row) => row.label
    });
    return {
        data: { ...table, players: rows.reduce((total, row) => total + row.players, 0), crash_reports_without_session: crashReportsWithoutSession(q, 'current') },
        meta: { coverage: q.coverage() }
    };
}

module.exports = {
    cards: {
        'performance.fps_distribution': fpsDistribution,
        'performance.under_30': under30,
        'performance.fps_by': fpsBy,
        'performance.slowest_rooms': slowestRooms,
        'performance.loading_stats': loadingStats,
        'performance.room_load_daily': roomLoadDaily,
        'performance.loading_by_platform': loadingByPlatform,
        'performance.loading_by_room': loadingByRoom,
        'performance.hardware': hardware
    }
};
