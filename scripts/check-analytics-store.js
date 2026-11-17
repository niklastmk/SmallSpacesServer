#!/usr/bin/env node

// Checks the analytics store of server.js (TD-SERVER-473): the game's routes
// append to events.ndjson / sessions.ndjson, the admin routes read the history
// (events.json / sessions.json) plus the logs.
//
// Usage: node scripts/check-analytics-store.js [port]      (needs `npm install` in server/)
//
// Runs server.js from this folder on 127.0.0.1 against a new temporary storage
// folder that it fills with a small made-up history and deletes at the end. It
// takes no storage path and no server address, so it cannot reach real data.
// Starts and stops the server several times. Prints one line per check and
// exits 1 if a check failed.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const serverFile = path.join(__dirname, '..', 'server.js');
const port = Number(process.argv[2]) || 39473;
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-analytics-check-'));
const ADMIN = 'local-test-only-' + process.pid; // throwaway key for this run only
const dir = path.join(storage, 'analytics');
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

// A made-up history in the format the server wrote before: 3,000 events and 800
// sessions, between 200 and 2 days old.
function writeHistory() {
    fs.mkdirSync(dir, { recursive: true });
    const names = ['FurniturePlaced', 'FurnitureRemoved', 'MaterialChanged', 'RoomOpened', 'DesignSaved'];
    const sessions = [];
    for (let i = 0; i < 800; i++) {
        const start = NOW - 200 * DAY + Math.floor((198 * DAY) * (i / 800));
        sessions.push({ id: crypto.randomUUID(), start_time: new Date(start).toISOString(),
            end_time: i % 3 ? new Date(start + 600000).toISOString() : null,
            client_version: '1.0.0', platform: 'Windows', metadata: {}, event_count: i % 50 });
    }
    const events = [];
    for (let i = 0; i < 3000; i++) {
        events.push({ id: crypto.randomUUID(), session_id: sessions[i % 800].id, event_name: names[i % names.length],
            properties: { item_id: 'item_' + (i % 90), room: i % 2 ? 'Berlin' : 'Tokyo' },
            timestamp: new Date(NOW - 200 * DAY + Math.floor((198 * DAY) * (i / 3000))).toISOString(),
            client_version: '1.0.0', platform: 'Windows' });
    }
    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(events, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify(sessions, null, 2) + '\n');
}
const eventsLog = path.join(dir, 'events.ndjson');
const sessionsLog = path.join(dir, 'sessions.ndjson');

let child = null;
let serverOutput = '';
let failed = 0;

function check(name, ok, detail) {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
}

