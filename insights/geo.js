// The country of a network address: two letters, or null.
//
// The address is looked up in memory while the request is handled and is then
// forgotten: only the two letters are stored. The table is DB-IP's free country
// list (CC BY 4.0), made into insights/geo/countries.bin.gz by
// scripts/build-geo.js. Without the file every lookup answers null.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FILE = path.join(__dirname, 'geo', 'countries.bin.gz');

// '1.2.3.4' -> { version: 4, value: number }; an IPv6 address -> { version: 6,
// value: its first 64 bits }. Anything else -> null.
function parse(text) {
    if (typeof text !== 'string') return null;
    let address = text.trim().toLowerCase();
    const zone = address.indexOf('%');
    if (zone >= 0) address = address.slice(0, zone);
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
    if (mapped) address = mapped[1];
    if (address.includes('.') && !address.includes(':')) {
        const parts = address.split('.');
        if (parts.length !== 4) return null;
        let value = 0;
        for (const part of parts) {
            if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
            value = value * 256 + Number(part);
        }
        return { version: 4, value };
    }
    if (!address.includes(':') || address.includes('.')) return null;
    const halves = address.split('::');
    if (halves.length > 2) return null;
    const groups = (half) => (half === '' ? [] : half.split(':'));
    const head = groups(halves[0]);
    const tail = halves.length === 2 ? groups(halves[1]) : [];
    const missing = 8 - head.length - tail.length;
    if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
    const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
    if (!all.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
    let value = 0n;
    for (const group of all.slice(0, 4)) value = (value << 16n) | BigInt(parseInt(group, 16));
    return { version: 6, value };
}

let table; // undefined: not read yet; null: not there
function load() {
    if (table !== undefined) return table;
    table = null;
    try {
        const raw = zlib.gunzipSync(fs.readFileSync(FILE));
        const end = raw.indexOf(0x0A);
        const header = JSON.parse(raw.toString('utf8', 0, end));
        if (header.format !== 1) throw new Error(`unknown format ${header.format}`);
        let at = end + 1;
        const take = (length) => raw.subarray(at, (at += length));
        table = { header, v4: take(header.v4 * 4), v6: take(header.v6 * 8), c4: take(header.v4), c6: take(header.v6) };
    } catch (error) {
        console.error('Insights: the country table cannot be read, countries stay empty:', error.message);
    }
    return table;
}

// The last entry that is not above `value`, or -1.
function position(count, valueAt, value) {
    let low = 0;
    let high = count - 1;
    let found = -1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        if (valueAt(middle) <= value) {
            found = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return found;
}

function countryOf(text) {
    const address = parse(text);
    const data = address ? load() : null;
    if (!data) return null;
    const index = address.version === 4
        ? position(data.header.v4, (i) => data.v4.readUInt32BE(i * 4), address.value)
        : position(data.header.v6, (i) => data.v6.readBigUInt64BE(i * 8), address.value);
    if (index < 0) return null;
    return data.header.codes[(address.version === 4 ? data.c4 : data.c6)[index]] || null;
}

const info = () => { const data = load(); return data ? { source: data.header.source, month: data.header.month } : null; };

module.exports = { FILE, parse, countryOf, info, load };
