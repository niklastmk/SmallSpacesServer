// Stability: crash issues, reports, hardware and the health of crash reporting.
//
// A crash issue is a row of `crash_groups` (SS-<id>), a report a row of
// `crashes` (R-<id>). A report counts in a date range by the time the crash
// happened (`occurred_at`); only the Pipeline page counts by the time the
// server received it.
//
// What a report without a session or an install counts as: a session of its
// own and a player of its own (crash reports of old builds usually name
// neither). Every card that counts players also says how many of them are
// known installs.
const fs = require('fs');
const path = require('path');
const { DAY, utcDay, dayStart, compareBuilds, share, topList, histogram } = require('./common');

let crashParse = null;
try { crashParse = require('../crash-parse'); } catch (error) { crashParse = null; }

const NEW_DAYS = 7;
const TREND_DAYS = 14;
const PLATFORMS = ['windows', 'mac', 'deck'];
const STATUSES = ['new', 'open', 'fixed', 'regressed', 'ignored'];
const SETTABLE = ['open', 'fixed', 'fixed_next', 'ignored'];
const BUILD_NAME = /^[A-Za-z0-9._+-]{1,50}$/;
const NOTES_MAX = 10000;
const STACK_REPORTS_MAX = 2000;   // reports read to find the most common trace of an issue
const FRAMES_MAX = 60;
const LAUNCH_EDGES_S = [0, 60, 300, 900, 1800, 3600];
const WAITING_WARN = 100;
const WAITING_WARN_MS = 30 * 60 * 1000;

function refuse(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function parseJson(text, fallback) {
    if (typeof text !== 'string' || text === '') return fallback;
    try {
        const value = JSON.parse(text);
        return value === null || value === undefined ? fallback : value;
    } catch (error) {
        return fallback;
    }
}

const whole = (value) => (value === null || value === undefined ? null : Math.round(Number(value)));
const numberOrNull = (value) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value));

// 'SS-231', 'ss-231', '231' or 231 -> 231. Anything else -> null.
function idOf(value, prefix) {
    const text = String(value === undefined || value === null ? '' : value).trim().replace(new RegExp(`^${prefix}-`, 'i'), '');
    return /^\d{1,12}$/.test(text) ? Number(text) : null;
}
const issueIdOf = (value) => idOf(value, 'SS');
const reportIdOf = (value) => idOf(value, 'R');
const issueKey = (id) => `SS-${id}`;
const reportKey = (id) => `R-${id}`;

// ---------------------------------------------------------------------------
// Hardware names (pure functions)
// ---------------------------------------------------------------------------

const cleanName = (name) => String(name || '').replace(/\((R|TM|C)\)/gi, '').replace(/\s+/g, ' ').trim();

// "NVIDIA GeForce RTX 3060" -> { key: 'nvidia_rtx_30', label: 'NVIDIA RTX 30 series', vendor: 'nvidia' }.
// `platform` is the dashboard platform of the report or session, when known:
// a Mac without an Apple chip is an Intel Mac whatever its graphics chip is.
function gpuFamily(name, platform) {
    const text = cleanName(name);
    const lower = text.toLowerCase();
    const family = (key, label, vendor) => ({ key, label, vendor });
    if (lower === '') return family('unknown', 'Unknown', null);
    if (/custom gpu 0(405|932)|vangogh|van gogh|sephiroth/.test(lower)) return family('steam_deck', 'Steam Deck (AMD)', 'amd');
    let m = /\bapple (m\d+)/.exec(lower);
    if (m) return family(`apple_${m[1]}`, `Apple ${m[1].toUpperCase()} family`, 'apple');
    if (lower.includes('apple')) return family('apple', 'Apple silicon', 'apple');
    if (platform === 'mac') return family('intel_mac', 'Intel Mac', lower.includes('amd') || lower.includes('radeon') ? 'amd' : 'intel');
    m = /\b(rtx|gtx|gt)\s*(\d{3,4})/.exec(lower);
    if (m) {
        const series = m[2].length === 4 ? m[2].slice(0, 2) : `${m[2][0]}00`;
        return family(`nvidia_${m[1]}_${series}`, `NVIDIA ${m[1].toUpperCase()} ${series} series`, 'nvidia');
    }
    if (/nvidia|geforce|quadro|titan/.test(lower)) return family('nvidia_other', 'NVIDIA, other', 'nvidia');
    m = /\brx\s*(\d{3,4})/.exec(lower);
    if (m) {
        const series = m[1].length === 4 ? `${m[1][0]}000` : `${m[1][0]}00`;
        return family(`amd_rx_${series}`, `AMD Radeon RX ${series}`, 'amd');
    }
    if (/radeon|\bamd\b/.test(lower)) {
        return /graphics|vega/.test(lower) ? family('amd_integrated', 'AMD integrated', 'amd') : family('amd_other', 'AMD, other', 'amd');
    }
    if (/\barc\b/.test(lower)) return family('intel_arc', 'Intel Arc', 'intel');
    if (/intel|uhd|iris/.test(lower)) return family('intel_integrated', 'Intel integrated', 'intel');
    return family('other', 'Other', null);
}

// "NVIDIA GeForce GTX 1650" -> "GTX 1650", "Intel(R) UHD Graphics 630" -> "Intel UHD 630".
function gpuShort(name) {
    const text = cleanName(name);
    if (text === '') return null;
    if (/custom gpu 0(405|932)|vangogh|sephiroth/i.test(text)) return 'Steam Deck';
    return text.replace(/^NVIDIA\s+(GeForce\s+)?/i, '').replace(/^AMD\s+(?=Radeon RX)/i, '').replace(/\s+Graphics\b/i, '').trim() || text;
}

const MACOS_NAMES = { 11: 'Big Sur', 12: 'Monterey', 13: 'Ventura', 14: 'Sonoma', 15: 'Sequoia', 26: 'Tahoe' };

// "Windows 11 (24H2)" -> 'Windows 11 24H2'; "15.1" or "macOS 15.1 (24B83)" -> 'macOS 15 Sequoia'.
function osFamily(text, platform) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    const family = (key, label) => ({ key, label });
    if (value === '') return family('unknown', 'Unknown');
    const lower = value.toLowerCase();
    if (lower.includes('proton') || lower.includes('steamos')) {
        return platform === 'deck' || lower.includes('steamos') ? family('steamos', 'SteamOS (Proton)') : family('linux_proton', 'Linux (Proton)');
    }
    if (lower.startsWith('windows')) {
        const major = /windows\s+(server\s+)?(\d+)/.exec(lower);
        const release = /\b(\d{2}h\d)\b/.exec(lower);
        const label = `Windows${major ? ` ${major[1] ? 'Server ' : ''}${major[2]}` : ''}${release ? ` ${release[1].toUpperCase()}` : ''}`;
        return family(label.toLowerCase().replace(/\s+/g, '_'), label);
    }
    if (platform === 'mac' || /^(mac ?os|os x|darwin)/.test(lower) || /^\d+(\.\d+)*$/.test(lower)) {
        const version = /(\d+)(?:\.(\d+))?/.exec(lower);
        if (!version) return family('macos', 'macOS');
        const major = Number(version[1]);
        if (major === 10) return family(`macos_10_${version[2] || 0}`, `macOS 10.${version[2] || 0}`);
        return family(`macos_${major}`, `macOS ${major}${MACOS_NAMES[major] ? ` ${MACOS_NAMES[major]}` : ''}`);
    }
    if (/linux|ubuntu|debian|fedora|arch/.test(lower)) return family('linux', 'Linux');
    return family(lower.slice(0, 40), value.slice(0, 40));
}

const MEMORY_STEPS = [4, 8, 12, 16, 18, 24, 32, 36, 48, 64];

// 15.9 -> { key: '16', label: '16 GB', gb: 16 }. The top step is open-ended.
function memoryBucket(gb) {
    const value = Number(gb);
    if (!(value > 0)) return { key: 'unknown', label: 'Unknown', gb: null };
    let step = MEMORY_STEPS[0];
    for (const candidate of MEMORY_STEPS) {
        if (Math.abs(candidate - value) < Math.abs(step - value)) step = candidate;
    }
    if (step === 64 || value > 64) return { key: '64', label: '64 GB or more', gb: 64 };
    if (step === 4) return { key: '4', label: '4 GB or less', gb: 4 };
    return { key: String(step), label: `${step} GB`, gb: step };
}

// The dashboard platform of a report that has no session row. The platform the
// game sent decides; a report that came without one is placed by the operating
// system its own crash context names. The Steam Deck is known from the session
// only (as for sessions of old builds), never from the graphics chip.
function reportPlatform(platform, os, gpu) {
    const sent = String(platform || '').toLowerCase();
    if (sent.startsWith('mac')) return 'mac';
    if (sent.startsWith('win')) return 'windows';
    if (sent.startsWith('linux')) return 'deck';
    const system = String(os || '').toLowerCase().trim();
    if (system.startsWith('windows')) return 'windows';
    if (/^(mac ?os|os x|darwin)/.test(system) || /^\d+(\.\d+)*$/.test(system) || /^apple\b/i.test(String(gpu || '').trim())) return 'mac';
    return 'other';
}

// ---------------------------------------------------------------------------
// Stack traces (pure functions)
// ---------------------------------------------------------------------------

// One line of a call stack, in any of the three forms the reports hold:
//   Module!Function(args) [File.cpp:123]      (Windows, with symbols)
//   Module 0x00007ff6a2e50000 + 2f3b0d4       (Windows, without symbols)
//   image+12345 (symbol)                      (macOS)
// A frame is a game frame when it starts with `SmallSpaces!` or names a
// SmallSpaces module.
function parseFrame(line) {
    const raw = String(line || '').trim();
    const frame = { raw, module: null, fn: null, file: null, line: null, offset: null, game: false };
    let m = /^([^\s!]+)!(.*?)(?:\s*\[([^\]]*)\])?$/.exec(raw);
    if (m) {
        frame.module = m[1];
        frame.fn = m[2].replace(/\s*\+\s*(0x)?[0-9a-fA-F]+(\s*bytes)?$/, '').trim() || null;
        const where = (m[3] || '').trim();
        const fileLine = /^(.*):(\d+)$/.exec(where);
        if (fileLine && !/^0x[0-9a-f]+$/i.test(where)) {
            frame.file = fileLine[1].split(/[\\/]/).pop();
            frame.line = Number(fileLine[2]);
        }
    } else if ((m = /^(\S+)\s+(0x[0-9a-fA-F]+)\s*\+\s*([0-9a-fA-F]+)$/.exec(raw))) {
        frame.module = m[1];
        frame.offset = m[3];
    } else if ((m = /^(.+?)\+(0x[0-9a-fA-F]+|\d+)(?:\s+\((.*)\))?$/.exec(raw))) {
        frame.module = m[1].trim();
        frame.offset = m[2];
        frame.fn = m[3] ? m[3].trim() || null : null;
    } else {
        frame.fn = raw || null;
    }
    frame.game = /^SmallSpaces!/.test(raw) || (frame.module !== null && /SmallSpaces/i.test(frame.module));
    return frame;
}