function call(method, urlPath, body, admin) {
    return new Promise((resolve) => {
        const data = body ? JSON.stringify(body) : null;
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (admin) headers['x-admin-key'] = ADMIN;
        const started = Date.now();
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
                resolve({ status: res.statusCode, json, ms: Date.now() - started });
            });
        });
        req.on('error', (err) => resolve({ status: 0, error: err.message, ms: Date.now() - started }));
        if (data) req.write(data);
        req.end();
    });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
    serverOutput = '';
    child = spawn(process.execPath, [serverFile], {
        cwd: path.dirname(serverFile),
        // Only what the server needs: no key or address of a real service is passed on.
        env: { HOME: process.env.HOME, PATH: process.env.PATH, PORT: String(port), NODE_ENV: 'production',
            RAILWAY_VOLUME_MOUNT_PATH: storage, ADMIN_RESET_KEY: ADMIN },
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

function batch(sessionId, n, name, timestamp) {
    const events = [];
    for (let i = 0; i < n; i++) {
        events.push({ event_name: name || 'FurniturePlaced', timestamp: timestamp || new Date().toISOString(),
            properties: { item_id: 'item_' + i, room: 'Berlin' } });
    }
    return { session_id: sessionId, client_version: '1.1.0', platform: 'Windows', events };
}

const summary = async () => (await call('GET', '/api/analytics/summary', null, true)).json;

(async () => {
    writeHistory();
    const historyEvents = JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8'));
    const historySessions = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'));
    const H = historyEvents.length, S = historySessions.length;
    const historyActive = historySessions.filter((s) => !s.end_time).length;
    const openHistorySession = historySessions.find((s) => !s.end_time);
    const historyBytes = [fs.statSync(path.join(dir, 'events.json')).size, fs.statSync(path.join(dir, 'sessions.json')).size];
    console.log(`history: ${H} events, ${S} sessions (${historyActive} without end)`);

    await startServer();

    // --- history only
    let sum = await summary();
    check('summary counts the history before anything is added', sum.events.total === H && sum.sessions.total === S && sum.sessions.active === historyActive,
        { events: sum.events.total, sessions: sum.sessions.total, active: sum.sessions.active });

    // --- response shapes
    const start = await call('POST', '/api/analytics/session/start', { client_version: '1.1.0', platform: 'Windows' });
    const sid = start.json && start.json.session_id;
    check('session start answers { success, session_id }', start.status === 200 && start.json.success === true && typeof sid === 'string' && sid.length === 36, start.json);

    let sent = 0;
    for (let i = 0; i < 3; i++) {
        const r = await call('POST', '/api/analytics/batch', batch(sid, 12));
        sent += 12;
        if (i === 0) {
            check('batch answers { success, event_ids, count }', r.status === 200 && r.json.success === true && Array.isArray(r.json.event_ids) && r.json.event_ids.length === 12 && r.json.count === 12,
                { status: r.status, count: r.json && r.json.count, ids: r.json && r.json.event_ids && r.json.event_ids.length });
        }
    }
    const single = await call('POST', '/api/analytics/event', { session_id: sid, event_name: 'VerifyOnlyInLog', properties: { colour: 'green' }, client_version: '1.1.0', platform: 'Windows' });
    sent += 1;
    check('single event answers { success, event_id }', single.status === 200 && single.json.success === true && typeof single.json.event_id === 'string', single.json);

    const bad1 = await call('POST', '/api/analytics/event', { session_id: sid });
    const bad2 = await call('POST', '/api/analytics/batch', { session_id: sid });
    const bad3 = await call('POST', '/api/analytics/session/end', {});
    const bad4 = await call('POST', '/api/analytics/batch', { session_id: sid, events: [{ event_name: 5 }, { nothing: true }] });
    check('invalid requests are answered as before (400, 400, 400, empty batch 200)',
        bad1.status === 400 && bad2.status === 400 && bad3.status === 400 && bad4.status === 200 && bad4.json.count === 0,
        [bad1.status, bad2.status, bad3.status, bad4.status, bad4.json]);

    check('the history files were not touched by the writes',
        fs.statSync(path.join(dir, 'events.json')).size === historyBytes[0] && fs.statSync(path.join(dir, 'sessions.json')).size === historyBytes[1]);

    // --- readers see history plus log
    sum = await summary();
    check('summary counts history and new events together', sum.events.total === H + sent && sum.sessions.total === S + 1 && sum.sessions.active === historyActive + 1,
        { events: sum.events.total, expected: H + sent, sessions: sum.sessions.total, active: sum.sessions.active });
    const mine = await call('GET', `/api/analytics/events?session_id=${sid}&limit=5`, null, true);
    check('events query finds the new events', mine.json.total === sent && mine.json.events.length === 5 && mine.json.events[0].session_id === sid, { total: mine.json.total });
    const names = await call('GET', '/api/analytics/event-names', null, true);
    check('event names include a name that is only in the log', names.json.event_names.includes('VerifyOnlyInLog') && names.json.event_names.includes('RoomOpened'));
    const breakdown = await call('GET', '/api/analytics/event-breakdown?event_name=VerifyOnlyInLog&property=colour', null, true);
    check('event breakdown reads the log', breakdown.json.total_count === 1 && breakdown.json.breakdown[0].value === 'green', breakdown.json);
    const fp = await call('GET', '/api/analytics/event-breakdown?event_name=FurniturePlaced&property=room', null, true);
    const historyFp = historyEvents.filter((e) => e.event_name === 'FurniturePlaced').length;
    check('event breakdown adds history and log', fp.json.total_count === historyFp + 36, { total: fp.json.total_count, expected: historyFp + 36 });
    let list = await call('GET', '/api/analytics/sessions?limit=1', null, true);
    check('sessions list shows the new session as active', list.json.total === S + 1 && list.json.sessions[0].id === sid && list.json.sessions[0].end_time === null, list.json.sessions[0]);

    // --- restart loses nothing (graceful stop)
    await stopServer('SIGTERM');
    await startServer();
    sum = await summary();
    check('after a restart (SIGTERM) every event and session is still there', sum.events.total === H + sent && sum.sessions.total === S + 1, { events: sum.events.total, sessions: sum.sessions.total });

    // --- restart loses nothing (killed right after the answer)
    const beforeKill = await call('POST', '/api/analytics/batch', batch(sid, 12));
    sent += 12;
    await stopServer('SIGKILL');
    await startServer();
    sum = await summary();
    check('a batch answered 200 survives a kill -9 straight afterwards', beforeKill.status === 200 && sum.events.total === H + sent, { events: sum.events.total, expected: H + sent });

    // --- session end after a restart: the session started in an earlier process
    const afterRestart = await call('POST', '/api/analytics/batch', batch(sid, 7));
    sent += 7;
    const end = await call('POST', '/api/analytics/session/end', { session_id: sid });
    check('session end answers { success, session } without the session in memory',
        end.status === 200 && end.json.success === true && end.json.session.id === sid && typeof end.json.session.end_time === 'string' && end.json.session.event_count === 7,
        end.json);
    list = await call('GET', '/api/analytics/sessions?limit=1', null, true);
    const shown = list.json.sessions[0];
    check('sessions list shows it ended, with its start from the log', shown.id === sid && shown.end_time === end.json.session.end_time && typeof shown.start_time === 'string' && shown.platform === 'Windows' && shown.event_count === 7, shown);

    // --- session started and ended in one process: full session in the answer
    const s2 = (await call('POST', '/api/analytics/session/start', { client_version: '1.1.0', platform: 'Windows' })).json.session_id;
    await call('POST', '/api/analytics/batch', batch(s2, 9));
    sent += 9;
    const end2 = await call('POST', '/api/analytics/session/end', { session_id: s2 });
    const e2 = end2.json.session;
    check('session end in the same process answers the whole session with its count',
        end2.status === 200 && e2.id === s2 && typeof e2.start_time === 'string' && e2.platform === 'Windows' && e2.client_version === '1.1.0' && e2.event_count === 9 && typeof e2.end_time === 'string'
        && JSON.stringify(Object.keys(e2).sort()) === JSON.stringify(['client_version', 'end_time', 'event_count', 'id', 'metadata', 'platform', 'start_time']), e2);

    // --- a session from the history can be ended; an unknown id changes nothing
    const endOld = await call('POST', '/api/analytics/session/end', { session_id: openHistorySession.id });
    const endUnknown = await call('POST', '/api/analytics/session/end', { session_id: 'no-such-session' });
    sum = await summary();
    check('ending a session from the history marks it ended; an unknown id adds no session',
        endOld.status === 200 && endUnknown.status === 200 && sum.sessions.total === S + 2 && sum.sessions.active === historyActive - 1,
        { total: sum.sessions.total, active: sum.sessions.active, expectedActive: historyActive - 1 });

    // --- many batches at once: no line is mixed with another
    const burst = await Promise.all(Array.from({ length: 200 }, (_, i) => call('POST', '/api/analytics/batch', batch('burst-' + (i % 10), 5, 'BurstEvent'))));
    sent += 1000;
    const lines = fs.readFileSync(eventsLog, 'utf8').split('\n').filter(Boolean);
    let unparsable = 0;
    for (const line of lines) { try { JSON.parse(line); } catch (e) { unparsable++; } }
    sum = await summary();
    check('200 batches at once are all stored, one whole line per event',
        burst.every((r) => r.status === 200 && r.json.count === 5) && unparsable === 0 && lines.length === sent && sum.events.total === H + sent,
        { ok: burst.filter((r) => r.status === 200).length, lines: lines.length, unparsable, total: sum.events.total, expected: H + sent });

    // --- an unfinished last line (process killed in the middle of an append)
    await stopServer('SIGTERM');
    fs.appendFileSync(eventsLog, '{"id":"torn","event_name":"Tor');
    await startServer();
    const afterTorn = await call('POST', '/api/analytics/event', { session_id: 'after-torn', event_name: 'AfterTornLine' });
    sent += 1;
    sum = await summary();
    const foundAfterTorn = await call('GET', '/api/analytics/events?event_name=AfterTornLine', null, true);
    check('an unfinished last line is closed at startup and costs only itself',
        afterTorn.status === 200 && sum.events.total === H + sent && foundAfterTorn.json.total === 1
        && serverOutput.includes('ended in an unfinished line') && serverOutput.includes('1 unreadable line(s) skipped'),
        { total: sum.events.total, expected: H + sent, found: foundAfterTorn.json.total });

    // --- delete before a date: history and log
    const oldStamp = new Date(NOW - 30 * 60 * 60 * 1000).toISOString();
    const cutoffHistory = new Date(NOW - 36 * 60 * 60 * 1000).toISOString();
    const cutoffDated = new Date(NOW - 24 * 60 * 60 * 1000).toISOString();
    await call('POST', '/api/analytics/batch', batch('dated', 20, 'DatedEvent', oldStamp));
    sent += 20;
    const del1 = await call('DELETE', `/api/analytics/events/before?date=${cutoffHistory}`, null, true);
    check('delete before 36 hours ago removes the whole history and nothing from the log',
        del1.status === 200 && del1.json.deleted_count === H && del1.json.remaining_count === sent
        && fs.readFileSync(path.join(dir, 'events.json'), 'utf8').trim() === '[]', del1.json);
    const del2 = await call('DELETE', `/api/analytics/events/before?date=${cutoffDated}`, null, true);
    sum = await summary();
    check('delete before 24 hours ago removes the 20 events dated 30 hours ago from the log',
        del2.status === 200 && del2.json.deleted_count === 20 && del2.json.remaining_count === sent - 20 && sum.events.total === sent - 20
        && !fs.existsSync(eventsLog + '.tmp'), { ...del2.json, total: sum.events.total });
    const afterDelete = await call('POST', '/api/analytics/event', { session_id: 'after-delete', event_name: 'AfterDelete' });
    sum = await summary();
    check('events still arrive after the log was rewritten', afterDelete.status === 200 && sum.events.total === sent - 20 + 1, { total: sum.events.total });

    // --- a history file that cannot be read is not replaced by an empty one
    fs.writeFileSync(path.join(dir, 'events.json'), '[{"id": "broken"');
    const delBroken = await call('DELETE', '/api/analytics/events/before?date=2030-01-01T00:00:00Z', null, true);
    const logLinesAfter = fs.readFileSync(eventsLog, 'utf8').split('\n').filter(Boolean).length;
    check('delete refuses when the history cannot be read and leaves both files alone',
        delBroken.status === 500 && fs.readFileSync(path.join(dir, 'events.json'), 'utf8') === '[{"id": "broken"' && logLinesAfter > 1000 && !fs.existsSync(path.join(dir, 'events.json.tmp')),
        { status: delBroken.status, logLines: logLinesAfter });
    fs.writeFileSync(path.join(dir, 'events.json'), '[]\n');

    // --- clear removes history and log
    const clear = await call('DELETE', '/api/analytics/clear', null, true);
    sum = await summary();
    check('clear empties history and logs', clear.status === 200 && clear.json.success === true && sum.events.total === 0 && sum.sessions.total === 0
        && !fs.existsSync(eventsLog) && !fs.existsSync(sessionsLog), { events: sum.events.total, sessions: sum.sessions.total });

    await call('POST', '/api/analytics/session/start', { client_version: '1.1.0', platform: 'Windows' });
    await call('POST', '/api/analytics/batch', batch('x', 3));
    sum = await summary();
    const refilled = sum.events.total === 3 && sum.sessions.total === 1;
    const reset = await call('DELETE', '/api/admin/reset-analytics', null, true);
    sum = await summary();
    check('admin reset-analytics empties history and logs too', refilled && reset.status === 200 && reset.json.success === true && sum.events.total === 0 && sum.sessions.total === 0,
        { refilled, events: sum.events.total, sessions: sum.sessions.total });

    const noKey = await call('GET', '/api/analytics/summary');
    check('admin routes still refuse a request without the admin key', noKey.status === 403, noKey.status);

    await stopServer('SIGTERM');
    fs.rmSync(storage, { recursive: true, force: true });
    console.log(failed ? `RESULT: ${failed} check(s) FAILED` : 'RESULT: all checks passed');
    process.exit(failed ? 1 : 0);
})().catch(async (error) => {
    console.error('check stopped:', error);
    console.error(serverOutput.slice(-2000));
    await stopServer('SIGKILL');
    fs.rmSync(storage, { recursive: true, force: true });
    process.exit(1);
});
