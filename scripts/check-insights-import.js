#!/usr/bin/env node

// Checks three parts of the insights store (server/insights/):
//   import.js               the one-time import of the files the old routes wrote
//   retention.js            the nightly prune and the mark left by "Delete crash reports"
//   queries/maintenance.js  the Settings page's cards and actions
//
// Usage: node scripts/check-insights-import.js [port]     (needs `npm install` in server/, Node 22.5 or newer)
//
// Runs server.js from this folder on 127.0.0.1 against temporary storage
// folders that it fills with made-up old files and deletes at the end. It
// takes no storage path and no server address, so it cannot reach real data.
// Starts and stops the server many times. Prints one numbered line per check
// and exits 1 if a check failed.
//
// Also a module: require() it for writeOldFiles(), which other scripts use to
// build a storage folder with old files of any size.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// Made-up old files, in the shapes the old routes store
// ---------------------------------------------------------------------------

function generator(seed) {
    let state = seed >>> 0;
    const random = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
    const whole = (low, high) => low + Math.floor(random() * (high - low + 1));
    const pick = (list) => list[Math.floor(random() * list.length)];
    const uuid = () => {
        const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16)).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    };
    return { random, whole, pick, uuid, chance: (p) => random() < p };
}

const LEGACY_MODES = { Unpack: 'unpack', Design: 'design', Designer: 'design', Creative: 'creative' };
const BELIEVABLE_FROM = Date.UTC(2020, 0, 1);