function parseStack(callstack) {
    return String(callstack || '').split('\n').map((line) => line.trim()).filter((line) => line !== '').map(parseFrame);
}

// What a frame is called in a list: the function without its arguments, or
// module+offset when there is no symbol.
function frameLabel(frame) {
    if (!frame) return null;
    if (frame.fn) return frame.fn.replace(/\(.*\)\s*$/, '').trim() || frame.fn;
    if (frame.module) return frame.offset ? `${frame.module}+${frame.offset}` : frame.module;
    return frame.raw || null;
}

// Two reports have the same trace when their frames match without addresses.
function stackSignature(frames) {
    return frames.map((frame) => `${frame.module || ''}!${frame.fn || frame.offset || ''}`).join('\n');
}

// A readable title from the first report's message. Unreal puts the file and
// line first and the actual sentence on the next line.
function issueTitle(group) {
    const lines = String(group.error_message || '').split('\n').map((line) => line.trim()).filter((line) => line !== '');
    if (lines.length === 0) return String(group.title || 'Unknown crash').slice(0, 160);
    let where = '';
    const first = lines[0].replace(/\s*\[File:[^\]]*?([^\\/\]]+)\]\s*\[Line:\s*(\d+)\]\s*/, (all, file, line) => {
        where = `${file}:${line}`;
        return ' ';
    }).trim();
    const bare = first.replace(/[:\s]+$/, '');
    const text = (/^(fatal error|assertion failed|ensure condition failed)?$/i.test(bare) && lines.length > 1) ? lines[1] : bare;
    return `${text}${where ? ` (${where})` : ''}`.slice(0, 160);
}

// ---------------------------------------------------------------------------
// Activity at the crash (pure functions)
// ---------------------------------------------------------------------------

// 'loading:design:tokyo-03' -> { key: 'loading', kind: 'loading', mode: 'design', level: 'tokyo-03' }.
// Breakdown keys: startup, menu_loading, menu, loading, room:<mode>, load_failed, unknown.
function activityOf(stage) {
    const text = String(stage || '').trim();
    if (text === '') return { key: 'unknown', kind: 'unknown', mode: null, level: null, stage: null };
    const [kind, mode, ...rest] = text.split(':');
    const level = rest.length > 0 ? rest.join(':') : null;
    if (kind === 'loading') return { key: 'loading', kind, mode: mode || null, level, stage: text };
    if (kind === 'room') return { key: mode ? `room:${mode}` : 'room', kind, mode: mode || null, level, stage: text };
    return { key: kind, kind, mode: null, level: null, stage: text };
}

// ---------------------------------------------------------------------------
// Reading reports and sessions
// ---------------------------------------------------------------------------

const spanOf = (q, period) => (period === 'previous' ? { from: q.range.prevFrom, to: q.range.prevTo } : { from: q.range.from, to: q.range.to });

// The reports of a time span with the request's platform and build filters,
// each with its session's facts. options: { platform, build } override the
// request's filters ('all' for none), { group } one issue, { by: 'received' }
// the time column, { context: true } also the stored crash context.
function loadReports(q, span, options = {}) {
    const column = options.by === 'received' ? 'c.received_at' : 'c.occurred_at';
    const parts = [];
    const args = [];
    if (span) {
        parts.push(`${column} >= ? AND ${column} < ?`);
        args.push(span.from, span.to);
    }
    const build = options.build === undefined ? q.build : options.build;
    if (build !== 'all') {
        parts.push('c.build = ?');
        args.push(build);
    }
    if (options.group !== undefined) {
        parts.push('c.group_id = ?');
        args.push(options.group);
    }
    const rows = q.db.all(
        `SELECT c.id, c.group_id, c.legacy, c.crash_guid, c.install_id, c.session_id, c.build, c.platform, c.received_at,
                c.occurred_at, c.file, c.file_size, c.parsed, c.category, c.gpu, c.os, c.ram_gb, c.seconds_since_start
                ${options.context ? ', c.context' : ''},
                s.session_id AS s_id, s.install_id AS s_install, s.platform AS s_platform, s.device AS s_device,
                s.gpu AS s_gpu, s.os_version AS s_os, s.ram_gb AS s_ram, s.last_stage AS s_stage, s.legacy AS s_legacy
         FROM crashes c LEFT JOIN sessions s ON s.session_id = c.session_id
         WHERE ${parts.length > 0 ? parts.join(' AND ') : '1 = 1'}`, ...args);
    const platform = options.platform === undefined ? q.platform : options.platform;
    const reports = [];
    for (const row of rows) {
        const gpu = row.gpu || row.s_gpu || null;
        const os = row.os || row.s_os || null;
        const plat = row.s_id ? q.platformOf(row.s_platform, row.s_device) : reportPlatform(row.platform, os, gpu);
        if (platform !== 'all' && plat !== platform) continue;
        const install = row.install_id || row.s_install || null;
        const occurred = Number(row.occurred_at);
        reports.push({
            id: Number(row.id),
            group: row.group_id === null ? null : Number(row.group_id),
            legacy: Number(row.legacy) === 1,
            guid: row.crash_guid,
            install,
            session: row.session_id || null,
            session_seen: Boolean(row.s_id),
            session_tracked: Boolean(row.s_id) && Number(row.s_legacy) === 0,
            // One player and one session per report that names neither.
            player: install || row.session_id || row.crash_guid,
            session_key: row.session_id || row.crash_guid,
            build: row.build || null,
            plat,
            received_at: Number(row.received_at),
            occurred_at: occurred,
            day: utcDay(occurred),
            file: row.file || null,
            file_size: numberOrNull(row.file_size),
            parsed: Number(row.parsed),
            category: row.category || null,
            gpu,
            os,
            ram_gb: numberOrNull(row.ram_gb) || numberOrNull(row.s_ram),
            seconds: numberOrNull(row.seconds_since_start),
            stage: row.s_stage || null,
            context: options.context ? row.context : undefined
        });
    }
    return reports;
}

// WHERE for sessions of a span with the build filter and, unless
// `platform` is 'all', the platform filter.
function sessionsWhere(q, span, platform = q.platform) {
    const parts = ['s.started_at >= ? AND s.started_at < ?'];
    const args = [span.from, span.to];
    if (platform !== 'all') {
        parts.push(`${q.platformSql('s')} = ?`);
        args.push(platform);
    }
    if (q.build !== 'all') {
        parts.push('s.build = ?');
        args.push(q.build);
    }
    return { sql: parts.join(' AND '), args };
}

// Sessions of a span per platform, with the build filter: Map plat -> n.
function sessionsByPlatform(q, span) {
    const where = sessionsWhere(q, span, 'all');
    const counts = new Map();
    for (const row of q.db.all(`SELECT ${q.platformSql('s')} AS plat, COUNT(*) AS n FROM sessions s WHERE ${where.sql} GROUP BY plat`, ...where.args)) {
        counts.set(row.plat, Number(row.n));
    }
    return counts;
}

const sumOf = (map) => [...map.values()].reduce((total, value) => total + value, 0);
const rateOf = (sessions, crashed) => (sessions > 0 ? Math.min(1, Math.max(0, 1 - crashed / sessions)) : null);

// Crash-free sessions of a span for every platform and for all of them:
// { all, windows, mac, deck } of { sessions, crashed, rate }.
//   sessions: sessions started in the span (old builds included).
//   crashed:  sessions that a crash report of the span belongs to. A report
//             that names no session counts as one session of its own.
//   rate:     1 - crashed / sessions, null without sessions.
// The build filter applies; `reports` may be passed when already loaded
// (all platforms, the span, the build filter).
function crashFreeByPlatform(q, span, reports = null) {
    const sessions = sessionsByPlatform(q, span);
    const crashed = new Map();
    for (const report of reports || loadReports(q, span, { platform: 'all' })) {
        if (!crashed.has(report.plat)) crashed.set(report.plat, new Set());
        crashed.get(report.plat).add(report.session_key);
    }
    const answer = {};
    const all = { sessions: sumOf(sessions), crashed: [...crashed.values()].reduce((total, set) => total + set.size, 0) };
    answer.all = { ...all, rate: rateOf(all.sessions, all.crashed) };
    for (const platform of [...PLATFORMS, 'other']) {
        const n = sessions.get(platform) || 0;
        const c = crashed.has(platform) ? crashed.get(platform).size : 0;
        answer[platform] = { sessions: n, crashed: c, rate: rateOf(n, c) };
    }
    return answer;
}

// Crash-free sessions of a span with the request's platform and build
// filters: { sessions, crashed, rate }. The Overview page uses this, so both
// pages show the same number.
function crashFree(q, span) {
    const by = crashFreeByPlatform(q, span);
    return by[q.platform === 'all' ? 'all' : q.platform] || { sessions: 0, crashed: 0, rate: null };
}

// ---------------------------------------------------------------------------
// Issue status
// ---------------------------------------------------------------------------

// What the status pill shows: New only for seven days and until somebody
// opened the issue, then Open.
function shownStatus(group, now) {
    if (group.status === 'new') {
        return Number(group.first_seen) >= now - NEW_DAYS * DAY && !group.opened_at ? 'new' : 'open';
    }
    return STATUSES.includes(group.status) ? group.status : 'open';
}

