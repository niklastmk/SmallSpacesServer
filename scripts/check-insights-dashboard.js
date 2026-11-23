#!/usr/bin/env node

// Checks the dashboard side of the insights store (server/insights/admin.js
// and queries/): sign-in and its cookie, which requests are refused, that the
// old admin routes accept the session, the file routes, and that every
// registered card answers for every filter combination in good time.
//
// Usage: node scripts/check-insights-dashboard.js [port]   (needs `npm install` in server/, Node 22.5 or newer)
//
// Seeds a new temporary storage folder with made-up data (seed-insights.js),
// runs server.js from this folder on 127.0.0.1 against it and deletes the
// folder at the end. It takes no storage path and no server address, so it
// cannot reach real data. Prints one numbered line per check, exits 1 if one failed.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const admin = require('../insights/admin');

const serverFile = path.join(__dirname, '..', 'server.js');
const port = Number(process.argv[2]) || 39476;
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-insights-dash-check-'));
const ADMIN = 'local-test-only-' + process.pid; // throwaway key for this run only
const SLOW_MS = 1500;

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
        if (body) {
            data = Buffer.from(JSON.stringify(body));
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = data.length;
        }
        if (options.admin) headers['x-admin-key'] = ADMIN;
        if (options.cookie) headers.Cookie = options.cookie;
        const started = Date.now();
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                let json = null;
                try { json = JSON.parse(buffer.toString('utf8')); } catch (e) { /* not JSON */ }
                resolve({ status: res.statusCode, json, bytes: buffer.length, headers: res.headers, ms: Date.now() - started });
            });
        });
        req.on('error', (err) => resolve({ status: 0, error: err.message, ms: Date.now() - started }));
        if (data) req.write(data);
        req.end();
    });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
    child = spawn(process.execPath, [serverFile], {
        cwd: path.dirname(serverFile),
        env: { HOME: process.env.HOME, PATH: process.env.PATH, PORT: String(port), NODE_ENV: 'production',
            RAILWAY_VOLUME_MOUNT_PATH: storage, ADMIN_RESET_KEY: ADMIN },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (c) => { serverOutput += c; });
    child.stderr.on('data', (c) => { serverOutput += c; });
    for (let i = 0; i < 100; i++) {
        if ((await call('GET', '/api/health')).status === 200) return;
        await sleep(100);
    }
    throw new Error('server did not start:\n' + serverOutput);
}

