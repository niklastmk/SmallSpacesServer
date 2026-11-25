// Plays made-up players against a LOCAL server, so the Live page has something
// to show: a crowd that is already playing, then launches and quits as they come.
//
//   node scripts/simulate-live.js [port] [--playing 70] [--per-minute 14] [--minutes 30]
//
// It behaves like the released game of November 2026: a launch and the menu are
// sent at once, everything about rooms when the player quits. It takes no
// address: only 127.0.0.1 is ever contacted. Start the server on throwaway
// storage first (scripts/seed-insights.js).
const http = require('http');
const crypto = require('crypto');

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : fallback; };
const PORT = Number(args.find((arg) => /^\d+$/.test(arg) && !args[args.indexOf(arg) - 1]?.startsWith('--'))) || 3878;
const PLAYING = option('playing', 70);
const PER_MINUTE = option('per-minute', 14);
const MINUTES = option('minutes', 30);

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const between = (a, b) => a + Math.random() * (b - a);
const whole = (a, b) => Math.floor(between(a, b + 1));
const weighted = (table) => { let roll = Math.random() * table.reduce((t, e) => t + e[1], 0); for (const [v, w] of table) { roll -= w; if (roll <= 0) return v; } return table[0][0]; };

// Public addresses of networks in these countries; only the country is worked out from them.
const ADDRESSES = [['8.8.8.8', 30], ['91.0.0.1', 14], ['81.2.69.142', 8], ['114.114.114.114', 8], ['90.0.0.1', 6], ['99.224.0.1', 5], ['126.0.0.1', 5], ['177.0.0.1', 4], ['1.128.0.1', 4],
    ['1.208.0.1', 3], ['77.160.0.1', 3], ['83.0.0.1', 3], ['80.24.0.1', 2], ['78.64.0.1', 2], ['79.0.0.1', 2], ['187.128.0.1', 2], ['46.0.0.1', 2], ['41.0.0.1', 1], ['181.0.0.1', 1], ['203.97.0.1', 1]];
const LEVELS = ['berlin_new_41', 'berlin_new_12', 'berlin_new_80', 'newyork_new_19', 'newyork_new_83', 'tokyo_new_05', 'offgrid_new_22', 'sanfrancisco_new_07', 'berlin_new_33', 'tokyo_new_14'];
const ITEMS = ['BP_Sofa_Loop', 'BP_Chair_Bistro', 'BP_Table_Oak', 'BP_Lamp_Arc', 'BP_Plant_Monstera', 'BP_Rug_Wool', 'BP_Shelf_Wall', 'BP_Bed_Low', 'BP_Desk_Studio', 'BP_Mirror_Round', 'BP_Books_Stack', 'BP_Vase_Clay'];
const PCS = [['NVIDIA GeForce RTX 3060', 'D3D12', 62], ['NVIDIA GeForce RTX 4070', 'D3D12', 95], ['NVIDIA GeForce GTX 1650', 'D3D12', 34], ['AMD Radeon RX 6600', 'D3D12', 70], ['Intel(R) Iris(R) Xe Graphics', 'D3D12', 24], ['NVIDIA GeForce RTX 5080', 'D3D12', 120]];
const MACS = [['Apple M1', 44], ['Apple M2', 52], ['Apple M3 Pro', 78], ['Apple M4', 70]];

function post(body, address) {
    return new Promise((resolve) => {
        const text = JSON.stringify(body);
        const request = http.request({ host: '127.0.0.1', port: PORT, path: '/api/v2/collect', method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'x-forwarded-for': address } }, (response) => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
        });
        request.on('error', () => resolve(0));
        request.end(text);
    });
}

function player() {
    const mac = Math.random() < 0.1;
    const deck = !mac && Math.random() < 0.05;
    const [gpu, rhi, fps] = mac ? (([g, f]) => [g, 'Metal', f])(pick(MACS)) : deck ? ['AMD Custom GPU 0932', 'D3D12', 38] : pick(PCS);
    const [screen_w, screen_h] = deck ? [1280, 800] : mac ? [1728, 1117] : pick([[1920, 1080], [1920, 1080], [2560, 1440], [3840, 2160]]);
    return { install: crypto.randomUUID(), address: weighted(ADDRESSES), platform: mac ? 'Mac' : 'Windows', fps,
        fields: { device: mac ? 'apple_silicon' : deck ? 'steam_deck' : 'pc', os_version: mac ? '26.1' : pick(['10.0.26100.1.256.64bit', '10.0.19045.1.256.64bit', '10.0.26200.1.256.64bit']),
            cpu_cores: pick([6, 8, 8, 12]), ram_gb: pick([8, 16, 16, 32]), gpu, rhi, screen_w, screen_h, res_scale: 100, language: weighted([['en', 40], ['de', 16], ['zh-Hans', 10], ['fr', 8], ['ja', 6], ['pt-BR', 5], ['ko', 4]]),
            quality_preset: fps < 40 ? pick(['0', '1']) : pick(['2', '3', '3', '4']), upscaler: mac ? 'tsr' : pick(['dlss', 'fsr', 'tsr']), window_mode: pick(['borderless', 'fullscreen', 'windowed']),
            launch_count: weighted([[1, 25], [4, 40], [20, 35]]), existing_player: Math.random() < 0.7 } };
}
const send = (session, events) => post({ schema: 2, install_id: session.who.install, session_id: session.id, build: '1.4.1', steam_build: 20144210, platform: session.who.platform, sent_at: Date.now(), events }, session.who.address);