// "Fixed in the next build": once a build marker newer than the status change
// exists, that build is the fixed build. It is stored here, when somebody
// reads, so the worker can mark a regression from then on; a report from a
// build after it that arrived in between is caught here.
function resolveFixedNext(q) {
    const waiting = q.db.all(`SELECT id, status_at FROM crash_groups WHERE status = 'fixed' AND fixed_next = 1 AND fixed_build IS NULL`);
    if (waiting.length === 0) return 0;
    const markers = q.builds.filter((build) => build.marker).sort((a, b) => a.released_at - b.released_at || compareBuilds(a.name, b.name));
    let resolved = 0;
    for (const group of waiting) {
        const since = Number(group.status_at) || 0;
        const next = markers.find((build) => build.released_at > since);
        if (!next) continue;
        q.db.run(`UPDATE crash_groups SET fixed_build = ?, fixed_next = 0 WHERE id = ? AND status = 'fixed' AND fixed_next = 1 AND fixed_build IS NULL`,
            next.name, group.id);
        const later = q.db.all('SELECT build, MIN(received_at) AS at FROM crashes WHERE group_id = ? AND received_at > ? AND build IS NOT NULL GROUP BY build',
            group.id, since).filter((row) => compareBuilds(row.build, next.name) > 0);
        if (later.length > 0) {
            q.db.run(`UPDATE crash_groups SET status = 'regressed', status_at = ? WHERE id = ? AND status = 'fixed'`,
                Math.min(...later.map((row) => Number(row.at))), group.id);
        }
        resolved++;
    }
    return resolved;
}

const GROUP_COLUMNS = `id, title, category, crash_type, error_message, count, first_seen, last_seen, builds, status, status_at,
    fixed_build, fixed_next, opened_at`;

function statusFields(group, now) {
    return {
        status: shownStatus(group, now),
        status_at: whole(group.status_at),
        fixed_build: group.fixed_build || null,
        fixed_next: Number(group.fixed_next) === 1 && !group.fixed_build
    };
}

function sortedBuilds(json) {
    const list = parseJson(json, []);
    return (Array.isArray(list) ? list : []).filter((name) => typeof name === 'string' && name !== '').sort(compareBuilds);
}

// The frames of the newest report of an issue that has a call stack.
function latestStack(q, groupId) {
    const row = q.db.get('SELECT id, context FROM crashes WHERE group_id = ? AND has_context = 1 ORDER BY occurred_at DESC LIMIT 1', groupId);
    if (!row) return { report: null, frames: [] };
    return { report: Number(row.id), frames: parseStack(parseJson(row.context, {}).callstack) };
}

// ---------------------------------------------------------------------------
// The issue list (also the order for previous and next on the issue page)
// ---------------------------------------------------------------------------

const ISSUE_SORTS = { players: 1, reports: 1, rate: 1, trend: 1, last_seen: 1, first_seen: 1 };

function tally(reports) {
    const players = new Set();
    const installs = new Set();
    let withoutInstall = 0;
    for (const report of reports) {
        players.add(report.player);
        if (report.install) installs.add(report.install); else withoutInstall++;
    }
    return { reports: reports.length, players: players.size, players_known: installs.size, reports_without_install: withoutInstall };
}

// Every issue with a report in the range under the shared filters, with its
// numbers, filtered by the table's own filters and sorted. Not paged.
function issueList(q) {
    resolveFixedNext(q);
    const days = q.range.days;
    const dayIndex = new Map(days.map((day, index) => [day, index]));
    const byGroup = new Map();
    for (const report of loadReports(q, spanOf(q, 'current'))) {
        if (report.group === null) continue;
        if (!byGroup.has(report.group)) byGroup.set(report.group, []);
        byGroup.get(report.group).push(report);
    }
    const before = new Map();
    if (q.compare) {
        for (const report of loadReports(q, spanOf(q, 'previous'))) {
            if (report.group === null) continue;
            if (!before.has(report.group)) before.set(report.group, []);
            before.get(report.group).push(report);
        }
    }
    const sessionsWhereNow = sessionsWhere(q, spanOf(q, 'current'));
    const sessions = Number(q.db.get(`SELECT COUNT(*) AS n FROM sessions s WHERE ${sessionsWhereNow.sql}`, ...sessionsWhereNow.args).n);
    let sessionsBefore = null;
    if (q.compare) {
        const where = sessionsWhere(q, spanOf(q, 'previous'));
        sessionsBefore = Number(q.db.get(`SELECT COUNT(*) AS n FROM sessions s WHERE ${where.sql}`, ...where.args).n);
    }

    const half = Math.floor(days.length / 2);
    const stacks = new Map();
    const stackOf = (id) => {
        if (!stacks.has(id)) stacks.set(id, latestStack(q, id));
        return stacks.get(id);
    };
    const all = [];
    for (const group of q.db.all(`SELECT ${GROUP_COLUMNS} FROM crash_groups`)) {
        const reports = byGroup.get(Number(group.id));
        if (!reports) continue;
        const trend = days.map(() => 0);
        const platforms = new Set();
        let lastSeen = 0;
        for (const report of reports) {
            const index = dayIndex.get(report.day);
            if (index !== undefined) trend[index]++;
            platforms.add(report.plat);
            if (report.occurred_at > lastSeen) lastSeen = report.occurred_at;
        }
        const builds = sortedBuilds(group.builds);
        const earlier = before.get(Number(group.id));
        const previous = q.compare ? tally(earlier || []) : null;
        all.push({
            id: Number(group.id),
            key: issueKey(group.id),
            ...statusFields(group, q.now),
            title: issueTitle(group),
            raw_title: group.title || '',
            error_message: group.error_message || '',
            category: group.category || 'Unknown',
            ...tally(reports),
            rate: sessions > 0 ? (reports.length / sessions) * 1000 : null,
            platforms: [...PLATFORMS, 'other'].filter((platform) => platforms.has(platform)),
            first_build: builds.length > 0 ? builds[0] : null,
            last_build: builds.length > 0 ? builds[builds.length - 1] : null,
            first_seen: whole(group.first_seen),
            last_seen: whole(lastSeen),
            trend,
            trend_change: trend.slice(half).reduce((a, b) => a + b, 0) - trend.slice(0, half).reduce((a, b) => a + b, 0),
            previous: previous ? {
                reports: previous.reports, players: previous.players,
                rate: sessionsBefore > 0 ? (previous.reports / sessionsBefore) * 1000 : null
            } : null
        });
    }

    // The table's own filters: category, search, then status.
    const categories = topList(all.reduce((counts, issue) => counts.set(issue.category, (counts.get(issue.category) || 0) + 1), new Map()), 100)
        .map((entry) => ({ key: entry.key, count: entry.count }));
    const category = typeof q.params.category === 'string' ? q.params.category.trim().toLowerCase() : '';
    const search = typeof q.params.q === 'string' ? q.params.q.trim().toLowerCase() : '';
    let rows = all;
    if (category !== '' && category !== 'all') rows = rows.filter((issue) => issue.category.toLowerCase() === category);
    if (search !== '') {
        rows = rows.filter((issue) => issue.key.toLowerCase() === search
            || issue.title.toLowerCase().includes(search)
            || issue.error_message.toLowerCase().includes(search)
            || stackOf(issue.id).frames.some((frame) => frame.raw.toLowerCase().includes(search)));
    }
    const counts = { all: rows.length, new: 0, open: 0, regressed: 0, fixed: 0, ignored: 0 };
    for (const issue of rows) counts[issue.status]++;
    const status = STATUSES.includes(q.params.status) ? q.params.status : 'all';
    if (status !== 'all') rows = rows.filter((issue) => issue.status === status);

    const paging = q.paging(ISSUE_SORTS);
    const valueOf = { players: 'players', reports: 'reports', rate: 'rate', trend: 'trend_change', last_seen: 'last_seen', first_seen: 'first_seen' }[paging.sort];
    const direction = paging.dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => direction * ((a[valueOf] || 0) - (b[valueOf] || 0))
        || b.players - a.players || b.reports - a.reports || b.id - a.id);
    return { rows, in_range: all.length, counts, categories, status, sessions, days, paging, stackOf };
}

function issueRow(issue, stack) {
    const top = stack.frames[0] || null;
    const game = stack.frames.find((frame) => frame.game) || null;
    const { error_message: unused, trend_change: alsoUnused, ...row } = issue;
    return { ...row, top_frame: frameLabel(top), top_game_frame: frameLabel(game) };
}

function issuesCard(q) {
    const list = issueList(q);
    const { paging } = list;
    const page = list.rows.slice(paging.offset, paging.offset + paging.per);
    return {
        data: {
            days: list.days,
            sessions: list.sessions,
            in_range: list.in_range,
            counts: list.counts,
            categories: list.categories,
            status: list.status,
            paging: { sort: paging.sort, dir: paging.dir, page: paging.page, per: paging.per, total: list.rows.length },
            rows: page.map((issue) => issueRow(issue, list.stackOf(issue.id)))
        }
    };
}

// ---------------------------------------------------------------------------
// One issue
// ---------------------------------------------------------------------------

function groupOf(q, value) {
    const id = issueIdOf(value);
    if (id === null) throw refuse('invalid', 'An issue ID such as SS-12 is needed.');
    const group = q.db.get('SELECT * FROM crash_groups WHERE id = ?', id);
    if (!group) throw refuse('not_found', `There is no issue ${issueKey(id)}.`);
    return group;
}
const issueParam = (q) => (q.params.id !== undefined ? q.params.id : q.params.issue);

