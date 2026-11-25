#!/usr/bin/env node

// Checks the Live page's data (insights/queries/live.js), the country lookup
// (insights/geo.js) and where it is stored.
//
// Usage: node scripts/check-insights-live.js [port]
//
// Runs server.js from this folder on 127.0.0.1 against a new temporary storage
// folder that it fills with made-up players and deletes at the end. It takes no
// storage path and no server address, so it cannot reach real data. Prints one
// line per check and exits 1 if a check failed.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const geo = require('../insights/geo');
const live = require('../insights/queries/live');

const serverFile = path.join(__dirname, '..', 'server.js');
const port = Number(process.argv[2]) || 39478;
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-live-check-'));
const ADMIN = 'local-test-only-' + process.pid; // throwaway key for this run only
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const dbFile = path.join(storage, 'insights', 'insights.db');
let child = null;
let output = '';
let failed = 0;
let n = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function check(name, ok, detail) {
    n++;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${name}${detail !== undefined && (!ok || process.env.VERBOSE) ? '  ' + JSON.stringify(detail).slice(0, 900) : ''}`);
}
function call(method, url, body, options = {}) {
    return new Promise((resolve) => {
        const text = body === null || body === undefined ? null : JSON.stringify(body);
        const request = http.request({ host: '127.0.0.1', port, path: url, method, headers: {
            ...(text ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } : {}),
            ...(options.from ? { 'x-forwarded-for': options.from } : {}), ...(options.admin ? { 'x-admin-key': ADMIN } : {}) } }, (response) => {
            let data = '';
            response.on('data', (chunk) => { data += chunk; });
            response.on('end', () => { let json = null; try { json = JSON.parse(data); } catch (error) { /* not JSON */ } resolve({ status: response.statusCode, json, text: data }); });
        });
        request.on('error', (error) => resolve({ status: 0, error: error.message }));
        request.end(text || undefined);
    });
}
async function startServer() {
    output = '';
    child = spawn(process.execPath, [serverFile], { cwd: path.dirname(serverFile), stdio: ['ignore', 'pipe', 'pipe'],
        env: { HOME: process.env.HOME, PATH: process.env.PATH, PORT: String(port), NODE_ENV: 'production', RAILWAY_VOLUME_MOUNT_PATH: storage, ADMIN_RESET_KEY: ADMIN } });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    for (let i = 0; i < 200; i++) {
        const answer = (await call('GET', '/api/admin/v2/health', null, { admin: true })).json;
        if (answer && answer.database && answer.database.status === 'ok') return;
        await sleep(50);
    }
    throw new Error('server did not start:\n' + output);
}
const stopServer = () => new Promise((resolve) => { if (!child) return resolve(); const c = child; child = null; c.once('exit', resolve); c.kill('SIGTERM'); setTimeout(() => c.kill('SIGKILL'), 3000).unref(); });
const card = async (name, params = {}) => (await call('GET', `/api/admin/v2/q/live.${name}?` + new URLSearchParams(params), null, { admin: true })).json.data;
async function settle() {
    for (let i = 0; i < 200; i++) {
        const health = (await call('GET', '/api/admin/v2/health', null, { admin: true })).json;
        if (health && health.spool && health.spool.backlog_bytes === 0 && health.crashes_waiting === 0) break;
        await sleep(50);
    }
    await sleep(31000); // the cards remember the sessions of earlier hours for half a minute
}
function query(sql, ...args) {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try { return db.prepare(sql).all(...args); } finally { db.close(); }
}
const near = (a, b, by) => Math.abs(a - b) <= by;

const base = { device: 'pc', os_version: '10.0.26100.1.256.64bit', ram_gb: 16, gpu: 'NVIDIA GeForce RTX 3060', rhi: 'D3D12', screen_w: 1920, screen_h: 1080, language: 'en', quality_preset: '3', upscaler: 'dlss', window_mode: 'borderless', launch_count: 9, existing_player: true };
function player(overrides = {}) {
    const p = { install: crypto.randomUUID(), session: crypto.randomUUID(), platform: 'Windows', from: '8.8.8.8', seq: 0, ...overrides };
    p.send = (events) => call('POST', '/api/v2/collect', { schema: 2, install_id: p.install, session_id: p.session, build: '1.5.0', steam_build: 1, platform: p.platform, sent_at: Date.now(),
        events: events.map(([name, ago, props]) => ({ name, t: Date.now() - ago, seq: p.seq++, props: props || {} })) }, { from: p.from });
    return p;
}

(async () => {
    // ------------------------------------------------------------------ country lookup
    check('addresses: IPv4, mapped IPv4 and IPv6 give a country; private, reserved and broken ones give none',
        geo.countryOf('8.8.8.8') === 'US' && geo.countryOf('::ffff:8.8.8.8') === 'US' && geo.countryOf('2a02:8108::1') === 'DE' && geo.countryOf('2606:4700:4700::1111') !== null
        && ['10.0.0.1', '192.168.1.1', '127.0.0.1', '::1', 'unknown', '', null, undefined, '1.2.3', '1.2.3.999', '1:2:3', 'a::b::c', '8.8.8.8, 1.1.1.1'].every((value) => geo.countryOf(value) === null),
        [geo.countryOf('8.8.8.8'), geo.countryOf('2a02:8108::1'), geo.countryOf('2606:4700:4700::1111')]);
    check('the table says where it is from and when', /^\d{4}-\d{2}$/.test(geo.info().month) && /DB-IP/.test(geo.info().source), geo.info());

    // ------------------------------------------------------------------ the estimate, as arithmetic
    const table = new Float64Array(722);
    for (let m = 0; m < table.length; m++) table[m] = Math.max(0, 1 - m / 100); // sessions end evenly over 100 minutes
    const model = { table, lost: 0.25 };
    const now = Date.now();
    const at = (session) => live.aliveAt({ legacy: false, ended: null, reason: null, duration: null, ...session }, now, now, model);
    const ago = (minutes) => now - minutes * MINUTE;
    check('a session heard from in the last ten minutes counts whole, one that ended or was replaced counts nothing',
        at({ started: ago(50), seen: ago(4) }) === 1 && at({ started: ago(50), seen: ago(9), ended: ago(9) }) === 0 && at({ started: ago(50), seen: ago(40), reason: 'abnormal', duration: 300 }) === 0
        && at({ started: ago(50), seen: ago(45), next: ago(10) }) === 0);
    // Started 50 min ago, last heard at the age of 0: S(50) = 0.5, S(0) = 1 -> 0.5 / (0.5 + 0.25 * 0.5) = 0.8
    check('a silent session: S(x) / (S(x) + lost * (S(a) - S(x)))', near(at({ started: ago(50), seen: ago(50) }), 0.8, 1e-9) && near(at({ started: ago(80), seen: ago(60) }), 0.2 / (0.2 + 0.25 * 0.6), 1e-9)
        && near(at({ started: ago(50), seen: ago(50), legacy: true }), 0.5, 1e-9) && at({ started: ago(13 * 60), seen: ago(13 * 60) }) === 0, at({ started: ago(50), seen: ago(50) }));
    check('looking back, a silent session is the surer to have run the earlier one looks', (() => {
        const session = { legacy: false, ended: null, reason: null, duration: null, started: ago(60), seen: ago(60) };
        const then = [60, 40, 20, 0].map((minutes) => live.aliveAt(session, ago(minutes), now, model));
        return then[0] === 1 && then[0] > then[1] && then[1] > then[2] && then[2] > then[3] && near(then[3], 0.4 / (0.4 + 0.25 * 0.6), 1e-9);
    })());

    await startServer();
    // ------------------------------------------------------------------ nothing stored yet
    const empty = {};
    for (const name of ['now', 'pulse', 'play', 'region', 'devices', 'health', 'community', 'feed']) empty[name] = await call('GET', `/api/admin/v2/q/live.${name}?w=1h`, null, { admin: true });
    check('every card answers on an empty store', Object.values(empty).every((answer) => answer.status === 200 && answer.json.data), Object.entries(empty).map(([name, answer]) => [name, answer.status]));
    check('the cards need the key', (await call('GET', '/api/admin/v2/q/live.now')).status === 401);

    // ------------------------------------------------------------------ players
    // 60 finished sessions of 10, 11, ... 69 minutes, all over by now, in the last six hours.
    for (let i = 0; i < 60; i++) {
        const p = player();
        const length = 10 + i;
        const end = (100 + i) * MINUTE;
        await p.send([['session_start', end + length * MINUTE, { platform: 'Windows', ...base }], ['session_end', end, { duration_s: length * 60, active_s: length * 50, reason: 'quit' }]]);
    }
    const heard = player({ from: '91.0.0.1' }); // Germany, on a Mac, heard from two minutes ago, in a room
    await heard.send([['session_start', 30 * MINUTE, { platform: 'Mac', ...base, device: 'apple_silicon', os_version: '26.1', gpu: 'Apple M2', launch_count: 1, existing_player: false }], ['menu_shown', 29 * MINUTE, { startup_s: 8 }],
        ['room_enter', 3 * MINUTE, { mode: 'design', level_id: 'berlin_new_41' }], ['room_ready', 2 * MINUTE, { mode: 'design', level_id: 'berlin_new_41', load_s: 12 }]]);
    const silent = player({ from: '2a02:8108::1' }); // Germany, over IPv6: launched 40 minutes ago, nothing since
    await silent.send([['session_start', 40 * MINUTE, { platform: 'Windows', ...base }], ['menu_shown', 39 * MINUTE, { startup_s: 10 }]]);
    const replaced = player({ from: '8.8.8.8' }); // two launches of one player: the first is over
    await replaced.send([['session_start', 25 * MINUTE, { platform: 'Windows', ...base }]]);
    replaced.session = crypto.randomUUID();
    replaced.seq = 0;
    await replaced.send([['session_start', 1 * MINUTE, { platform: 'Windows', ...base }]]);
    const nowhere = player({ from: '198.51.100.7' }); // a documentation address: no country
    await nowhere.send([['session_start', 2 * MINUTE, { platform: 'Windows', ...base, device: 'steam_deck', gpu: 'AMD Custom GPU 0932' }]]);
    const busy = player({ from: '126.0.0.1' }); // Japan: two rooms, a lot of failed saves, quit
    await busy.send([['session_start', 50 * MINUTE, { platform: 'Windows', ...base }], ['room_enter', 48 * MINUTE, { mode: 'unpack', level_id: 'tokyo_new_05' }], ['room_ready', 47 * MINUTE, { mode: 'unpack', level_id: 'tokyo_new_05', load_s: 6 }],
        ['star_earned', 30 * MINUTE, { level_id: 'tokyo_new_05', stars_total: 1 }],
        ['room_exit', 28 * MINUTE, { mode: 'unpack', level_id: 'tokyo_new_05', duration_s: 1200, active_s: 1000, items_placed: 42, items_moved: 7, materials_applied: 3, undo_count: 2, redo_count: 1, saves: 2, ready: true, exit_to: 'menu' }],
        ['room_perf', 28 * MINUTE, { mode: 'unpack', level_id: 'tokyo_new_05', fps_avg: 24 }], ['catalog_usage', 28 * MINUTE, { mode: 'unpack', level_id: 'tokyo_new_05', items: 'BP_Sofa_Loop:30,BP_Lamp_Arc:12,BP_Cut' }],
        ['gallery_open', 20 * MINUTE, { ok: true, count: 40 }], ['design_like', 19 * MINUTE, { design_id: crypto.randomUUID(), like: true }]]);
    for (let i = 0; i < 30; i++) await busy.send([['save_failed', 15 * MINUTE - i * 1000, { outcome: 'WriteFailed', mode: 'unpack', level_id: 'tokyo_new_05' }]]);
    await busy.send([['session_end', 12 * MINUTE, { duration_s: 2280, active_s: 2000, reason: 'quit' }]]);
    const old = await call('POST', '/api/analytics/session/start', { client_version: '1.0.0', platform: 'Windows', metadata: {} }, { from: '90.0.0.1' });
    const before = player(); // the hour before the last one
    await before.send([['room_exit', 90 * MINUTE, { mode: 'design', level_id: 'berlin_new_41', duration_s: 600, active_s: 600, items_placed: 10, saves: 1, ready: true, exit_to: 'quit' }], ['session_end', 89 * MINUTE, { duration_s: 700, active_s: 600, reason: 'quit' }]]);
    fs.writeFileSync(path.join(storage, 'metadata.json'), JSON.stringify([
        { id: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', title: 'New one', author_name: 'a', level: '/Game/Levels/berlin_new_41.berlin_new_41', download_count: 1, upload_date: new Date(Date.now() - 5 * MINUTE).toISOString(), thumbnail_url: '/api/thumbnails/x.png' },
        { id: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', title: 'Old one', author_name: 'b', level: 'tokyo', download_count: 9, upload_date: new Date(Date.now() - 400 * HOUR).toISOString(), thumbnail_url: '/api/thumbnails/y.png' }]));
    fs.writeFileSync(path.join(storage, 'artist_clicks.json'), JSON.stringify([{ slug: 'leah', timestamp: new Date(Date.now() - 4 * MINUTE).toISOString(), bot: false }, { slug: 'leah', timestamp: new Date(Date.now() - 4 * MINUTE).toISOString(), bot: true }]));
    await settle();

    // ------------------------------------------------------------------ country stored, address not
    const countries = Object.fromEntries(query('SELECT session_id, country FROM sessions').map((row) => [row.session_id, row.country]));
    check('a session is stored with its country (IPv4, IPv6, old versions too), without one for an address that has none',
        countries[heard.session] === 'DE' && countries[silent.session] === 'DE' && countries[busy.session] === 'JP' && countries[nowhere.session] === null && countries[old.json.session_id] === 'FR',
        [countries[heard.session], countries[silent.session], countries[busy.session], countries[nowhere.session], countries[old.json.session_id]]);
    const spool = fs.readdirSync(path.join(storage, 'insights', 'spool')).map((name) => fs.readFileSync(path.join(storage, 'insights', 'spool', name), 'utf8')).join('\n');
    const dump = JSON.stringify(query('SELECT * FROM sessions')) + JSON.stringify(query('SELECT * FROM events')) + JSON.stringify(query('SELECT * FROM installs'));
    const addresses = ['8.8.8.8', '91.0.0.1', '2a02:8108', '198.51.100.7', '126.0.0.1', '90.0.0.1'];
    check('no address is in the spool, the database or the log', addresses.every((address) => !spool.includes(address) && !dump.includes(address) && !output.includes(address)));
    const other = player();
    await other.send([['session_start', 0, { platform: 'Windows', ...base, country: 'XX' }]]);
    other.from = '91.0.0.1';
    await other.send([['menu_shown', 0, {}]]);
    await settle();
    check('the game cannot set the country, and the first one heard stays', query('SELECT country FROM sessions WHERE session_id = ?', other.session)[0].country === 'US');
    check('when an end was heard of is stored', query('SELECT end_received_at AS t, ended_at AS e FROM sessions WHERE session_id = ?', busy.session).every((row) => Number(row.t) - Number(row.e) > 11 * MINUTE)
        && query('SELECT end_received_at AS t FROM sessions WHERE session_id = ?', silent.session)[0].t === null);

    // ------------------------------------------------------------------ live.now
    const state = await card('now');
    // Whole: heard, the second launch of `replaced`, nowhere, other, the old build's launch (just heard).
    // The silent one is 40 minutes old, last heard at 1: S from 61 finished sessions (10..69 min and busy's 38).
    const lengths = [...Array.from({ length: 60 }, (_, i) => 10 + i), 38, 700 / 60];
    const S = (minutes) => { const l = (m) => (lengths.filter((length) => length > m).length + 0.5) / (lengths.length + 1); const f = Math.floor(minutes); return l(f) + (l(f + 1) - l(f)) * (minutes - f); };
    const told = 1 - 0.7; // fewer than 30 sessions are old enough to say how many ends arrive: 70 %
    const silentAge = 40 + 31 * 2 / 60 + 0.2;
    const expected = 5 + S(silentAge) / (S(silentAge) + told * (S(1) - S(silentAge)));
    check('the estimate is the sum of who is surely there and who probably is', state.estimate === Math.round(expected) && state.heard === 5 && state.low >= 5 && state.high >= state.estimate, { estimate: state.estimate, expected, heard: state.heard, low: state.low, high: state.high, basis: state.basis });
    check('its platforms add up, and it says what it rests on', near(state.by_platform.reduce((total, row) => total + row.value, 0), expected, 0.06) && state.by_platform.find((row) => row.platform === 'mac').value === 1 && state.by_platform.find((row) => row.platform === 'deck').value === 1
        && state.basis.measured === true && state.basis.sessions === 62 && near(state.old_builds, 1, 1e-9), [state.by_platform, state.basis]);
    const when = Date.now() - 125 * MINUTE;
    const index = state.curve.times.findIndex((time) => time >= when);
    const t = state.curve.times[index];
    const running = query("SELECT COUNT(*) AS n FROM sessions WHERE started_at <= ? AND ended_at > ? AND legacy = 0", t, t)[0].n;
    check('the curve is exact where all ends are known', state.curve.windows[index] === Number(running) && state.curve.times.length === 145, { curve: state.curve.windows[index], running });
    check('launches of the last hour and five minutes', state.launches.last_hour === 8 && state.launches.last_5_min === 4 && state.launches.last_15.reduce((a, b) => a + b, 0) === 8, state.launches);
    const mac = await card('now', { platform: 'mac' });
    check('the platform filter', mac.estimate === 1 && mac.curve.windows.every((value) => value === 0) && mac.launches.last_hour === 1, mac.estimate);

    // ------------------------------------------------------------------ the windows
    const tile = (data, key) => data.tiles.find((entry) => entry.key === key);
    const pulse = await card('pulse', { w: '1h' });
    check('the numbers of the last hour', tile(pulse, 'launches').value === 8 && tile(pulse, 'players').value === 6 && tile(pulse, 'new_players').value === 1 && tile(pulse, 'rooms').value === 2 && tile(pulse, 'items').value === 42
        && tile(pulse, 'moves').value === 7 && tile(pulse, 'materials').value === 3 && tile(pulse, 'saves').value === 2 && tile(pulse, 'stars').value === 1 && tile(pulse, 'undo').value === 3 && tile(pulse, 'uploads').value === 1
        && near(tile(pulse, 'hours').value, 1000 / 3600, 1e-9) && tile(pulse, 'items').series.reduce((a, b) => a + b, 0) === 42, pulse.tiles.map((entry) => [entry.key, entry.value, entry.previous]));
    check('and of the hour before', tile(pulse, 'items').previous === 10 && tile(pulse, 'saves').previous === 1, [tile(pulse, 'items').previous]);
    const wide = await card('pulse', { w: '24h' });
    check('a window that began before anything was collected has nothing to compare with', tile(wide, 'items').value === 52 && tile(wide, 'items').previous === null && wide.partial === true);

    const play = await card('play', { w: '1h' });
    const mode = (key) => play.modes.find((entry) => entry.mode === key);
    check('modes, rooms and items', mode('unpack').rooms === 1 && mode('unpack').seconds === 1000 && mode('design').rooms === 1 && play.level_count === 2 && play.levels.find((level) => level.level === 'tokyo_new_05').items === 42
        && play.items_total === 42 && play.items[0].item === 'BP_Sofa_Loop' && play.items[0].count === 30 && play.items.length === 2, play);
    const place = (key) => play.now.places.find((entry) => entry.key === key).value;
    check('where people were last reported: one in a design room, the fresh launches in the menu, the silent one unknown', place('design') === 1 && place('unpack') === 0 && near(place('menu'), 4, 1e-9) && near(place('unknown'), expected - 5, 0.05)
        && play.now.levels.length === 1 && play.now.levels[0].level === 'berlin_new_41', play.now);

    const region = await card('region', { w: '1h' });
    const country = (code) => region.countries.find((row) => row.code === code);
    check('countries: players, who is playing, and how many have one', country('DE').players === 2 && country('DE').mac === 1 && country('JP').players === 1 && country('JP').playing === 0 && country('FR').players === 1 && country('US').players === 2
        && region.players === 7 && region.known === 6 && near(country('DE').playing, 1 + expected - 5, 0.05), region.countries);
    const devices = await card('devices', { w: '1h' });
    const dim = (key) => Object.fromEntries(devices.dims[key].rows.map((row) => [row.key, row.count]));
    check('devices: one entry per player, named as on the other pages', devices.players === 6 && devices.old_builds === 1 && dim('device')['Steam Deck'] === 1 && dim('device')['Mac, Apple chip'] === 1 && dim('os')['macOS 26 Tahoe'] === 1
        && dim('gpu')['NVIDIA RTX 30 series'] === 4 && dim('memory')['16 GB'] === 6 && dim('launches')['First launch ever'] === 1 && dim('quality').Epic === 6 && devices.builds.find((row) => row.key === 'Before the update').count === 1, devices);
    const health = await card('health', { w: '1h' });
    check('a player whose saves fail over and over is one player, and is named as a problem', health.saves.failed === 30 && health.saves.failed_players === 1 && health.saves.rows[0].count === 30 && health.saves.rows[0].session === busy.session
        && health.alerts.some((alert) => alert.kind === 'save_loop' && alert.level === 'bad' && alert.count === 30 && alert.players === 1 && alert.outcome === 'WriteFailed') && health.fps.rooms === 1 && health.fps.median === null && health.load.rooms === 2, health);
    const community = await card('community', { w: '1h' });
    check('community', community.uploads === 1 && community.total_designs === 2 && community.newest[0].title === 'New one' && community.gallery_visits === 1 && community.likes === 1 && community.artist_total === 1 && community.newest[0].thumb === '/api/admin/v2/thumb/x.png', community);

    // ------------------------------------------------------------------ the feed
    const feed = await card('feed');
    const saveRows = feed.entries.filter((entry) => entry.name === 'save_failed');
    check('the feed: newest arrival first, the same failure folded into one line, with country, and no ids of players', saveRows.length === 1 && saveRows[0].count === 30 && saveRows[0].country === 'JP' && feed.entries.length === 60
        && feed.entries.every((entry, i) => i === 0 || entry.id < feed.entries[i - 1].id) && !JSON.stringify(feed).includes(busy.install), { saveRows, first: feed.entries[0] });
    await heard.send([['star_earned', 0, { level_id: 'berlin_new_41', stars_total: 2 }]]);
    await sleep(700);
    const next = await card('feed', { since: String(feed.cursor) });
    check('with the cursor only what is new comes back', next.entries.length === 1 && next.entries[0].name === 'star_earned' && next.entries[0].platform === 'mac', next.entries);
    check('the feed follows the platform filter', (await card('feed', { platform: 'mac' })).entries.every((entry) => entry.platform === 'mac'));
    await stopServer();

    // ------------------------------------------------------------------ a database from before this version
    const db = new DatabaseSync(dbFile);
    db.exec('ALTER TABLE sessions DROP COLUMN country; ALTER TABLE sessions DROP COLUMN end_received_at;');
    db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
    const sessionsBefore = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
    db.close();
    await startServer();
    await player({ from: '91.0.0.1' }).send([['session_start', 0, { platform: 'Windows', ...base }]]);
    await settle();
    check('a database of the version before is brought up to date with its rows, and goes on', query("SELECT value FROM meta WHERE key = 'schema_version'")[0].value === '3'
        && query('SELECT COUNT(*) AS n FROM sessions')[0].n === sessionsBefore + 1 && query("SELECT COUNT(*) AS n FROM sessions WHERE country = 'DE'")[0].n === 1);
    check('every card answers on it', (await Promise.all(['now', 'pulse', 'play', 'region', 'devices', 'health', 'community', 'feed'].map((name) => call('GET', `/api/admin/v2/q/live.${name}`, null, { admin: true })))).every((answer) => answer.status === 200));
    await stopServer();
    console.log(failed === 0 ? `RESULT: all ${n} checks passed` : `RESULT: ${failed} of ${n} check(s) FAILED`);
})().catch((error) => {
    failed++;
    console.error(error, output.slice(-1500));
}).finally(async () => {
    await stopServer();
    fs.rmSync(storage, { recursive: true, force: true });
    process.exit(failed === 0 ? 0 : 1);
});
