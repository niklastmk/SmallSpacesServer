// Turns DB-IP's free country table into the small file the server looks
// countries up in (insights/geo/countries.bin.gz, read by insights/geo.js).
//
//   node scripts/build-geo.js <dbip-country-lite-YYYY-MM.csv.gz>
//
// The table: https://db-ip.com/db/download/ip-to-country-lite, a new one every
// month, licence CC BY 4.0 (the credit stands in insights/README.md and on the
// Live page). A range of IPv6 is kept by the first 64 bits of its addresses.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const geo = require('../insights/geo');

const input = process.argv[2];
if (!input) {
    console.error('usage: node scripts/build-geo.js <dbip-country-lite-YYYY-MM.csv.gz>');
    process.exit(2);
}
const month = (/(\d{4}-\d{2})/.exec(path.basename(input)) || [])[1] || '';
const text = zlib.gunzipSync(fs.readFileSync(input)).toString('utf8');

const codes = ['']; // index 0: no country
const codeIndex = new Map([['', 0], ['ZZ', 0]]);
const four = [];
const six = [];
for (const line of text.split('\n')) {
    const [first, last, code] = line.trim().split(',');
    if (!first || !last || !/^[A-Z]{2}$/.test(code || '')) continue;
    if (!codeIndex.has(code)) {
        codeIndex.set(code, codes.length);
        codes.push(code);
    }
    const from = geo.parse(first);
    const to = geo.parse(last);
    if (!from || !to || from.version !== to.version) continue;
    (from.version === 4 ? four : six).push([from.value, to.value, codeIndex.get(code)]);
}

// Sorted starts with the country each runs to the next start; gaps have none.
function starts(ranges, zero, one) {
    ranges.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const out = [];
    const add = (at, index) => {
        const last = out[out.length - 1];
        if (last && last[0] === at) last[1] = index;
        else out.push([at, index]);
    };
    let expected = zero;
    for (const [from, to, index] of ranges) {
        if (from > expected) add(expected, 0);
        if (from >= expected || out.length === 0) add(from, index);
        else if (to >= expected) add(expected, index); // begins inside a /64 the one before took
        if (to + one > expected) expected = to + one;
    }
    add(expected, 0);
    // Neighbours with the same country become one.
    return out.filter((entry, i) => i === 0 || out[i - 1][1] !== entry[1] || entry[0] === zero).filter((entry, i, list) => i === 0 || list[i - 1][1] !== entry[1]);
}
const v4 = starts(four, 0, 1).filter((entry) => entry[0] <= 0xFFFFFFFF);
const v6 = starts(six, 0n, 1n).filter((entry) => entry[0] <= 0xFFFFFFFFFFFFFFFFn);

const header = Buffer.from(JSON.stringify({ format: 1, source: 'DB-IP IP to Country Lite', month, codes, v4: v4.length, v6: v6.length }) + '\n');
const body = Buffer.alloc(v4.length * 5 + v6.length * 9);
let at = 0;
for (const [start] of v4) at = body.writeUInt32BE(start, at);
for (const [start] of v6) at = body.writeBigUInt64BE(start, at);
for (const [, index] of v4) at = body.writeUInt8(index, at);
for (const [, index] of v6) at = body.writeUInt8(index, at);
fs.mkdirSync(path.dirname(geo.FILE), { recursive: true });
fs.writeFileSync(geo.FILE, zlib.gzipSync(Buffer.concat([header, body]), { level: 9 }));
console.log(`${codes.length - 1} countries, ${v4.length} IPv4 and ${v6.length} IPv6 ranges, ${(fs.statSync(geo.FILE).size / 1e6).toFixed(2)} MB -> ${geo.FILE}`);