function issueCard(q) {
    resolveFixedNext(q);
    const group = groupOf(q, issueParam(q));
    const id = Number(group.id);
    const span = spanOf(q, 'current');
    const everything = loadReports(q, span);
    const reports = everything.filter((report) => report.group === id);
    const where = sessionsWhere(q, span);
    const sessions = Number(q.db.get(`SELECT COUNT(*) AS n FROM sessions s WHERE ${where.sql}`, ...where.args).n);
    const first = q.db.get('SELECT build, occurred_at FROM crashes WHERE group_id = ? ORDER BY occurred_at ASC LIMIT 1', id);
    const last = q.db.get('SELECT build, occurred_at FROM crashes WHERE group_id = ? ORDER BY occurred_at DESC LIMIT 1', id);
    const platforms = new Set(reports.map((report) => report.plat));

    let previous = null;
    if (q.compare) {
        const earlier = spanOf(q, 'previous');
        const before = loadReports(q, earlier, { group: id });
        const earlierWhere = sessionsWhere(q, earlier);
        const earlierSessions = Number(q.db.get(`SELECT COUNT(*) AS n FROM sessions s WHERE ${earlierWhere.sql}`, ...earlierWhere.args).n);
        const numbers = tally(before);
        previous = { reports: numbers.reports, players: numbers.players, rate: earlierSessions > 0 ? (numbers.reports / earlierSessions) * 1000 : null };
    }

    // Where the issue stands in the list the reader came from.
    const list = issueList(q).rows;
    const at = list.findIndex((issue) => issue.id === id);
    const stack = latestStack(q, id);
    return {
        data: {
            id,
            key: issueKey(id),
            ...statusFields(group, q.now),
            stored_status: group.status,
            opened_at: whole(group.opened_at),
            title: issueTitle(group),
            raw_title: group.title || '',
            error_message: group.error_message || '',
            category: group.category || 'Unknown',
            crash_type: group.crash_type || null,
            top_frame: frameLabel(stack.frames[0] || null),
            top_game_frame: frameLabel(stack.frames.find((frame) => frame.game) || null),
            notes: group.notes || '',
            notes_at: whole(group.notes_at),
            ...tally(reports),
            sessions,
            rate: sessions > 0 ? (reports.length / sessions) * 1000 : null,
            share_of_crashes: share(reports.length, everything.length),
            reports_all_time: Number(group.count),
            platforms: [...PLATFORMS, 'other'].filter((platform) => platforms.has(platform)),
            builds: sortedBuilds(group.builds),
            first_seen: { at: whole(first ? first.occurred_at : group.first_seen), build: first ? first.build || null : null },
            last_seen: { at: whole(last ? last.occurred_at : group.last_seen), build: last ? last.build || null : null },
            // The builds "Fixed in build" offers, newest first.
            fix_builds: q.builds.map((build) => ({ name: build.name, released_at: build.released_at, marker: build.marker })),
            previous,
            position: {
                index: at >= 0 ? at + 1 : null,
                total: list.length,
                previous: at > 0 ? list[at - 1].key : null,
                next: at >= 0 && at + 1 < list.length ? list[at + 1].key : null
            }
        }
    };
}

// Reports of one issue per day, stacked by build, oldest build first. With
// more than three builds in the range the two newest keep their own series
// and the older ones are summed (`older: true`).
function issueDailyCard(q) {
    const group = groupOf(q, issueParam(q));
    const days = q.range.days;
    const dayIndex = new Map(days.map((day, index) => [day, index]));
    const byBuild = new Map();
    for (const report of loadReports(q, spanOf(q, 'current'), { group: Number(group.id) })) {
        const index = dayIndex.get(report.day);
        if (index === undefined) continue;
        const build = report.build || '';
        if (!byBuild.has(build)) byBuild.set(build, days.map(() => 0));
        byBuild.get(build)[index]++;
    }
    const named = [...byBuild.keys()].filter((build) => build !== '').sort(compareBuilds);
    const own = named.length > 3 ? named.slice(-2) : named;
    const folded = [...named.filter((build) => !own.includes(build)), ...(byBuild.has('') ? [''] : [])];
    const series = [];
    if (folded.length > 0) {
        const values = days.map(() => 0);
        for (const build of folded) byBuild.get(build).forEach((n, index) => { values[index] += n; });
        series.push({ build: null, older: true, builds: folded.filter((build) => build !== ''), unknown_build: byBuild.has(''), values });
    }
    for (const build of own) series.push({ build, older: false, builds: [build], unknown_build: false, values: byBuild.get(build) });
    return {
        data: {
            days,
            series,
            total: series.reduce((total, entry) => total + entry.values.reduce((a, b) => a + b, 0), 0),
            last_day_partial: days.length > 0 && days[days.length - 1] === utcDay(q.now)
        }
    };
}

// What the player was doing, for reports that name a session: the stage the
// next launch reported, otherwise the last room or menu event of the session.
function activityOfReport(q, report) {
    if (report.stage) return activityOf(report.stage);
    if (!report.session_tracked) return activityOf(null);
    const event = q.db.get(
        `SELECT name, props FROM events WHERE session_id = ? AND t <= ?
           AND name IN ('room_enter', 'room_ready', 'room_exit', 'room_load_failed', 'menu_shown')
         ORDER BY t DESC LIMIT 1`, report.session, report.occurred_at + 1000);
    if (!event) return activityOf('startup');
    const props = parseJson(event.props, {});
    const where = `${props.mode || ''}:${props.level_id || ''}`;
    if (event.name === 'room_enter') return activityOf(`loading:${where}`);
    if (event.name === 'room_ready') return activityOf(`room:${where}`);
    if (event.name === 'room_load_failed') return activityOf('load_failed');
    return activityOf('menu');
}

// [{ key, label, count, share }] largest first, `other` after `limit` rows,
// `unknown` last. Shares are of all the reports given.
function barList(reports, keyOf, limit = 6) {
    const counts = new Map();
    const labels = new Map();
    for (const report of reports) {
        const entry = keyOf(report);
        counts.set(entry.key, (counts.get(entry.key) || 0) + 1);
        if (!labels.has(entry.key)) labels.set(entry.key, entry.label === undefined ? null : entry.label);
    }
    const unknown = counts.get('unknown') || 0;
    counts.delete('unknown');
    const rows = topList(counts, limit).map((entry) => ({
        key: entry.key, label: entry.other ? null : labels.get(entry.key), count: entry.count,
        share: share(entry.count, reports.length), other: entry.other === true
    }));
    if (unknown > 0) rows.push({ key: 'unknown', label: null, count: unknown, share: share(unknown, reports.length), other: false });
    return { total: reports.length, known: reports.length - unknown, rows };
}

const BREAKDOWNS = {
    gpu: (q, reports) => barList(reports, (report) => gpuFamily(report.gpu, report.plat)),
    memory: (q, reports) => barList(reports, (report) => memoryBucket(report.ram_gb)),
    os: (q, reports) => barList(reports, (report) => osFamily(report.os, report.plat)),
    platform: (q, reports) => {
        const list = barList(reports, (report) => ({ key: report.plat }), 10);
        // Every platform has a row, also at zero.
        for (const platform of PLATFORMS) {
            if (!list.rows.some((row) => row.key === platform)) list.rows.push({ key: platform, label: null, count: 0, share: reports.length > 0 ? 0 : null, other: false });
        }
        return list;
    },
    activity: (q, reports) => barList(reports, (report) => ({ key: activityOfReport(q, report).key }), 10),
    launch: (q, reports) => {
        const values = reports.map((report) => report.seconds).filter((value) => value !== null && value >= 0);
        return {
            total: reports.length,
            known: values.length,
            unit: 's',
            bins: histogram(values, LAUNCH_EDGES_S).map((bin) => ({ ...bin, share: share(bin.count, values.length) }))
        };
    },
    // Neither the game nor the crash context sends the size of the video memory.
    vram: () => ({ available: false, reason: 'not_collected', total: 0, known: 0, rows: [] })
};

function issueBreakdownCard(q) {
    const group = groupOf(q, issueParam(q));
    const by = typeof q.params.by === 'string' ? q.params.by : 'all';
    if (by !== 'all' && !Object.prototype.hasOwnProperty.call(BREAKDOWNS, by)) {
        throw refuse('invalid', `Unknown breakdown ${JSON.stringify(by)}. Use one of: all, ${Object.keys(BREAKDOWNS).join(', ')}.`);
    }
    const reports = loadReports(q, spanOf(q, 'current'), { group: Number(group.id) });
    if (by !== 'all') return { data: { by, ...BREAKDOWNS[by](q, reports) } };
    const data = { by: 'all' };
    for (const name of Object.keys(BREAKDOWNS)) data[name] = BREAKDOWNS[name](q, reports);
    return { data };
}

// The most common call stack of an issue's reports. Reads the range first and
// every report of the issue when the range has none with a stack.
function commonStack(q, groupId, span) {
    const read = (reports) => {
        const withStack = reports.filter((report) => report.context).sort((a, b) => b.occurred_at - a.occurred_at).slice(0, STACK_REPORTS_MAX);
        const traces = new Map(); // signature -> { n, report, frames, message }
        for (const report of withStack) {
            const context = parseJson(report.context, {});
            const frames = parseStack(context.callstack);
            if (frames.length === 0) continue;
            const signature = stackSignature(frames);
            const entry = traces.get(signature);
            if (entry) entry.n++;
            else traces.set(signature, { n: 1, report: report.id, frames, message: context.error_message || '' });
        }
        let best = null;
        let of = 0;
        for (const entry of traces.values()) {
            of += entry.n;
            if (!best || entry.n > best.n) best = entry;
        }
        return { best, of, read: withStack.length, reports: reports.length };
    };
    let found = read(loadReports(q, span, { group: groupId, context: true }));
    let scope = 'range';
    if (!found.best) {
        found = read(loadReports(q, null, { group: groupId, context: true, platform: 'all', build: 'all' }));
        scope = 'all_time';
    }
    return { ...found, scope };
}

function issueStackCard(q) {
    const group = groupOf(q, issueParam(q));
    const found = commonStack(q, Number(group.id), spanOf(q, 'current'));
    const frames = found.best ? found.best.frames : [];
    const message = (found.best && found.best.message) || group.error_message || '';
    return {
        data: {
            error_message: message,
            frames: frames.slice(0, FRAMES_MAX).map((frame, index) => ({
                index, text: frameLabel(frame), raw: frame.raw, module: frame.module, fn: frame.fn, file: frame.file, line: frame.line, game: frame.game
            })),
            frames_total: frames.length,
            // For the Copy button: the message, then the frames as stored.
            text: [message, ...frames.map((frame, index) => `${index} ${frame.raw}`)].filter((line) => line !== '').join('\n'),
            report: found.best ? reportKey(found.best.report) : null,
            same: found.best ? found.best.n : 0,   // reports with exactly this trace
            of: found.of,                          // reports that have a trace
            reports: found.reports,                // reports looked at
            scope: found.scope                     // 'range', or 'all_time' when the range has no trace
        }
    };
}

// The generated summary as stored: JSON { likely_cause, suggested_fix }, or
// plain text from an older writer.
function summaryOf(group) {
    if (!group.summary) return null;
    const stored = parseJson(group.summary, null);
    const text = (value) => (typeof value === 'string' ? value.trim() : '');
    const parts = stored && typeof stored === 'object'
        ? { likely_cause: text(stored.likely_cause), suggested_fix: text(stored.suggested_fix) }
        : { likely_cause: String(group.summary).trim(), suggested_fix: '' };
    return { ...parts, at: whole(group.summary_at), reports: numberOrNull(group.summary_reports) };
}

