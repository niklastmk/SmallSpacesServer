// The Players pages: Activity, Retention, Platforms and hardware, Settings and
// languages. Also the hardware names and the small helpers the Performance
// pages share (exported at the bottom).
//
// What a number here means:
// - A player is an install. A player is active on the UTC day one of their
//   sessions started (the Overview counts the same way). Old builds have no
//   installs, so every player count is null ("not collected") before the first
//   tracked day, never zero. Sessions are counted for old builds too.
// - Times are milliseconds, shares are 0..1, days are 'YYYY-MM-DD' (UTC).
// - `state` next to a value says how much is behind it: 'ok', 'low' (fewer
//   than 30) or 'none' (fewer than 5: the value is null).
const { DAY, utcDay, dayStart, daysOf, median, share } = require('./common');

const LOW_SAMPLE = 30;      // a rate or median from fewer sessions is shown muted
const NO_VALUE = 5;         // from fewer than this there is no value
const LOW_PLAYERS = 250;    // a hardware row with fewer players is shown muted
const MILESTONES = [1, 3, 7, 14, 30];
const PLATFORM_ORDER = ['windows', 'mac', 'deck', 'other'];

// The UTC day of a time column as a whole number of days since 1970.
const DAYNUM = (column) => `CAST(${column} / ${DAY} AS INTEGER)`;
const dayNumber = (ms) => Math.floor(ms / DAY);
const dayOf = (number) => utcDay(number * DAY);

const sampleState = (n, low = LOW_SAMPLE, none = NO_VALUE) => (n < none ? 'none' : n < low ? 'low' : 'ok');
// A median with what is behind it; no value from fewer than five.
function medianOf(values) {
    const state = sampleState(values.length);
    return { value: state === 'none' ? null : median(values), sample: values.length, state };
}
// A share with what is behind it; no value from fewer than five.
function shareOf(part, whole) {
    const state = sampleState(whole);
    return { value: state === 'none' ? null : part / whole, sample: whole, state };
}

// ---------------------------------------------------------------------------
// Hardware names (pure functions)
// ---------------------------------------------------------------------------

const text = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

// 'Apple M2 Pro' -> M2. Intel Macs are their own entry.
function appleChip(name, device) {
    if (device === 'intel_mac') return { key: 'intel', label: 'Intel', rank: 100 };
    const match = /\bM(\d{1,2})\b/i.exec(text(name));
    if (match) return { key: `m${match[1]}`, label: `M${match[1]} family`, rank: Number(match[1]) };
    return { key: 'unknown', label: 'Unknown Apple chip', rank: 101 };
}

// A graphics card name as vendor and series: 'NVIDIA GeForce RTX 3060' ->
// 'NVIDIA RTX 30 series'. `platform` is the logo the row gets.
function gpuFamily(gpu, device) {
    const name = text(gpu);
    const lower = name.toLowerCase();
    const family = (key, label, vendor, platform = 'windows') => ({ key, label, vendor, platform });
    if (device === 'steam_deck' || /custom gpu 0(405|932)|vangogh/.test(lower)) return family('deck', 'Steam Deck (AMD)', 'AMD', 'deck');
    if (device === 'intel_mac') return family('intel-mac', 'Intel Mac', 'Apple', 'mac');
    if (device === 'apple_silicon' || lower.startsWith('apple')) {
        const chip = appleChip(name, device);
        return chip.key === 'unknown' ? family('apple-other', 'Apple silicon (other)', 'Apple', 'mac')
            : family(`apple-${chip.key}`, `Apple ${chip.label}`, 'Apple', 'mac');
    }
    if (name === '') return family('unknown', 'Unknown', 'Unknown');
    if (/microsoft basic|llvmpipe|swiftshader|vmware|virtualbox|parallels|virtual/.test(lower)) return family('software', 'Virtual or software', 'Other');
    if (/nvidia|geforce|quadro|\b[rg]tx\b/.test(lower)) {
        const model = /\b(rtx|gtx)\s*(\d{3,4})/.exec(lower);
        if (model) {
            const series = model[2].length === 4 ? model[2].slice(0, 2) : `${model[2][0]}00`;
            return family(`nvidia-${model[1]}-${series}`, `NVIDIA ${model[1].toUpperCase()} ${series} series`, 'NVIDIA');
        }
        if (/quadro|rtx\s*a\d{4}|\bnvs\b/.test(lower)) return family('nvidia-workstation', 'NVIDIA workstation', 'NVIDIA');
        if (/\b(gt|mx)\s*\d{3,4}/.test(lower)) return family('nvidia-gt-mx', 'NVIDIA GT and MX', 'NVIDIA');
        return family('nvidia-other', 'NVIDIA (other)', 'NVIDIA');
    }
    if (/intel/.test(lower)) {
        // 'Arc(TM) A750 Graphics' is a card; 'Arc(TM) Graphics' is built into the processor.
        if (/arc(\(tm\))?\s+(pro\s+)?[ab]\d{3}/.test(lower)) return family('intel-arc', 'Intel Arc', 'Intel');
        return family('intel-integrated', 'Intel integrated', 'Intel');
    }
    if (/amd|radeon|\bati\b/.test(lower)) {
        const model = /\brx\s*(\d{3,4})/.exec(lower);
        if (model) {
            const series = model[1].length === 4 ? `${model[1][0]}000` : `${model[1][0]}00`;
            return family(`amd-rx-${series}`, `AMD Radeon RX ${series}`, 'AMD');
        }
        if (/radeon(\(tm\))?\s+graphics|vega|radeon(\(tm\))?\s+\d{3}m\b|r[357]\s+graphics|radeon hd/.test(lower)) return family('amd-integrated', 'AMD integrated', 'AMD');
        return family('amd-other', 'AMD (other)', 'AMD');
    }
    return family('other', 'Other', 'Other');
}

// The same, with every Apple chip as one entry (the Apple chips card splits them).
function gpuFamilyMerged(gpu, device) {
    const family = gpuFamily(gpu, device);
    return family.key.startsWith('apple-') ? { key: 'apple-silicon', label: 'Apple silicon', vendor: 'Apple', platform: 'mac' } : family;
}

// Memory as the size the machine was sold with. `gb` is the bin, `open` says
// whether the bin has no lower or upper end.
function memoryBin(ramGb) {
    const gb = Number(ramGb);
    if (ramGb === null || ramGb === undefined || !Number.isFinite(gb) || gb <= 0) return null;
    const bin = (size, open = null) => ({ key: open === 'below' ? 'under-8' : open === 'above' ? '64-or-more' : String(size), gb: size, open, rank: size - (open === 'below' ? 1 : 0) });
    if (gb < 7) return bin(8, 'below');
    if (gb < 10) return bin(8);
    if (gb < 14) return bin(12);
    if (gb < 17) return bin(16);
    if (gb < 20) return bin(18);
    if (gb < 28) return bin(24);
    if (gb < 34) return bin(32);
    if (gb < 41) return bin(36);
    if (gb < 57) return bin(48);
    return bin(64, 'above');
}

const MACOS_NAMES = { 11: 'Big Sur', 12: 'Monterey', 13: 'Ventura', 14: 'Sonoma', 15: 'Sequoia', 26: 'Tahoe' };
const WINDOWS_BUILDS = [
    [26200, '11', '25H2'], [26100, '11', '24H2'], [22631, '11', '23H2'], [22621, '11', '22H2'], [22000, '11', '21H2'],
    [19045, '10', '22H2'], [19044, '10', '21H2'], [19043, '10', '21H1'], [19042, '10', '20H2'], [19041, '10', '2004'],
    [18363, '10', '1909'], [18362, '10', '1903'], [17763, '10', '1809'], [10240, '10', null]
];