async function main() {
    const seeded = spawnSync(process.execPath, [path.join(__dirname, 'seed-insights.js'), storage, '--days', '20', '--players', '120'], { encoding: 'utf8' });
    check('made-up data written to a temporary folder', seeded.status === 0, (seeded.stdout || seeded.stderr || '').trim().slice(0, 200));
    await startServer();

    // The worker stores the seeded spool; wait until nothing is waiting.
    let health = null;
    for (let i = 0; i < 150; i++) {
        health = (await call('GET', '/api/admin/v2/health', null, { admin: true })).json;
        if (health && health.tables && health.spool.backlog_bytes === 0 && health.crashes_waiting === 0 && health.tables.sessions > 0) break;
        await sleep(200);
    }
    check('the seeded data is stored (no backlog, no line refused)',
        Boolean(health && health.tables && health.spool.backlog_bytes === 0 && health.worker.lines_failed === 0 && health.tables.events > 1000 && health.tables.crashes > 10),
        health && { tables: health.tables, failed: health.worker.lines_failed, last_error: health.worker.last_error });

    // --- Sign-in ---------------------------------------------------------
    const none = await call('GET', '/api/admin/v2/frame');
    check('no session: the frame is refused with 401', none.status === 401 && none.json.error === 'signed_out', none.status);
    const wrong = await call('POST', '/api/admin/v2/sign-in', { key: 'not-the-key' });
    check('a wrong key is refused with 401 and sets no cookie', wrong.status === 401 && wrong.json.error === 'invalid_key' && !wrong.headers['set-cookie'], wrong.status);
    const right = await call('POST', '/api/admin/v2/sign-in', { key: ADMIN });
    const setCookie = (right.headers['set-cookie'] || [])[0] || '';
    const cookie = setCookie.split(';')[0];
    check('the right key answers 204 with a session cookie: HttpOnly, SameSite=Strict, Secure, 30 days, not the key itself',
        right.status === 204 && /^insights_session=/.test(cookie) && /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie)
        && /Secure/i.test(setCookie) && /Max-Age=2592000/i.test(setCookie) && !setCookie.includes(ADMIN), setCookie.replace(/=[^;]+/, '=…'));
    const frame = await call('GET', '/api/admin/v2/frame', null, { cookie });
    check('with the cookie the frame answers: builds, tracking start, event names, short link base',
        frame.status === 200 && Array.isArray(frame.json.builds) && frame.json.builds.length === 3 && typeof frame.json.tracking_since === 'number'
        && frame.json.events.includes('session_start') && typeof frame.json.short_link_base === 'string' && frame.json.query_sections_failed.length === 0,
        frame.json && { builds: frame.json.builds.map((b) => b.name), failed: frame.json.query_sections_failed });
    const tampered = await call('GET', '/api/admin/v2/frame', null, { cookie: `${cookie.slice(0, -4)}0000` });
    const expired = await call('GET', '/api/admin/v2/frame', null, { cookie: `insights_session=${admin.newToken(ADMIN, Date.now() - 31 * 24 * 60 * 60 * 1000)}` });
    const otherKey = await call('GET', '/api/admin/v2/frame', null, { cookie: `insights_session=${admin.newToken('another-key')}` });
    check('a changed, an expired and a wrongly signed cookie are refused', tampered.status === 401 && expired.status === 401 && otherKey.status === 401,
        [tampered.status, expired.status, otherKey.status]);
    const noHeader = await call('POST', '/api/admin/v2/do/nothing.here', {}, { cookie });
    const withHeader = await call('POST', '/api/admin/v2/do/nothing.here', {}, { cookie, headers: { 'x-insights': '1' } });
    check('a change with the cookie but without the x-insights header is refused; with it the request is looked at (unknown action, 404)',
        noHeader.status === 401 && withHeader.status === 404, [noHeader.status, withHeader.status]);
    const oldGet = await call('GET', '/api/featured/admin', null, { cookie });
    const oldPostNoHeader = await call('POST', '/api/featured/admin', { ids: [] }, { cookie });
    const oldNoCookie = await call('GET', '/api/featured/admin');
    check('the old admin routes accept the session for reading, refuse a change without the header, and refuse no session',
        oldGet.status === 200 && Array.isArray(oldGet.json.ids) && oldGet.json.ids.length > 0 && oldPostNoHeader.status === 403 && oldNoCookie.status === 403,
        [oldGet.status, oldPostNoHeader.status, oldNoCookie.status]);
    let limited = 0;
    for (let i = 0; i < 12; i++) {
        const attempt = await call('POST', '/api/admin/v2/sign-in', { key: `guess-${i}` }, { from: '203.0.113.77' });
        if (attempt.status === 429) limited++;
    }
    const others = await call('POST', '/api/admin/v2/sign-in', { key: ADMIN }, { from: '203.0.113.78' });
    check('ten wrong keys from one address, then that address is refused (429); another address still signs in', limited === 2 && others.status === 204, { limited, others: others.status });

    // --- The general limit ---------------------------------------------------
    let refused = 0;
    const many = [];
    for (let i = 0; i < 1100; i++) many.push(call('GET', '/api/admin/v2/frame', null, { cookie, from: '203.0.113.90' }).then((answer) => { if (answer.status !== 200) refused++; }));
    await Promise.all(many);
    const afterMany = await call('GET', '/api/health', null, { from: '203.0.113.90' });
    let signedOutRefused = 0;
    const statuses = {};
    for (let batch = 0; batch < 11; batch++) {
        const signedOut = [];
        for (let i = 0; i < 100; i++) signedOut.push(call('GET', '/api/admin/v2/frame', null, { from: '203.0.113.91' }).then((answer) => {
            statuses[answer.status] = (statuses[answer.status] || 0) + 1;
            if (answer.status === 429) signedOutRefused++;
        }));
        await Promise.all(signedOut);
    }
    check('1,100 requests of a signed-in dashboard from one address are all answered and do not count against that address; without a session the general limit applies',
        refused === 0 && afterMany.status === 200 && signedOutRefused > 0, { refused, health: afterMany.status, signedOutRefused, statuses });

    // --- Files -------------------------------------------------------------
    const thumbName = fs.readdirSync(path.join(storage, 'thumbnails'))[0];
    const thumb = await call('GET', `/api/admin/v2/thumb/${thumbName}`, null, { cookie });
    const thumbNoSession = await call('GET', `/api/admin/v2/thumb/${thumbName}`);
    const traversal = await call('GET', '/api/admin/v2/thumb/..%2Fmetadata.json', null, { cookie });
    check('a thumbnail is sent with a session, refused without, and a path outside the folder is not found',
        thumb.status === 200 && /image\/png/.test(thumb.headers['content-type']) && thumbNoSession.status === 401 && traversal.status === 404,
        [thumb.status, thumbNoSession.status, traversal.status]);

    // --- Every card, every filter ----------------------------------------
    const list = await call('GET', '/api/admin/v2/cards', null, { cookie });
    check('the list of cards and actions answers and no query file failed to load',
        list.status === 200 && list.json.cards.length >= 7 && list.json.failed.length === 0, list.json && { cards: list.json.cards.length, actions: list.json.actions.length, failed: list.json.failed });
    const filters = ['range=today', 'range=7d', 'range=30d&compare=1', 'range=90d&platform=mac', 'range=30d&platform=deck&build=newest',
        'range=since:1.4.0&platform=windows', 'range=custom&from=2020-01-01&to=2020-01-05', 'range=nonsense&platform=nonsense&build=%27%3B--&sort=nonsense&page=-3'];
    const bad = [];
    const slow = [];
    let asked = 0;
    for (const card of (list.json && list.json.cards) || []) {
        for (const filter of filters) {
            const answer = await call('GET', `/api/admin/v2/q/${card}?${filter}`, null, { cookie });
            asked++;
            // A card that needs an id (an issue, a session) may answer 400 or 404 without one; nothing may answer 500.
            const fine = (answer.status === 200 && answer.json && 'data' in answer.json && answer.json.meta && typeof answer.json.generated_at === 'number')
                || answer.status === 400 || answer.status === 404;
            if (!fine) bad.push(`${card}?${filter} -> ${answer.status} ${(answer.json && answer.json.detail) || ''}`.slice(0, 200));
            if (answer.ms > SLOW_MS) slow.push(`${card}?${filter} ${answer.ms} ms`);
        }
    }
    check(`every card answers for every filter combination (${asked} requests), an empty range and nonsense values included`, bad.length === 0, bad.slice(0, 12));
    check(`no card takes longer than ${SLOW_MS} ms on the seeded data`, slow.length === 0, slow.slice(0, 12));

    // --- The interface -----------------------------------------------------
    const built = fs.existsSync(path.join(__dirname, '..', 'insights-ui', 'dist', 'index.html'));
    const page = await call('GET', '/insights/');
    const deep = await call('GET', '/insights/stability/issues/SS-1');
    check(built ? 'the interface is served at /insights and at an address inside it' : 'the interface is not built; /insights answers 404',
        built ? page.status === 200 && deep.status === 200 && /text\/html/.test(page.headers['content-type']) : page.status === 404, [page.status, deep.status]);

    const out = await call('POST', '/api/admin/v2/sign-out', {}, { cookie });
    check('sign-out answers 204 and clears the cookie', out.status === 204 && /insights_session=;/.test(((out.headers['set-cookie'] || [])[0]) || ''), out.status);
}

main().catch((error) => {
    failed++;
    console.error('FAIL  the check itself stopped:', error);
}).finally(() => {
    if (child) child.kill('SIGKILL');
    setTimeout(() => {
        try { fs.rmSync(storage, { recursive: true, force: true }); } catch (error) { /* temporary folder */ }
        console.log(failed === 0 ? `\nAll ${number} checks passed.` : `\n${failed} of ${number} checks FAILED.`);
        process.exit(failed === 0 ? 0 : 1);
    }, 300);
});
