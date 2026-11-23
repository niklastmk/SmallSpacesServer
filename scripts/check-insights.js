#!/usr/bin/env node

// Checks the insights store of server.js (server/insights/): the two routes the
// new game build calls (POST /api/v2/collect, POST /api/v2/crashes), the worker
// thread that moves the spool into the database, the copy of what old builds
// send, and the admin health view.
//
// Usage: node scripts/check-insights.js [port]      (needs `npm install` in server/, Node 22.5 or newer)
//
// Runs server.js from this folder on 127.0.0.1 against a new temporary storage
// folder that it deletes at the end. It takes no storage path and no server
// address, so it cannot reach real data. Starts and stops the server several
// times. Prints one numbered line per check and exits 1 if a check failed.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const { DatabaseSync } = require('node:sqlite');
const registry = require('../insights/events.json');

const serverFile = path.join(__dirname, '..', 'server.js');
const port = Number(process.argv[2]) || 39474;
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-insights-check-'));
const ADMIN = 'local-test-only-' + process.pid; // throwaway key for this run only
const insightsDir = path.join(storage, 'insights');
const spoolDir = path.join(insightsDir, 'spool');
const crashDir = path.join(insightsDir, 'crashes');
const dbFile = path.join(insightsDir, 'insights.db');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

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

// Every call comes from another made-up player address, so the per-player
// limits are not what is being tested (except where `from` is given).
function call(method, urlPath, body, options = {}) {
    return new Promise((resolve) => {
        const headers = { 'X-Forwarded-For': options.from || `198.51.100.${(calls++ % 250) + 1}`, ...(options.headers || {}) };
        let data = null;
        if (Buffer.isBuffer(body)) {
            data = body;
            headers['Content-Type'] = options.type || 'application/zip';
        } else if (typeof body === 'string') {
            data = Buffer.from(body);
            headers['Content-Type'] = options.type || 'application/json';
        } else if (body) {
            data = Buffer.from(JSON.stringify(body));
            headers['Content-Type'] = 'application/json';
        }
        if (data && headers['Content-Length'] === undefined) headers['Content-Length'] = data.length;
        if (options.admin) headers['x-admin-key'] = ADMIN;
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
                resolve({ status: res.statusCode, json, text, headers: res.headers });
            });
        });
        req.on('error', (err) => resolve({ status: 0, error: err.message }));
        if (data) req.write(data);
        req.end();
    });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    for (let i = 0; i < 100; i++) {
        const r = await call('GET', '/api/health');
        if (r.status === 200) return;
        await sleep(100);
    }
    throw new Error('server did not start:\n' + serverOutput);
}

function stopServer(signal) {
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

// Waits until the worker has stored everything that was sent and read every archive.
async function settle() {
    let last = null;
    for (let i = 0; i < 150; i++) {
        last = await health();
        if (last && last.database && last.database.status === 'ok' && last.spool.backlog_bytes === 0 && last.crashes_waiting === 0) return last;
        await sleep(100);
    }
    throw new Error('the worker did not catch up: ' + JSON.stringify(last) + '\n' + serverOutput.slice(-2000));
}

// Reads the database the way the dashboard will: read-only, from outside the worker.
function rows(sql, ...params) {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
        return db.prepare(sql).all(...params);
    } finally {
        db.close();
    }
}
const row = (sql, ...params) => rows(sql, ...params)[0];
const count = (table, where = '1 = 1', ...params) => Number(row(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...params).n);

const newId = () => crypto.randomUUID();

// The session fields come from events.json, so the check follows that list:
// one value of the right kind for every field.
const sessionFields = Object.entries(registry.session_fields);
const fieldValue = (name, kind, variant) => (kind === 's' ? `${name}-${variant}` : kind === 'n' ? (variant === 'a' ? 16 : 2560) : variant === 'a');
const fieldsWith = (names, variant) => Object.fromEntries(sessionFields.filter(([name]) => names.includes(name))
    .map(([name, kind]) => [name, fieldValue(name, kind, variant)]));
const stored = (value) => (typeof value === 'boolean' ? (value ? 1 : 0) : value); // how SQLite gives it back
const sameFields = (rowObject, expected) => Object.entries(expected).filter(([name, value]) => rowObject[name] !== stored(value)).map(([name]) => name);
function batch(installId, sessionId, events, extra = {}) {
    return { schema: 2, install_id: installId, session_id: sessionId, build: '1.4.0', steam_build: 20001,
        platform: 'Windows', sent_at: Date.now(), events, ...extra };
}
const collect = (body, options) => call('POST', '/api/v2/collect', body, options);
const crashUrl = (query) => '/api/v2/crashes?' + new URLSearchParams(query).toString();

function zipOf(files) {
    const zip = new AdmZip();
    for (const [name, content] of Object.entries(files)) {
        zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content));
    }
    return zip.toBuffer();
}