// The operating system as name and release. The game sends what the engine
// reports: '10.0.26100.1.256.64bit' on Windows, '15.1.0' on a Mac. Under
// Proton that is the Windows version Proton pretends to be, so the Steam Deck
// and other Linux machines are named by their device instead.
function osFamily(platform, osVersion, device) {
    const version = text(osVersion);
    const lower = String(platform || '').toLowerCase();
    if (device === 'steam_deck') return { key: 'steamos', label: 'SteamOS (Steam Deck)', platform: 'deck' };
    if (device === 'proton' || lower.startsWith('linux')) return { key: 'linux-proton', label: 'Linux (Proton)', platform: 'windows' };
    if (lower.startsWith('mac')) {
        const match = /(\d+)(?:\.\d+)*/.exec(version);
        if (!match) return { key: 'macos', label: 'macOS', platform: 'mac' };
        const major = Number(match[1]);
        return { key: `macos-${major}`, label: MACOS_NAMES[major] ? `macOS ${major} ${MACOS_NAMES[major]}` : `macOS ${major}`, platform: 'mac' };
    }
    if (lower.startsWith('win')) {
        const named = /windows\s*(\d+)(?:\D+(\d{2}H\d|\d{4}))?/i.exec(version);
        if (named) {
            const release = named[2] ? ` ${named[2].toUpperCase()}` : '';
            return { key: `windows-${named[1]}${release.trim() ? `-${release.trim().toLowerCase()}` : ''}`, label: `Windows ${named[1]}${release}`, platform: 'windows' };
        }
        const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
        if (parts) {
            const [major, minor, build] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
            if (major === 10) {
                const known = WINDOWS_BUILDS.find((entry) => build >= entry[0]);
                if (known) {
                    // A build between two known releases is named by its Windows only.
                    const exact = WINDOWS_BUILDS.some((entry) => entry[0] === build) && known[2];
                    return exact ? { key: `windows-${known[1]}-${known[2].toLowerCase()}`, label: `Windows ${known[1]} ${known[2]}`, platform: 'windows' }
                        : { key: `windows-${known[1]}`, label: `Windows ${known[1]}`, platform: 'windows' };
                }
            }
            if (major === 6 && minor === 1) return { key: 'windows-7', label: 'Windows 7', platform: 'windows' };
            if (major === 6) return { key: 'windows-8', label: 'Windows 8', platform: 'windows' };
        }
        return { key: 'windows', label: 'Windows', platform: 'windows' };
    }
    return null;
}

// The Steam Deck model from the name of its processor or graphics chip.
function deckModel(cpu, gpu) {
    const name = `${text(cpu)} ${text(gpu)}`;
    if (/\b0405\b/.test(name)) return { key: 'lcd', label: 'Steam Deck LCD', rank: 1 };
    if (/\b0932\b/.test(name)) return { key: 'oled', label: 'Steam Deck OLED', rank: 0 };
    return { key: 'unknown', label: 'Steam Deck (model unknown)', rank: 2 };
}

function resolution(width, height, scale = 100) {
    const w = Math.round(Number(width) * Number(scale) / 100);
    const h = Math.round(Number(height) * Number(scale) / 100);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return { key: `${w}x${h}`, w, h };
}

const DEVICES = {
    pc: ['Windows PC', 'windows', 0], proton: ['Linux (Proton)', 'windows', 1], steam_deck: ['Steam Deck', 'deck', 2],
    apple_silicon: ['Mac with Apple chip', 'mac', 3], intel_mac: ['Intel Mac', 'mac', 4]
};

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const firstTrackedDay = (q) => (q.tracking.since === null ? null : utcDay(q.tracking.since));
const spanOf = (q, period) => (period === 'previous' ? { from: q.range.prevFrom, to: q.range.prevTo }
    : period === 'current' ? { from: q.range.from, to: q.range.to } : period);
// Whether a span has any tracked time in it at all.
const tracked = (q, span) => q.tracking.since !== null && span.to > q.tracking.since;
// The first day a daily series has data, when that is inside the chart.
const notCollectedBefore = (q, days) => {
    const first = firstTrackedDay(q);
    if (first === null) return days.length > 0 ? utcDay(q.now + DAY) : null;
    return days.length > 0 && first > days[0] ? first : null;
};
const partialLastDay = (q, days) => days.length > 0 && days[days.length - 1] === utcDay(q.now);
// The span a daily series reads: the range from the start of its first day,
// so that day is whole ("today" begins in the middle of yesterday).
const chartSpan = (q) => ({ from: dayStart(q.range.from), to: q.range.to });
// The previous period for a daily series: from the start of its first day, so
// that day is whole, and the same number of days as the range.
const previousDays = (q) => ({
    span: { from: dayStart(q.range.prevFrom), to: q.range.prevTo },
    days: daysOf(q.range.prevFrom, q.range.prevTo).slice(0, q.range.days.length)
});

// The WHERE for tracked sessions of a period: q.sessionWhere, limited to the
// new protocol. The range is cut at the first tracked moment, so the index is
// not read through months of old-build sessions.
function trackedWhere(q, alias, period) {
    const span = spanOf(q, period);
    const since = q.tracking.since === null ? span.to : q.tracking.since;
    const where = q.sessionWhere(alias, { from: Math.max(span.from, since), to: span.to });
    return { sql: `${where.sql} AND ${alias ? `${alias}.` : ''}legacy = 0`, args: where.args };
}

// The WHERE of events `e` of some names in a period, the platform and build
// filters applied as q.events() applies them. The platform filter reads the
// session `s`, so the query must join it then (see eventRows).
function eventFilter(q, names, period) {
    const list = Array.isArray(names) ? names : [names];
    const span = spanOf(q, period);
    const parts = [`e.name IN (${list.map(() => '?').join(', ')})`, 'e.t >= ? AND e.t < ?', 'e.legacy = 0'];
    const args = [...list, span.from, span.to];
    if (q.platform !== 'all') {
        parts.push(`${q.platformSql('s')} = ?`);
        args.push(q.platform);
    }
    if (q.build !== 'all') {
        parts.push('e.build = ?');
        args.push(q.build);
    }
    return { sql: parts.join(' AND '), args };
}

// Events with chosen properties as columns: [{ t, <column>... }]. Reading
// only what a card needs keeps a month of room visits fast.
//   props:           { column: 'property name' } (a column must not be an SQL word)
//   options.columns: event columns to add, of session_id, install_id, build, name
//   options.platform: add `plat`, the dashboard's platform
//   options.session: session columns to add, as s_<column>
function eventRows(q, names, period, props = {}, options = {}) {
    const where = eventFilter(q, names, period);
    const safe = (name) => /^[a-z_0-9]+$/.test(name);
    const sessionColumns = (options.session || []).filter(safe);
    const join = q.platform !== 'all' || options.platform === true || sessionColumns.length > 0;
    const select = ['e.t AS t',
        ...(options.columns || []).filter((column) => ['session_id', 'install_id', 'build', 'name'].includes(column)).map((column) => `e.${column} AS ${column}`),
        ...Object.entries(props).filter(([column, name]) => safe(column) && safe(name)).map(([column, name]) => `json_extract(e.props, '$.${name}') AS ${column}`),
        ...(options.platform === true ? ['e.platform AS e_platform', 's.platform AS s_platform', 's.device AS s_device'] : []),
        ...sessionColumns.map((column) => `s.${column} AS s_${column}`)];
    const rows = q.db.all(
        `SELECT ${select.join(', ')} FROM events e ${join ? 'LEFT JOIN sessions s ON s.session_id = e.session_id' : ''}
         WHERE ${where.sql}`, ...where.args);
    for (const row of rows) {
        row.t = Number(row.t);
        if (options.platform === true) row.plat = q.platformOf(row.s_platform || row.e_platform, row.s_device);
    }
    return rows;
}