function canSummarise() {
    if (typeof process.env.ANTHROPIC_API_KEY !== 'string' || process.env.ANTHROPIC_API_KEY === '') return { possible: false, reason: 'no_key' };
    try { require.resolve('@anthropic-ai/sdk'); } catch (error) { return { possible: false, reason: 'no_sdk' }; }
    return { possible: true, reason: null };
}

function issueSummaryCard(q) {
    const group = groupOf(q, issueParam(q));
    const can = canSummarise();
    return {
        data: {
            summary: summaryOf(group),
            reports_now: Number(group.count),
            can_generate: can.possible,
            unavailable_reason: can.reason      // 'no_key', 'no_sdk' or null
        }
    };
}

// The facts the generated summary is written from (main-actions/stability.js).
// All time, not the request's range: the newest reports of the issue.
function summaryFactsCard(q) {
    const group = groupOf(q, issueParam(q));
    const id = Number(group.id);
    const reports = loadReports(q, null, { group: id, platform: 'all', build: 'all' })
        .sort((a, b) => b.occurred_at - a.occurred_at).slice(0, STACK_REPORTS_MAX);
    const found = commonStack(q, id, null);
    const top = (list, nameOf = (row) => row.label || row.key) => list.rows.slice(0, 6).map((row) => ({ name: nameOf(row), share: row.share }));
    const ACTIVITY_NAMES = { startup: 'starting up', menu_loading: 'loading the main menu', menu: 'main menu', loading: 'loading a room', load_failed: 'after a failed room load', unknown: 'not known' };
    const activityName = (row) => ACTIVITY_NAMES[row.key] || (row.key.startsWith('room:') ? `in a room, ${row.key.slice(5)} mode` : row.key);
    return {
        data: {
            id,
            key: issueKey(id),
            title: issueTitle(group),
            category: group.category || 'Unknown',
            crash_type: group.crash_type || null,
            error_message: String(group.error_message || '').slice(0, 1500),
            reports_all_time: Number(group.count),
            reports_read: reports.length,
            first_seen: whole(group.first_seen),
            last_seen: whole(group.last_seen),
            builds: sortedBuilds(group.builds),
            platforms: top(BREAKDOWNS.platform(q, reports), (row) => ({ windows: 'Windows', mac: 'Mac', deck: 'Steam Deck' }[row.key] || 'other')).filter((row) => row.share > 0),
            graphics_cards: top(BREAKDOWNS.gpu(q, reports)),
            memory: top(BREAKDOWNS.memory(q, reports)),
            systems: top(BREAKDOWNS.os(q, reports)),
            activity: top(BREAKDOWNS.activity(q, reports), activityName),
            time_since_launch: BREAKDOWNS.launch(q, reports).bins.map((bin) => ({ from_s: bin.from, to_s: bin.to, share: bin.share })),
            frames: (found.best ? found.best.frames : []).slice(0, 16).map((frame) => ({ text: frameLabel(frame), game: frame.game })),
            same_trace: { same: found.best ? found.best.n : 0, of: found.of }
        }
    };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

// Whether the stored archive of a report can be downloaded: the same checks as
// GET /api/admin/v2/crash-archive/<id>.
function archiveOf(q, report) {
    let available = false;
    if (report.file) {
        const file = path.resolve(q.storageDir, report.file);
        const inside = path.relative(path.resolve(q.storageDir), file);
        const outside = inside.startsWith('..') || path.isAbsolute(inside);
        available = (!outside || path.isAbsolute(report.file)) && fs.existsSync(file);
    }
    return { available, size: report.file_size, path: available ? `/api/admin/v2/crash-archive/${reportKey(report.id)}` : null };
}

const REPORT_SORTS = { received: 1, session_time: 1, size: 1 };
const REPORT_STATES = { 0: 'waiting', 1: 'read', 2: 'unreadable' };

function reportsCard(q) {
    let reports = loadReports(q, spanOf(q, 'current'));
    const issue = q.params.issue !== undefined && q.params.issue !== '' ? issueIdOf(q.params.issue) : null;
    if (q.params.issue !== undefined && q.params.issue !== '' && issue === null) throw refuse('invalid', 'The issue filter needs an ID such as SS-12.');
    if (issue !== null) reports = reports.filter((report) => report.group === issue);
    const category = typeof q.params.category === 'string' ? q.params.category.trim().toLowerCase() : '';
    if (category !== '' && category !== 'all') reports = reports.filter((report) => (report.category || 'Unknown').toLowerCase() === category);

    const groups = new Map();
    for (const group of q.db.all(`SELECT ${GROUP_COLUMNS} FROM crash_groups`)) {
        groups.set(Number(group.id), { id: Number(group.id), key: issueKey(group.id), title: issueTitle(group), status: shownStatus(group, q.now) });
    }
    const search = typeof q.params.q === 'string' ? q.params.q.trim().toLowerCase() : '';
    if (search !== '') {
        reports = reports.filter((report) => {
            const group = report.group === null ? null : groups.get(report.group);
            return reportKey(report.id).toLowerCase() === search
                || (group && (group.key.toLowerCase() === search || group.title.toLowerCase().includes(search)))
                || (report.gpu || '').toLowerCase().includes(search)
                || (report.build || '').toLowerCase() === search
                || report.guid.toLowerCase().includes(search);
        });
    }

    const paging = q.paging(REPORT_SORTS);
    const valueOf = { received: 'received_at', session_time: 'seconds', size: 'file_size' }[paging.sort];
    const direction = paging.dir === 'asc' ? 1 : -1;
    // A report without the value sorts last in both directions.
    reports.sort((a, b) => (a[valueOf] === null) - (b[valueOf] === null)
        || direction * ((a[valueOf] || 0) - (b[valueOf] || 0)) || b.id - a.id);
    const page = reports.slice(paging.offset, paging.offset + paging.per);
    return {
        data: {
            paging: { sort: paging.sort, dir: paging.dir, page: paging.page, per: paging.per, total: reports.length },
            issue: issue !== null ? (groups.get(issue) || null) : null,
            rows: page.map((report) => ({
                id: report.id,
                key: reportKey(report.id),
                received_at: whole(report.received_at),
                occurred_at: whole(report.occurred_at),
                state: REPORT_STATES[report.parsed] || 'read',
                issue: report.group === null ? null : (groups.get(report.group) || null),
                category: report.category,
                build: report.build,
                platform: report.plat,
                gpu: report.gpu,
                gpu_short: gpuShort(report.gpu),
                ram_gb: report.ram_gb,
                session_time_s: report.seconds,
                old_route: report.legacy,
                archive: archiveOf(q, report)
            }))
        }
    };
}

// One report, for the drawer.
function reportCard(q) {
    const id = reportIdOf(q.params.report !== undefined ? q.params.report : q.params.id);
    if (id === null) throw refuse('invalid', 'A report ID such as R-12 is needed.');
    const row = q.db.get('SELECT * FROM crashes WHERE id = ?', id);
    if (!row) throw refuse('not_found', `There is no report ${reportKey(id)}.`);
    const context = parseJson(row.context, {});
    const session = row.session_id ? q.db.get('SELECT * FROM sessions WHERE session_id = ?', row.session_id) : null;
    const group = row.group_id === null ? null : q.db.get(`SELECT ${GROUP_COLUMNS} FROM crash_groups WHERE id = ?`, row.group_id);
    const gpu = row.gpu || (session && session.gpu) || null;
    const os = row.os || (session && session.os_version) || null;
    const platform = session ? q.platformOf(session.platform, session.device) : reportPlatform(row.platform, os, gpu);
    const occurred = Number(row.occurred_at);
    const tracked = Boolean(session) && Number(session.legacy) === 0;

    // The last events of the session before the crash, oldest first. Only the
    // properties the registry lists, and none of the hardware of session_start.
    let events = [];
    if (session) {
        events = q.db.all('SELECT name, t, props FROM events WHERE session_id = ? AND t <= ? ORDER BY t DESC, id DESC LIMIT 8',
            row.session_id, occurred + 1000).reverse().map((event) => {
            const registered = q.registry.events && q.registry.events[event.name] ? q.registry.events[event.name].props : null;
            const all = parseJson(event.props, {});
            const props = {};
            if (registered && typeof registered === 'object') {
                for (const key of Object.keys(registered)) {
                    if (all[key] !== undefined && all[key] !== null) props[key] = typeof all[key] === 'string' ? all[key].slice(0, 80) : all[key];
                }
            }
            return { t: whole(event.t), name: event.name, props };
        });
    }
    const report = {
        id, file: row.file || null, file_size: numberOrNull(row.file_size), stage: session ? session.last_stage || null : null,
        session: row.session_id || null, session_tracked: tracked, occurred_at: occurred
    };
    const activity = session ? activityOfReport(q, report) : activityOf(null);
    const frames = parseStack(context.callstack);
    return {
        data: {
            id,
            key: reportKey(id),
            state: REPORT_STATES[Number(row.parsed)] || 'read',
            parse_error: row.parse_error || null,
            old_route: Number(row.legacy) === 1,
            issue: group ? { id: Number(group.id), key: issueKey(group.id), title: issueTitle(group), category: group.category || 'Unknown', status: shownStatus(group, q.now) } : null,
            received_at: whole(row.received_at),
            occurred_at: whole(occurred),
            build: row.build || null,
            steam_build: numberOrNull(row.steam_build),
            platform,
            os,
            os_label: osFamily(os, platform).label,
            gpu,
            gpu_short: gpuShort(gpu),
            gpu_family: gpuFamily(gpu, platform).label,
            cpu: row.cpu || (session && session.cpu) || null,
            ram_gb: numberOrNull(row.ram_gb) || (session ? numberOrNull(session.ram_gb) : null),
            engine_version: row.engine_version || null,
            category: row.category || null,
            crash_type: row.crash_type || null,
            error_message: row.error_message || '',
            top_frame: frameLabel(frames[0] || null),
            session_time_s: numberOrNull(row.seconds_since_start),
            settings: tracked ? {
                quality_preset: session.quality_preset === null || session.quality_preset === undefined ? null : String(session.quality_preset),
                upscaler: session.upscaler || null,
                window_mode: session.window_mode || null,
                screen_w: numberOrNull(session.screen_w),
                screen_h: numberOrNull(session.screen_h),
                res_scale: numberOrNull(session.res_scale),
                rhi: session.rhi || null
            } : null,
            language: (session && session.language) || context.locale || null,
            activity: activity.kind === 'unknown' ? null : { key: activity.key, kind: activity.kind, mode: activity.mode, level: activity.level },
            // `seen`: the session has a row (the Events page can open it).
            session: row.session_id ? {
                id: row.session_id, seen: Boolean(session), tracked,
                started_at: session ? whole(session.started_at) : null,
                end_reason: session ? session.end_reason || null : null
            } : null,
            events,
            archive: { ...archiveOf(q, report), has_minidump: row.has_minidump === null || row.has_minidump === undefined ? null : Number(row.has_minidump) === 1 }
        }
    };
}

// ---------------------------------------------------------------------------
// The strip
// ---------------------------------------------------------------------------

// Tracked sessions of a span: how they ended and how many players they are.
function sessionEnds(q, span) {
    const where = sessionsWhere(q, span);
    const row = q.db.get(
        `SELECT COUNT(*) AS sessions,
                SUM(CASE WHEN s.legacy = 0 THEN 1 ELSE 0 END) AS tracked,
                SUM(CASE WHEN s.legacy = 0 AND s.end_reason = 'abnormal' THEN 1 ELSE 0 END) AS abnormal,
                SUM(CASE WHEN s.legacy = 0 AND s.end_reason = 'clean' THEN 1 ELSE 0 END) AS clean,
                COUNT(DISTINCT s.install_id) AS players
         FROM sessions s WHERE ${where.sql}`, ...where.args);
    const abnormal = Number(row.abnormal) || 0;
    const clean = Number(row.clean) || 0;
    const tracked = Number(row.tracked) || 0;
    return {
        sessions: Number(row.sessions) || 0, tracked, abnormal, ended: abnormal + clean, open: tracked - abnormal - clean,
        players: Number(row.players) || 0, coverage: share(tracked, Number(row.sessions) || 0)
    };
}

function stripNumbers(q, span) {
    const everyPlatform = loadReports(q, span, { platform: 'all' });
    const reports = q.platform === 'all' ? everyPlatform : everyPlatform.filter((report) => report.plat === q.platform);
    const crashFreeBy = crashFreeByPlatform(q, span, everyPlatform);
    const ends = sessionEnds(q, span);
    return {
        crash_free: crashFreeBy,
        reports: reports.length,
        sessions: ends.sessions,
        per_1000: ends.sessions > 0 ? (reports.length / ends.sessions) * 1000 : null,
        ends,
        abnormal_share: share(ends.abnormal, ends.ended),
        affected: tally(reports)
    };
}

// The same numbers per UTC day for the 14 days that end with the range.
function stripTrend(q) {
    const to = q.range.to;
    const from = dayStart(to - 1) - (TREND_DAYS - 1) * DAY;
    const days = [];
    for (let day = from; days.length < TREND_DAYS; day += DAY) days.push(utcDay(day));
    const index = new Map(days.map((day, at) => [day, at]));
    const blank = () => days.map(() => 0);
    const sessions = { all: blank(), windows: blank(), mac: blank(), deck: blank(), other: blank() };
    const filtered = { sessions: blank(), abnormal: blank(), ended: blank() };
    const where = sessionsWhere(q, { from, to }, 'all');
    const rows = q.db.all(
        `SELECT CAST(s.started_at / ${DAY} AS INTEGER) AS d, ${q.platformSql('s')} AS plat, COUNT(*) AS n,
                SUM(CASE WHEN s.legacy = 0 AND s.end_reason = 'abnormal' THEN 1 ELSE 0 END) AS abnormal,
                SUM(CASE WHEN s.legacy = 0 AND s.end_reason = 'clean' THEN 1 ELSE 0 END) AS clean
         FROM sessions s WHERE ${where.sql} GROUP BY d, plat`, ...where.args);
    for (const row of rows) {
        const at = index.get(utcDay(Number(row.d) * DAY));
        if (at === undefined) continue;
        const n = Number(row.n);
        sessions.all[at] += n;
        if (sessions[row.plat]) sessions[row.plat][at] += n;
        if (q.platform === 'all' || q.platform === row.plat) {
            filtered.sessions[at] += n;
            filtered.abnormal[at] += Number(row.abnormal) || 0;
            filtered.ended[at] += (Number(row.abnormal) || 0) + (Number(row.clean) || 0);
        }
    }
    const crashed = { windows: days.map(() => new Set()), mac: days.map(() => new Set()), deck: days.map(() => new Set()) };
    const reports = blank();
    const players = days.map(() => new Set());
    for (const report of loadReports(q, { from, to }, { platform: 'all' })) {
        const at = index.get(report.day);
        if (at === undefined) continue;
        if (crashed[report.plat]) crashed[report.plat][at].add(report.session_key);
        if (q.platform === 'all' || q.platform === report.plat) {
            reports[at]++;
            players[at].add(report.player);
        }
    }
    return {
        days,
        crash_free: Object.fromEntries(PLATFORMS.map((platform) => [platform,
            days.map((day, at) => rateOf(sessions[platform][at], crashed[platform][at].size))])),
        per_1000: days.map((day, at) => (filtered.sessions[at] > 0 ? (reports[at] / filtered.sessions[at]) * 1000 : null)),
        abnormal: days.map((day, at) => share(filtered.abnormal[at], filtered.ended[at])),
        affected: days.map((day, at) => players[at].size)
    };
}

// The six tiles above Issues, Reports and Hardware. The three crash-free
// tiles are per platform and so do not follow the platform filter; the other
// three follow every filter.
function stripCard(q) {
    const now = stripNumbers(q, spanOf(q, 'current'));
    const before = stripNumbers(q, spanOf(q, 'previous'));
    const trend = stripTrend(q);
    return {
        data: {
            trend_days: trend.days,
            crash_free: PLATFORMS.map((platform) => ({
                platform,
                value: now.crash_free[platform].rate,
                sessions: now.crash_free[platform].sessions,
                crashed: now.crash_free[platform].crashed,
                previous: before.crash_free[platform].rate,
                previous_sessions: before.crash_free[platform].sessions,
                trend: trend.crash_free[platform]
            })),
            crashes_per_1000: {
                value: now.per_1000, reports: now.reports, sessions: now.sessions,
                previous: before.per_1000, previous_reports: before.reports, previous_sessions: before.sessions,
                trend: trend.per_1000
            },
            // Of the sessions of builds that report how they ended, and whose end is known.
            abnormal_ends: {
                value: now.abnormal_share, abnormal: now.ends.abnormal, ended: now.ends.ended, end_unknown: now.ends.open,
                previous: before.abnormal_share, previous_ended: before.ends.ended,
                coverage: now.ends.coverage,
                trend: trend.abnormal
            },
            // `value` counts a report without an install as a player of its own;
            // `known` are installs, `active_players` the installs that played.
            players_affected: {
                value: now.affected.players, known: now.affected.players_known, reports_without_install: now.affected.reports_without_install,
                active_players: now.ends.players, share_of_active: share(now.affected.players_known, now.ends.players),
                previous: before.affected.players, previous_known: before.affected.players_known,
                trend: trend.affected
            }
        },
        meta: { coverage: q.coverage() }
    };
}

// ---------------------------------------------------------------------------
// Hardware
// ---------------------------------------------------------------------------

const HARDWARE = {
    gpu: (row) => gpuFamily(row.gpu, row.plat),
    memory: (row) => memoryBucket(row.ram_gb),
    os: (row) => osFamily(row.os, row.plat)
};
const HARDWARE_SORTS = { over_index: 1, players: 1, crashes: 1 };

const fromTrackedBuild = (q, report) => !report.legacy || report.session_tracked
    || (q.tracking.first_build && report.build && compareBuilds(report.build, q.tracking.first_build) >= 0);

// Share of crashes divided by share of players, per graphics card family,
// memory size or system version. Players and their hardware are known for the
// builds that send usage data only, so crashes are those builds' reports too.
function hardwareCard(q) {
    const by = Object.prototype.hasOwnProperty.call(HARDWARE, q.params.by) ? q.params.by : 'gpu';
    const span = spanOf(q, 'current');
    const where = sessionsWhere(q, span);
    // The hardware of each install's newest session in the range.
    const installs = q.db.all(
        `SELECT s.install_id, s.gpu, s.ram_gb, s.os_version AS os, s.platform, s.device, MAX(s.started_at) AS newest
         FROM sessions s WHERE ${where.sql} AND s.legacy = 0 AND s.install_id IS NOT NULL GROUP BY s.install_id`, ...where.args);
    const rows = new Map();
    const rowOf = (entry) => {
        if (!rows.has(entry.key)) rows.set(entry.key, { key: entry.key, label: entry.label, players: 0, crashes: 0 });
        return rows.get(entry.key);
    };
    for (const install of installs) {
        rowOf(HARDWARE[by]({ ...install, plat: q.platformOf(install.platform, install.device) })).players++;
    }
    const reports = loadReports(q, span).filter((report) => fromTrackedBuild(q, report));
    for (const report of reports) rowOf(HARDWARE[by](report)).crashes++;

    const unknown = rows.get('unknown') || { players: 0, crashes: 0 };
    rows.delete('unknown');
    const players = installs.length - unknown.players;
    const crashes = reports.length - unknown.crashes;
    const list = [...rows.values()].map((row) => {
        const playersShare = share(row.players, players);
        const crashesShare = share(row.crashes, crashes);
        return {
            ...row, players_share: playersShare, crashes_share: crashesShare,
            over_index: playersShare > 0 && crashesShare !== null ? crashesShare / playersShare : null
        };
    });
    const paging = q.paging(HARDWARE_SORTS);
    const valueOf = paging.sort;
    const direction = paging.dir === 'asc' ? 1 : -1;
    list.sort((a, b) => (a[valueOf] === null) - (b[valueOf] === null)
        || direction * ((a[valueOf] || 0) - (b[valueOf] || 0)) || b.players - a.players || String(a.label).localeCompare(String(b.label)));
    return {
        data: {
            by,
            sort: paging.sort,
            dir: paging.dir,
            players,
            crashes,
            unknown: { players: unknown.players, crashes: unknown.crashes },
            rows: list
        },
        meta: { coverage: q.coverage() }
    };
}

// Reports per crash category and graphics card family: the nine families and
// eight categories with the most reports, the rest summed.
function hardwareMatrixCard(q) {
    const reports = loadReports(q, spanOf(q, 'current'));
    const families = new Map();
    const categories = new Map();
    const cells = new Map();
    const labels = new Map();
    for (const report of reports) {
        const family = gpuFamily(report.gpu, report.plat);
        const category = report.category || 'Unknown';
        labels.set(family.key, family.label);
        families.set(family.key, (families.get(family.key) || 0) + 1);
        categories.set(category, (categories.get(category) || 0) + 1);
        const cell = `${category}\n${family.key}`;
        cells.set(cell, (cells.get(cell) || 0) + 1);
    }
    const unknown = families.get('unknown') || 0;
    families.delete('unknown');
    const columns = topList(families, 9).filter((entry) => !entry.other).map((entry) => ({ key: entry.key, label: labels.get(entry.key), total: entry.count }));
    const kept = topList(categories, 8).filter((entry) => !entry.other);
    const rows = kept.map((entry) => ({
        category: entry.key, total: entry.count,
        counts: columns.map((column) => cells.get(`${entry.key}\n${column.key}`) || 0)
    }));
    return {
        data: {
            columns,
            rows,
            total: reports.length,
            max: rows.reduce((max, row) => Math.max(max, ...row.counts), 0),
            // What the table leaves out.
            unknown_gpu: unknown,
            other_families: [...families.keys()].length - columns.length,
            other_categories: [...categories.keys()].length - rows.length
        }
    };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

const COUNTERS = ['crash_upload_stored', 'crash_upload_duplicate', 'crash_upload_abandoned'];

// The upload counters per UTC day of a span: Map day -> { stored, duplicate, abandoned }.
// Counters are kept per day and without platform or build.
function countersOf(q, span) {
    const days = new Map();
    const rows = q.db.all(`SELECT day, key, n FROM counters WHERE day >= ? AND day <= ? AND key IN (${COUNTERS.map(() => '?').join(', ')})`,
        utcDay(span.from), utcDay(span.to - 1), ...COUNTERS);
    for (const row of rows) {
        if (!days.has(row.day)) days.set(row.day, { stored: 0, duplicate: 0, abandoned: 0 });
        days.get(row.day)[row.key.replace('crash_upload_', '')] = Number(row.n);
    }
    return days;
}
function counterTotals(q, span) {
    const totals = { stored: 0, duplicate: 0, abandoned: 0 };
    for (const day of countersOf(q, span).values()) {
        totals.stored += day.stored;
        totals.duplicate += day.duplicate;
        totals.abandoned += day.abandoned;
    }
    return totals;
}

// Sessions that ended abnormally and have no crash report, per day and platform.
function abnormalWithoutReport(q, span) {
    const where = sessionsWhere(q, span);
    return q.db.all(
        `SELECT CAST(s.started_at / ${DAY} AS INTEGER) AS d, ${q.platformSql('s')} AS plat, COUNT(*) AS n
         FROM sessions s
         WHERE ${where.sql} AND s.legacy = 0 AND s.end_reason = 'abnormal'
           AND NOT EXISTS (SELECT 1 FROM crashes c WHERE c.session_id = s.session_id)
         GROUP BY d, plat`, ...where.args)
        .map((row) => ({ day: utcDay(Number(row.d) * DAY), platform: row.plat, n: Number(row.n) }));
}

function storageFacts(q) {
    const archives = q.db.get('SELECT COALESCE(SUM(file_size), 0) AS bytes, COUNT(*) AS n FROM crashes WHERE file IS NOT NULL');
    const month = q.db.get('SELECT COALESCE(SUM(file_size), 0) AS bytes FROM crashes WHERE file IS NOT NULL AND received_at >= ?', q.now - 30 * DAY);
    let database = 0;
    for (const suffix of ['', '-wal', '-shm']) {
        try { database += fs.statSync(path.join(q.storageDir, 'insights', `insights.db${suffix}`)).size; } catch (error) { /* not there */ }
    }
    let volume = { total: null, free: null };
    try {
        const stat = fs.statfsSync(q.storageDir);
        volume = { total: Number(stat.blocks) * Number(stat.bsize), free: Number(stat.bavail) * Number(stat.bsize) };
    } catch (error) { /* older Node or no such folder */ }
    return {
        archives_bytes: Number(archives.bytes),
        archives: Number(archives.n),
        database_bytes: database,
        volume_total_bytes: volume.total,
        volume_free_bytes: volume.free,
        volume_used_bytes: volume.total === null ? null : volume.total - volume.free,
        archives_bytes_per_day: Number(month.bytes) / 30
    };
}

function pipelineNumbers(q, span) {
    const received = loadReports(q, span, { by: 'received' });
    const counters = counterTotals(q, span);
    const uploads = counters.stored + counters.duplicate;
    const started = uploads + counters.abandoned;
    return {
        new_reports: received.length,
        duplicates: counters.duplicate,
        received: received.length + counters.duplicate,
        duplicate_share: share(counters.duplicate, received.length + counters.duplicate),
        abandoned: counters.abandoned,
        started,
        abandoned_share: share(counters.abandoned, started),
        abnormal_no_report: abnormalWithoutReport(q, span).reduce((total, row) => total + row.n, 0),
        unreadable: received.filter((report) => report.parsed === 2).length
    };
}

// The six tiles of the Pipeline page. The upload counters (duplicates,
// abandoned) are kept per UTC day without platform or build, so they follow
// the date range only.
function pipelineStripCard(q) {
    const now = pipelineNumbers(q, spanOf(q, 'current'));
    const before = pipelineNumbers(q, spanOf(q, 'previous'));
    const waiting = q.db.get('SELECT COUNT(*) AS n, MIN(received_at) AS oldest FROM crashes WHERE parsed = 0');
    const unreadable = q.db.get('SELECT COUNT(*) AS n FROM crashes WHERE parsed = 2');
    const storage = storageFacts(q);
    return {
        data: {
            received: { value: now.received, new_reports: now.new_reports, previous: before.received },
            duplicates: { value: now.duplicate_share, duplicates: now.duplicates, received: now.received, previous: before.duplicate_share },
            abandoned: { value: now.abandoned_share, abandoned: now.abandoned, started: now.started, previous: before.abandoned_share },
            abnormal_no_report: { value: now.abnormal_no_report, previous: before.abnormal_no_report, coverage: q.coverage() },
            waiting: { value: Number(waiting.n), oldest_received_at: whole(waiting.oldest) },
            unreadable: { value: now.unreadable, previous: before.unreadable, all_time: Number(unreadable.n) },
            storage: { archives_bytes: storage.archives_bytes, volume_total_bytes: storage.volume_total_bytes, volume_used_bytes: storage.volume_used_bytes },
            counters_follow_filters: q.platform === 'all' && q.build === 'all'
        },
        meta: { coverage: q.coverage() }
    };
}

function pipelineReceivedCard(q) {
    const days = q.range.days;
    const index = new Map(days.map((day, at) => [day, at]));
    const fresh = days.map(() => 0);
    const duplicates = days.map(() => 0);
    const span = spanOf(q, 'current');
    for (const report of loadReports(q, span, { by: 'received' })) {
        const at = index.get(utcDay(report.received_at));
        if (at !== undefined) fresh[at]++;
    }
    for (const [day, counts] of countersOf(q, span)) {
        const at = index.get(day);
        if (at !== undefined) duplicates[at] = counts.duplicate;
    }
    return {
        data: {
            days, new_reports: fresh, duplicates,
            last_day_partial: days.length > 0 && days[days.length - 1] === utcDay(q.now),
            counters_follow_filters: q.platform === 'all' && q.build === 'all'
        }
    };
}

function pipelineAbandonedCard(q) {
    const days = q.range.days;
    const counters = countersOf(q, spanOf(q, 'current'));
    const rows = days.map((day) => {
        const counts = counters.get(day) || { stored: 0, duplicate: 0, abandoned: 0 };
        const started = counts.stored + counts.duplicate + counts.abandoned;
        return { abandoned: counts.abandoned, started, share: share(counts.abandoned, started) };
    });
    // The counters exist since the first build that uses the new upload route.
    const first = q.db.get(`SELECT MIN(day) AS day FROM counters WHERE key IN (${COUNTERS.map(() => '?').join(', ')})`, ...COUNTERS);
    return {
        data: {
            days,
            share: rows.map((row) => row.share),
            abandoned: rows.map((row) => row.abandoned),
            started: rows.map((row) => row.started),
            counted_since: first && first.day ? first.day : null,
            counters_follow_filters: q.platform === 'all' && q.build === 'all'
        },
        meta: { coverage: q.coverage() }
    };
}

function pipelineAbnormalCard(q) {
    const days = q.range.days;
    const index = new Map(days.map((day, at) => [day, at]));
    const series = Object.fromEntries(PLATFORMS.map((platform) => [platform, days.map(() => 0)]));
    let other = 0;
    for (const row of abnormalWithoutReport(q, spanOf(q, 'current'))) {
        const at = index.get(row.day);
        if (at === undefined) continue;
        if (series[row.platform]) series[row.platform][at] += row.n; else other += row.n;
    }
    return {
        data: {
            days,
            series: PLATFORMS.map((platform) => ({ platform, values: series[platform] })),
            other_platforms: other,
            last_day_partial: days.length > 0 && days[days.length - 1] === utcDay(q.now)
        },
        meta: { coverage: q.coverage() }
    };
}

function pipelineStorageCard(q) {
    const storage = storageFacts(q);
    return {
        data: {
            ...storage,
            // Everything on the volume that is neither a crash archive nor the database.
            other_bytes: storage.volume_used_bytes === null ? null : Math.max(0, storage.volume_used_bytes - storage.archives_bytes - storage.database_bytes),
            days_until_full: storage.volume_free_bytes !== null && storage.archives_bytes_per_day > 0
                ? storage.volume_free_bytes / storage.archives_bytes_per_day : null,
            // Nothing deletes archives by age yet.
            archive_retention_days: null
        }
    };
}

// What can be said about the pipeline from the stored data. Each row:
// { key, state: 'ok' | 'warn' | 'bad', ... its facts }.
function pipelineChecksCard(q) {
    const span = spanOf(q, 'current');
    const last = q.db.get('SELECT MAX(received_at) AS at FROM crashes');
    const waiting = q.db.get('SELECT COUNT(*) AS n, MIN(received_at) AS oldest FROM crashes WHERE parsed = 0');
    const lastRead = q.db.get('SELECT MAX(received_at) AS at FROM crashes WHERE parsed <> 0');
    const reports = loadReports(q, span, { by: 'received' });
    const unreadable = reports.filter((report) => report.parsed === 2);
    const reasons = q.db.all(
        `SELECT COALESCE(parse_error, 'unknown') AS reason, COUNT(*) AS n FROM crashes
         WHERE parsed = 2 AND received_at >= ? AND received_at < ? GROUP BY reason ORDER BY n DESC LIMIT 5`, span.from, span.to);
    const noTrace = q.db.all(
        `SELECT c.id FROM crashes c WHERE c.parsed = 1 AND COALESCE(c.has_context, 0) = 0 AND c.received_at >= ? AND c.received_at < ?`,
        span.from, span.to).map((row) => Number(row.id));
    const noTraceIds = new Set(noTrace);
    const perPlatform = (list) => Object.fromEntries([...PLATFORMS, 'other'].map((platform) => [platform, list.filter((report) => report.plat === platform).length]));
    const waitingCount = Number(waiting.n);
    const oldest = whole(waiting.oldest);
    const reader = crashParse ? crashParse.available() : false;
    return {
        data: {
            rows: [
                { key: 'last_report', state: last && last.at ? 'ok' : 'warn', at: whole(last ? last.at : null) },
                { key: 'archive_reader', state: reader ? 'ok' : 'bad', available: reader },
                {
                    key: 'processing',
                    state: waitingCount > WAITING_WARN || (oldest !== null && q.now - oldest > WAITING_WARN_MS) ? 'warn' : 'ok',
                    waiting: waitingCount, oldest_received_at: oldest, last_read_received_at: whole(lastRead ? lastRead.at : null)
                },
                {
                    key: 'unreadable', state: unreadable.length > 0 ? 'warn' : 'ok', reports: unreadable.length,
                    platforms: perPlatform(unreadable), reasons: reasons.map((row) => ({ reason: String(row.reason).slice(0, 200), reports: Number(row.n) }))
                },
                {
                    key: 'no_trace', state: noTrace.length > 0 ? 'warn' : 'ok', reports: noTrace.length,
                    platforms: perPlatform(reports.filter((report) => noTraceIds.has(report.id)))
                }
            ]
        }
    };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const STATE_COLUMNS = 'id, status, status_at, fixed_build, fixed_next, opened_at, first_seen';
const stateOf = (group) => ({
    id: Number(group.id), status: group.status, status_at: whole(group.status_at), fixed_build: group.fixed_build || null,
    fixed_next: Number(group.fixed_next) === 1, opened_at: whole(group.opened_at)
});
const shownOf = (q, id) => {
    const group = q.db.get(`SELECT ${STATE_COLUMNS} FROM crash_groups WHERE id = ?`, id);
    return { id: Number(group.id), key: issueKey(group.id), ...statusFields(group, q.now) };
};

// { ids: ['SS-1', ...] (or id), status: 'open' | 'fixed' | 'fixed_next' | 'ignored', build }
//   sets the status of one or several issues. `build` is needed for 'fixed'.
// { restore: [{ id, status, status_at, fixed_build, fixed_next, opened_at }] }
//   puts earlier states back: send the `previous` of an answer to undo it.
// Answers { changed, previous, issues }.
function setStatus(q, body) {
    if (Array.isArray(body.restore)) {
        if (body.restore.length === 0 || body.restore.length > 200) throw refuse('invalid', 'Between 1 and 200 issues can be restored at once.');
        const previous = [];
        for (const entry of body.restore) {
            const id = issueIdOf(entry && entry.id);
            if (id === null) throw refuse('invalid', 'Every restored state needs an issue ID.');
            if (!STATUSES.includes(entry.status)) throw refuse('invalid', `Unknown status ${JSON.stringify(entry.status)}.`);
            const fixedBuild = entry.fixed_build === null || entry.fixed_build === undefined || entry.fixed_build === '' ? null : String(entry.fixed_build);
            if (fixedBuild !== null && !BUILD_NAME.test(fixedBuild)) throw refuse('invalid', 'The fixed build is not a build name.');
            const group = q.db.get(`SELECT ${STATE_COLUMNS} FROM crash_groups WHERE id = ?`, id);
            if (!group) throw refuse('not_found', `There is no issue ${issueKey(id)}.`);
            previous.push(stateOf(group));
            q.db.run('UPDATE crash_groups SET status = ?, status_at = ?, fixed_build = ?, fixed_next = ?, opened_at = ? WHERE id = ?',
                entry.status, numberOrNull(entry.status_at), fixedBuild, entry.fixed_next === true || entry.fixed_next === 1 ? 1 : 0,
                numberOrNull(entry.opened_at), id);
        }
        q.log('stability.status_restored', { ids: previous.map((state) => state.id) });
        return { changed: previous.length, previous, issues: previous.map((state) => shownOf(q, state.id)) };
    }

    const given = Array.isArray(body.ids) ? body.ids : (body.id !== undefined ? [body.id] : []);
    const ids = [...new Set(given.map(issueIdOf))];
    if (ids.length === 0 || ids.includes(null)) throw refuse('invalid', 'Name the issues to change, for example { "ids": ["SS-12"] }.');
    if (ids.length > 200) throw refuse('invalid', 'At most 200 issues can be changed at once.');
    if (!SETTABLE.includes(body.status)) throw refuse('invalid', `The status must be one of: ${SETTABLE.join(', ')}.`);
    let build = null;
    if (body.status === 'fixed') {
        build = typeof body.build === 'string' ? body.build.trim() : '';
        if (!BUILD_NAME.test(build)) throw refuse('invalid', 'Fixed in a build needs the build, for example { "status": "fixed", "build": "1.4.1" }.');
        if (!q.builds.some((entry) => entry.name === build)) throw refuse('invalid', `Build ${build} is not known. Add a build marker in Settings first.`);
    }
    const previous = [];
    for (const id of ids) {
        const group = q.db.get(`SELECT ${STATE_COLUMNS} FROM crash_groups WHERE id = ?`, id);
        if (!group) throw refuse('not_found', `There is no issue ${issueKey(id)}.`);
        previous.push(stateOf(group));
        // Changing the status also means somebody has looked at the issue.
        q.db.run('UPDATE crash_groups SET status = ?, status_at = ?, fixed_build = ?, fixed_next = ?, opened_at = COALESCE(opened_at, ?) WHERE id = ?',
            body.status === 'fixed_next' ? 'fixed' : body.status, q.now, build, body.status === 'fixed_next' ? 1 : 0, q.now, id);
    }
    // A marker dated after now already names the next build.
    if (body.status === 'fixed_next') resolveFixedNext(q);
    q.log('stability.status', { ids, status: body.status, build });
    return { changed: ids.length, previous, issues: ids.map((id) => shownOf(q, id)) };
}

// { id }: the issue page was opened. New becomes Open; anything else stays.
function markOpened(q, body) {
    const group = groupOf(q, body.id);
    const id = Number(group.id);
    const changed = group.status === 'new';
    if (changed) {
        q.db.run(`UPDATE crash_groups SET status = 'open', status_at = ?, opened_at = COALESCE(opened_at, ?) WHERE id = ? AND status = 'new'`, q.now, q.now, id);
    } else if (!group.opened_at) {
        q.db.run('UPDATE crash_groups SET opened_at = ? WHERE id = ? AND opened_at IS NULL', q.now, id);
    }
    return { changed, previous: stateOf(group), issue: shownOf(q, id) };
}

// { id, notes }: the notes of an issue. There is one shared access key, so
// only the time is kept, not who wrote.
function saveNotes(q, body) {
    const group = groupOf(q, body.id);
    if (typeof body.notes !== 'string') throw refuse('invalid', 'The notes must be text.');
    const notes = body.notes.replace(/\r\n/g, '\n').trim();
    if (notes.length > NOTES_MAX) throw refuse('invalid', `Notes can be at most ${NOTES_MAX.toLocaleString('en-US')} characters long.`);
    if (notes === (group.notes || '')) return { changed: false, notes, notes_at: whole(group.notes_at) };
    q.db.run('UPDATE crash_groups SET notes = ?, notes_at = ? WHERE id = ?', notes === '' ? null : notes, q.now, group.id);
    q.log('stability.notes', { id: Number(group.id), length: notes.length });
    return { changed: true, notes, notes_at: q.now };
}

// { id, likely_cause, suggested_fix, reports }: stores a generated summary.
// Called by `stability.summarise` (main-actions/stability.js) after the model answered.
function saveSummary(q, body) {
    const group = groupOf(q, body.id);
    const text = (value) => (typeof value === 'string' ? value.trim().slice(0, 4000) : '');
    const summary = { likely_cause: text(body.likely_cause), suggested_fix: text(body.suggested_fix) };
    if (summary.likely_cause === '' && summary.suggested_fix === '') throw refuse('invalid', 'The summary is empty.');
    const reports = Number.isInteger(body.reports) && body.reports >= 0 ? body.reports : Number(group.count);
    q.db.run('UPDATE crash_groups SET summary = ?, summary_at = ?, summary_reports = ? WHERE id = ?', JSON.stringify(summary), q.now, reports, group.id);
    q.log('stability.summary', { id: Number(group.id), reports });
    return { summary: { ...summary, at: q.now, reports } };
}

module.exports = {
    cards: {
        'stability.strip': stripCard,
        'stability.issues': issuesCard,
        'stability.issue': issueCard,
        'stability.issue_daily': issueDailyCard,
        'stability.issue_breakdown': issueBreakdownCard,
        'stability.issue_stack': issueStackCard,
        'stability.issue_summary': issueSummaryCard,
        'stability.summary_facts': summaryFactsCard,
        'stability.reports': reportsCard,
        'stability.report': reportCard,
        'stability.hardware': hardwareCard,
        'stability.hardware_matrix': hardwareMatrixCard,
        'stability.pipeline_strip': pipelineStripCard,
        'stability.pipeline_received': pipelineReceivedCard,
        'stability.pipeline_abandoned': pipelineAbandonedCard,
        'stability.pipeline_abnormal': pipelineAbnormalCard,
        'stability.pipeline_storage': pipelineStorageCard,
        'stability.pipeline_checks': pipelineChecksCard
    },
    actions: {
        'stability.set_status': setStatus,
        'stability.mark_opened': markOpened,
        'stability.save_notes': saveNotes,
        'stability.save_summary': saveSummary
    },
    // For other sections (Overview shows the same crash-free number).
    crashFree,
    crashFreeByPlatform,
    // Pure helpers, exported for tests.
    gpuFamily, gpuShort, osFamily, memoryBucket, reportPlatform, parseFrame, parseStack, frameLabel, issueTitle, activityOf, shownStatus
};