function crashContextXml(message, type = 'Assert') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<FGenericCrashContext>
<RuntimeProperties>
<CrashType>${type}</CrashType>
<ErrorMessage>${message}</ErrorMessage>
<IsAssert>true</IsAssert>
<PCallStackHash>ABCDEF0123</PCallStackHash>
<PCallStack>SmallSpaces 0x0000000140000000 + 12345</PCallStack>
<Misc.CPUBrand>Test CPU 9000</Misc.CPUBrand>
<Misc.PrimaryGPUBrand>Test GPU 4080</Misc.PrimaryGPUBrand>
<Misc.OSVersionMajor>Windows 11</Misc.OSVersionMajor>
<MemoryStats.TotalPhysicalGB>32</MemoryStats.TotalPhysicalGB>
<EngineVersion>5.8.4-0+UE5</EngineVersion>
<SecondsSinceStart>77</SecondsSinceStart>
</RuntimeProperties>
</FGenericCrashContext>`;
}

function minidump(unixSeconds) {
    const dump = Buffer.alloc(32);
    dump.write('MDMP', 0, 'ascii');
    dump.writeUInt32LE(unixSeconds, 20);
    return dump;
}

// A small macOS crash report in the .ips form: a header line, then the body.
function ipsReport(whenMs, overrides = {}) {
    const local = new Date(whenMs + HOUR).toISOString(); // written as local time at +0100
    const header = { app_name: 'SmallSpaces', timestamp: `${local.slice(0, 10)} ${local.slice(11, 19)}.00 +0100`,
        app_version: '1.4.0', bug_type: '309', os_version: 'macOS 15.1 (24B83)', name: 'SmallSpaces', ...(overrides.header || {}) };
    const body = {
        modelCode: 'Mac14,2', cpuType: 'ARM-64',
        exception: { type: 'EXC_BAD_ACCESS', signal: 'SIGSEGV', subtype: 'KERN_INVALID_ADDRESS at 0x0000000000000010' },
        termination: { indicator: 'Segmentation fault: 11' },
        faultingThread: 1,
        threads: [
            { frames: [{ imageIndex: 1, imageOffset: 100 }] },
            { triggered: true, frames: [
                { imageIndex: 1, imageOffset: 4660 },
                { imageIndex: 0, imageOffset: 11256099 },
                { imageIndex: 0, imageOffset: 2222 },
                { imageIndex: 1, imageOffset: 9 },
                { imageIndex: 0, imageOffset: 3333 },
                { imageIndex: 0, imageOffset: 4444 }
            ] }
        ],
        usedImages: [
            { name: 'SmallSpaces', path: '/Applications/SmallSpaces.app/Contents/MacOS/SmallSpaces' },
            { name: 'libsystem_kernel.dylib', path: '/usr/lib/system/libsystem_kernel.dylib' }
        ],
        ...(overrides.body || {})
    };
    return JSON.stringify(header) + '\n' + JSON.stringify(body, null, 2);
}

function storedText() {
    // Everything the insights store wrote, as text: spool lines and database.
    let text = '';
    for (const name of fs.readdirSync(spoolDir)) text += fs.readFileSync(path.join(spoolDir, name), 'latin1');
    for (const name of fs.readdirSync(insightsDir)) {
        const file = path.join(insightsDir, name);
        if (fs.statSync(file).isFile()) text += fs.readFileSync(file, 'latin1');
    }
    return text;
}

(async () => {
    await startServer();

    // ------------------------------------------------------------------ admin health
    const noKey = await call('GET', '/api/admin/v2/health');
    const wrongKey = await call('GET', '/api/admin/v2/health', null, { headers: { 'x-admin-key': 'not-the-key' } });
    check('admin health refuses a request without or with a wrong admin key', noKey.status === 403 && wrongKey.status === 403, [noKey.status, wrongKey.status]);
    let h = await settle();
    check('admin health answers: worker running, database ok, eleven tables without data',
        h.worker.status === 'running' && h.database.status === 'ok' && h.database.schema_version === 2
        && Object.keys(h.tables).length === 11 && h.tables.events === 0 && h.tables.sessions === 0 && h.spool.backlog_bytes === 0,
        { database: h.database, tables: h.tables });

    // ------------------------------------------------------------------ collect
    const installA = newId();
    const sessionA = newId();
    const t0 = Date.now();
    const startProps = { ...fieldsWith(sessionFields.map(([name]) => name), 'a'), build: '1.4.0', steam_build: 20001, platform: 'Windows',
        existing_player: true, not_a_session_field: 'ignored' };
    const startBatch = batch(installA, sessionA, [
        { name: 'session_start', t: t0 - 4000, seq: 1, props: startProps },
        { name: 'room_enter', t: t0 - 2000, seq: 2, props: { mode: 'design', level_id: 'berlin', source: 'menu' } },
        { name: 'room_ready', t: t0 - 1000, seq: 3, props: { mode: 'design', level_id: 'berlin', load_s: 1.25 } }
    ]);
    const first = await collect(startBatch);
    check('collect answers 202 {"ok":true}', first.status === 202 && first.text === '{"ok":true}', [first.status, first.text]);
    h = await settle();
    const byName = Object.fromEntries(h.events_last_hour.map((e) => [e.name, e.count]));
    check('the batch is in the database and in the health view after the worker ran',
        h.tables.events === 3 && h.tables.sessions === 1 && h.tables.installs === 1 && h.tables.install_days === 1
        && byName.session_start === 1 && byName.room_enter === 1 && byName.room_ready === 1
        && Math.abs(h.last_event_at - (t0 - 1000)) < 5000,
        { tables: h.tables, byName, last_event_at: h.last_event_at });

    const again = await collect(startBatch);
    const overlapping = await collect(batch(installA, sessionA, [
        { name: 'room_ready', t: t0 - 1000, seq: 3, props: { mode: 'design', level_id: 'berlin', load_s: 1.25 } },
        { name: 'gallery_open', t: t0 - 500, seq: 4, props: { ok: true, count: 21 } }
    ]));
    await settle();
    const sA = row('SELECT * FROM sessions WHERE session_id = ?', sessionA);
    check('the same batch twice is stored once; a batch that overlaps adds only its new event',
        again.status === 202 && overlapping.status === 202 && count('events') === 4 && sA.event_count === 4
        && count('events', 'session_id = ? AND seq = 3', sessionA) === 1, { events: count('events'), event_count: sA.event_count });

    // ------------------------------------------------------------------ session_start
    const iA = row('SELECT * FROM installs WHERE install_id = ?', installA);
    const dayA = row('SELECT * FROM install_days WHERE install_id = ?', installA);
    const startExpected = { ...startProps };
    delete startExpected.not_a_session_field;
    check(`session_start fills the session row from its properties (all ${sessionFields.length} session fields of events.json)`,
        sA.install_id === installA && sA.legacy === 0 && sessionFields.length >= 10 && sameFields(sA, startExpected).length === 0
        && sA.existing_player === 1 && sA.build === '1.4.0' && sA.steam_build === 20001 && sA.platform === 'Windows'
        && !Object.prototype.hasOwnProperty.call(sA, 'not_a_session_field')
        && Math.abs(sA.started_at - (t0 - 4000)) < 5000 && sA.ended_at === null && sA.end_reason === null,
        { different: sameFields(sA, startExpected), gpu: sA.gpu, cpu_cores: sA.cpu_cores, existing_player: sA.existing_player, started: sA.started_at - t0 });
    check('session_start creates the install (first seen, first build, platform, existing player) and its day',
        Math.abs(iA.first_seen - (t0 - 4000)) < 5000 && iA.last_seen >= iA.first_seen && iA.first_build === '1.4.0' && iA.platform === 'Windows'
        && iA.existing_player === 1 && dayA.day === new Date(t0).toISOString().slice(0, 10) && dayA.platform === 'Windows' && dayA.build === '1.4.0',
        { install: iA, day: dayA });

    // ------------------------------------------------------------------ clock correction
    const sessionClock = newId();
    const wrongClock = Date.now() - 3 * HOUR; // this PC's clock is three hours behind
    await collect(batch(installA, sessionClock, [{ name: 'room_enter', t: wrongClock - 60000, seq: 1, props: { mode: 'unpack' } }], { sent_at: wrongClock }));
    const farClock = Date.now() - 3 * DAY;    // off by more than a day: not corrected
    await collect(batch(installA, sessionClock, [{ name: 'room_enter', t: farClock - 60000, seq: 2, props: {} }], { sent_at: farClock }));
    await collect(batch(installA, sessionClock, [{ name: 'room_enter', t: 12345, seq: 3, props: {} }], { sent_at: undefined }));
    await collect(batch(installA, sessionClock, [{ name: 'room_enter', seq: 4, props: {} }]));
    const sentAround = Date.now();
    await settle();
    const clock = rows('SELECT seq, t FROM events WHERE session_id = ? ORDER BY seq', sessionClock).map((e) => e.t - sentAround);
    check('a clock three hours behind is corrected to one minute before receipt',
        clock.length === 4 && Math.abs(clock[0] + 60000) < 5000, { ms_from_receipt: clock[0] });
    check('a clock off by days, a missing sent_at and a missing t all fall back to the receive time',
        Math.abs(clock[1]) < 5000 && Math.abs(clock[2]) < 5000 && Math.abs(clock[3]) < 5000, { ms_from_receipt: clock.slice(1) });

    // ------------------------------------------------------------------ refused bodies
    const eventsBefore = count('events');
    const sessionsBefore = count('sessions');
    const big = batch(installA, newId(), [{ name: 'room_enter', t: Date.now(), seq: 1, props: { a: 'x'.repeat(400) } }]);
    for (let i = 0; i < 200; i++) big['pad' + i] = 'y'.repeat(400);
    const tooBig = await collect(big);
    const tooMany = await collect(batch(installA, newId(), Array.from({ length: 101 }, (_, i) => ({ name: 'room_enter', t: Date.now(), seq: i }))));
    const noInstall = await collect({ schema: 2, session_id: newId(), events: [] });
    const badInstall = await collect(batch('../../etc/passwd', newId(), []));
    const noSession = await collect({ schema: 2, install_id: installA, events: [] });
    const badSession = await collect(batch(installA, 'short', []));
    const noEvents = await collect({ schema: 2, install_id: installA, session_id: newId() });
    const eventsObject = await collect(batch(installA, newId(), { name: 'room_enter' }));
    const notJson = await collect('{"schema": 2, "install_id": ', {});
    const jsonArray = await collect('[1, 2, 3]', {});
    const noBody = await call('POST', '/api/v2/collect');
    const hundred = await collect(batch(installA, newId(), Array.from({ length: 100 }, (_, i) => ({ name: 'room_enter', t: Date.now(), seq: i, props: {} }))));
    await settle();
    const refused = [tooBig, tooMany, noInstall, badInstall, noSession, badSession, noEvents, eventsObject, notJson, jsonArray, noBody].map((r) => r.status);
    check('oversize (413) and malformed bodies (400) are refused and store nothing; exactly 100 events are accepted',
        JSON.stringify(refused) === JSON.stringify([413, 400, 400, 400, 400, 400, 400, 400, 400, 400, 400])
        && hundred.status === 202 && count('events') === eventsBefore + 100 && count('sessions') === sessionsBefore + 1,
        { refused, hundred: hundred.status, events: count('events') - eventsBefore, sessions: count('sessions') - sessionsBefore });

    // ------------------------------------------------------------------ sanitising
    const sessionSan = newId();
    const manyProps = {};
    for (let i = 0; i < 80; i++) manyProps['p' + i] = i;
    await collect(batch(installA, sessionSan, [
        { name: 'room_enter', t: Date.now(), seq: 1, props: { long: 'z'.repeat(900), nested: { a: 1 }, list: [1], nothing: null, yes: true, n: 1.5, ['k'.repeat(65)]: 'dropped' } },
        { name: 'room_exit', t: Date.now(), seq: 2, props: manyProps },
        { name: 'BadName', t: Date.now(), seq: 3, props: {} },
        { name: 'drop table', t: Date.now(), seq: 4, props: {} },
        { t: Date.now(), seq: 5 },
        'not an event'
    ], { build: 'b'.repeat(90), platform: 'P'.repeat(90) }));
    await settle();
    const san = rows('SELECT name, props, build, platform FROM events WHERE session_id = ? ORDER BY seq', sessionSan);
    const sanProps = san.length ? JSON.parse(san[0].props) : {};
    check('properties are flattened and cut, names that do not fit are dropped, build and platform are cut to 50',
        san.length === 2 && san[0].name === 'room_enter' && san[1].name === 'room_exit'
        && JSON.stringify(Object.keys(sanProps).sort()) === JSON.stringify(['long', 'n', 'yes']) && sanProps.long.length === 500
        && Object.keys(JSON.parse(san[1].props)).length === 50 && san[0].build.length === 50 && san[0].platform.length === 50,
        { stored: san.map((e) => e.name), keys: Object.keys(sanProps), long: sanProps.long && sanProps.long.length });

    // ------------------------------------------------------------------ heartbeat
    const before = row('SELECT last_seen_at, event_count FROM sessions WHERE session_id = ?', sessionA);
    const eventsBeforeBeat = count('events');
    await sleep(1100);
    const beat = await collect(batch(installA, sessionA, [], { heartbeat: true }));
    await settle();
    const after = row('SELECT last_seen_at, event_count, started_at FROM sessions WHERE session_id = ?', sessionA);
    check('a heartbeat with no events moves last-seen forward and stores no event',
        beat.status === 202 && after.last_seen_at >= before.last_seen_at + 1000 && Math.abs(after.last_seen_at - Date.now()) < 5000
        && count('events') === eventsBeforeBeat && after.event_count === before.event_count && after.started_at === sA.started_at,
        { moved_ms: after.last_seen_at - before.last_seen_at });

    // ------------------------------------------------------------------ settings snapshot and changes
    // The settings snapshot on menu_shown: the session fields that event lists in events.json.
    const menuNames = Object.keys(registry.events.menu_shown.props).filter((name) => registry.session_fields[name]);
    const menuProps = fieldsWith(menuNames, 'b');
    const changedText = menuNames.find((name) => registry.session_fields[name] === 's');
    const changedNumber = sessionFields.map(([name, kind]) => (kind === 'n' && !menuNames.includes(name) && name !== 'steam_build' ? name : null)).find(Boolean);
    const untouched = sessionFields.map(([name, kind]) => (kind === 's' && !menuNames.includes(name) && !['build', 'platform'].includes(name) ? name : null)).find(Boolean);
    await collect(batch(installA, sessionA, [
        { name: 'menu_shown', t: Date.now(), seq: 10, props: { startup_s: 8.5, ...menuProps } },
        { name: 'setting_change', t: Date.now(), seq: 11, props: { key: changedText, to: 'epic' } },
        { name: 'setting_change', t: Date.now(), seq: 12, props: { key: changedNumber, to: '240' } },
        { name: 'setting_change', t: Date.now(), seq: 13, props: { key: 'not_a_session_field', to: '80' } },
        { name: 'setting_change', t: Date.now(), seq: 14, props: { key: 'ended_at', to: '1' } }
    ]));
    await settle();
    const set = row('SELECT * FROM sessions WHERE session_id = ?', sessionA);
    const menuExpected = { ...menuProps, [changedText]: 'epic' };
    check(`menu_shown updates the ${menuNames.length} session fields it carries; setting_change sets its field (a number field as a number)`,
        menuNames.length >= 3 && changedText && changedNumber && untouched && sameFields(set, menuExpected).length === 0
        && set[changedNumber] === 240 && set[untouched] === `${untouched}-a` && set.ended_at === null
        && !Object.prototype.hasOwnProperty.call(set, 'startup_s'),
        { different: sameFields(set, menuExpected), [changedText]: set[changedText], [changedNumber]: set[changedNumber], [untouched]: set[untouched], ended_at: set.ended_at });

    // ------------------------------------------------------------------ session end
    const endAt = Date.now();
    await collect(batch(installA, sessionA, [{ name: 'session_end', t: endAt, seq: 20, props: { duration_s: 1234.5, active_s: 1000, reason: 'quit' } }]));
    // The next launch: a new session reports that the one before it did not end cleanly.
    const sessionCrashed = newId();
    const sessionNext = newId();
    const sessionUnseen = newId();
    const unseenStarted = Date.now() - 60000;
    await collect(batch(installA, sessionCrashed, [{ name: 'session_start', t: Date.now(), seq: 1, props: { platform: 'Windows' } }]));
    await collect(batch(installA, sessionNext, [
        { name: 'session_start', t: Date.now(), seq: 1, props: { platform: 'Windows' } },
        { name: 'session_abnormal_end', t: Date.now(), seq: 2, props: { prev_session_id: sessionCrashed.toUpperCase(), last_stage: 'room:berlin', seconds_alive: 321, had_crash_folder: true } },
        { name: 'session_abnormal_end', t: Date.now(), seq: 3, props: { prev_session_id: sessionA, last_stage: 'menu', seconds_alive: 5 } },
        { name: 'session_abnormal_end', t: Date.now(), seq: 4, props: { prev_session_id: sessionUnseen, last_stage: 'startup', seconds_alive: 4, prev_started_ms: unseenStarted, prev_last_ms: unseenStarted + 4000 } }
    ]));
    await settle();
    const unseenStub = row('SELECT * FROM sessions WHERE session_id = ?', sessionUnseen);
    // The session that died sends its own first batch only now (the game kept it on disk).
    await collect(batch(installA, sessionUnseen, [{ name: 'session_start', t: unseenStarted, seq: 1, props: { platform: 'Windows', cpu: 'Late CPU' } }]));
    await settle();
    const unseen = row('SELECT * FROM sessions WHERE session_id = ?', sessionUnseen);
    check('an abnormal end for a session the server never saw gives it a row; its own first batch, arriving later, fills it in and it stays abnormal',
        unseenStub && unseenStub.end_reason === 'abnormal' && unseenStub.last_stage === 'startup' && unseenStub.install_id === installA
        && Math.abs(unseenStub.started_at - unseenStarted) < 5000 && Math.abs(unseenStub.last_seen_at - unseenStarted - 4000) < 5000
        && unseen.end_reason === 'abnormal' && unseen.cpu === 'Late CPU' && unseen.duration_s === 4,
        { stub: unseenStub && [unseenStub.end_reason, unseenStub.last_stage, unseenStub.started_at - unseenStarted], later: [unseen.end_reason, unseen.cpu, unseen.duration_s] });
    const ended = row('SELECT * FROM sessions WHERE session_id = ?', sessionA);
    const crashed = row('SELECT * FROM sessions WHERE session_id = ?', sessionCrashed);
    check('session_end sets the end time, reason "clean", duration and active seconds',
        Math.abs(ended.ended_at - endAt) < 5000 && ended.end_reason === 'clean' && ended.duration_s === 1234.5 && ended.active_s === 1000,
        { end_reason: ended.end_reason, duration_s: ended.duration_s, active_s: ended.active_s });
    check('session_abnormal_end marks the previous session abnormal with its last stage; a clean end stays clean',
        crashed.end_reason === 'abnormal' && crashed.last_stage === 'room:berlin' && crashed.duration_s === 321 && crashed.ended_at === null
        && ended.end_reason === 'clean' && ended.last_stage === null && count('sessions', 'end_reason = ?', 'abnormal') === 2,
        { crashed: [crashed.end_reason, crashed.last_stage, crashed.duration_s], clean: [ended.end_reason, ended.last_stage] });

    // ------------------------------------------------------------------ unregistered events
    await collect(batch(installA, sessionNext, [{ name: 'brand_new_event', t: Date.now(), seq: 10, props: { a: 1 } }, { name: 'room_enter', t: Date.now(), seq: 11, props: {} }]));
    h = await settle();
    const unregistered = rows('SELECT name FROM events WHERE registered = 0 AND legacy = 0').map((e) => e.name);
    check('an event that is not in events.json is stored, flagged, and listed in the health view',
        JSON.stringify(unregistered) === JSON.stringify(['brand_new_event'])
        && h.unregistered_last_24h.length === 1 && h.unregistered_last_24h[0].name === 'brand_new_event' && h.unregistered_last_24h[0].count === 1
        && count('events', "name = 'room_enter' AND registered = 0") === 0, h.unregistered_last_24h);

    // ------------------------------------------------------------------ old routes
    const legacyStart = await call('POST', '/api/analytics/session/start', { client_version: '1.0.0', platform: 'Mac', metadata: { os: 'macOS' } });
    const legacySid = legacyStart.json && legacyStart.json.session_id;
    const legacyBatch = await call('POST', '/api/analytics/batch', { session_id: legacySid, client_version: '1.0.0', platform: 'Mac', events: [
        { event_name: 'TrackGameMode', timestamp: new Date().toISOString(), properties: { GameMode: 'Design' } },
        { event_name: 'TrackGameMode', timestamp: new Date().toISOString(), properties: { GameMode: 'Unpack' } },
        { event_name: 'OldOnlyEvent', timestamp: '2001-01-01T00:00:00Z', properties: { colour: 'green' } }
    ] });
    const legacySingle = await call('POST', '/api/analytics/event', { session_id: legacySid, event_name: 'TrackGameMode', properties: { GameMode: 'Creative' }, client_version: '1.0.0', platform: 'Mac' });
    const legacyBad = await call('POST', '/api/analytics/batch', { session_id: legacySid });
    check('the old routes answer as before ({success, session_id}, {success, event_ids, count}, {success, event_id}, 400)',
        legacyStart.status === 200 && JSON.stringify(Object.keys(legacyStart.json)) === '["success","session_id"]' && legacySid.length === 36
        && legacyBatch.status === 200 && JSON.stringify(Object.keys(legacyBatch.json)) === '["success","event_ids","count"]' && legacyBatch.json.count === 3
        && legacySingle.status === 200 && JSON.stringify(Object.keys(legacySingle.json)) === '["success","event_id"]' && legacyBad.status === 400,
        [legacyStart.json, legacyBatch.json && legacyBatch.json.count, legacySingle.status, legacyBad.status]);
    const oldSummary = (await call('GET', '/api/analytics/summary', null, { admin: true })).json;
    check('the old store still gets them (old dashboard summary: 4 events, 1 session)',
        oldSummary && oldSummary.events.total === 4 && oldSummary.sessions.total === 1, oldSummary && { events: oldSummary.events.total, sessions: oldSummary.sessions.total });
    await settle();
    const legacySession = row('SELECT * FROM sessions WHERE session_id = ?', legacySid);
    const legacyEvents = rows('SELECT name, props, registered, legacy, seq, install_id, platform, build, t FROM events WHERE session_id = ? ORDER BY id', legacySid);
    const modes = legacyEvents.filter((e) => e.name === 'room_enter').map((e) => JSON.parse(e.props).mode);
    const oldOnly = legacyEvents.find((e) => e.name === 'OldOnlyEvent');
    check('an old session start and old events appear in the new store as legacy rows, TrackGameMode as room_enter',
        legacySession && legacySession.legacy === 1 && legacySession.platform === 'Mac' && legacySession.build === '1.0.0' && legacySession.install_id === null
        && legacySession.event_count === 4 && legacyEvents.length === 4 && legacyEvents.every((e) => e.legacy === 1 && e.seq === null && e.platform === 'Mac')
        && JSON.stringify(modes) === JSON.stringify(['design', 'unpack', 'creative']) && legacyEvents.filter((e) => e.name === 'room_enter').every((e) => e.registered === 1)
        && oldOnly && oldOnly.registered === 0 && Math.abs(oldOnly.t - Date.now()) < 10000,
        { session: legacySession && [legacySession.legacy, legacySession.platform, legacySession.event_count], names: legacyEvents.map((e) => e.name), modes });

    // ------------------------------------------------------------------ crash upload
    const crashTime = Math.floor(Date.now() / 1000) - 600;
    const assertMessage = 'Assertion failed: Thing.IsValid() [File:D:\\build\\Source\\Runtime\\Thing.cpp] [Line: 123] Thing went away';
    const winZip = zipOf({ 'CrashContext.runtime-xml': crashContextXml(assertMessage), 'UEMinidump.dmp': minidump(crashTime), 'SmallSpaces.log': 'log' });
    const guid1 = 'UECC-Windows-' + crypto.randomBytes(16).toString('hex').toUpperCase();
    const up1 = await call('POST', crashUrl({ crash_guid: guid1, install_id: installA, session_id: sessionCrashed, build: '1.4.0', steam_build: '20001', platform: 'Windows' }), winZip);
    const stored1 = path.join(crashDir, guid1 + '.zip');
    check('a crash upload answers 200 {"ok":true,"duplicate":false} and the archive is stored under its crash_guid',
        up1.status === 200 && up1.text === '{"ok":true,"duplicate":false}' && fs.existsSync(stored1) && fs.readFileSync(stored1).equals(winZip)
        && fs.readdirSync(crashDir).every((name) => !name.endsWith('.tmp')) && up1.headers['ratelimit-limit'] === '60',
        [up1.status, up1.text, up1.headers['ratelimit-limit']]);

    const otherZip = zipOf({ 'CrashContext.runtime-xml': crashContextXml('something else entirely') });
    const up1Again = await call('POST', crashUrl({ crash_guid: guid1, install_id: installA, session_id: sessionCrashed, build: '1.4.0', platform: 'Windows' }), otherZip);
    await settle();
    check('the same crash_guid again is answered as duplicate, the stored archive is not rewritten, and there is one row',
        up1Again.status === 200 && up1Again.text === '{"ok":true,"duplicate":true}' && fs.readFileSync(stored1).equals(winZip) && count('crashes', 'crash_guid = ?', guid1) === 1,
        [up1Again.status, up1Again.text]);

    const crashesBefore = count('crashes');
    const filesBefore = fs.readdirSync(crashDir).length;
    const notZip = await call('POST', crashUrl({ crash_guid: 'not-a-zip-0001', platform: 'Windows' }), Buffer.from('this is not an archive'));
    const emptyBody = await call('POST', crashUrl({ crash_guid: 'empty-body-0001', platform: 'Windows' }), Buffer.alloc(0));
    const jsonBody = await call('POST', crashUrl({ crash_guid: 'json-body-0001', platform: 'Windows' }), { crashData: 'UEsDBA==' });
    const noGuid = await call('POST', crashUrl({ platform: 'Windows' }), winZip);
    const badGuid = await call('POST', crashUrl({ crash_guid: '../../evil', platform: 'Windows' }), winZip);
    const shortGuid = await call('POST', crashUrl({ crash_guid: 'abc', platform: 'Windows' }), winZip);
    const oversize = Buffer.alloc(50 * 1024 * 1024 + 1);
    oversize.write('PK');
    const tooLarge = await call('POST', crashUrl({ crash_guid: 'too-large-0001', platform: 'Windows' }), oversize);
    await settle();
    const refusedCrashes = [notZip, emptyBody, jsonBody, noGuid, badGuid, shortGuid, tooLarge].map((r) => r.status);
    check('a body that is not a ZIP, an empty body, a JSON body and a bad crash_guid are refused with 400, over 50 MB with 413; nothing is stored',
        JSON.stringify(refusedCrashes) === JSON.stringify([400, 400, 400, 400, 400, 400, 413])
        && count('crashes') === crashesBefore && fs.readdirSync(crashDir).length === filesBefore, refusedCrashes);

    // ------------------------------------------------------------------ crash parsing and grouping
    const c1 = row('SELECT * FROM crashes WHERE crash_guid = ?', guid1);
    const g1 = c1 && row('SELECT * FROM crash_groups WHERE id = ?', c1.group_id);
    check('the archive with a CrashContext.runtime-xml is read: platform from the query, context, crash time from the minidump',
        c1 && c1.parsed === 1 && c1.legacy === 0 && c1.platform === 'Windows' && c1.build === '1.4.0' && c1.steam_build === 20001
        && c1.install_id === installA && c1.session_id === sessionCrashed && c1.has_context === 1 && c1.has_minidump === 1
        && c1.category === 'Fatal Error' && c1.crash_type === 'Assert' && c1.error_message === assertMessage && c1.gpu === 'Test GPU 4080'
        && c1.cpu === 'Test CPU 9000' && c1.os === 'Windows 11' && c1.ram_gb === 32 && c1.seconds_since_start === 77
        && c1.occurred_at === crashTime * 1000 && c1.file === `insights/crashes/${guid1}.zip` && c1.file_size === winZip.length
        && JSON.parse(c1.context).callstack_hash === 'ABCDEF0123',
        c1 && { parsed: c1.parsed, platform: c1.platform, category: c1.category, occurred: c1.occurred_at - crashTime * 1000, error: c1.parse_error });

    const guid2 = 'UECC-Windows-' + crypto.randomBytes(16).toString('hex').toUpperCase();
    const winZip2 = zipOf({ 'CrashContext.runtime-xml': crashContextXml('Assertion failed: Other() [File:D:\\other\\path\\Thing.cpp] [Line: 123] different words') });
    await call('POST', crashUrl({ crash_guid: guid2, install_id: installA, session_id: sessionNext, build: '1.4.1', platform: 'Windows' }), winZip2);
    await settle();
    const c2 = row('SELECT * FROM crashes WHERE crash_guid = ?', guid2);
    const g2 = row('SELECT * FROM crash_groups WHERE group_key = ?', 'Thing.cpp:123');
    check('two crashes at the same file and line share one group: count 2, both builds, first and last seen',
        g1 && g2 && c2.group_id === c1.group_id && g2.count === 2 && g2.category === 'Fatal Error' && g2.title === assertMessage.slice(0, 120)
        && JSON.stringify(JSON.parse(g2.builds)) === '["1.4.0","1.4.1"]' && JSON.stringify(JSON.parse(g2.platforms)) === '["Windows"]'
        && g2.first_seen === crashTime * 1000 && g2.last_seen === c2.occurred_at && c2.has_minidump === 0 && Math.abs(c2.occurred_at - Date.now()) < 10000,
        g2 && { count: g2.count, builds: g2.builds, platforms: g2.platforms });

    // ------------------------------------------------------------------ Mac archives
    const macWhen = Math.floor((Date.now() - 5 * MINUTE) / 1000) * 1000;
    const macGuid = 'mac-' + newId();
    const macGuid2 = 'mac-' + newId();
    const hangGuid = 'mac-hang-' + newId();
    const brokenGuid = 'mac-broken-' + newId();
    const bareGuid = 'mac-bare-' + newId();
    const macQuery = (guid) => crashUrl({ crash_guid: guid, install_id: installA, session_id: sessionNext, build: '1.4.0', platform: 'Mac' });
    const macUploads = [
        await call('POST', macQuery(macGuid), zipOf({ 'SmallSpaces-2026-11-23-101500.ips': ipsReport(macWhen) })),
        // Same crash on another machine: other system frames and addresses, same frames in the game.
        await call('POST', macQuery(macGuid2), zipOf({ 'Crashes/SmallSpaces-2026-11-23-111500.ips': ipsReport(macWhen, { body: { modelCode: 'Mac15,6',
            exception: { type: 'EXC_BAD_ACCESS', signal: 'SIGSEGV', subtype: 'KERN_INVALID_ADDRESS at 0x0000000000000abc' } } }) })),
        await call('POST', macQuery(hangGuid), zipOf({ 'SmallSpaces.ips': ipsReport(macWhen, { header: { bug_type: '298' }, body: { exception: {}, termination: {} } }) })),
        await call('POST', macQuery(brokenGuid), zipOf({ 'SmallSpaces.ips': '{"app_name": "SmallSpaces", "timestamp": ' })),
        await call('POST', macQuery(bareGuid), zipOf({ 'notes.txt': 'no report in here' }))
    ];
    await settle();
    const mac = row('SELECT * FROM crashes WHERE crash_guid = ?', macGuid);
    const mac2 = row('SELECT * FROM crashes WHERE crash_guid = ?', macGuid2);
    const macGroup = mac && row('SELECT * FROM crash_groups WHERE id = ?', mac.group_id);
    const macContext = mac && mac.context ? JSON.parse(mac.context) : {};
    check('a Mac archive with an .ips report is read: message, category, time from the header, system, top frames',
        macUploads.every((r) => r.status === 200) && mac && mac.parsed === 1 && mac.platform === 'Mac' && mac.has_context === 1 && mac.has_minidump === 0
        && mac.error_message === 'EXC_BAD_ACCESS (SIGSEGV): Segmentation fault: 11' && mac.category === 'Access Violation'
        && mac.occurred_at === macWhen && mac.os === 'macOS 15.1 (24B83)' && mac.cpu === 'ARM-64 (Mac14,2)'
        && macContext.callstack.split('\n').length === 6 && macContext.callstack.startsWith('libsystem_kernel.dylib+4660\nSmallSpaces+11256099\n'),
        mac && { parsed: mac.parsed, message: mac.error_message, category: mac.category, occurred: mac.occurred_at - macWhen, cpu: mac.cpu, error: mac.parse_error });
    check('its group key is the exception type plus the top three frames of the game itself, shared by the same crash elsewhere',
        macGroup && macGroup.group_key === 'mac:EXC_BAD_ACCESS|SmallSpaces+11256099|SmallSpaces+2222|SmallSpaces+3333'
        && mac2.group_id === mac.group_id && macGroup.count === 2 && JSON.stringify(JSON.parse(macGroup.platforms)) === '["Mac"]',
        macGroup && { key: macGroup.group_key, count: macGroup.count });
    const hang = row('SELECT * FROM crashes WHERE crash_guid = ?', hangGuid);
    const broken = row('SELECT * FROM crashes WHERE crash_guid = ?', brokenGuid);
    const bare = row('SELECT * FROM crashes WHERE crash_guid = ?', bareGuid);
    const bareGroup = bare && row('SELECT * FROM crash_groups WHERE id = ?', bare.group_id);
    check('a hang report (bug_type 298) is a Hang; a report that cannot be read and an archive without one are kept as rows without context',
        hang && hang.category === 'Hang' && hang.parsed === 1 && hang.group_id !== mac.group_id
        && broken && broken.parsed === 1 && broken.has_context === 0 && broken.context === null && broken.platform === 'Mac' && /could not be read/.test(broken.parse_error)
        && bare && bare.parsed === 1 && bare.has_context === 0 && bare.group_id === broken.group_id && bareGroup.group_key === 'no-context:Mac' && bareGroup.count === 2,
        { hang: hang && hang.category, broken: broken && [broken.parsed, broken.has_context, broken.parse_error], bare: bareGroup && [bareGroup.group_key, bareGroup.count] });

    // The older text form of a macOS report, and a hang file nobody can read.
    const crashText = [
        'Process:               SmallSpaces [4242]',
        'Version:               1.4.0 (1)',
        'Code Type:             ARM-64 (Native)',
        'Date/Time:             2026-11-23 10:15:00.123 +0100',
        'OS Version:            macOS 15.1 (24B83)',
        '',
        'Crashed Thread:        3  RenderThread',
        '',
        'Exception Type:        EXC_CRASH (SIGABRT)',
        'Exception Codes:       0x0000000000000000, 0x0000000000000000',
        '',
        'Thread 0:: Dispatch queue: com.apple.main-thread',
        '0   libsystem_kernel.dylib        \t0x00000001803a1234 mach_msg2_trap + 8',
        '',
        'Thread 3 Crashed:: RenderThread',
        '0   libsystem_kernel.dylib        \t0x00000001803f0000 __pthread_kill + 8',
        '1   SmallSpaces                   \t0x0000000104f3c1a4 0x104000000 + 15974820',
        '2   SmallSpaces                   \t0x0000000104f3c2b0 0x104000000 + 15975088',
        '',
        'Thread 4:',
        '0   libsystem_kernel.dylib        \t0x00000001803a1234 __psynch_cvwait + 8',
        ''
    ].join('\n');
    const textGuid = 'mac-text-' + newId();
    const hangFileGuid = 'mac-hangfile-' + newId();
    await call('POST', macQuery(textGuid), zipOf({ 'SmallSpaces_2026-11-23-101500_Mac.crash': crashText }));
    await call('POST', macQuery(hangFileGuid), zipOf({ 'SmallSpaces_2026-11-23-101500.hang': 'Date/Time: unknown\nnothing a parser knows' }));
    await settle();
    const textCrash = row('SELECT * FROM crashes WHERE crash_guid = ?', textGuid);
    const textGroup = textCrash && row('SELECT * FROM crash_groups WHERE id = ?', textCrash.group_id);
    const hangFile = row('SELECT * FROM crashes WHERE crash_guid = ?', hangFileGuid);
    check('the older .crash text report is read too (EXC_CRASH / SIGABRT is a Crash); an unreadable .hang file is kept as a Hang without context',
        textCrash && textCrash.parsed === 1 && textCrash.has_context === 1 && textCrash.error_message === 'EXC_CRASH (SIGABRT)' && textCrash.category === 'Crash'
        && textCrash.os === 'macOS 15.1 (24B83)' && textGroup.group_key === 'mac:EXC_CRASH|SmallSpaces+15974820|SmallSpaces+15975088'
        && JSON.parse(textCrash.context).callstack.startsWith('libsystem_kernel.dylib+8 (__pthread_kill)\nSmallSpaces+15974820')
        && hangFile && hangFile.parsed === 1 && hangFile.has_context === 0 && hangFile.category === 'Hang',
        { text: textCrash && [textCrash.error_message, textCrash.category, textGroup && textGroup.group_key], hang: hangFile && [hangFile.category, hangFile.has_context] });

    // ------------------------------------------------------------------ old crash route
    const legacyZip = zipOf({ 'CrashContext.runtime-xml': crashContextXml('Assertion failed: Old() [File:D:\\x\\Thing.cpp] [Line: 123] from an old build'), 'UEMinidump.dmp': minidump(crashTime + 60) });
    const legacyCrash1 = await call('POST', '/api/crashes', { crashData: legacyZip.toString('base64'), filename: 'UECC-Windows-OLD.zip', sessionId: legacySid,
        metadata: { platform: 'Mac', version: '0.1.0', gpu: 'Old GPU' } });
    const legacyCrash2 = await call('POST', '/api/crashes', { crashData: zipOf({ 'readme.txt': 'nothing' }).toString('base64'), filename: 'x.zip' });
    const legacyCrashBad = await call('POST', '/api/crashes', { filename: 'x.zip' });
    await settle();
    const oldCrashList = (await call('GET', '/api/crashes', null, { admin: true })).json;
    const lc1 = legacyCrash1.json && row('SELECT * FROM crashes WHERE crash_guid = ?', legacyCrash1.json.crash_id);
    const lc2 = legacyCrash2.json && row('SELECT * FROM crashes WHERE crash_guid = ?', legacyCrash2.json.crash_id);
    const groupAfterLegacy = row('SELECT * FROM crash_groups WHERE group_key = ?', 'Thing.cpp:123');
    check('the old crash route answers as before and the old crash list still has its reports',
        legacyCrash1.status === 200 && JSON.stringify(Object.keys(legacyCrash1.json)) === '["success","crash_id","message"]' && legacyCrash1.json.success === true
        && legacyCrash2.status === 200 && legacyCrashBad.status === 400 && oldCrashList && (oldCrashList.crashes || oldCrashList).length === 2,
        [legacyCrash1.status, legacyCrash1.json, legacyCrashBad.status]);
    check('old crash uploads appear in the new store as legacy rows: platform only when the game sent one, grouped with the new ones',
        lc1 && lc1.legacy === 1 && lc1.platform === 'Mac' && lc1.build === '0.1.0' && lc1.parsed === 1 && lc1.session_id === legacySid
        && lc1.group_id === c1.group_id && lc1.occurred_at === (crashTime + 60) * 1000 && lc1.gpu === 'Test GPU 4080'
        && lc1.file === `crashes/${legacyCrash1.json.crash_id}_UECC-Windows-OLD.zip` && fs.existsSync(path.join(storage, lc1.file))
        && lc2 && lc2.legacy === 1 && lc2.platform === null && lc2.build === null && lc2.has_context === 0
        && groupAfterLegacy.count === 3 && JSON.stringify(JSON.parse(groupAfterLegacy.platforms)) === '["Windows","Mac"]',
        { first: lc1 && [lc1.legacy, lc1.platform, lc1.build, lc1.file], second: lc2 && [lc2.platform, lc2.has_context], group: groupAfterLegacy.count });

    // ------------------------------------------------------------------ crash upload limit
    const player = '203.0.113.60';
    const statuses = {};
    for (let i = 0; i < 60; i++) {
        const r = await call('POST', crashUrl({ platform: 'Windows' }), Buffer.from('PK'), { from: player });
        statuses[r.status] = (statuses[r.status] || 0) + 1;
    }
    const overLimit = await call('POST', crashUrl({ crash_guid: 'limit-test-0001', platform: 'Windows' }), winZip, { from: player });
    const designUpload = await call('POST', '/api/designs', {}, { from: player });
    check('crash uploads have their own limit of 60 per player in 15 minutes and do not use up design uploads',
        statuses[400] === 60 && overLimit.status === 429 && designUpload.status === 400 && designUpload.headers['ratelimit-limit'] === '30'
        && designUpload.headers['ratelimit-remaining'] === '29', { statuses, over: overLimit.status, design: [designUpload.status, designUpload.headers['ratelimit-remaining']] });

    // ------------------------------------------------------------------ many at once
    const burstInstall = newId();
    const burstBefore = count('events');
    const burst = await Promise.all(Array.from({ length: 200 }, (_, i) => collect(batch(burstInstall, newId(),
        Array.from({ length: 5 }, (_, n) => ({ name: 'room_enter', t: Date.now(), seq: n, props: { mode: 'design', i } }))))));
    await settle();
    let unparsable = 0;
    for (const name of fs.readdirSync(spoolDir)) {
        for (const line of fs.readFileSync(path.join(spoolDir, name), 'utf8').split('\n').filter(Boolean)) {
            try { JSON.parse(line); } catch (e) { unparsable++; }
        }
    }
    check('200 batches at once are all answered 202 and stored, one whole line each',
        burst.every((r) => r.status === 202) && unparsable === 0 && count('events') === burstBefore + 1000 && count('sessions', 'install_id = ?', burstInstall) === 200,
        { ok: burst.filter((r) => r.status === 202).length, unparsable, events: count('events') - burstBefore });

    // ------------------------------------------------------------------ privacy
    const written = storedText();
    h = await health();
    check('no network address is stored or logged by the insights routes',
        !written.includes('198.51.100.') && !written.includes('203.0.113.') && !written.includes('127.0.0.1')
        && !serverOutput.includes('198.51.100.') && !serverOutput.includes('203.0.113.') && !JSON.stringify(h).includes('198.51.100.'));

    // ------------------------------------------------------------------ restart
    const totals = () => ({ events: count('events'), sessions: count('sessions'), installs: count('installs'), crashes: count('crashes'),
        groups: count('crash_groups'), group_total: Number(row('SELECT SUM(count) AS n FROM crash_groups').n) });
    const beforeRestart = totals();
    await stopServer('SIGTERM');
    check('the server stops on SIGTERM and says the insights worker had no trouble',
        serverOutput.includes('Received SIGTERM') && !serverOutput.includes('Insights worker stopped unexpectedly')
        && !serverOutput.includes('ExperimentalWarning') && !/\[insights\].*(failed|not stored)/.test(serverOutput),
        serverOutput.split('\n').filter((line) => /insights/i.test(line)).slice(-6));
    await startServer();
    await settle();
    check('after a restart nothing is stored a second time', JSON.stringify(totals()) === JSON.stringify(beforeRestart), totals());

    // A batch answered 202 survives a kill -9 straight afterwards.
    const sessionKill = newId();
    const beforeKill = await collect(batch(installA, sessionKill, [{ name: 'room_enter', t: Date.now(), seq: 1, props: {} }]));
    await stopServer('SIGKILL');
    // While it is down: an unfinished last line, and a spool file from ten days ago.
    const today = path.join(spoolDir, `collect-${new Date().toISOString().slice(0, 10)}.ndjson`);
    fs.appendFileSync(today, '{"type":"collect","received_at":17');
    const oldDay = new Date(Date.now() - 10 * DAY).toISOString().slice(0, 10);
    const oldSpool = path.join(spoolDir, `collect-${oldDay}.ndjson`);
    const sessionOld = newId();
    fs.writeFileSync(oldSpool, JSON.stringify({ type: 'collect', received_at: Date.now() - 10 * DAY, schema: 2, install_id: installA, session_id: sessionOld,
        build: '1.3.9', platform: 'Windows', sent_at: Date.now() - 10 * DAY, events: [{ name: 'room_enter', t: Date.now() - 10 * DAY - 1000, seq: 1, props: {} }] }) + '\n');
    await startServer();
    const sessionAfterTorn = newId();
    const afterTorn = await collect(batch(installA, sessionAfterTorn, [{ name: 'room_enter', t: Date.now(), seq: 1, props: {} }]));
    h = await settle();
    check('a batch answered 202 survives a kill -9 straight afterwards',
        beforeKill.status === 202 && count('events', 'session_id = ?', sessionKill) === 1);
    check('an unfinished last line is closed at startup and costs only itself',
        afterTorn.status === 202 && count('events', 'session_id = ?', sessionAfterTorn) === 1 && h.worker.lines_unreadable === 1
        && serverOutput.includes('ended in an unfinished line'), { unreadable: h.worker.lines_unreadable });
    const oldEvent = row('SELECT t FROM events WHERE session_id = ?', sessionOld);
    for (let i = 0; i < 50 && fs.existsSync(oldSpool); i++) await sleep(100);
    check('a spool file from ten days ago is stored with its own dates and then deleted; the newer ones stay',
        oldEvent && Math.abs(oldEvent.t - (Date.now() - 10 * DAY)) < 60000 && !fs.existsSync(oldSpool) && fs.existsSync(today)
        && count('install_days', 'install_id = ? AND day = ?', installA, oldDay) === 1
        && count('spool_offsets', 'file = ?', path.basename(oldSpool)) === 0,
        { stored: Boolean(oldEvent), file_gone: !fs.existsSync(oldSpool) });

    // ------------------------------------------------------------------ database unusable
    await stopServer('SIGTERM');
    const beforeDisabled = totals();
    await startServer({ INSIGHTS_DB_DISABLED: '1' });
    const sessionOffline = newId();
    const offlineGuid = 'offline-' + newId();
    const offCollect = await collect(batch(installA, sessionOffline, [
        { name: 'session_start', t: Date.now(), seq: 1, props: { platform: 'Windows', os_version: 'Offline OS' } },
        { name: 'room_enter', t: Date.now(), seq: 2, props: { mode: 'design' } }
    ]));
    const offCrash = await call('POST', crashUrl({ crash_guid: offlineGuid, install_id: installA, session_id: sessionOffline, build: '1.4.0', platform: 'Windows' }), winZip);
    const offLegacy = await call('POST', '/api/analytics/session/start', { client_version: '1.0.0', platform: 'Windows' });
    const offLegacyBatch = await call('POST', '/api/analytics/batch', { session_id: offLegacy.json && offLegacy.json.session_id, events: [{ event_name: 'TrackGameMode', properties: { GameMode: 'Design' } }] });
    const offDesigns = await call('GET', '/api/designs?offset=0&limit=5');
    await sleep(4500); // more than two polls of the worker
    const offHealth = await call('GET', '/api/admin/v2/health', null, { admin: true });
    const saidSo = serverOutput.split('database cannot be opened').length - 1;
    check('with the database unusable the server still starts, the old routes work and the new ones accept data',
        offCollect.status === 202 && offCrash.status === 200 && offCrash.json.duplicate === false && offLegacy.status === 200 && offLegacy.json.success === true
        && offLegacyBatch.status === 200 && offLegacyBatch.json.count === 1 && offDesigns.status === 200,
        [offCollect.status, offCrash.status, offLegacy.status, offLegacyBatch.status, offDesigns.status]);
    check('the health view then reports the database as unavailable and the waiting spool; the worker says so once',
        offHealth.status === 200 && offHealth.json.database.status === 'unavailable' && offHealth.json.worker.status === 'running'
        && offHealth.json.spool.backlog_bytes > 0 && offHealth.json.tables === undefined && saidSo === 1,
        { database: offHealth.json && offHealth.json.database, backlog: offHealth.json && offHealth.json.spool.backlog_bytes, said: saidSo });
    await stopServer('SIGTERM');
    check('the database file was not touched while it was disabled', JSON.stringify(totals()) === JSON.stringify(beforeDisabled));

    // A database file that really cannot be opened (a folder in its place).
    // (Its write-ahead files are moved with it: they can hold rows that are not in the main file yet.)
    const dbParts = ['', '-wal', '-shm'].filter((suffix) => fs.existsSync(dbFile + suffix));
    for (const suffix of dbParts) fs.renameSync(dbFile + suffix, dbFile + '.aside' + suffix);
    fs.mkdirSync(dbFile);
    await startServer();
    const sessionBroken = newId();
    const brokenCollect = await collect(batch(installA, sessionBroken, [{ name: 'room_enter', t: Date.now(), seq: 1, props: {} }]));
    await sleep(500);
    const brokenHealth = await call('GET', '/api/admin/v2/health', null, { admin: true });
    const brokenOld = await call('POST', '/api/analytics/session/start', { client_version: '1.0.0', platform: 'Windows' });
    check('the same holds when the database file itself cannot be opened',
        brokenCollect.status === 202 && brokenHealth.status === 200 && brokenHealth.json.database.status === 'unavailable'
        && typeof brokenHealth.json.database.error === 'string' && brokenOld.status === 200,
        [brokenCollect.status, brokenHealth.json && brokenHealth.json.database]);
    await stopServer('SIGTERM');
    fs.rmdirSync(dbFile);
    for (const suffix of dbParts) fs.renameSync(dbFile + '.aside' + suffix, dbFile + suffix);

    await startServer();
    await settle();
    const offSession = row('SELECT * FROM sessions WHERE session_id = ?', sessionOffline);
    const offCrashRow = row('SELECT * FROM crashes WHERE crash_guid = ?', offlineGuid);
    check('on the next normal start everything that waited in the spool is stored',
        offSession && offSession.os_version === 'Offline OS' && offSession.event_count === 2 && offCrashRow && offCrashRow.parsed === 1 && offCrashRow.category === 'Fatal Error'
        && count('sessions', 'session_id = ?', offLegacy.json.session_id) === 1 && count('events', 'session_id = ? AND legacy = 1', offLegacy.json.session_id) === 1
        && count('events', 'session_id = ?', sessionBroken) === 1 && count('events') === beforeDisabled.events + 4,
        { session: offSession && [offSession.os_version, offSession.event_count], crash: offCrashRow && [offCrashRow.parsed, offCrashRow.category], events: count('events') - beforeDisabled.events });

    await stopServer('SIGTERM');
    fs.rmSync(storage, { recursive: true, force: true });
    console.log(failed ? `RESULT: ${failed} of ${number} check(s) FAILED` : `RESULT: all ${number} checks passed`);
    process.exit(failed ? 1 : 0);
})().catch(async (error) => {
    console.error('check stopped:', error);
    console.error(serverOutput.slice(-3000));
    await stopServer('SIGKILL');
    fs.rmSync(storage, { recursive: true, force: true });
    process.exit(1);
});