async function launch(age, length) {
    const who = player();
    const session = { id: crypto.randomUUID(), who, started: Date.now() - age, ends: Date.now() - age + length, seq: 0 };
    const at = (seconds) => session.started + seconds * 1000;
    const events = [{ name: 'session_start', t: at(0), seq: session.seq++, props: { build: '1.4.1', platform: who.platform, ...who.fields } }];
    events.push({ name: 'menu_shown', t: at(9), seq: session.seq++, props: { startup_s: Math.round(between(5, 22) * 10) / 10 } });
    await send(session, events);
    // A third of the long sessions have had their first half hour delivered.
    if (age > 30 * 60000 && Math.random() < 0.5) await rooms(session, 1, false);
    return session;
}
async function rooms(session, count, close) {
    const events = [];
    const add = (name, t, props) => events.push({ name, t: Math.round(Math.min(t, Date.now())), seq: session.seq++, props });
    let t = Math.max(session.started + 40000, session.clock || 0);
    const until = Math.min(session.ends, Date.now());
    for (let i = 0; i < count; i++) {
        const mode = weighted([['unpack', 22], ['design', 58], ['community', 20]]);
        const level_id = weighted(LEVELS.map((level, n) => [level, 10 - n]));
        add('room_enter', t, { mode, level_id });
        add('room_ready', t + 9000, { mode, level_id, load_s: Math.round(between(4, 22) * 10) / 10 });
        session.clock = t + 9000;
        if (!close) break;
        const length = Math.max(60, (until - t) / 1000 / (count - i) - 20);
        const placed = mode === 'community' ? 0 : whole(3, 80);
        const end = t + length * 1000;
        if (mode === 'unpack' && Math.random() < 0.5) add('star_earned', end - 5000, { level_id, stars_total: whole(1, 9) });
        if (Math.random() < 0.06) add('save_failed', end - 8000, { outcome: pick(['WriteFailed', 'Conflict']), mode, level_id });
        add('room_exit', end, { mode, level_id, duration_s: Math.round(length), active_s: Math.round(length * 0.85), items_placed: placed, items_removed: whole(0, 9), items_moved: whole(0, 60),
            materials_applied: whole(0, 10), build_steps: 0, undo_count: whole(0, 15), redo_count: whole(0, 3), saves: whole(0, 3), ready: true, exit_to: 'menu' });
        add('room_perf', end, { mode, level_id, fps_avg: Math.round(session.who.fps * between(0.8, 1.15) * 10) / 10, fps_p1: 30, hitches: whole(0, 9), mem_mb: 4200 });
        if (placed > 0) add('catalog_usage', end, { mode, level_id, items: Array.from({ length: 6 }, (_, n) => `${ITEMS[(n * 5 + whole(0, 5)) % ITEMS.length]}:${whole(1, 9)}`).join(',') });
        t = end + 8000;
        session.clock = t;
    }
    if (events.length > 0) await send(session, events);
}
async function quit(session) {
    await rooms(session, whole(1, 2), true);
    const events = [];
    if (Math.random() < 0.3) events.push({ name: 'gallery_open', t: Date.now() - 4000, seq: session.seq++, props: { ok: true, count: 40 } });
    if (Math.random() < 0.15) events.push({ name: 'design_like', t: Date.now() - 3000, seq: session.seq++, props: { design_id: crypto.randomUUID(), like: true } });
    if (Math.random() < 0.04) events.push({ name: 'design_upload', t: Date.now() - 2000, seq: session.seq++, props: { ok: true } });
    if (Math.random() < 0.85) events.push({ name: 'session_end', t: Date.now(), seq: session.seq++, props: { duration_s: Math.round((Date.now() - session.started) / 1000), active_s: Math.round((Date.now() - session.started) / 1200), reason: 'quit' } });
    if (events.length > 0) await send(session, events);
}

(async () => {
    const length = () => -Math.log(1 - Math.random()) * 34 * 60000 + 3 * 60000;
    const running = [];
    for (let i = 0; i < PLAYING; i++) {
        const whole = length();
        running.push(await launch(between(0, whole), whole));
    }
    console.log(`${running.length} people are playing on 127.0.0.1:${PORT}`);
    const stopAt = Date.now() + MINUTES * 60000;
    while (Date.now() < stopAt) {
        await new Promise((resolve) => setTimeout(resolve, 60000 / PER_MINUTE * between(0.3, 1.7)));
        if (Math.random() < 0.5) running.push(await launch(0, length()));
        else {
            const over = running.findIndex((session) => session.ends < Date.now());
            const index = over >= 0 ? over : whole(0, running.length - 1);
            await quit(running.splice(index, 1)[0]);
        }
    }
})();