// Sorting and paging of rows that were computed here, from the address.
// sortable: { name: (row) => value }, the first is the default. Rows without a
// value sort last in both directions.
function sortedPage(q, rows, sortable, defaultDir = 'desc', paged = true) {
    const paging = q.paging(Object.fromEntries(Object.keys(sortable).map((name) => [name, name])), defaultDir);
    const valueOf = sortable[paging.sort];
    const sign = paging.dir === 'asc' ? 1 : -1;
    const sorted = rows.map((row, index) => ({ row, index, value: valueOf(row) })).sort((a, b) => {
        const [left, right] = [a.value, b.value];
        const leftMissing = left === null || left === undefined;
        const rightMissing = right === null || right === undefined;
        if (leftMissing || rightMissing) return leftMissing === rightMissing ? a.index - b.index : leftMissing ? 1 : -1;
        const order = typeof left === 'string' || typeof right === 'string' ? String(left).localeCompare(String(right)) : left - right;
        return order !== 0 ? order * sign : a.index - b.index;
    }).map((entry) => entry.row);
    return {
        rows: paged ? sorted.slice(paging.offset, paging.offset + paging.per) : sorted,
        total: sorted.length, sort: paging.sort, dir: paging.dir, page: paged ? paging.page : 1, per: paged ? paging.per : sorted.length
    };
}

