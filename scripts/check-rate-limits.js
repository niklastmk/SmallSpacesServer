// Local check of the design server's per-player rate limits (TD-SERVER-241, TD-SERVER-472).
// Usage: node scripts/check-rate-limits.js [server file] [port]   (defaults: ../server.js, 3917)
// Starts that server file on 127.0.0.1 with a throwaway storage folder in the system
// temp directory, sends about 9,000 requests as several players (X-Forwarded-For) and
// prints PASS or FAIL per check. It never contacts production. The server file needs
// its dependencies next to it (npm ci).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const serverFile = path.resolve(process.argv[2] || path.join(__dirname, '..', 'server.js'));
const port = Number(process.argv[3] || 3917);
const base = `http://127.0.0.1:${port}`;
const storage = path.join(os.tmpdir(), `smallspaces-limit-check-${port}`);
const ID = 'ABCDEF0123456789ABCDEF0123456789';

fs.rmSync(storage, { recursive: true, force: true });
fs.mkdirSync(path.join(storage, 'designs'), { recursive: true });
fs.mkdirSync(path.join(storage, 'thumbnails'), { recursive: true });
fs.writeFileSync(path.join(storage, 'designs', `${ID}.sav`), Buffer.from('GVAS-test'));
// 1x1 PNG
fs.writeFileSync(path.join(storage, 'thumbnails', `${ID}.png`), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
fs.writeFileSync(path.join(storage, 'metadata.json'), JSON.stringify([{
    id: ID, title: 'Test design', description: '', author_name: 'Tester', level: '/Game/Levels/Test.Test',
    download_count: 5, upload_date: new Date().toISOString(), thumbnail_url: `/api/thumbnails/${ID}.png`
}]));
fs.writeFileSync(path.join(storage, 'featured.json'), JSON.stringify([ID]));

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  [${detail}]` : ''}`);
}

async function call(player, method, url, body) {
    const headers = {};
    if (player) headers['X-Forwarded-For'] = player;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, limit: res.headers.get('ratelimit-limit'), remaining: res.headers.get('ratelimit-remaining'), text };
}
const thumb = (p) => call(p, 'GET', `/api/thumbnails/${ID}.png`);
const like = (p) => call(p, 'POST', `/api/designs/${ID}/like`, { increment: 1 });
const browse = (p) => call(p, 'GET', '/api/designs?offset=0&limit=21&sort=downloads');
const search = (p) => call(p, 'GET', '/api/designs?offset=0&limit=21&sort=date&search=test');
const featured = (p) => call(p, 'GET', '/api/featured');
const metadata = (p) => call(p, 'POST', '/api/designs/metadata', { ids: [ID] });
const download = (p) => call(p, 'POST', `/api/designs/${ID}/download/binary`);
const health = (p) => call(p, 'GET', '/api/health');

// n calls, 25 at a time; returns the count per status
async function many(n, fn) {
    const counts = {};
    let sent = 0;
    async function worker() {
        while (sent < n) { sent++; const r = await fn(); counts[r.status] = (counts[r.status] || 0) + 1; }
    }
    await Promise.all(Array.from({ length: 25 }, worker));
    return counts;
}
const only = (counts, status, n) => Object.keys(counts).length === 1 && counts[status] === n;