// Writes the five old files into `storage` and returns what an import of them
// must give. options: counts, `now`, `malformed` (adds broken input of every
// kind), `readBytes` (the import's entry limit, for the oversized entries).
function writeOldFiles(storage, options = {}) {
    const o = { sessionsJson: 3500, sessionsLog: 2500, eventsJson: 18000, eventsLog: 12000, crashes: 400, now: Date.now(),
        seed: 20261123, malformed: false, readBytes: 1024 * 1024, callstackLines: 18, days: 400, ...options };
    const g = generator(o.seed);
    const analytics = path.join(storage, 'analytics');
    fs.mkdirSync(analytics, { recursive: true });
    fs.mkdirSync(path.join(storage, 'crashes'), { recursive: true });
    const iso = (ms) => new Date(ms).toISOString();
    const start = o.now - o.days * DAY;
    const span = o.days * DAY - 2 * HOUR;

    const expected = {
        sessions: new Map(),   // id -> { started, last, events }
        events: [],            // 'session|name|t'
        crashes: new Map(),    // id -> { received, occurred, build, session_id, file, group }
        groups: new Map(),     // group key -> { count, first, last }
        files: {
            'crashes_metadata.json': { imported: 0, unreadable: 0, oversized: 0, failed: 0 },
            'sessions.json': { imported: 0, unreadable: 0, oversized: 0, ends: 0 },
            'sessions.ndjson': { imported: 0, unreadable: 0, oversized: 0, ends: 0 },
            'events.json': { imported: 0, unreadable: 0, oversized: 0 },
            'events.ndjson': { imported: 0, unreadable: 0, oversized: 0 }
        },
        roomEnters: 0,
        timesReplaced: 0,
        archives: []           // files written into storage/crashes
    };
    const touch = (id, t) => {
        const entry = expected.sessions.get(id) || { started: t, last: t, events: 0 };
        entry.started = Math.min(entry.started, t);
        entry.last = Math.max(entry.last, t);
        expected.sessions.set(id, entry);
        return entry;
    };

    // ---- sessions: the history list, then the log (starts and ends)
    const sessionIds = [];
    const sessionTotal = o.sessionsJson + o.sessionsLog;
    let lastGood = null;
    const makeSession = (index, file) => {
        const id = g.uuid();
        let t = Math.round(start + (index + g.random()) * (span / Math.max(1, sessionTotal)));
        let startText = iso(t);
        // A few starts carry a time nobody can believe: they get the time of the one before.
        if (lastGood !== null && index % 977 === 5) {
            startText = index % 2 ? 'not a date' : '2099-01-01T00:00:00.000Z';
            t = lastGood;
            expected.timesReplaced++;
        } else {
            lastGood = t;
        }
        const session = { id, start_time: startText, end_time: null, client_version: g.pick(['1.2.0', '1.3.1', '1.3.2', 'unknown']),
            platform: g.pick(['Windows', 'Windows', 'Mac', 'Linux', 'unknown']), metadata: { os: 'made up', cores: g.whole(4, 16) }, event_count: 0 };
        touch(id, t);
        sessionIds.push({ id, t });
        expected.files[file].imported++;
        return { session, t };
    };
    const history = [];
    for (let i = 0; i < o.sessionsJson; i++) {
        const { session, t } = makeSession(i, 'sessions.json');
        if (g.chance(0.6)) {
            const end = t + g.whole(2, 180) * MINUTE;
            session.end_time = iso(end);
            session.event_count = g.whole(0, 30);
            touch(session.id, end);
        }
        history.push(session);
    }
    let sessionsJsonText = JSON.stringify(history, null, 2);
    if (o.malformed) {
        // The list ends in the middle of one more entry.
        const extra = JSON.stringify({ id: g.uuid(), start_time: iso(start + span), end_time: null, client_version: '1.3.2', platform: 'Windows' }, null, 2);
        sessionsJsonText = sessionsJsonText.replace(/\n\]$/, ',\n' + extra.slice(0, Math.floor(extra.length / 2)));
        expected.files['sessions.json'].unreadable++;
    }
    fs.writeFileSync(path.join(analytics, 'sessions.json'), sessionsJsonText);

    const sessionLines = [];
    const open = [];
    for (let i = 0; i < o.sessionsLog; i++) {
        const { session, t } = makeSession(o.sessionsJson + i, 'sessions.ndjson');
        sessionLines.push(JSON.stringify(session));
        open.push({ id: session.id, t });
        if (open.length > 3 && g.chance(0.7)) {
            const ended = open.splice(g.whole(0, open.length - 1), 1)[0];
            const end = ended.t + g.whole(2, 200) * MINUTE;
            sessionLines.push(JSON.stringify({ ended: ended.id, end_time: iso(end), event_count: g.whole(0, 40) }));
            touch(ended.id, end);
            expected.files['sessions.ndjson'].ends++;
        }
    }
    if (history.length > 0) {
        // The end of a session of the history, and an end nobody knows the session of.
        const old = sessionIds[0];
        sessionLines.push(JSON.stringify({ ended: old.id, end_time: iso(old.t + 5 * HOUR), event_count: 3 }));
        touch(old.id, old.t + 5 * HOUR);
        expected.files['sessions.ndjson'].ends++;
    }
    if (o.sessionsLog > 0) {
        sessionLines.push(JSON.stringify({ ended: g.uuid(), end_time: iso(start + span), event_count: 0 }));
        expected.files['sessions.ndjson'].ends++;
    }
    if (o.malformed) {
        sessionLines.splice(Math.min(3, sessionLines.length), 0, 'this is not JSON', JSON.stringify({ start_time: iso(start), platform: 'Windows' }));
        expected.files['sessions.ndjson'].unreadable += 2;
    }
    fs.writeFileSync(path.join(analytics, 'sessions.ndjson'), sessionLines.map((line) => line + '\n').join(''));

    // ---- events: the history list, then the log
    const strangers = Array.from({ length: 40 }, () => g.uuid()); // sessions that never called session/start
    const eventTotal = o.eventsJson + o.eventsLog;
    let lastEventTime = null;
    const makeEvent = (index, file, counts = true) => {
        const roll = g.random();
        const sessionId = roll < 0.03 ? 'anonymous' : roll < 0.06 ? g.pick(strangers) : sessionIds.length > 0
            ? sessionIds[Math.min(sessionIds.length - 1, Math.floor((index / eventTotal) * sessionIds.length))].id : 'anonymous';
        const name = g.pick(['TrackGameMode', 'TrackGameMode', 'LevelCompleted', 'ItemPlaced', 'PhotoTaken', 'MenuOpened']);
        const properties = name === 'TrackGameMode' ? { GameMode: g.pick(Object.keys(LEGACY_MODES)) }
            : name === 'LevelCompleted' ? { Level: `L${g.whole(1, 30)}`, Stars: g.whole(1, 3) } : { Item: `item_${g.whole(1, 400)}`, Fast: g.chance(0.5) };
        let t = Math.round(start + (index + g.random()) * (span / Math.max(1, eventTotal)));
        let stamp = iso(t);
        if (lastEventTime !== null && index % 811 === 7) {
            stamp = [undefined, 'yesterday', '2099-06-01T00:00:00.000Z', '1999-05-05T05:05:05.000Z'][index % 4];
            t = lastEventTime;
            if (counts) expected.timesReplaced++;
        } else {
            lastEventTime = t;
        }
        const event = { id: g.uuid(), session_id: sessionId, event_name: name, properties, timestamp: stamp,
            client_version: g.pick(['1.3.1', '1.3.2', 'unknown']), platform: g.pick(['Windows', 'Mac', 'unknown']) };
        if (stamp === undefined) delete event.timestamp;
        if (!counts) return event;
        const stored = name === 'TrackGameMode' ? 'room_enter' : name;
        if (stored === 'room_enter') expected.roomEnters++;
        expected.events.push(`${sessionId}|${stored}|${t}`);
        if (sessionId !== 'anonymous') touch(sessionId, t).events++;
        expected.files[file].imported++;
        return event;
    };
    const eventHistory = [];
    for (let i = 0; i < o.eventsJson; i++) eventHistory.push(makeEvent(i, 'events.json', !o.malformed));
    if (o.malformed) {
        // Not a list at all: nothing of it can be imported.
        fs.writeFileSync(path.join(analytics, 'events.json'), JSON.stringify({ events: eventHistory.slice(0, 5) }));
        lastEventTime = null;
    } else {
        fs.writeFileSync(path.join(analytics, 'events.json'), JSON.stringify(eventHistory));
    }
    const eventLines = [];
    for (let i = 0; i < o.eventsLog; i++) eventLines.push(JSON.stringify(makeEvent(o.eventsJson + i, 'events.ndjson')));
    if (o.malformed) {
        const big = { id: g.uuid(), session_id: 'anonymous', event_name: 'ItemPlaced', properties: { Item: 'x'.repeat(o.readBytes + 5000) }, timestamp: iso(start + span) };
        eventLines.splice(5, 0, '{"id":"broken","event_name":', '123', '"just text"', '[1,2,3]', JSON.stringify({ id: g.uuid(), session_id: 'anonymous' }), '', '',
            JSON.stringify(big));
        expected.files['events.ndjson'].unreadable += 5;
        expected.files['events.ndjson'].oversized += 1;
    }
    let eventLog = eventLines.map((line) => line + '\n').join('');
    if (o.malformed) {
        // What a process leaves that was stopped in the middle of an append.
        eventLog += '{"id":"' + g.uuid() + '","session_id":"anonymous","event_name":"ItemPl';
        expected.files['events.ndjson'].unreadable += 1;
    }
    fs.writeFileSync(path.join(analytics, 'events.ndjson'), eventLog);

    // ---- crash reports: the list POST /api/crashes rewrites on every upload
    const messages = [];
    for (let k = 0; k < 12; k++) {
        messages.push({ text: `Assertion failed: Thing${k}.IsValid() [File:D:\\build\\Source\\SmallSpaces\\Thing${k}.cpp] [Line: ${100 + k}] \nmade up for the check`, key: `Thing${k}.cpp:${100 + k}`, type: 'Assert' });
    }
    messages.push({ text: 'Out of video memory trying to allocate a rendering resource. Make sure your video card has the minimum required memory.', type: 'GPUCrash' });
    messages.push({ text: 'Unhandled Exception: EXCEPTION_ACCESS_VIOLATION reading address 0x0000000012345678', key: 'Unhandled Exception: EXCEPTION_ACCESS_VIOLATION reading address 0x_', type: 'Crash' });
    for (const message of messages) if (!message.key) message.key = message.text.slice(0, 120);
    const frame = (n) => `SmallSpaces!UThing::Function${n}() [D:\\build\\Source\\SmallSpaces\\Private\\Thing.cpp:${n}]`;
    const crashList = [];
    let lastUpload = null;
    for (let i = 0; i < o.crashes; i++) {
        const id = g.uuid();
        const uploaded = Math.round(start + (i + g.random()) * (span / Math.max(1, o.crashes)));
        lastUpload = uploaded;
        const kind = g.random();
        const message = g.pick(messages);
        const context = kind < 0.12 ? null : {
            error_message: message.text, crash_type: message.type, is_assert: message.type === 'Assert', is_stall: false, is_oom: false,
            callstack_hash: crypto.createHash('sha1').update(message.key).digest('hex').slice(0, 16).toUpperCase(),
            callstack: Array.from({ length: o.callstackLines }, (unused, n) => frame(n + i % 7)).join('\n'),
            cpu: g.pick(['AMD Ryzen 7 5800X', 'Intel Core i7-12700K']), gpu: g.pick(['NVIDIA GeForce RTX 3060', 'AMD Radeon RX 6700 XT']),
            os: 'Windows 11', ram_gb: g.pick([16, 32]), engine_version: '5.6.1-44394996+++UE5+Release-5.6', build_config: 'Shipping',
            seconds_since_start: g.whole(5, 9000), locale: 'en-US',
            // The minidump's time: mostly a few minutes before the upload, sometimes missing or far off.
            crash_time: kind < 0.2 ? null : kind < 0.26 ? iso(uploaded - 200 * DAY) : iso(uploaded - g.whole(1, 600) * 1000)
        };
        const session = sessionIds.length > 0 && g.chance(0.7) ? g.pick(sessionIds).id : 'unknown';
        const version = g.pick(['1.2.0', '1.3.1', '1.3.2', 'unknown']);
        const entry = {
            id, filename: `UECC-Windows-${id.slice(0, 8).toUpperCase()}.zip`, stored_filename: `${id}_UECC-Windows-${id.slice(0, 8).toUpperCase()}.zip`,
            session_id: session, error_message: context ? context.error_message : '', file_size: g.whole(40000, 900000), upload_date: iso(uploaded),
            game: 'SmallSpaces', version, platform: context ? 'Windows' : 'unknown', rhi: 'D3D12', gpu: context ? context.gpu : 'unknown',
            driver: 'unknown', steam_appid: '', build_id: '', timestamp_utc: '', crash_context: context,
            category: context ? 'Fatal Error' : 'Unknown', crash_type: context ? context.crash_type : 'Unknown'
        };
        crashList.push(entry);
        const crashTime = context && context.crash_time ? Date.parse(context.crash_time) : null;
        const occurred = crashTime !== null && crashTime <= uploaded + 10 * MINUTE && crashTime >= uploaded - 90 * DAY ? crashTime : uploaded;
        const group = context ? message.key : 'no-context:unknown';
        expected.crashes.set(id, { received: uploaded, occurred, build: version === 'unknown' ? null : version,
            session_id: session === 'unknown' ? null : session, file: `crashes/${entry.stored_filename}`, group });
        const counted = expected.groups.get(group) || { count: 0, first: occurred, last: occurred };
        counted.count++;
        counted.first = Math.min(counted.first, occurred);
        counted.last = Math.max(counted.last, occurred);
        expected.groups.set(group, counted);
        expected.files['crashes_metadata.json'].imported++;
        if (i < 5) {
            // The archive of the old route, which nothing here may touch.
            fs.writeFileSync(path.join(storage, 'crashes', entry.stored_filename), `not really a zip ${id}`);
            expected.archives.push(entry.stored_filename);
        }
    }
    if (o.malformed && lastUpload !== null) {
        const id = g.uuid();
        const odd = { id, filename: 'odd.zip', stored_filename: `${id}_odd.zip`, session_id: 'unknown', error_message: 'context is text', file_size: 10,
            upload_date: iso(lastUpload + 1000), game: 'SmallSpaces', version: 'unknown', platform: 'Windows', crash_context: 'this should be an object' };
        const huge = { id: g.uuid(), filename: 'huge.zip', stored_filename: 'huge.zip', upload_date: iso(lastUpload),
            crash_context: { error_message: 'huge', callstack: 'y'.repeat(o.readBytes + 20000) } };
        const unstorable = { id: g.uuid(), filename: 'bad.zip', stored_filename: 'bad.zip', upload_date: iso(lastUpload), crash_context: { error_message: 5, crash_type: 'Crash' } };
        crashList.splice(3, 0, null, 'text where an entry should be', 42, { filename: 'no-id.zip', upload_date: iso(lastUpload) }, huge, unstorable);
        crashList.push(odd);
        expected.files['crashes_metadata.json'].unreadable += 4;
        expected.files['crashes_metadata.json'].oversized += 1;
        expected.files['crashes_metadata.json'].failed += 1;
        expected.files['crashes_metadata.json'].imported += 1;
        expected.crashes.set(id, { received: lastUpload + 1000, occurred: lastUpload + 1000, build: null, session_id: null, file: `crashes/${odd.stored_filename}`, group: 'no-context:unknown' });
        const counted = expected.groups.get('no-context:unknown') || { count: 0, first: lastUpload + 1000, last: lastUpload + 1000 };
        counted.count++;
        counted.last = Math.max(counted.last, lastUpload + 1000);
        expected.groups.set('no-context:unknown', counted);
    }
    fs.writeFileSync(path.join(storage, 'crashes_metadata.json'), JSON.stringify(crashList, null, 2));
    fs.writeFileSync(path.join(storage, 'crash_groups.json'), '[]');
    expected.eventLogBytes = Buffer.byteLength(eventLog);
    return expected;
}

module.exports = { writeOldFiles };
if (require.main !== module) return;

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

const AdmZip = require('adm-zip');
const { DatabaseSync } = require('node:sqlite');

const serverFile = path.join(__dirname, '..', 'server.js');
const port = Number(process.argv[2]) || 39484;
const ADMIN = 'local-test-only-' + process.pid; // throwaway key for this run only
const NOW = Date.now();
const storages = [];

let storage = null;
let child = null;
let serverOutput = '';
let failed = 0;
let number = 0;
let calls = 0;

function check(name, ok, detail) {
    number++;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(number).padStart(2, '0')}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
}