// Tracked sessions of a span with a crash report, per group. A report that
// names no session (most reports of old builds) cannot be given to a platform
// or a graphics card and is left out; `crashReportsWithoutSession` counts them.
function crashReportsWithoutSession(q, period) {
    const span = spanOf(q, period);
    const rows = q.db.all(
        `SELECT c.platform AS platform, c.build AS build, COUNT(*) AS n FROM crashes c
         WHERE c.occurred_at >= ? AND c.occurred_at < ? AND c.session_id IS NULL GROUP BY c.platform, c.build`, span.from, span.to);
    let count = 0;
    for (const row of rows) {
        // Without a platform the report cannot be matched to a platform filter.
        if (q.platform !== 'all' && q.platformOf(row.platform, null) !== q.platform) continue;
        if (q.build !== 'all' && row.build !== q.build) continue;
        count += Number(row.n);
    }
    return count;
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

// Who was active on which day, for tracked sessions started in the span with
// the platform and build filters applied. byInstall: install -> ascending day
// numbers. perDay: day number -> { players, sessions }.
function activeDays(q, span) {
    const where = trackedWhere(q, 's', span);
    const rows = q.db.all(
        `SELECT s.install_id AS id, ${DAYNUM('s.started_at')} AS d, COUNT(*) AS n FROM sessions s
         WHERE ${where.sql} AND s.install_id IS NOT NULL
         GROUP BY s.install_id, d ORDER BY s.install_id, d`, ...where.args);
    const byInstall = new Map();
    const perDay = new Map();
    for (const row of rows) {
        const day = Number(row.d);
        if (!byInstall.has(row.id)) byInstall.set(row.id, []);
        byInstall.get(row.id).push(day);
        if (!perDay.has(day)) perDay.set(day, { players: 0, sessions: 0 });
        perDay.get(day).players++;
        perDay.get(day).sessions += Number(row.n);
    }
    return { byInstall, perDay };
}

// Players active in the `window` days ending on each of `count` days from `firstDay`.
function rollingPlayers(byInstall, firstDay, count, window) {
    const steps = new Int32Array(count + 1);
    for (const days of byInstall.values()) {
        let counted = -Infinity; // the install is already counted on every day before this one
        for (const day of days) {
            const low = Math.max(day, counted, firstDay) - firstDay;
            const high = Math.min(day + window, firstDay + count) - firstDay;
            if (high > low) {
                steps[low]++;
                steps[high]--;
            }
            counted = Math.max(counted, day + window);
        }
    }
    const values = new Array(count);
    let running = 0;
    for (let index = 0; index < count; index++) {
        running += steps[index];
        values[index] = running;
    }
    return values;
}

// Daily, weekly and monthly players for each day of a run of days, and the
// sessions per day. Days before tracking began are null.
function activeSeries(q, firstDay, count) {
    const to = Math.min(q.now, (firstDay + count) * DAY);
    const { byInstall, perDay } = activeDays(q, { from: (firstDay - 29) * DAY, to });
    const trackedFrom = q.tracking.since === null ? Infinity : dayNumber(q.tracking.since);
    const cut = (values) => values.map((value, index) => (firstDay + index >= trackedFrom ? value : null));
    return {
        daily: cut(rollingPlayers(byInstall, firstDay, count, 1)),
        weekly: cut(rollingPlayers(byInstall, firstDay, count, 7)),
        monthly: cut(rollingPlayers(byInstall, firstDay, count, 30)),
        perDay
    };
}

function playersIn(q, span) {
    if (!tracked(q, span)) return null;
    const where = trackedWhere(q, 's', span);
    return Number(q.db.get(`SELECT COUNT(DISTINCT s.install_id) AS n FROM sessions s WHERE ${where.sql}`, ...where.args).n);
}

// Players per day of a span: Map day number -> { players, sessions }.
function dailyPlayers(q, span) {
    const where = trackedWhere(q, 's', span);
    return new Map(q.db.all(
        `SELECT ${DAYNUM('s.started_at')} AS d, COUNT(DISTINCT s.install_id) AS players, COUNT(*) AS sessions
         FROM sessions s WHERE ${where.sql} GROUP BY d`, ...where.args)
        .map((row) => [Number(row.d), { players: Number(row.players), sessions: Number(row.sessions) }]));
}

// The installs first seen on each day of a span that played that day under
// the filters: Map day number -> { fresh, existing }. `fresh` are new players;
// `existing` had a save from before tracking (new to tracking only).
function firstSeenByDay(q, span) {
    if (!tracked(q, span)) return new Map();
    const filters = q.sessionWhere('s', 'any');
    const day = DAYNUM('i.first_seen');
    return new Map(q.db.all(
        `SELECT ${day} AS d,
                SUM(CASE WHEN COALESCE(i.existing_player, 0) = 0 THEN 1 ELSE 0 END) AS fresh,
                SUM(CASE WHEN i.existing_player = 1 THEN 1 ELSE 0 END) AS existing
         FROM installs i
         WHERE i.first_seen >= ? AND i.first_seen < ?
           AND EXISTS (SELECT 1 FROM sessions s WHERE s.install_id = i.install_id AND s.legacy = 0
                         AND s.started_at >= ${day} * ${DAY} AND s.started_at < (${day} + 1) * ${DAY} AND ${filters.sql})
         GROUP BY d`, span.from, span.to, ...filters.args)
        .map((row) => [Number(row.d), { fresh: Number(row.fresh), existing: Number(row.existing) }]));
}

// New players of a span, and those seen for the first time with an older save.
function newPlayersIn(q, span) {
    if (!tracked(q, span)) return { fresh: null, existing: null };
    let fresh = 0;
    let existing = 0;
    for (const day of firstSeenByDay(q, span).values()) {
        fresh += day.fresh;
        existing += day.existing;
    }
    return { fresh, existing };
}

// How many days of a span were tracked (the unfinished day counts as a part).
function trackedDays(q, span) {
    if (!tracked(q, span)) return 0;
    return (Math.min(span.to, q.now) - Math.max(span.from, dayStart(q.tracking.since))) / DAY;
}

// Lengths of the sessions of a span that have one: every clean end, and an
// abnormal end when the next launch reported how long the session lived.
function sessionLengths(q, period) {
    const where = trackedWhere(q, 's', period);
    return q.db.all(
        `SELECT s.duration_s AS d, s.started_at AS t, ${q.platformSql('s')} AS plat FROM sessions s
         WHERE ${where.sql} AND s.duration_s IS NOT NULL AND s.duration_s >= 0
           AND s.end_reason IN ('clean', 'abnormal')`, ...where.args);
}

// Sessions of a period: all of them, those of tracked builds, and the players behind those.
function sessionCounts(q, period) {
    const where = q.sessionWhere('s', period);
    const row = q.db.get(
        `SELECT COUNT(*) AS sessions, SUM(CASE WHEN s.legacy = 0 THEN 1 ELSE 0 END) AS tracked,
                COUNT(DISTINCT CASE WHEN s.legacy = 0 THEN s.install_id END) AS players
         FROM sessions s WHERE ${where.sql}`, ...where.args);
    const sessions = Number(row.sessions);
    const trackedSessions = Number(row.tracked || 0);
    // The same number q.coverage() gives, without reading the sessions again.
    return { sessions, tracked: trackedSessions, players: Number(row.players), coverage: sessions > 0 ? trackedSessions / sessions : null };
}

// The six tiles of the Activity page. Daily players are the 24 hours ending at
// the end of the range, against the same 24 hours a week earlier. Weekly and
// monthly players are the 7 and 30 days ending on the last day of the range
// (the last point of the Active players chart), against the 7 and 30 days
// before those. The other three are over the range. `trend` is the last 14 days.
function activityStats(q) {
    const end = q.range.to;
    const lastDay = dayNumber(end - 1);
    const firstDay = lastDay - 30; // 31 days: the trend, and the day a month earlier for the comparison
    const series = activeSeries(q, firstDay, 31);
    const trendFirst = lastDay - 13;
    const trendDays = Array.from({ length: 14 }, (unused, index) => dayOf(trendFirst + index));
    const since = q.tracking.since === null ? Infinity : dayNumber(q.tracking.since);
    const trendOf = (valueOf) => trendDays.map((unused, index) => (trendFirst + index >= since ? valueOf(trendFirst + index) : null));

    // A window that reaches back to the first tracked day (which is not a
    // whole day) or before it holds only a part of its players: the value is
    // given and marked, and an earlier window is not compared.
    const windowTile = (values, window) => ({
        value: values[lastDay - firstDay],
        previous: lastDay - 2 * window + 1 > since ? values[lastDay - window - firstDay] : null,
        window_days: window, partial: lastDay >= since && lastDay - window + 1 <= since,
        collecting: q.collecting(window), compared_with: 'previous_window',
        // The trend leaves out the days whose window was not whole yet.
        trend: values.slice(-14).map((value, index) => (trendFirst + index - window + 1 > since ? value : null))
    });
    const weekAgo = { from: end - 8 * DAY, to: end - 7 * DAY };

    const curSpan = spanOf(q, 'current');
    const prevSpan = spanOf(q, 'previous');
    const now = sessionCounts(q, 'current');
    const before = sessionCounts(q, 'previous');
    const newNow = newPlayersIn(q, curSpan);
    const newBefore = newPlayersIn(q, prevSpan);
    const newByDay = firstSeenByDay(q, { from: trendFirst * DAY, to: end });
    const perDayNow = trackedDays(q, curSpan);
    const perDayBefore = trackedDays(q, prevSpan);

    // One read for the range and the trend days.
    const lengthRows = sessionLengths(q, { from: Math.min(curSpan.from, trendFirst * DAY), to: end });
    const lengthsByDay = new Map();
    const lengthsNow = [];
    for (const row of lengthRows) {
        const ms = Number(row.d) * 1000;
        const day = dayNumber(Number(row.t));
        if (Number(row.t) >= curSpan.from) lengthsNow.push(ms);
        if (day >= trendFirst) {
            if (!lengthsByDay.has(day)) lengthsByDay.set(day, []);
            lengthsByDay.get(day).push(ms);
        }
    }
    const medianNow = medianOf(lengthsNow);
    const medianBefore = medianOf(sessionLengths(q, 'previous').map((row) => Number(row.d) * 1000));
    const perPlayerDayCache = new Map();
    const perPlayerDay = (span) => {
        if (!perPlayerDayCache.has(span)) {
            let sessions = 0;
            let playerDays = 0;
            for (const day of dailyPlayers(q, span).values()) {
                sessions += day.sessions;
                playerDays += day.players;
            }
            perPlayerDayCache.set(span, { value: playerDays > 0 ? sessions / playerDays : null, playerDays });
        }
        return perPlayerDayCache.get(span);
    };

    return {
        data: {
            trend_days: trendDays,
            daily: {
                value: playersIn(q, { from: end - DAY, to: end }),
                previous: q.tracking.since !== null && weekAgo.from >= q.tracking.since ? playersIn(q, weekAgo) : null,
                window_days: 1, partial: false, collecting: null, compared_with: 'week_ago', trend: series.daily.slice(-14)
            },
            weekly: windowTile(series.weekly, 7),
            monthly: windowTile(series.monthly, 30),
            new_per_day: {
                value: newNow.fresh !== null && perDayNow > 0 ? newNow.fresh / perDayNow : null,
                previous: newBefore.fresh !== null && perDayBefore > 0 ? newBefore.fresh / perDayBefore : null,
                new_players: newNow.fresh, existing_first_seen: newNow.existing, days: perDayNow,
                compared_with: 'previous_period', trend: trendOf((day) => (newByDay.has(day) ? newByDay.get(day).fresh : 0))
            },
            // Sessions a player starts on a day they play: sessions over player days,
            // the average of what the Sessions per player chart draws.
            sessions_per_player: {
                value: perPlayerDay(curSpan).value, previous: perPlayerDay(prevSpan).value,
                sessions: now.tracked, players: now.players, player_days: perPlayerDay(curSpan).playerDays, compared_with: 'previous_period',
                trend: trendOf((day) => {
                    const row = series.perDay.get(day);
                    return row && row.players > 0 ? row.sessions / row.players : null;
                })
            },
            median_session_ms: {
                value: medianNow.value, previous: medianBefore.value, sample: medianNow.sample, state: medianNow.state,
                based_on: share(medianNow.sample, now.sessions), compared_with: 'previous_period',
                trend: trendOf((day) => medianOf(lengthsByDay.get(day) || []).value)
            }
        },
        meta: { coverage: now.coverage }
    };
}

// Players active in the day, and in the 7 and 30 days ending that day.
function activePlayers(q) {
    const days = q.range.days;
    const pick = (series) => ({ daily: series.daily, weekly: series.weekly, monthly: series.monthly });
    const since = q.tracking.since === null ? null : dayNumber(q.tracking.since);
    let previous = null;
    if (q.compare) {
        const before = previousDays(q);
        previous = { days: before.days, ...pick(activeSeries(q, dayNumber(q.range.prevFrom), before.days.length)) };
    }
    return {
        data: {
            days, ...pick(activeSeries(q, dayNumber(q.range.from), days.length)),
            not_collected_before: notCollectedBefore(q, days),
            // The 7 and 30 day counts only hold a whole window from these days on
            // (the first tracked day is not a whole day and does not count).
            full_from: since === null ? null : { daily: dayOf(since), weekly: dayOf(since + 7), monthly: dayOf(since + 30) },
            partial_last_day: partialLastDay(q, days),
            previous
        },
        meta: { coverage: q.coverage(), collecting: q.collecting(1) }
    };
}

const LENGTH_EDGES_MIN = [0, 5, 15, 30, 60, 120];

function sessionLength(q) {
    const counts = sessionCounts(q, 'current');
    const lengths = sessionLengths(q, 'current').map((row) => Number(row.d) * 1000);
    const bins = LENGTH_EDGES_MIN.map((edge, index) => ({
        from_ms: edge * 60000, to_ms: index + 1 < LENGTH_EDGES_MIN.length ? LENGTH_EDGES_MIN[index + 1] * 60000 : null, count: 0, share: null
    }));
    for (const length of lengths) {
        let index = bins.length - 1;
        while (index > 0 && length < bins[index].from_ms) index--;
        bins[index].count++;
    }
    for (const bin of bins) bin.share = share(bin.count, lengths.length);
    const now = medianOf(lengths);
    const before = q.compare ? medianOf(sessionLengths(q, 'previous').map((row) => Number(row.d) * 1000)) : null;
    return {
        data: {
            bins, median_ms: now.value, state: now.state,
            // What the distribution rests on: sessions with a known length out of all sessions in the range.
            measured: lengths.length, sessions: counts.sessions, tracked_sessions: counts.tracked, based_on: share(lengths.length, counts.sessions),
            enough: lengths.length >= 100,
            previous: before ? { median_ms: before.value, measured: before.sample } : null
        },
        meta: { coverage: counts.coverage }
    };
}

// Players per day as new, returning, and seen for the first time but with a
// save from before tracking (not new players, only new to tracking).
function newAndReturning(q) {
    const days = q.range.days;
    const first = firstTrackedDay(q);
    const seriesOf = (list, span) => {
        const players = dailyPlayers(q, span);
        const firstSeen = firstSeenByDay(q, span);
        const pick = (valueOf) => list.map((day) => {
            if (first === null || day < first) return null;
            const number = dayNumber(Date.parse(`${day}T00:00:00Z`));
            return valueOf(players.get(number) || { players: 0 }, firstSeen.get(number) || { fresh: 0, existing: 0 });
        });
        return {
            new_players: pick((active, seen) => seen.fresh),
            existing_first_seen: pick((active, seen) => seen.existing),
            returning: pick((active, seen) => active.players - seen.fresh - seen.existing)
        };
    };
    const before = previousDays(q);
    return {
        data: {
            days, ...seriesOf(days, chartSpan(q)),
            not_collected_before: notCollectedBefore(q, days), partial_last_day: partialLastDay(q, days),
            previous: q.compare ? { days: before.days, ...seriesOf(before.days, before.span) } : null
        },
        meta: { coverage: q.coverage(), collecting: q.collecting(1) }
    };
}

function sessionsPerPlayer(q) {
    const days = q.range.days;
    const first = firstTrackedDay(q);
    const seriesOf = (list, span) => {
        const rows = dailyPlayers(q, span);
        const rowOf = (day) => rows.get(dayNumber(Date.parse(`${day}T00:00:00Z`)));
        const collected = (day) => first !== null && day >= first;
        return {
            values: list.map((day) => (collected(day) && rowOf(day) && rowOf(day).players > 0 ? rowOf(day).sessions / rowOf(day).players : null)),
            sessions: list.map((day) => (collected(day) ? (rowOf(day) ? rowOf(day).sessions : 0) : null)),
            players: list.map((day) => (collected(day) ? (rowOf(day) ? rowOf(day).players : 0) : null))
        };
    };
    const before = previousDays(q);
    return {
        data: {
            days, ...seriesOf(days, chartSpan(q)),
            not_collected_before: notCollectedBefore(q, days), partial_last_day: partialLastDay(q, days),
            previous: q.compare ? { days: before.days, ...seriesOf(before.days, before.span) } : null
        },
        meta: { coverage: q.coverage(), collecting: q.collecting(1) }
    };
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

// The players first seen in the range with the days they played on, counted
// from their first day. The platform is the one of their first session; the
// build filter is the build they were first seen on. Players who had a save
// from before tracking are kept apart (`existing`).
function cohortPlayers(q) {
    if (q.tracking.since === null) return [];
    const rows = q.db.all(
        `SELECT i.install_id AS id, ${DAYNUM('i.first_seen')} AS d0, COALESCE(i.existing_player, 0) AS existing, i.first_build AS first_build,
                ${DAYNUM('s.started_at')} AS d, ${q.platformSql('s')} AS plat, MIN(s.started_at) AS first_start
         FROM installs i JOIN sessions s ON s.install_id = i.install_id
         WHERE i.first_seen >= ? AND i.first_seen < ? AND s.legacy = 0
         GROUP BY i.install_id, d ORDER BY i.install_id, d`, q.range.from, q.range.to);
    const players = [];
    let current = null;
    for (const row of rows) {
        if (!current || current.id !== row.id) {
            current = { id: row.id, d0: Number(row.d0), existing: Number(row.existing) === 1, first_build: row.first_build, plat: row.plat, days: new Set() };
            players.push(current);
        }
        const offset = Number(row.d) - current.d0;
        if (offset >= 0) current.days.add(offset);
    }
    return players.filter((player) => (q.platform === 'all' || player.plat === q.platform) && (q.build === 'all' || player.first_build === q.build));
}

// A cell of the cohort grid: the share of `players` who played `offset` days
// after their first day. Pending until that day has finished.
function cohortCell(q, players, cohortDay, offset) {
    const due = (cohortDay + offset + 1) * DAY;
    if (q.now < due) return { n: offset, state: 'pending', value: null, returned: null, due: utcDay(due) };
    const returned = players.reduce((count, player) => count + (player.days.has(offset) ? 1 : 0), 0);
    const sample = sampleState(players.length);
    return { n: offset, state: sample === 'none' ? 'none' : 'value', value: sample === 'none' ? null : returned / players.length, returned, due: null, low: sample === 'low' };
}

const mondayOf = (day) => day - ((day + 3) % 7); // 1 Jan 1970 was a Thursday

// When the first week row gets its first value: the week holding the first
// tracked day, plus the week after it.
function weeklyCollecting(q) {
    if (q.tracking.since === null) return { since: null, due: null };
    const due = (mondayOf(dayNumber(q.tracking.since)) + 14) * DAY;
    return q.now >= due ? null : { since: q.tracking.since, due };
}

function retentionStats(q) {
    const players = cohortPlayers(q).filter((player) => !player.existing);
    const today = dayNumber(q.now);
    const firstCohort = players.reduce((first, player) => Math.min(first, player.d0), Infinity);
    const tiles = MILESTONES.map((offset) => {
        const complete = players.filter((player) => player.d0 + offset < today);
        const returned = complete.reduce((count, player) => count + (player.days.has(offset) ? 1 : 0), 0);
        const cohorts = new Set(complete.map((player) => player.d0)).size;
        const result = shareOf(returned, complete.length);
        const firstDue = Number.isFinite(firstCohort) ? (firstCohort + offset + 1) * DAY : null;
        return {
            n: offset, value: cohorts > 0 ? result.value : null, state: cohorts > 0 ? result.state : 'none',
            cohorts, players: complete.length, returned,
            // The day the first cohort of the range had (or will have) this value.
            first_value: firstDue === null ? null : utcDay(firstDue),
            collecting: cohorts === 0 && firstDue !== null ? { since: q.tracking.since, due: firstDue } : null
        };
    });
    return {
        data: { days: tiles, new_players: players.length, weekly_cohorts: weeklyCollecting(q), tracking_since: q.tracking.since },
        meta: { coverage: q.coverage() }
    };
}

// The cohort grid. group=day: a row per first day, cells for day 1, 3, 7, 14
// and 30. group=week: a row per week (Monday to Sunday), cells for the share
// who played again in week 1 to 4 after it.
function retentionCohorts(q) {
    const group = q.params.group === 'week' ? 'week' : 'day';
    const all = cohortPlayers(q);
    const fresh = all.filter((player) => !player.existing);
    const since = q.tracking.since === null ? null : dayNumber(q.tracking.since);
    const first = dayNumber(q.range.from);
    const last = dayNumber(Math.min(q.range.to, q.now) - 1);
    const rows = [];
    if (since !== null && group === 'day') {
        const byDay = new Map();
        for (const player of fresh) {
            if (!byDay.has(player.d0)) byDay.set(player.d0, []);
            byDay.get(player.d0).push(player);
        }
        const existingByDay = new Map();
        for (const player of all) if (player.existing) existingByDay.set(player.d0, (existingByDay.get(player.d0) || 0) + 1);
        for (let day = Math.max(first, since); day <= last; day++) {
            const cohort = byDay.get(day) || [];
            rows.push({
                start: dayOf(day), end: dayOf(day), new_players: cohort.length, existing_players: existingByDay.get(day) || 0, partial: false,
                cells: MILESTONES.map((offset) => cohortCell(q, cohort, day, offset))
            });
        }
    } else if (since !== null) {
        for (let week = mondayOf(Math.max(first, since)); week <= last; week += 7) {
            const inWeek = (player) => player.d0 >= week && player.d0 < week + 7;
            const cohort = fresh.filter(inWeek);
            const sample = sampleState(cohort.length);
            rows.push({
                start: dayOf(week), end: dayOf(week + 6), new_players: cohort.length, existing_players: all.filter((player) => player.existing && inWeek(player)).length,
                // The week began before tracking or before the range, or has not finished: its players are not all there.
                partial: week < since || week < first || (week + 7) * DAY > q.now,
                cells: [1, 2, 3, 4].map((offset) => {
                    const due = (week + 7 * offset + 7) * DAY;
                    if (q.now < due) return { n: offset, state: 'pending', value: null, returned: null, due: utcDay(due) };
                    const returned = cohort.reduce((count, player) => {
                        for (let day = week + 7 * offset; day < week + 7 * offset + 7; day++) if (player.days.has(day - player.d0)) return count + 1;
                        return count;
                    }, 0);
                    return { n: offset, state: sample === 'none' ? 'none' : 'value', value: sample === 'none' ? null : returned / cohort.length, returned, due: null, low: sample === 'low' };
                })
            });
        }
    }
    return {
        data: {
            group, columns: group === 'day' ? MILESTONES : [1, 2, 3, 4], rows,
            // Players from before this day were never collected: they count as seen for the first time on their first tracked session.
            not_collected_before: since !== null && first < since ? dayOf(since) : null,
            new_players: fresh.length, existing_players: all.length - fresh.length
        },
        meta: { coverage: q.coverage(), collecting: group === 'week' ? weeklyCollecting(q) : q.collecting(1) }
    };
}

// Share of new players who played again n days after their first day, for
// n = 1 to 30, per platform. Only cohorts whose day n has finished count.
function retentionCurve(q) {
    const players = cohortPlayers(q).filter((player) => !player.existing);
    const today = dayNumber(q.now);
    const firstCohort = players.reduce((first, player) => Math.min(first, player.d0), Infinity);
    let measured = 0;
    const seriesOf = (list) => {
        const values = [];
        const counts = [];
        for (let offset = 1; offset <= 30; offset++) {
            const complete = list.filter((player) => player.d0 + offset < today);
            const result = shareOf(complete.reduce((count, player) => count + (player.days.has(offset) ? 1 : 0), 0), complete.length);
            values.push(result.value);
            counts.push(complete.length);
            if (complete.length > 0) measured = Math.max(measured, offset);
        }
        return { values, players: counts, new_players: list.length };
    };
    const platforms = PLATFORM_ORDER.filter((platform) => players.some((player) => player.plat === platform));
    const series = platforms.map((platform) => ({ platform, ...seriesOf(players.filter((player) => player.plat === platform)) }));
    const all = seriesOf(players);
    const next = MILESTONES.find((offset) => offset > measured);
    return {
        data: {
            offsets: Array.from({ length: 30 }, (unused, index) => index + 1), series, all,
            last_measured: measured,
            // The next of day 1, 3, 7, 14, 30 that no cohort has reached yet.
            next: next !== undefined && Number.isFinite(firstCohort) ? { n: next, due: utcDay((firstCohort + next + 1) * DAY) } : null
        },
        meta: { coverage: q.coverage(), collecting: q.collecting(1) }
    };
}

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

// Players and sessions per platform and day. Sessions are there for old
// builds too (their Steam Deck sessions count as Windows: old builds do not
// say which device they run on); players only from the first tracked day.
function platformSplit(q) {
    const days = q.range.days;
    const where = q.sessionWhere('s', chartSpan(q));
    const rows = q.db.all(
        `SELECT ${DAYNUM('s.started_at')} AS d, ${q.platformSql('s')} AS plat, COUNT(*) AS sessions, COUNT(DISTINCT s.install_id) AS players
         FROM sessions s WHERE ${where.sql} GROUP BY d, plat`, ...where.args);
    const cells = new Map(rows.map((row) => [`${dayOf(Number(row.d))}|${row.plat}`, row]));
    const first = firstTrackedDay(q);
    const platforms = PLATFORM_ORDER.filter((platform) => (q.platform === 'all' ? platform !== 'other' : platform === q.platform)
        || rows.some((row) => row.plat === platform));
    return {
        data: {
            days,
            series: rows.length === 0 ? [] : platforms.map((platform) => ({
                platform,
                players: days.map((day) => (first !== null && day >= first ? Number((cells.get(`${day}|${platform}`) || {}).players || 0) : null)),
                sessions: days.map((day) => Number((cells.get(`${day}|${platform}`) || {}).sessions || 0))
            })),
            not_collected_before: notCollectedBefore(q, days), partial_last_day: partialLastDay(q, days)
        },
        meta: { coverage: q.coverage(), collecting: q.collecting(1) }
    };
}

// One row per platform for a period: players, sessions, median session,
// crash-free sessions and median frame rate.
function platformNumbers(q, period) {
    const span = spanOf(q, period);
    const where = q.sessionWhere('s', period);
    const base = q.db.all(
        `SELECT ${q.platformSql('s')} AS plat, COUNT(*) AS sessions, SUM(CASE WHEN s.legacy = 0 THEN 1 ELSE 0 END) AS tracked,
                COUNT(DISTINCT s.install_id) AS players,
                SUM(CASE WHEN s.legacy = 0 AND EXISTS (SELECT 1 FROM crashes c WHERE c.session_id = s.session_id) THEN 1 ELSE 0 END) AS crashed
         FROM sessions s WHERE ${where.sql} GROUP BY plat`, ...where.args);
    const lengths = new Map();
    for (const row of sessionLengths(q, period)) {
        if (!lengths.has(row.plat)) lengths.set(row.plat, []);
        lengths.get(row.plat).push(Number(row.d) * 1000);
    }
    const frames = new Map();
    for (const row of eventRows(q, 'room_perf', period, { fps: 'fps_avg' }, { platform: true })) {
        if (typeof row.fps !== 'number') continue;
        if (!frames.has(row.plat)) frames.set(row.plat, []);
        frames.get(row.plat).push(row.fps);
    }
    const hasPlayers = tracked(q, span);
    const byPlatform = new Map(base.map((row) => [row.plat, row]));
    const totalSessions = base.reduce((total, row) => total + Number(row.sessions), 0);
    const totalPlayers = base.reduce((total, row) => total + Number(row.players), 0);
    const platforms = PLATFORM_ORDER.filter((platform) => (q.platform === 'all' ? platform !== 'other' : platform === q.platform) || byPlatform.has(platform));
    const rows = totalSessions === 0 ? [] : platforms.map((platform) => {
        const row = byPlatform.get(platform) || { sessions: 0, tracked: 0, players: 0, crashed: 0 };
        const length = medianOf(lengths.get(platform) || []);
        const fps = medianOf(frames.get(platform) || []);
        const crashFree = shareOf(Number(row.tracked) - Number(row.crashed), Number(row.tracked));
        return {
            platform,
            players: hasPlayers ? Number(row.players) : null, players_share: hasPlayers ? share(Number(row.players), totalPlayers) : null,
            sessions: Number(row.sessions), sessions_share: share(Number(row.sessions), totalSessions), tracked_sessions: Number(row.tracked),
            median_session_ms: length.value, session_sample: length.sample, session_state: length.state,
            crash_free: crashFree.value, crashed_sessions: Number(row.crashed), crash_free_state: crashFree.state,
            median_fps: fps.value, fps_visits: fps.sample, fps_state: fps.state
        };
    });
    const totalTracked = base.reduce((total, row) => total + Number(row.tracked || 0), 0);
    return { rows, totalSessions, totalPlayers: hasPlayers ? totalPlayers : null, coverage: totalSessions > 0 ? totalTracked / totalSessions : null };
}

// The "share of players" card and the By platform table read the same rows.
function platforms(q) {
    const now = platformNumbers(q, 'current');
    if (q.compare) {
        const before = new Map(platformNumbers(q, 'previous').rows.map((row) => [row.platform, row]));
        for (const row of now.rows) {
            const old = before.get(row.platform);
            row.previous = old ? {
                players: old.players, players_share: old.players_share, sessions: old.sessions, sessions_share: old.sessions_share,
                median_session_ms: old.median_session_ms, crash_free: old.crash_free, median_fps: old.median_fps
            } : null;
        }
    }
    const table = sortedPage(q, now.rows, {
        players: (row) => (row.players === null ? row.sessions : row.players), sessions: (row) => row.sessions,
        median_session: (row) => row.median_session_ms, crash_free: (row) => row.crash_free, median_fps: (row) => row.median_fps
    }, 'desc', false);
    return {
        data: {
            ...table, players: now.totalPlayers, sessions: now.totalSessions,
            // Shares are of players where players are counted, of sessions before tracking began.
            share_of: now.totalPlayers === null ? 'sessions' : 'players',
            // Crash-free sessions count tracked sessions only; reports that name no session are left out.
            crash_reports_without_session: crashReportsWithoutSession(q, 'current')
        },
        meta: { coverage: now.coverage }
    };
}

// ---------------------------------------------------------------------------
// Hardware and settings: one value per session, the latest per player
// ---------------------------------------------------------------------------

const preset = (value) => {
    const level = Number(text(String(value === null || value === undefined ? '' : value)));
    return text(String(value === null || value === undefined ? '' : value)) === '' || !Number.isInteger(level) ? null : { key: String(level), rank: level };
};
const plain = (value) => {
    const key = text(String(value === null || value === undefined ? '' : value)).toLowerCase();
    return key === '' ? null : { key };
};

// What each breakdown reads and how it names a session. `only` limits it to
// some sessions (Apple chips: Macs). `limit`: rows shown before "other".
// `order: 'rank'` keeps a natural order (memory sizes) instead of largest first.
const BREAKDOWNS = {
    gpu: {
        columns: ['gpu', 'device'], limit: 12,
        of: (row) => {
            const family = gpuFamilyMerged(row.gpu, row.device);
            return family.key === 'unknown' ? null : family;
        }
    },
    os: { columns: ['platform', 'os_version', 'device'], of: (row) => osFamily(row.platform, row.os_version, row.device), limit: 10 },
    screen: { columns: ['screen_w', 'screen_h'], of: (row) => resolution(row.screen_w, row.screen_h), limit: 7 },
    memory: { columns: ['ram_gb'], of: (row) => memoryBin(row.ram_gb), order: 'rank' },
    apple: { columns: ['cpu', 'gpu', 'device'], only: (row) => row.plat === 'mac', of: (row) => appleChip(row.cpu || row.gpu, row.device), order: 'rank' },
    deck_model: { columns: ['cpu', 'gpu', 'device'], only: (row) => row.device === 'steam_deck', of: (row) => deckModel(row.cpu, row.gpu), order: 'rank' },
    device: {
        columns: ['device'], order: 'rank',
        of: (row) => (DEVICES[row.device] ? { key: row.device, label: DEVICES[row.device][0], platform: DEVICES[row.device][1], rank: DEVICES[row.device][2] } : null)
    },
    language: { columns: ['language'], of: (row) => (text(row.language) === '' ? null : { key: text(row.language).replace(/_/g, '-') }), limit: 10 },
    render_resolution: { columns: ['screen_w', 'screen_h', 'res_scale'], of: (row) => resolution(row.screen_w, row.screen_h, row.res_scale === null ? 100 : row.res_scale), limit: 7 },
    quality_preset: { columns: ['quality_preset'], of: (row) => preset(row.quality_preset), order: 'rank' },
    window_mode: { columns: ['window_mode'], of: (row) => plain(row.window_mode) },
    upscaler: { columns: ['upscaler'], of: (row) => plain(row.upscaler) }
};
const HARDWARE_DIMS = ['gpu', 'os', 'screen', 'memory', 'apple', 'deck_model', 'device'];
const SETTING_DIMS = ['language', 'render_resolution', 'quality_preset', 'window_mode', 'upscaler'];

// Players and sessions per value of one breakdown for a period. A session has
// the value it ended with; a player has the value of their latest session.
function breakdownCounts(q, dim, period) {
    const spec = BREAKDOWNS[dim];
    const where = trackedWhere(q, 's', period);
    const columns = [...new Set(['device', ...spec.columns])].map((column) => `s.${column} AS ${column}`).join(', ');
    const rows = q.db.all(
        `SELECT s.install_id AS id, s.started_at AS t, ${q.platformSql('s')} AS plat, ${columns}
         FROM sessions s WHERE ${where.sql}`, ...where.args);
    const entries = new Map(); // key -> { entry, sessions }
    const latest = new Map();  // install -> { t, key }
    let sessions = 0;
    let unknownSessions = 0;
    for (const row of rows) {
        if (spec.only && !spec.only(row)) continue;
        const entry = spec.of(row);
        if (!entry) {
            unknownSessions++;
            if (row.id !== null && (!latest.has(row.id) || Number(row.t) > latest.get(row.id).t)) latest.set(row.id, { t: Number(row.t), key: null });
            continue;
        }
        sessions++;
        if (!entries.has(entry.key)) entries.set(entry.key, { ...entry, sessions: 0, players: 0 });
        entries.get(entry.key).sessions++;
        if (row.id !== null && (!latest.has(row.id) || Number(row.t) > latest.get(row.id).t)) latest.set(row.id, { t: Number(row.t), key: entry.key });
    }
    let players = 0;
    let unknownPlayers = 0;
    for (const value of latest.values()) {
        if (value.key === null) { unknownPlayers++; continue; }
        players++;
        entries.get(value.key).players++;
    }
    return { entries, players, sessions, unknownPlayers, unknownSessions };
}

function breakdown(q, dim) {
    const spec = BREAKDOWNS[dim];
    const now = breakdownCounts(q, dim, 'current');
    const before = q.compare ? breakdownCounts(q, dim, 'previous') : null;
    const rowOf = (entry) => {
        const { sessions, players, rank, ...rest } = entry;
        const row = {
            ...rest, players, share: share(players, now.players), sessions, sessions_share: share(sessions, now.sessions),
            low: players < LOW_PLAYERS
        };
        if (before) {
            const old = before.entries.get(entry.key);
            row.previous = { players: old ? old.players : 0, share: share(old ? old.players : 0, before.players), sessions_share: share(old ? old.sessions : 0, before.sessions) };
        }
        return row;
    };
    const list = [...now.entries.values()].sort((a, b) => b.players - a.players || b.sessions - a.sessions || String(a.key).localeCompare(String(b.key)));
    // One value past the limit is shown rather than called "other".
    const limit = !spec.limit || list.length <= spec.limit + 1 ? list.length : spec.limit;
    let shown = list.slice(0, limit);
    const rest = list.slice(limit);
    if (spec.order === 'rank') shown = shown.sort((a, b) => (a.rank || 0) - (b.rank || 0));
    const restPlayers = rest.reduce((total, entry) => total + entry.players, 0);
    const restSessions = rest.reduce((total, entry) => total + entry.sessions, 0);
    return {
        data: {
            dim, rows: shown.map(rowOf),
            // Everything past the rows shown, as one line.
            other: rest.length > 0 ? { kinds: rest.length, players: restPlayers, share: share(restPlayers, now.players), sessions: restSessions, sessions_share: share(restSessions, now.sessions) } : null,
            players: now.players, sessions: now.sessions,
            // Sessions and players whose value was not sent; left out of the shares.
            unknown: { players: now.unknownPlayers, sessions: now.unknownSessions }
        },
        meta: { coverage: q.coverage() }
    };
}

const hardware = (q) => breakdown(q, HARDWARE_DIMS.includes(q.params.dim) ? q.params.dim : 'gpu');
const settings = (q) => breakdown(q, SETTING_DIMS.includes(q.params.dim) ? q.params.dim : 'language');

// ---------------------------------------------------------------------------
// Settings players changed
// ---------------------------------------------------------------------------

const SETTING_GROUP = { screen_w: 'resolution', screen_h: 'resolution' };

// Which settings players changed themselves (in the menu or in a room), by how
// many of the players in the range, and the most common change. What a setting
// was before comes from the settings the session showed its menu with.
function settingsChanges(q) {
    const events = eventRows(q, 'setting_change', 'current', { k: 'key', v: 'to', who: 'by' }, { columns: ['session_id', 'install_id'] });
    const bySession = new Map();
    for (const event of events) {
        if (typeof event.k !== 'string') continue;
        if (!bySession.has(event.session_id)) bySession.set(event.session_id, { install: event.install_id, events: [], player: false });
        const session = bySession.get(event.session_id);
        session.events.push(event);
        if (event.who === 'player') session.player = true;
    }
    const wanted = [...bySession.entries()].filter((entry) => entry[1].player).map((entry) => entry[0]);

    // The settings each of those sessions had when its menu appeared. The plus
    // keeps SQLite on the index by session instead of reading every menu event.
    const baseline = new Map();
    for (let index = 0; index < wanted.length; index += 400) {
        const chunk = wanted.slice(index, index + 400);
        const rows = q.db.all(
            `SELECT e.session_id AS id, e.props AS props FROM events e
             WHERE e.session_id IN (${chunk.map(() => '?').join(', ')}) AND +e.name = 'menu_shown' ORDER BY e.t`, ...chunk);
        for (const row of rows) {
            if (baseline.has(row.id)) continue;
            try { baseline.set(row.id, JSON.parse(row.props) || {}); } catch (error) { baseline.set(row.id, {}); }
        }
    }

    const settingsOf = new Map(); // key -> { players: Set, sessions: Set, changes, pairs: Map }
    const record = (key, session, sessionId, from, to) => {
        if (from !== null && from === to) return;
        if (!settingsOf.has(key)) settingsOf.set(key, { players: new Set(), sessions: new Set(), changes: 0, pairs: new Map() });
        const setting = settingsOf.get(key);
        setting.players.add(session.install || sessionId);
        setting.sessions.add(sessionId);
        setting.changes++;
        if (from !== null) {
            const pair = `${from}\u0000${to}`;
            setting.pairs.set(pair, (setting.pairs.get(pair) || 0) + 1);
        }
    };
    const sizeOf = (state) => (state.screen_w !== undefined && state.screen_h !== undefined ? `${state.screen_w}x${state.screen_h}` : null);
    for (const sessionId of wanted) {
        const session = bySession.get(sessionId);
        const state = {};
        for (const [key, value] of Object.entries(baseline.get(sessionId) || {})) state[key] = String(value);
        const ordered = session.events.sort((a, b) => a.t - b.t);
        for (let index = 0; index < ordered.length; index++) {
            const event = ordered[index];
            if (SETTING_GROUP[event.k] === 'resolution') {
                // Width and height change together: one change of the resolution.
                const from = sizeOf(state);
                let byPlayer = false;
                let last = index;
                while (last < ordered.length && SETTING_GROUP[ordered[last].k] === 'resolution' && ordered[last].t - event.t <= 1000) {
                    state[ordered[last].k] = String(ordered[last].v);
                    if (ordered[last].who === 'player') byPlayer = true;
                    last++;
                }
                index = last - 1;
                if (byPlayer && sizeOf(state) !== null) record('resolution', session, sessionId, from, sizeOf(state));
                continue;
            }
            const from = state[event.k] === undefined ? null : state[event.k];
            state[event.k] = String(event.v);
            if (event.who === 'player') record(event.k, session, sessionId, from, String(event.v));
        }
    }

    const active = sessionCounts(q, 'current');
    const rows = [...settingsOf.entries()].map(([key, setting]) => {
        const top = [...setting.pairs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
        return {
            key, players: setting.players.size, share: share(setting.players.size, active.players), sessions: setting.sessions.size, changes: setting.changes,
            top_change: top ? { from: top[0].split('\u0000')[0], to: top[0].split('\u0000')[1], count: top[1] } : null
        };
    });
    const table = sortedPage(q, rows, { changed_by: (row) => row.players, changes: (row) => row.changes, setting: (row) => row.key });
    return { data: { ...table, players: active.players }, meta: { coverage: active.coverage } };
}

module.exports = {
    cards: {
        'players.activity_stats': activityStats,
        'players.active': activePlayers,
        'players.session_length': sessionLength,
        'players.new_returning': newAndReturning,
        'players.sessions_per_player': sessionsPerPlayer,
        'players.retention_stats': retentionStats,
        'players.retention_cohorts': retentionCohorts,
        'players.retention_curve': retentionCurve,
        'players.platform_split': platformSplit,
        'players.platforms': platforms,
        'players.hardware': hardware,
        'players.settings': settings,
        'players.settings_changes': settingsChanges
    },
    // For performance.js (and tests): the hardware names and the shared pieces.
    appleChip, gpuFamily, gpuFamilyMerged, memoryBin, osFamily, deckModel, resolution,
    LOW_SAMPLE, NO_VALUE, LOW_PLAYERS, PLATFORM_ORDER, DAYNUM, dayNumber, dayOf, sampleState, medianOf, shareOf,
    firstTrackedDay, spanOf, tracked, notCollectedBefore, partialLastDay, chartSpan, previousDays, trackedWhere, eventFilter, eventRows, sortedPage, sessionCounts, crashReportsWithoutSession
};