async function main() {
    const child = spawn(process.execPath, [serverFile], {
        env: { ...process.env, PORT: String(port), RAILWAY_VOLUME_MOUNT_PATH: storage, NODE_ENV: 'production',
               GAME_API_KEY: '', ADMIN_RESET_KEY: '', AZURE_CONTENT_SAFETY_ENDPOINT: '', AZURE_CONTENT_SAFETY_KEY: '' },
        stdio: ['ignore', 'ignore', 'inherit']
    });
    try {
        for (let i = 0; i < 100; i++) {
            try { if ((await fetch(base + '/api/health')).status === 200) break; } catch (e) { /* not up yet */ }
            await new Promise(r => setTimeout(r, 100));
        }
        console.log(`server: ${path.basename(serverFile)} on port ${port}`);

        // Player A: the reporter's pattern, five Showcase visits of 176 thumbnails, then more up to 1000.
        const A = '203.0.113.10';
        let c = await many(5 * 176, () => thumb(A));
        check('A: 880 thumbnails (five visits of 176) all answered 200', only(c, 200, 880), JSON.stringify(c));
        c = await many(120, () => thumb(A));
        check('A: 120 more thumbnails (1000 in total) all answered 200', only(c, 200, 120), JSON.stringify(c));
        let r = await thumb(A);
        check('A: thumbnail 1001 answered 200', r.status === 200, r.status);
        check('A: thumbnail answers report limit 6000', r.limit === '6000', r.limit);
        r = await like(A);
        check('A: like after 1001 thumbnails answered 200', r.status === 200, `${r.status} ${r.text.slice(0, 60)}`);
        check('A: like reports limit 1000 with 999 left', r.limit === '1000' && r.remaining === '999', `${r.limit}/${r.remaining}`);
        r = await browse(A); check('A: level list answered 200', r.status === 200, r.status);
        r = await search(A); check('A: search answered 200', r.status === 200, r.status);
        r = await featured(A); check('A: featured list answered 200', r.status === 200, r.status);
        r = await metadata(A); check('A: metadata lookup answered 200', r.status === 200, r.status);
        r = await download(A); check('A: design download answered 200', r.status === 200, r.status);

        // Player A uses up the general limit: 6 used above, 994 more are accepted, the next is refused.
        c = await many(994, () => health(A));
        check('A: general requests 7 to 1000 all answered 200', only(c, 200, 994), JSON.stringify(c));
        r = await like(A);
        check('A: general request 1001 answered 429 with the old message', r.status === 429 && r.text.includes('Too many requests, please try again later'), `${r.status} ${r.text.slice(0, 60)}`);
        r = await thumb(A);
        check('A: thumbnails still answered 200 while the general limit is used up', r.status === 200, r.status);

        // Player B is unaffected by A.
        const B = '203.0.113.20';
        r = await like(B); check('B: like answered 200 with 999 left', r.status === 200 && r.remaining === '999', `${r.status} ${r.remaining}`);
        r = await thumb(B); check('B: thumbnail answered 200', r.status === 200, r.status);

        // Player C reaches the thumbnail limit; only thumbnails are refused.
        const C = '203.0.113.30';
        c = await many(6000, () => thumb(C));
        check('C: 6000 thumbnails all answered 200', only(c, 200, 6000), JSON.stringify(c));
        r = await thumb(C);
        check('C: thumbnail 6001 answered 429', r.status === 429, r.status);
        r = await like(C); check('C: like still answered 200 with 999 left', r.status === 200 && r.remaining === '999', `${r.status} ${r.remaining}`);
        r = await browse(C); check('C: level list still answered 200', r.status === 200, r.status);
        r = await thumb(B); check('B: thumbnail still answered 200 after C was refused', r.status === 200, r.status);

        // Upload limit unchanged: an empty upload is refused with 400 under limit 30.
        r = await call(B, 'POST', '/api/designs', {});
        check('B: empty upload answered 400 under limit 30', r.status === 400 && r.limit === '30', `${r.status} limit ${r.limit}`);

        // No forwarded header: the socket address is used and requests work.
        r = await like(null); check('no forwarded header: like answered 200', r.status === 200, r.status);
        r = await thumb(null); check('no forwarded header: thumbnail answered 200', r.status === 200, r.status);

        // The catalogue survived: one design, count 5 + four accepted likes (A, B, C, no header) + A's download.
        const list = JSON.parse((await browse('203.0.113.99')).text);
        check('catalogue holds the one design with count 10', list.total === 1 && list.designs[0].download_count === 10, `${list.total} design(s), count ${list.designs[0] && list.designs[0].download_count}`);
    } finally {
        child.kill();
        fs.rmSync(storage, { recursive: true, force: true });
    }
    const failed = results.filter(ok => !ok).length;
    console.log(`${results.length - failed} of ${results.length} checks passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