function call(method, urlPath, body, options = {}) {
    return new Promise((resolve) => {
        const headers = { 'X-Forwarded-For': options.from || `198.51.100.${(calls++ % 250) + 1}`, ...(options.headers || {}) };
        let data = null;
        if (Buffer.isBuffer(body)) {
            data = body;
            headers['Content-Type'] = options.type || 'application/zip';
        } else if (body) {
            data = Buffer.from(JSON.stringify(body));
            headers['Content-Type'] = 'application/json';
        }
        if (data) headers['Content-Length'] = data.length;
        if (options.admin) headers['x-admin-key'] = ADMIN;
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
                resolve({ status: res.statusCode, json, text });
            });
        });
        req.on('error', (err) => resolve({ status: 0, error: err.message }));
        if (data) req.write(data);
        req.end();
    });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newStorage() {
    storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-insights-import-check-'));
    storages.push(storage);
    return storage;
}
const dbFile = () => path.join(storage, 'insights', 'insights.db');
const spoolDir = () => path.join(storage, 'insights', 'spool');
const ownCrashDir = () => path.join(storage, 'insights', 'crashes');

async function startServer(extraEnv = {}) {
    serverOutput = '';
    child = spawn(process.execPath, [serverFile], {
        cwd: path.dirname(serverFile),
        // Only what the server needs: no key or address of a real service is passed on.
        env: { HOME: process.env.HOME, PATH: process.env.PATH, PORT: String(port), NODE_ENV: 'production',
            RAILWAY_VOLUME_MOUNT_PATH: storage, ADMIN_RESET_KEY: ADMIN, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (c) => { serverOutput += c; });
    child.stderr.on('data', (c) => { serverOutput += c; });
    for (let i = 0; i < 200; i++) {
        const r = await call('GET', '/api/health');
        if (r.status === 200) return;
        await sleep(50);
    }
    throw new Error('server did not start:\n' + serverOutput);
}

function stopServer(signal = 'SIGTERM') {
    return new Promise((resolve) => {
        if (!child) return resolve();
        const c = child;
        child = null;
        c.once('exit', () => resolve());
        c.kill(signal);
        if (signal !== 'SIGKILL') setTimeout(() => c.kill('SIGKILL'), 3000);
    });
}

const health = async () => (await call('GET', '/api/admin/v2/health', null, { admin: true })).json;
let cardCalls = 0;
// A changing parameter, so the 20-second cache of card answers is not in the way.
const card = (name, params = {}) => call('GET', `/api/admin/v2/q/${name}?` + new URLSearchParams({ ...params, n: String(cardCalls++) }).toString(), null, { admin: true });
const action = (name, body) => call('POST', `/api/admin/v2/do/${name}`, body, { admin: true });

async function waitFor(what, test, timeoutMs = 60000, everyMs = 50) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        last = await health();
        if (last && test(last)) return last;
        await sleep(everyMs);
    }
    throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last && { import: last.import, retention: last.retention, spool: last.spool })}\n${serverOutput.slice(-2000)}`);
}
const importDone = (timeoutMs) => waitFor('the import to finish', (h) => h.import && h.import.state !== 'running' && !h.import.pending, timeoutMs);
const settled = () => waitFor('the worker to catch up', (h) => h.database && h.database.status === 'ok' && h.spool.backlog_bytes === 0 && h.crashes_waiting === 0
    && h.import && h.import.state !== 'running' && !h.import.pending);

function rows(sql, ...params) {
    const db = new DatabaseSync(dbFile(), { readOnly: true });
    try {
        return db.prepare(sql).all(...params);
    } finally {
        db.close();
    }
}
const row = (sql, ...params) => rows(sql, ...params)[0];
const count = (table, where = '1 = 1', ...params) => Number(row(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...params).n);
// Changes the database directly. Only while the server is stopped.
function write(fn) {
    const db = new DatabaseSync(dbFile());
    try {
        db.exec('BEGIN');
        fn((sql, ...params) => db.prepare(sql).run(...params), (sql, ...params) => db.prepare(sql).all(...params));
        db.exec('COMMIT');
    } finally {
        db.close();
    }
}

const sha = (text) => crypto.createHash('sha1').update(text).digest('hex');
const OLD_FILES = ['crashes_metadata.json', 'crash_groups.json', 'analytics/sessions.json', 'analytics/sessions.ndjson', 'analytics/events.json', 'analytics/events.ndjson'];
const oldFileHashes = () => OLD_FILES.map((name) => {
    try { return sha(fs.readFileSync(path.join(storage, name))); } catch (error) { return 'missing'; }
}).join(' ');
const fileOf = (h, name) => h.import.files.find((file) => file.name === name);

// What the database holds of the old data, in a form two runs can be compared by.
function stored() {
    return {
        sessions: sha(rows('SELECT session_id, started_at, last_seen_at, event_count FROM sessions WHERE legacy = 1 ORDER BY session_id')
            .map((r) => `${r.session_id}|${r.started_at}|${r.last_seen_at}|${r.event_count}`).join('\n')),
        events: sha(rows('SELECT session_id, name, t FROM events WHERE legacy = 1').map((r) => `${r.session_id}|${r.name}|${r.t}`).sort().join('\n')),
        crashes: sha(rows('SELECT crash_guid, received_at, occurred_at, build, session_id, file FROM crashes WHERE legacy = 1 ORDER BY crash_guid')
            .map((r) => `${r.crash_guid}|${r.received_at}|${r.occurred_at}|${r.build}|${r.session_id}|${r.file}`).join('\n')),
        groups: sha(rows('SELECT group_key, count, first_seen, last_seen, status FROM crash_groups ORDER BY group_key')
            .map((r) => `${r.group_key}|${r.count}|${r.first_seen}|${r.last_seen}|${r.status}`).join('\n')),
        counts: { sessions: count('sessions'), events: count('events'), crashes: count('crashes'), groups: count('crash_groups') }
    };
}
function expectedStored(expected) {
    return {
        sessions: sha([...expected.sessions.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([id, s]) => `${id}|${s.started}|${s.last}|${s.events}`).join('\n')),
        events: sha([...expected.events].sort().join('\n')),
        crashes: sha([...expected.crashes.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
            .map(([id, c]) => `${id}|${c.received}|${c.occurred}|${c.build}|${c.session_id}|${c.file}`).join('\n')),
        groups: sha([...expected.groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([key, g]) => `${key}|${g.count}|${g.first}|${g.last}|open`).join('\n')),
        counts: { sessions: expected.sessions.size, events: expected.events.length, crashes: expected.crashes.size, groups: expected.groups.size }
    };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const kept = (retention) => ({ events_days: retention.events_days, reports_days: retention.reports_days, sessions_days: retention.sessions_days });
const differences = (a, b) => Object.keys(a).filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));

function zipOf(files) {
    const zip = new AdmZip();
    for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content));
    return zip.toBuffer();
}
const crashXml = (message) => `<?xml version="1.0" encoding="UTF-8"?>
<FGenericCrashContext><RuntimeProperties>
<CrashType>Assert</CrashType><ErrorMessage>${message}</ErrorMessage><IsAssert>true</IsAssert>
<PCallStackHash>ABCDEF0123</PCallStackHash><PCallStack>SmallSpaces 0x0000000140000000 + 12345</PCallStack>
<Misc.CPUBrand>Test CPU 9000</Misc.CPUBrand><Misc.PrimaryGPUBrand>Test GPU 4080</Misc.PrimaryGPUBrand><Misc.OSVersionMajor>Windows 11</Misc.OSVersionMajor>
<MemoryStats.TotalPhysicalGB>32</MemoryStats.TotalPhysicalGB><EngineVersion>5.8.4-0+UE5</EngineVersion><SecondsSinceStart>77</SecondsSinceStart>
</RuntimeProperties></FGenericCrashContext>`;
const crashZip = (message) => zipOf({ 'CrashContext.runtime-xml': crashXml(message) });
const newId = () => crypto.randomUUID();
const collect = (installId, sessionId, events) => call('POST', '/api/v2/collect', { schema: 2, install_id: installId, session_id: sessionId,
    build: '1.4.0', steam_build: 20001, platform: 'Windows', sent_at: Date.now(), events });
const uploadCrash = (guid, message, extra = {}) => call('POST', '/api/v2/crashes?' + new URLSearchParams({ crash_guid: guid, build: '1.4.0', platform: 'Windows', ...extra }).toString(),
    crashZip(message));
// What an old build sends: a session, a batch, single events, a crash report.
async function oldBuildSends(label, events) {
    const started = await call('POST', '/api/analytics/session/start', { client_version: '1.3.2', platform: 'Mac', metadata: { os: 'macOS' } });
    const sessionId = started.json && started.json.session_id;
    const batch = [];
    for (let i = 0; i < events - 2; i++) batch.push({ event_name: i % 2 ? 'TrackGameMode' : 'ItemPlaced', properties: i % 2 ? { GameMode: 'Design' } : { Item: `${label}-${i}` }, timestamp: new Date().toISOString() });
    const sent = await call('POST', '/api/analytics/batch', { session_id: sessionId, client_version: '1.3.2', platform: 'Mac', events: batch });
    const one = await call('POST', '/api/analytics/event', { session_id: sessionId, event_name: 'PhotoTaken', properties: { From: label }, client_version: '1.3.2', platform: 'Mac' });
    const two = await call('POST', '/api/analytics/event', { session_id: sessionId, event_name: 'TrackGameMode', properties: { GameMode: 'Creative' }, client_version: '1.3.2', platform: 'Mac' });
    const crash = await call('POST', '/api/crashes', { crashData: crashZip(`Assertion failed: Seam() [File:D:\\x\\Seam.cpp] [Line: 7] ${label}`).toString('base64'),
        filename: `UECC-${label}.zip`, sessionId, metadata: { platform: 'Mac', version: '1.3.2' } });
    const ok = started.status === 200 && sent.status === 200 && one.status === 200 && two.status === 200 && crash.status === 200;
    return { ok, sessionId, events, crashId: crash.json && crash.json.crash_id };
}

// The same sent to the server as it was between the store's start and the end of
// the old dashboard: the old routes wrote their own files and copied every line
// into the spool. Written here directly, in the shapes of that server.
async function oldServerStored(label, events) {
    const sessionId = newId();
    const now = Date.now();
    const line = (file, record) => fs.appendFileSync(path.join(storage, 'analytics', file), JSON.stringify(record) + '\n');
    fs.mkdirSync(spoolDir(), { recursive: true });
    const copy = (record) => fs.appendFileSync(path.join(spoolDir(), `collect-${new Date(now).toISOString().slice(0, 10)}.ndjson`), JSON.stringify(record) + '\n');
    const session = { id: sessionId, start_time: new Date(now).toISOString(), client_version: '1.3.2', platform: 'Mac', metadata: { os: 'macOS' } };
    line('sessions.ndjson', { ...session, end_time: null, event_count: 0 });
    copy({ type: 'legacy_session', legacy: true, received_at: now, session });
    const list = [];
    for (let n = 0; n < events; n++) list.push({ id: newId(), session_id: sessionId, event_name: n % 2 ? 'TrackGameMode' : 'ItemPlaced',
        properties: n % 2 ? { GameMode: 'Design' } : { Item: `${label}-${n}` }, timestamp: new Date(now + n).toISOString(), client_version: '1.3.2', platform: 'Mac' });
    for (const event of list) line('events.ndjson', event);
    copy({ type: 'legacy_events', legacy: true, received_at: now, events: list });
    const crashId = newId();
    const metadata = { id: crashId, filename: `UECC-${label}.zip`, stored_filename: `${crashId}_UECC-${label}.zip`, session_id: sessionId, error_message: '', file_size: 10,
        upload_date: new Date(now).toISOString(), version: '1.3.2', platform: 'Windows', gpu: 'unknown',
        crash_context: { error_message: `Assertion failed: Seam() [File:D:\\x\\Seam.cpp] [Line: 7] ${label}`, crash_type: 'Assert', callstack: '', crash_time: null } };
    const listFile = path.join(storage, 'crashes_metadata.json');
    fs.writeFileSync(listFile, JSON.stringify([...JSON.parse(fs.readFileSync(listFile, 'utf8')), metadata], null, 2));
    copy({ type: 'legacy_crash', legacy: true, received_at: now, crash_id: crashId, file: `crashes/${metadata.stored_filename}`, platform: 'Mac', metadata });
    return { ok: true, sessionId, events, crashId };
}

const SMALL = { sessionsJson: 500, sessionsLog: 400, eventsJson: 2500, eventsLog: 2000, crashes: 60 };

(async () => {
    // ====================================================================== full import
    newStorage();
    const expected = writeOldFiles(storage, { now: NOW });
    const wanted = expectedStored(expected);
    const hashesBefore = oldFileHashes();
    const eventLogSize = fs.statSync(path.join(storage, 'analytics', 'events.ndjson')).size;
    await startServer();
    let h = await importDone();
    await settled();
    const first = stored();
    const firstImport = h.import;
    check('the import finishes and says what it imported: every session start, event and crash report of the old files',
        h.import.state === 'done' && h.import.imported.sessions === expected.files['sessions.json'].imported + expected.files['sessions.ndjson'].imported
        && h.import.imported.events === expected.events.length && h.import.imported.crashes === expected.crashes.size
        && h.import.skipped.unreadable === 0 && h.import.skipped.oversized === 0 && h.import.skipped.failed === 0 && h.import.problems.length === 0 && h.import.progress === 1,
        { state: h.import.state, imported: h.import.imported, skipped: h.import.skipped, seconds: (h.import.finished_at - h.import.started_at) / 1000 });
    check('exact rows: one session per old session id (also those only events name), with the start of the old record and the last time anything was heard of it',
        first.sessions === wanted.sessions && first.counts.sessions === wanted.counts.sessions && count('sessions', 'legacy = 0') === 0,
        { sessions: first.counts.sessions, expected: wanted.counts.sessions });
    check('exact rows: every old event once, under its new name, at its own time (or the time of the line before it when its own is not believable)',
        first.events === wanted.events && first.counts.events === wanted.counts.events
        && count('events', "name = 'room_enter' AND legacy = 1") === expected.roomEnters && count('events', "name = 'TrackGameMode'") === 0
        && h.import.files.reduce((sum, file) => sum + file.times_replaced, 0) === expected.timesReplaced,
        { events: first.counts.events, expected: wanted.counts.events, room_enter: expected.roomEnters, times_replaced: expected.timesReplaced });
    const sampleEnter = row("SELECT props, registered, install_id, seq FROM events WHERE name = 'room_enter' LIMIT 1");
    check('an old TrackGameMode is stored as room_enter with its mode, without install and without sequence number',
        sampleEnter && Object.values(LEGACY_MODES).includes(JSON.parse(sampleEnter.props).mode) && sampleEnter.registered === 1 && sampleEnter.install_id === null && sampleEnter.seq === null,
        sampleEnter);
    check('exact rows: every old crash report once, received at its upload date, happened at the minidump time when that is within 90 days before it',
        first.crashes === wanted.crashes && first.counts.crashes === wanted.counts.crashes && count('crashes', 'parsed <> 1 OR has_context IS NULL') === 0,
        { crashes: first.counts.crashes, expected: wanted.counts.crashes });
    check('the platform of an old crash report is empty (the old file says Windows for nearly all of them), and no archive was read',
        count('crashes', 'platform IS NOT NULL') === 0 && count('crashes', "file NOT LIKE 'crashes/%'") === 0
        && rows('SELECT platforms FROM crash_groups').every((r) => r.platforms === '[]'), { with_platform: count('crashes', 'platform IS NOT NULL') });
    const frame = (await call('GET', '/api/admin/v2/frame', null, { admin: true })).json;
    check('imported crash issues are open, not new: the same groups and counts as the old reports give, first and last seen from the reports',
        first.groups === wanted.groups && count('crash_groups', "status <> 'open'") === 0 && frame && frame.new_issues === 0
        && Number(row('SELECT SUM(count) AS n FROM crash_groups').n) === expected.crashes.size,
        { groups: first.counts.groups, expected: wanted.counts.groups, new_issues: frame && frame.new_issues });
    check('nothing else was made up: no installs, no active days, and the old files are byte for byte what they were',
        count('installs') === 0 && count('install_days') === 0 && oldFileHashes() === hashesBefore, { installs: count('installs') });
    check('the log of the old events was read up to its size at the first start',
        fileOf(h, 'events.ndjson').bytes_total === eventLogSize && fileOf(h, 'events.ndjson').state === 'done', fileOf(h, 'events.ndjson'));
    const said = serverOutput.split('\n').filter((line) => line.includes('import:'));
    check('the server log says two lines about it: started, and finished with the totals', said.length === 2 && /are imported: \d+ sessions, \d+ events, \d+ crash reports/.test(said[1]), said);

    // ---- the Settings card
    const dataCard = await card('maintenance.data');
    const d = dataCard.json && dataCard.json.data;
    check('maintenance.data: retention defaults 90 / 90 / for ever, deleted every 24 hours and not yet, the options, storage used, the size of the volume, and the import',
        dataCard.status === 200 && same(d.retention, { events_days: 90, reports_days: 90, sessions_days: 0, last_run_at: null, every_hours: 24 }) && same(d.options, [30, 90, 180, 365, 0])
        && Number.isFinite(d.storage.capacity_bytes) && Number.isFinite(d.storage.free_bytes) && d.storage.free_bytes > 0 && d.storage.capacity_bytes > d.storage.free_bytes
        && d.storage.database_bytes > 100000 && d.storage.archives_bytes === 0 && d.storage.spool_bytes >= 0
        && d.storage.total_bytes === d.storage.database_bytes + d.storage.archives_bytes + d.storage.spool_bytes
        && same(d.storage.rows, { events: first.counts.events, sessions: first.counts.sessions, crashes: first.counts.crashes, installs: 0 })
        && d.import.state === 'done' && d.import.imported.events === expected.events.length,
        d && { retention: d.retention, options: d.options, storage: d.storage, import: d.import.state });
    const nextPrune = new Date(d.prune.next_at);
    check('nothing is pruned at the first start: the first prune is due at the first 03:00 UTC that is a day or more away, and events older than 90 days are still there',
        nextPrune.getUTCHours() === 3 && nextPrune.getUTCMinutes() === 0 && d.prune.next_at - Date.now() > DAY - MINUTE && d.prune.next_at - Date.now() <= 2 * DAY
        && d.prune.last_at === null && count('events', 't < ?', NOW - 90 * DAY) > 1000,
        { next: nextPrune.toISOString(), older_than_90_days: count('events', 't < ?', NOW - 90 * DAY) });

    // ====================================================================== a second start
    await stopServer();
    await startServer();
    await sleep(4500); // longer than the import waits before it looks at the spool again
    h = await settled();
    check('a second start imports nothing: same rows, same finish time, nothing said',
        same(stored(), first) && h.import.state === 'done' && h.import.finished_at === firstImport.finished_at && !serverOutput.includes('import:'),
        { same_rows: same(stored(), first), said: serverOutput.split('\n').filter((line) => line.includes('import:')) });
    await stopServer();

    // ====================================================================== stopped in the middle, three times
    newStorage();
    writeOldFiles(storage, { now: NOW });
    const small = { INSIGHTS_IMPORT_READ_BYTES: '16384' }; // many small steps, so there is a middle to stop in
    const kills = [];
    for (const threshold of [0.15, 0.45, 0.75]) {
        await startServer(small);
        let at = null;
        for (let i = 0; i < 4000; i++) {
            const now = await health();
            if (now && now.import && now.import.state === 'running' && now.import.progress >= threshold) {
                at = now.import.progress;
                break;
            }
            if (now && now.import && (now.import.state === 'done' || now.import.state === 'none')) break;
            await sleep(5);
        }
        await stopServer('SIGKILL');
        kills.push(at === null ? null : Number(at.toFixed(3)));
    }
    await startServer(small);
    h = await importDone();
    await settled();
    const afterKills = stored();
    check('the server was killed three times in the middle of the import',
        kills.every((at) => at !== null && at < 1) && kills[0] < kills[1] && kills[1] < kills[2], { killed_at_progress: kills });
    check('after the kills the database holds exactly what an import in one go gives: no gap and no duplicate',
        same(afterKills, first) && same(afterKills, wanted) && h.import.imported.events === expected.events.length
        && h.import.imported.sessions === firstImport.imported.sessions && h.import.imported.crashes === expected.crashes.size,
        { different: differences(afterKills, first), counts: afterKills.counts, imported: h.import.imported });

    // ====================================================================== new builds are stored while the import runs
    await stopServer();
    newStorage();
    writeOldFiles(storage, { now: NOW });
    await startServer({ INSIGHTS_IMPORT_READ_BYTES: '8192' });
    await waitFor('the import to start', (now) => now.import && now.import.state === 'running', 10000, 5);
    const install = newId();
    const delays = [];
    let stillRunning = 0;
    for (let i = 0; i < 6; i++) {
        const sessionId = newId();
        const sent = Date.now();
        const answer = await collect(install, sessionId, [{ name: 'session_start', t: Date.now(), seq: 0, props: { language: 'de' } }, { name: 'menu_shown', t: Date.now(), seq: 1, props: { startup_s: 4 } }]);
        let seen = null;
        for (let n = 0; n < 400 && answer.status === 202; n++) {
            seen = await health();
            if (seen && seen.tables && seen.tables.installs === 1 && seen.events_last_hour.some((e) => e.name === 'menu_shown' && e.count === i + 1)) break;
            seen = null;
            await sleep(5);
        }
        if (seen) delays.push(Date.now() - sent);
        if (seen && seen.import.state === 'running') stillRunning++;
        await sleep(40);
    }
    check('what a new build sends while the import runs is stored within a moment, not after the import',
        delays.length === 6 && stillRunning >= 3 && Math.max(...delays) < 1500, { ms_until_stored: delays, import_still_running: `${stillRunning} of 6` });
    h = await importDone();
    await settled();
    const withNew = stored();
    check('and the import still ends with exactly the old rows, beside the new ones',
        withNew.events === first.events && withNew.sessions === first.sessions && withNew.crashes === first.crashes
        && count('sessions', 'legacy = 0') === 6 && count('events', 'legacy = 0') === 12 && count('installs') === 1,
        { new_sessions: count('sessions', 'legacy = 0'), new_events: count('events', 'legacy = 0') });
    await stopServer();

    // ====================================================================== usage events deleted while the import runs
    newStorage();
    writeOldFiles(storage, { now: NOW });
    await startServer({ INSIGHTS_IMPORT_READ_BYTES: '8192' });
    const whenDeleted = await waitFor('the import to reach the events', (now) => now.import && fileOf(now, 'events.json').state === 'running' && fileOf(now, 'events.json').imported > 2000, 30000, 5);
    const deletedMidway = await action('maintenance.delete', { what: 'events', confirm: 'delete events' });
    h = await importDone();
    await settled();
    check('delete events while the import runs: the import of the old events stops there and brings none back; sessions and crash reports are imported in full',
        deletedMidway.status === 200 && deletedMidway.json.deleted.events > 2000 && count('events') === 0
        && fileOf(h, 'events.json').state === 'cancelled' && fileOf(h, 'events.ndjson').state === 'cancelled' && h.import.state === 'done'
        && fileOf(h, 'events.json').imported < expected.files['events.json'].imported && fileOf(h, 'events.ndjson').imported === 0
        && h.import.imported.sessions === firstImport.imported.sessions && same(stored().crashes, first.crashes) && count('sessions') >= expected.files['sessions.json'].imported,
        { deleted: deletedMidway.json && deletedMidway.json.deleted, events_imported_before: fileOf(whenDeleted, 'events.json').imported, events: count('events'),
            states: [fileOf(h, 'events.json').state, fileOf(h, 'events.ndjson').state], note: fileOf(h, 'events.json').note });
    await stopServer();

    // ====================================================================== the seam: old routes copied lines before the import began
    newStorage();
    const seamExpected = writeOldFiles(storage, { now: NOW, ...SMALL });
    const seamLogSize = fs.statSync(path.join(storage, 'analytics', 'events.ndjson')).size;
    // Copied by the server of that time, while the store had no database (as on
    // a server whose Node is too old), so nothing was imported yet.
    const before1 = await oldServerStored('before-a', 40);
    const before2 = await oldServerStored('before-b', 25);
    const grownLogSize = fs.statSync(path.join(storage, 'analytics', 'events.ndjson')).size;
    await startServer({ INSIGHTS_IMPORT_READ_BYTES: '16384' });
    const during = await oldBuildSends('during', 30);
    const after1 = await collect(newId(), newId(), [{ name: 'session_start', t: Date.now(), seq: 0, props: {} }]);
    h = await importDone();
    const late = await oldBuildSends('after', 12);
    h = await settled();
    const sentOld = [before1, before2, during, late];
    const perSession = sentOld.map((sent) => count('events', 'session_id = ? AND legacy = 1', sent.sessionId));
    const seamFile = fileOf(h, 'events.ndjson');
    check('sessions, events and crash reports of old versions arrive before, during and after the import; after the old dashboard only the spool is written', sentOld.every((sent) => sent.ok) && after1.status === 202 && grownLogSize > seamLogSize
        && fs.statSync(path.join(storage, 'analytics', 'events.ndjson')).size === grownLogSize,
        { log_bytes_before: seamLogSize, log_bytes_at_import: grownLogSize });
    check('the import ends exactly where the copies begin: the log is read up to the first line that is also in the spool',
        seamFile.state === 'done' && seamFile.bytes_total === seamLogSize && seamFile.imported === seamExpected.files['events.ndjson'].imported,
        { read_up_to: seamFile.bytes_total, first_copied_line_at: seamLogSize, imported: seamFile.imported });
    check('every event an old build sent is stored once: none missing, none twice, whether it came before, during or after the import',
        same(perSession, sentOld.map((sent) => sent.events)) && count('events', 'legacy = 1') === seamExpected.events.length + sentOld.reduce((sum, sent) => sum + sent.events, 0),
        { per_session: perSession, sent: sentOld.map((sent) => sent.events), old_events: count('events', 'legacy = 1') });
    check('their sessions and crash reports are stored once too, and a crash report that came through the old route keeps the platform the game sent',
        sentOld.every((sent) => count('sessions', 'session_id = ?', sent.sessionId) === 1 && count('crashes', 'crash_guid = ?', sent.crashId) === 1)
        && count('crashes') === seamExpected.crashes.size + 4 && count('sessions', 'legacy = 1') === seamExpected.sessions.size + 4
        && rows('SELECT platform FROM crashes WHERE crash_guid IN (?, ?, ?, ?)', ...sentOld.map((sent) => sent.crashId)).every((r) => r.platform === 'Mac')
        && Number(row("SELECT count FROM crash_groups WHERE group_key = 'Seam.cpp:7'").count) === 4,
        { crashes: count('crashes'), expected: seamExpected.crashes.size + 4, sessions: count('sessions', 'legacy = 1') });
    await stopServer();

    // ---- the seam cannot be found: copied events are stored, the spool that named the first of them is gone
    newStorage();
    writeOldFiles(storage, { now: NOW, sessionsJson: 0, sessionsLog: 0, eventsJson: 0, eventsLog: 0, crashes: 0 });
    await startServer();
    h = await importDone();
    const nothing = h.import.state;
    const copied = await oldServerStored('copied', 20);
    await settled();
    await stopServer();
    for (const name of fs.readdirSync(spoolDir())) fs.unlinkSync(path.join(spoolDir(), name));
    write((run) => {
        run("DELETE FROM meta WHERE key = 'import'");
        run('DELETE FROM spool_offsets');
    });
    const copiedEvents = count('events');
    await startServer();
    h = await importDone();
    await settled();
    check('empty old files: the import says there was nothing', nothing === 'none', { state: nothing });
    check('when the first copied events are no longer in the spool, the event log is not imported at all instead of risking every line twice; the health view says why',
        copied.ok && fileOf(h, 'events.ndjson').state === 'blocked' && count('events') === copiedEvents && copiedEvents === 20
        && h.import.state === 'done' && h.import.problems.some((problem) => problem.includes('events.ndjson') && problem.includes('cannot be found'))
        && serverOutput.includes('import: events.ndjson:'),
        { file: fileOf(h, 'events.ndjson'), events: count('events') });
    await stopServer();

    // ====================================================================== broken input
    newStorage();
    const READ = 65536;
    const broken = writeOldFiles(storage, { now: NOW, ...SMALL, malformed: true, readBytes: READ });
    const brokenHashes = oldFileHashes();
    await startServer({ INSIGHTS_IMPORT_READ_BYTES: String(READ) });
    h = await importDone();
    await settled();
    const got = Object.fromEntries(h.import.files.map((file) => [file.name, file]));
    const fits = (name) => got[name].imported === broken.files[name].imported && got[name].unreadable === broken.files[name].unreadable
        && got[name].oversized === broken.files[name].oversized && got[name].failed === (broken.files[name].failed || 0);
    check('broken lines in the logs are skipped and counted: not JSON, not an object, no name, a line longer than the limit, a half-written last line',
        fits('events.ndjson') && fits('sessions.ndjson') && got['events.ndjson'].state === 'done' && got['sessions.ndjson'].state === 'done',
        { 'events.ndjson': [got['events.ndjson'].imported, got['events.ndjson'].unreadable, got['events.ndjson'].oversized],
            expected: [broken.files['events.ndjson'].imported, broken.files['events.ndjson'].unreadable, broken.files['events.ndjson'].oversized],
            'sessions.ndjson': [got['sessions.ndjson'].imported, got['sessions.ndjson'].unreadable] });
    check('a history file that is not a list is left out whole; one that ends in the middle of an entry gives every entry before it',
        got['events.json'].state === 'unreadable' && got['events.json'].imported === 0 && fits('sessions.json') && got['sessions.json'].state === 'done'
        && /middle of an entry/.test(got['sessions.json'].note),
        { 'events.json': [got['events.json'].state, got['events.json'].note], 'sessions.json': [got['sessions.json'].imported, got['sessions.json'].unreadable, got['sessions.json'].note] });
    check('the crash list: entries that are not reports, one over the size limit and one that cannot be stored are counted, every other report is imported',
        fits('crashes_metadata.json') && count('crashes') === broken.crashes.size && same(stored().crashes, expectedStored(broken).crashes)
        && same(stored().groups, expectedStored(broken).groups),
        { got: [got['crashes_metadata.json'].imported, got['crashes_metadata.json'].unreadable, got['crashes_metadata.json'].oversized, got['crashes_metadata.json'].failed],
            expected: broken.files['crashes_metadata.json'] });
    const brokenLines = serverOutput.split('\n').filter((line) => line.includes('import: ') && !line.includes('reading the files') && !line.includes('are imported'));
    check('exact rows from what was readable, one log line per file that had something wrong, and the old files were not changed (a half-written last line included)',
        count('events') === broken.events.length && same(stored().events, expectedStored(broken).events) && count('sessions', 'legacy = 1') === broken.sessions.size
        && brokenLines.length === 5 && h.import.state === 'done' && h.worker.status === 'running'
        && oldFileHashes() === brokenHashes
        && fs.statSync(path.join(storage, 'analytics', 'events.ndjson')).size === broken.eventLogBytes,
        { events: count('events'), expected: broken.events.length, lines: brokenLines.map((line) => line.slice(0, 110)) });
    const afterBroken = await collect(newId(), newId(), [{ name: 'session_start', t: Date.now(), seq: 0, props: {} }]);
    await settled();
    check('the worker goes on storing what the game sends after all that', afterBroken.status === 202 && count('events', 'legacy = 0') === 1);
    await stopServer();

    // ---- the crash list read while the old route is rewriting it
    newStorage();
    const rewritten = writeOldFiles(storage, { now: NOW, sessionsJson: 0, sessionsLog: 0, eventsJson: 0, eventsLog: 0, crashes: 80 });
    const listFile = path.join(storage, 'crashes_metadata.json');
    const whole = fs.readFileSync(listFile);
    fs.writeFileSync(listFile, whole.subarray(0, Math.floor(whole.length * 0.6))); // as if caught half-written
    await startServer();
    await sleep(2500);
    const midway = await health();
    fs.writeFileSync(listFile, whole);
    h = await importDone();
    check('a crash list that is cut off is not taken as final at once: when the whole list is there a moment later, every report is imported once',
        midway.import.state === 'running' && count('crashes') === rewritten.crashes.size && same(stored().crashes, expectedStored(rewritten).crashes)
        && same(stored().groups, expectedStored(rewritten).groups) && fileOf(h, 'crashes_metadata.json').unreadable === 0,
        { midway: midway.import.state, crashes: count('crashes'), expected: rewritten.crashes.size });
    await stopServer();

    // ====================================================================== retention
    newStorage();
    await startServer();
    await importDone();
    const keptInstall = newId();
    await collect(keptInstall, newId(), [{ name: 'session_start', t: Date.now(), seq: 0, props: {} }]);
    const ages = [5, 40, 100, 200, 400];
    const ownGuids = ages.map((age) => `own-report-${age}-days`);
    for (const guid of ownGuids) await uploadCrash(guid, `Assertion failed: Kept() [File:D:\\x\\Kept.cpp] [Line: 9] ${guid}`);
    await settled();
    const badRetention = [
        await action('maintenance.set_retention', { events_days: 45 }),
        await action('maintenance.set_retention', { events_days: '30' }),
        await action('maintenance.set_retention', { event_days: 30 }),
        await action('maintenance.set_retention', {})
    ];
    const afterBad = kept((await card('maintenance.data')).json.data.retention);
    check('set_retention takes only the listed options and the three settings; anything else is refused and changes nothing',
        badRetention.every((answer) => answer.status === 400 && answer.json.error === 'invalid') && same(afterBad, { events_days: 90, reports_days: 90, sessions_days: 0 }),
        { statuses: badRetention.map((answer) => answer.status), detail: badRetention[0].json && badRetention[0].json.detail });
    await stopServer();

    // Rows of every age, written directly: 20 events, 4 sessions and 2 crash
    // reports per age (one of ours with its archive, one of the old route).
    const legacyArchives = ages.map((age) => `legacy-report-${age}-days.zip`);
    write((run) => {
        for (const age of ages) {
            const t = NOW - age * DAY - HOUR;
            for (let i = 0; i < 20; i++) run('INSERT INTO events (session_id, install_id, name, t, seq, legacy, props) VALUES (?, ?, ?, ?, ?, ?, ?)', `s-${age}-${i % 4}`, keptInstall, 'room_enter', t - i, i, i % 2, '{}');
            for (let i = 0; i < 4; i++) run('INSERT INTO sessions (session_id, install_id, legacy, started_at, last_seen_at, event_count) VALUES (?, ?, ?, ?, ?, 5)', `s-${age}-${i}`, i % 2 ? keptInstall : null, i % 2 ? 0 : 1, t - HOUR, t);
            run('UPDATE crashes SET received_at = ?, occurred_at = ? WHERE crash_guid = ?', t, t, `own-report-${age}-days`);
            run(`INSERT INTO crashes (crash_guid, legacy, received_at, occurred_at, file, file_size, parsed, group_id) VALUES (?, 1, ?, ?, ?, 10, 1, (SELECT id FROM crash_groups LIMIT 1))`,
                `legacy-report-${age}-days`, t, t, `crashes/legacy-report-${age}-days.zip`);
            run('INSERT INTO install_days (install_id, day) VALUES (?, ?)', keptInstall, new Date(t).toISOString().slice(0, 10));
            run('INSERT INTO counters (day, key, n) VALUES (?, ?, 3)', new Date(t).toISOString().slice(0, 10), 'crash_upload_abandoned');
        }
        run("UPDATE crash_groups SET count = 10, status = 'fixed', notes = 'a note that must stay'");
    });
    for (const name of legacyArchives) fs.writeFileSync(path.join(storage, 'crashes', name), 'the old route owns this file');
    const tables = () => ({
        events: rows('SELECT t FROM events ORDER BY t').map((r) => Math.round((NOW - r.t) / DAY)).filter((age) => age > 1).reduce((map, age) => ({ ...map, [age]: (map[age] || 0) + 1 }), {}),
        sessions: rows("SELECT session_id FROM sessions WHERE session_id LIKE 's-%' ORDER BY session_id").map((r) => r.session_id).join(' '),
        crashes: rows('SELECT crash_guid FROM crashes ORDER BY crash_guid').map((r) => r.crash_guid).join(' '),
        archives: fs.readdirSync(ownCrashDir()).sort().join(' '),
        legacy_archives: fs.readdirSync(path.join(storage, 'crashes')).sort().join(' '),
        groups: JSON.stringify(rows('SELECT group_key, count, status, notes, first_seen, last_seen FROM crash_groups')),
        installs: JSON.stringify(rows('SELECT * FROM installs')),
        install_days: count('install_days'),
        counters: JSON.stringify(rows('SELECT * FROM counters ORDER BY day, key'))
    });
    // One night: set the settings, make the prune due, let it run.
    async function night(settings) {
        await startServer();
        await settled();
        const set = await action('maintenance.set_retention', settings);
        const lastBefore = (await health()).retention.last_at;
        await stopServer();
        write((run, all) => {
            const value = JSON.parse(all("SELECT value FROM meta WHERE key = 'retention.run'")[0].value);
            value.due_at = Date.now() - 1000;
            run("UPDATE meta SET value = ? WHERE key = 'retention.run'", JSON.stringify(value));
        });
        await startServer();
        const done = await waitFor('the prune to finish', (now) => now.retention && now.retention.last_at !== null && now.retention.last_at !== lastBefore && !now.retention.running, 20000);
        await stopServer();
        return { set, done };
    }
    const start0 = tables();
    const night1 = await night({ events_days: 30, reports_days: 0, sessions_days: 0 });
    const t1 = tables();
    check('events kept 30 days: the events older than that are gone (60 of 100), and nothing else changed',
        night1.set.status === 200 && same(t1.events, { 5: 20 }) && same({ ...t1, events: 0 }, { ...start0, events: 0 })
        && night1.done.retention.last_deleted.events === 80 && night1.done.retention.last_deleted.reports === 0 && night1.done.retention.last_deleted.sessions === 0,
        { events_by_age_in_days: t1.events, before: start0.events, deleted: night1.done.retention.last_deleted, changed: differences(t1, start0) });
    const night2 = await night({ events_days: 0, reports_days: 90, sessions_days: 0 });
    const t2 = tables();
    const keptReports = ['legacy-report-40-days', 'legacy-report-5-days', 'own-report-40-days', 'own-report-5-days'].join(' ');
    check('crash reports kept 90 days: older reports are gone with our archives of them; the old route\'s files, the issues and their counts, and everything else are untouched',
        t2.crashes === keptReports && t2.archives === 'own-report-40-days.zip own-report-5-days.zip' && t2.legacy_archives === t1.legacy_archives
        && legacyArchives.every((name) => fs.existsSync(path.join(storage, 'crashes', name)))
        && same({ ...t2, crashes: 0, archives: 0 }, { ...t1, crashes: 0, archives: 0 }) && t2.groups.includes('a note that must stay') && t2.groups.includes('"count":10')
        && night2.done.retention.last_deleted.reports === 6 && night2.done.retention.last_deleted.archives === 3 && night2.done.retention.last_deleted.events === 0,
        { crashes: t2.crashes, archives: t2.archives, deleted: night2.done.retention.last_deleted, changed: differences(t2, t1) });
    const night3 = await night({ events_days: 0, reports_days: 0, sessions_days: 180 });
    const t3 = tables();
    check('sessions kept 180 days: sessions last seen before that are gone (8 of 20), nothing else',
        t3.sessions === ['100', '40', '5'].flatMap((age) => [0, 1, 2, 3].map((i) => `s-${age}-${i}`)).sort().join(' ')
        && same({ ...t3, sessions: 0 }, { ...t2, sessions: 0 }) && night3.done.retention.last_deleted.sessions === 8,
        { sessions: t3.sessions.split(' ').length, deleted: night3.done.retention.last_deleted, changed: differences(t3, t2) });
    const night4 = await night({ events_days: 0, reports_days: 0, sessions_days: 0 });
    const t4 = tables();
    check('everything on "for ever": a night deletes nothing; installs, active days and counters were never touched in any night',
        same(t4, t3) && same(night4.done.retention.last_deleted, { events: 0, reports: 0, archives: 0, archives_bytes: 0, sessions: 0 })
        && t4.installs === start0.installs && t4.install_days === start0.install_days && t4.counters === start0.counters,
        { deleted: night4.done.retention.last_deleted });
    check('each night is in the server log and the change of settings in the change log',
        serverOutput.includes('retention: nightly prune done') && count('admin_log', "kind = 'maintenance.set_retention'") === 4,
        { log_rows: count('admin_log', "kind = 'maintenance.set_retention'") });
    await startServer();
    await settled();
    const afterNights = (await card('maintenance.data')).json.data;
    check('the Settings card says when older data was last deleted, and set_retention answers with the same shape',
        afterNights.retention.last_run_at === night4.done.retention.last_at && Date.now() - afterNights.retention.last_run_at < 5 * MINUTE
        && afterNights.retention.every_hours === 24 && same(Object.keys(night4.set.json.retention), ['events_days', 'reports_days', 'sessions_days', 'last_run_at', 'every_hours']),
        { retention: afterNights.retention, set_retention_answer: night4.set.json });
    await stopServer();

    // ====================================================================== export
    const fullInstall = '0123456789abcdef0123456789abcdef';
    write((run) => {
        run('INSERT INTO installs (install_id, first_seen, last_seen, platform) VALUES (?, ?, ?, ?)', fullInstall, NOW - 20 * DAY, NOW, 'Mac');
        run('INSERT INTO sessions (session_id, install_id, legacy, started_at, last_seen_at, event_count, platform, build) VALUES (?, ?, 0, ?, ?, 0, ?, ?)', 'export-mac-session-0001', fullInstall, NOW - 3 * DAY, NOW - 3 * DAY, 'Mac', '1.4.1');
        for (let i = 0; i < 50500; i++) {
            run('INSERT INTO events (session_id, install_id, name, t, seq, build, platform, legacy, props) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
                'export-mac-session-0001', fullInstall, 'room_ready', NOW - 20 * DAY + i * 1000, i, '1.4.1', 'Mac', '{"mode":"design","load_s":3.5}');
        }
        for (let i = 0; i < 300; i++) {
            run('INSERT INTO events (session_id, install_id, name, t, seq, build, platform, legacy, props) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
                'export-mac-session-0001', fullInstall, 'photo_taken', NOW - 2 * DAY + i * 1000, 60000 + i, '1.4.1', 'Mac', '{"mode":"creative"}');
        }
        run('UPDATE crashes SET install_id = ? WHERE crash_guid = ?', fullInstall, 'own-report-5-days');
    });
    await startServer();
    await settled();
    const all = await card('maintenance.export', { what: 'events', range: 'all' });
    const week = await card('maintenance.export', { what: 'events', range: '7d' });
    const cells = (answer) => answer.json.data.rows.every((cellRow) => cellRow.length === answer.json.data.columns.length
        && cellRow.every((value) => value === null || typeof value === 'string' || typeof value === 'number'));
    check('export of events stops at 50,000 rows and says there were more; a range that holds fewer is whole',
        all.status === 200 && all.json.data.rows.length === 50000 && all.json.data.truncated === true && cells(all)
        && week.json.data.truncated === false && week.json.data.rows.length === count('events', 't >= ?', Math.floor(NOW / DAY) * DAY - 6 * DAY)
        && week.json.data.rows.length >= 300 && week.json.data.rows.length < 1000,
        { all: all.json && [all.json.data.rows.length, all.json.data.truncated], week: week.json && [week.json.data.rows.length, week.json.data.truncated], columns: all.json && all.json.data.columns });
    const sessionsOut = await card('maintenance.export', { what: 'sessions', range: 'all' });
    const macOut = await card('maintenance.export', { what: 'sessions', range: 'all', platform: 'mac' });
    const crashesOut = await card('maintenance.export', { what: 'crashes', range: 'all' });
    const issuesOut = await card('maintenance.export', { what: 'issues', range: 'all' });
    const installColumn = sessionsOut.json.data.columns.indexOf('install');
    check('exports of sessions, crash reports and issues have their columns and rows, the platform filter applies, and no install id is given in full',
        sessionsOut.status === 200 && sessionsOut.json.data.rows.length === count('sessions') && cells(sessionsOut) && !sessionsOut.json.data.columns.includes('install_id')
        && sessionsOut.json.data.rows.every((cellRow) => cellRow[installColumn] === null || cellRow[installColumn].length === 8)
        && macOut.json.data.rows.length === 1 && macOut.json.data.rows[0][0] === 'export-mac-session-0001'
        && crashesOut.json.data.rows.length === count('crashes') && cells(crashesOut) && crashesOut.json.data.columns.includes('issue')
        && issuesOut.json.data.rows.length === count('crash_groups') && cells(issuesOut) && issuesOut.json.data.columns.includes('status')
        && [all, week, sessionsOut, crashesOut, issuesOut].every((answer) => !answer.text.includes(fullInstall) && !answer.text.includes(keptInstall))
        && all.text.includes(fullInstall.slice(0, 8)),
        { sessions: sessionsOut.json.data.rows.length, mac: macOut.json.data.rows.length, crashes: crashesOut.json.data.rows.length, issues: issuesOut.json.data.rows.length,
            crash_columns: crashesOut.json.data.columns.length, issue_columns: issuesOut.json.data.columns });
    const badExport = [await card('maintenance.export', { what: 'installs' }), await card('maintenance.export', {})];
    check('an export of anything else is refused', badExport.every((answer) => answer.status === 400), badExport.map((answer) => answer.status));

    // ====================================================================== delete
    const beforeDelete = tables();
    const refusedDeletes = [
        await action('maintenance.delete', { what: 'reports', confirm: 'delete report' }),
        await action('maintenance.delete', { what: 'reports', confirm: 'Delete reports' }),
        await action('maintenance.delete', { what: 'events', confirm: 'delete everything' }),
        await action('maintenance.delete', { what: 'sessions', confirm: 'delete sessions' }),
        await action('maintenance.delete', { what: 'everything' })
    ];
    check('a delete without the exact word, or of something else, is refused and deletes nothing',
        refusedDeletes.every((answer) => answer.status === 400) && same(tables(), beforeDelete) && count('admin_log', "kind = 'maintenance.delete'") === 0,
        refusedDeletes.map((answer) => answer.status));

    const eventsBefore = count('events');
    const deleteEvents = await action('maintenance.delete', { what: 'events', confirm: 'delete events' });
    const afterEvents = tables();
    check('delete events: every single event is gone; sessions, players, active days, crash reports, issues and counters stay',
        deleteEvents.status === 200 && deleteEvents.json.deleted.events === eventsBefore && count('events') === 0
        && same({ ...afterEvents, events: 0 }, { ...beforeDelete, events: 0 }) && count('sessions') > 10,
        { answer: deleteEvents.json, sessions: count('sessions') });

    // Reports: two of ours with archives and two of the old route are left from the nights.
    const groupsBefore = tables().groups;
    const reportsBefore = count('crashes');
    const deleteReports = await action('maintenance.delete', { what: 'reports', confirm: 'delete reports' });
    await waitFor('the archives to be removed', (now) => now.retention && !now.retention.removing_archives, 15000);
    const afterReports = tables();
    check('delete reports: every report and our archives are gone; issues with status, notes and counts, the old route\'s files and everything else stay',
        deleteReports.status === 200 && deleteReports.json.deleted.reports === reportsBefore && reportsBefore === 4 && deleteReports.json.deleted.archives === 2
        && deleteReports.json.deleted.archives_bytes > 0 && count('crashes') === 0 && afterReports.archives === ''
        && afterReports.legacy_archives === beforeDelete.legacy_archives && afterReports.groups === groupsBefore && afterReports.groups.includes('a note that must stay')
        && same({ ...afterReports, crashes: 0, archives: 0 }, { ...afterEvents, crashes: 0, archives: 0 }),
        { answer: deleteReports.json, archives_left: afterReports.archives, changed: differences(afterReports, afterEvents) });
    const dataAfter = (await card('maintenance.data')).json.data;
    check('the Settings card shows it: no reports, no archive bytes', dataAfter.storage.rows.crashes === 0 && dataAfter.storage.archives_bytes === 0 && dataAfter.storage.rows.events === 0,
        dataAfter.storage);
    await stopServer();

    // A deleted report must not come back: a repeated upload line and an old
    // route's line from before the delete, still to be read from the spool.
    const deletedAt = Number(row("SELECT value FROM meta WHERE key = 'maintenance.reports_deleted_at'").value);
    fs.writeFileSync(path.join(ownCrashDir(), 'own-report-5-days.zip'), crashZip('Assertion failed: Kept() [File:D:\\x\\Kept.cpp] [Line: 9] back again'));
    const spoolFile = path.join(spoolDir(), `collect-${new Date().toISOString().slice(0, 10)}.ndjson`);
    fs.appendFileSync(spoolFile, [
        { type: 'crash', received_at: deletedAt - 500, crash_guid: 'own-report-5-days', build: '1.4.0', platform: 'Windows', file: 'insights/crashes/own-report-5-days.zip', size: 100, duplicate: true },
        { type: 'legacy_crash', legacy: true, received_at: deletedAt - 400, crash_id: 'legacy-report-5-days', file: 'crashes/legacy-report-5-days.zip', platform: null,
            metadata: { id: 'legacy-report-5-days', version: '1.3.2', crash_context: { error_message: 'Old one again', crash_type: 'Crash' } } }
    ].map((record) => JSON.stringify(record) + '\n').join(''));
    // And the import is made to run again, over a crash list from before the delete.
    const againList = writeOldFiles(storage, { now: deletedAt - DAY, sessionsJson: 0, sessionsLog: 0, eventsJson: 0, eventsLog: 0, crashes: 30 });
    write((run) => run("DELETE FROM meta WHERE key = 'import'"));
    await startServer();
    h = await importDone();
    await settled();
    const freshUpload = await uploadCrash('a-report-after-the-delete', 'Assertion failed: Fresh() [File:D:\\x\\Fresh.cpp] [Line: 3]');
    await settled();
    check('a deleted crash report does not come back: not through a repeated upload line, not through an old line, not through the import running again',
        count('crashes', "crash_guid <> 'a-report-after-the-delete'") === 0 && fileOf(h, 'crashes_metadata.json').imported === 0
        && h.import.skipped.deleted_before === againList.crashes.size && h.worker.lines_failed === 0
        && !fs.existsSync(path.join(ownCrashDir(), 'own-report-5-days.zip')) && fs.existsSync(path.join(storage, 'crashes', 'legacy-report-5-days.zip')),
        { crashes: count('crashes'), left_out_by_import: h.import.skipped.deleted_before, of: againList.crashes.size });
    check('a report that arrives after the delete is stored as usual',
        freshUpload.status === 200 && count('crashes') === 1 && row('SELECT parsed, group_id FROM crashes').parsed === 1 && fs.existsSync(path.join(ownCrashDir(), 'a-report-after-the-delete.zip')),
        { crashes: count('crashes') });

    // Everything.
    await action('maintenance.set_retention', { events_days: 30, sessions_days: 365 });
    await collect(newId(), newId(), [{ name: 'session_start', t: Date.now(), seq: 0, props: {} }, { name: 'menu_shown', t: Date.now(), seq: 1, props: {} }]);
    await settled();
    const filled = { events: count('events'), sessions: count('sessions'), installs: count('installs'), crashes: count('crashes'), groups: count('crash_groups') };
    const hashesAtDelete = oldFileHashes();
    const deleteAll = await action('maintenance.delete', { what: 'everything', confirm: 'delete everything' });
    await waitFor('the archives to be removed', (now) => now.retention && !now.retention.removing_archives, 15000);
    h = await settled();
    const empty = ['events', 'sessions', 'installs', 'install_days', 'crashes', 'crash_groups', 'counters', 'build_markers'].map((table) => count(table));
    const dataEmpty = (await card('maintenance.data')).json.data;
    check('delete everything: every table of data is empty, our archives are gone, the settings are back to their defaults, the change log holds only this delete',
        deleteAll.status === 200 && filled.events > 0 && filled.sessions > 10 && filled.crashes === 1 && filled.groups > 0
        && empty.every((n) => n === 0) && fs.readdirSync(ownCrashDir()).length === 0
        && same(kept(dataEmpty.retention), { events_days: 90, reports_days: 90, sessions_days: 0 }) && count('admin_log') === 1
        && row('SELECT kind FROM admin_log').kind === 'maintenance.delete' && deleteAll.json.deleted.sessions === filled.sessions,
        { answer: deleteAll.json, tables: empty, retention: dataEmpty.retention });
    check('the old files and the old route\'s archives are still exactly what they were, and the import does not start again',
        oldFileHashes() === hashesAtDelete && fs.readdirSync(path.join(storage, 'crashes')).sort().join(' ') === beforeDelete.legacy_archives.split(' ').concat(againList.archives).sort().join(' ')
        && h.import.state === 'done', { import: h.import.state });
    const afterAll = await collect(newId(), newId(), [{ name: 'session_start', t: Date.now(), seq: 0, props: {} }]);
    await settled();
    await stopServer();
    await startServer();
    await sleep(4000);
    h = await settled();
    check('the store works on after it, and a restart brings nothing back', afterAll.status === 202 && count('events') === 1 && count('sessions') === 1 && count('crashes') === 0
        && h.import.state === 'done' && !serverOutput.includes('import: reading'), { events: count('events'), crashes: count('crashes') });

    await stopServer();
    for (const folder of storages) fs.rmSync(folder, { recursive: true, force: true });
    console.log(failed ? `RESULT: ${failed} of ${number} check(s) FAILED` : `RESULT: all ${number} checks passed`);
    process.exit(failed ? 1 : 0);
})().catch(async (error) => {
    console.error('check stopped:', error);
    console.error(serverOutput.slice(-3000));
    await stopServer('SIGKILL');
    for (const folder of storages) fs.rmSync(folder, { recursive: true, force: true });
    process.exit(1);
});
