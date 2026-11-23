// Community actions that need the network. Main thread.
//
//   artists.check_destination   { url } -> does the artist's destination answer?
//
// The check must not become a way to look around the server's own network:
// it only ever talks to a public website over https on port 443, to an
// address it resolved and vetted itself, and it tells the caller nothing but
// "answered" or "did not answer" and the status number.
const dns = require('dns');
const https = require('https');
const net = require('net');

const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const URL_MAX = 2000;

const refuse = (message) => Object.assign(new Error(message), { code: 'invalid' });

// Everything that is not the public internet. Two lists: a single BlockList
// also matches an IPv4 address against the IPv6 rules, as ::ffff:a.b.c.d.
const blocked4 = new net.BlockList();
const blocked6 = new net.BlockList();
for (const [address, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
    ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) blocked4.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
    ['::', 3],            // unspecified, loopback, IPv4-mapped and IPv4-compatible
    ['64:ff9b::', 96], ['64:ff9b:1::', 48], // translated IPv4
    ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], // discard, protocol assignments (Teredo), documentation, 6to4
    ['4000::', 2], ['8000::', 1] // everything outside 2000::/3: unique local, link local, multicast, reserved
]) blocked6.addSubnet(address, prefix, 'ipv6');

function isPublicAddress(address, family) {
    const kind = family === 6 || family === 'IPv6' ? 'ipv6' : 'ipv4';
    if (net.isIP(address) !== (kind === 'ipv6' ? 6 : 4)) return false;
    return !(kind === 'ipv6' ? blocked6 : blocked4).check(address, kind);
}

// Names that never belong to a public website.
const PRIVATE_SUFFIXES = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp', 'private', 'arpa', 'test', 'invalid', 'onion'];

// A public https address, or an error that says what is wrong with it.
function vetUrl(text) {
    if (typeof text !== 'string' || text.trim() === '') throw refuse('Enter the destination address.');
    const trimmed = text.trim();
    if (trimmed.length > URL_MAX) throw refuse('The address is too long.');
    if (!/^https:\/\//i.test(trimmed)) throw refuse('Start the address with https://');
    let url;
    try { url = new URL(trimmed); } catch (error) { throw refuse('This is not a complete web address.'); }
    if (url.protocol !== 'https:') throw refuse('Start the address with https://');
    if (url.username !== '' || url.password !== '') throw refuse('The address must not contain a user name or password.');
    if (url.port !== '' && url.port !== '443') throw refuse('The address must not name a port.');
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    // The parser turns every spelling of an IPv4 address (decimal, hex, short) into dotted form.
    if (host.startsWith('[') || net.isIP(host) !== 0) throw refuse('Use the name of the website, not a network address.');
    const labels = host.split('.');
    if (labels.length < 2 || labels.some((label) => !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || /^\d+$/.test(labels[labels.length - 1])) {
        throw refuse('This is not the name of a public website.');
    }
    if (PRIVATE_SUFFIXES.includes(labels[labels.length - 1]) || host.endsWith('.home.arpa')) throw refuse('This is not the name of a public website.');
    return { url, host };
}

// The addresses of a host, only if every one of them is public.
async function publicAddresses(host, deadline) {
    let found;
    try {
        found = await Promise.race([
            dns.promises.lookup(host, { all: true, verbatim: true }),
            new Promise((resolve, reject) => setTimeout(() => reject(new Error('timeout')), Math.max(1, deadline - Date.now())).unref())
        ]);
    } catch (error) {
        return [];
    }
    if (!Array.isArray(found) || found.length === 0) return [];
    return found.every((entry) => isPublicAddress(entry.address, entry.family)) ? found : [];
}

// One request to a vetted address; resolves with the status and the Location header.
function ask(method, url, host, address, deadline) {
    return new Promise((resolve, reject) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(value);
        };
        const request = https.request({
            method,
            host,
            servername: host,
            port: 443,
            path: `${url.pathname}${url.search}`,
            agent: false,
            headers: { 'user-agent': 'Mozilla/5.0 (compatible; link-check)', accept: '*/*' },
            // Connect to the address that was vetted, whatever the name resolves to a moment later.
            lookup: (name, options, callback) => {
                const done = typeof options === 'function' ? options : callback;
                if (options && typeof options === 'object' && options.all) done(null, [{ address: address.address, family: address.family }]);
                else done(null, address.address, address.family);
            }
        });
        const timer = setTimeout(() => {
            request.destroy();
            finish(reject, Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
        }, remaining);
        request.on('response', (response) => {
            const answer = { status: response.statusCode || 0, location: typeof response.headers.location === 'string' ? response.headers.location : null };
            response.destroy(); // the body is never read
            finish(resolve, answer);
        });
        request.on('error', (error) => finish(reject, error));
        request.end();
    });
}

function failureOf(error) {
    const code = String((error && error.code) || '');
    if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout';
    if (/CERT|TLS|SSL|SELF_SIGNED|ALTNAME|UNABLE_TO_VERIFY|EPROTO/.test(code)) return 'certificate';
    return 'connection';
}

// Body: { url }. Answers { url, reachable, status, reason, redirected_to, checked_at, took_ms }.
//   reachable   the website answered and did not say the page is gone or broken
//               (any status below 500 except 404 and 410; a 401, 403 or 429
//               means it answers but turns automated visits away)
//   reason      null, or why not: 'no_public_address' (the name does not
//               resolve, or not to a public address), 'timeout', 'connection',
//               'certificate', 'not_found', 'server_error', 'redirect_refused'
//               (it forwards to something that is not a public https website),
//               'too_many_redirects'
// A destination that is not a public https address is refused (400).
async function checkDestination(body) {
    const started = Date.now();
    const deadline = started + TIMEOUT_MS;
    let { url, host } = vetUrl(body && body.url);
    const first = url.toString();
    const result = (fields) => ({
        url: first, reachable: false, status: null, reason: null, redirected_to: null, ...fields,
        checked_at: started, took_ms: Date.now() - started
    });

    for (let hop = 0; ; hop++) {
        const addresses = await publicAddresses(host, deadline);
        if (addresses.length === 0) {
            return result(hop === 0 ? { reason: Date.now() >= deadline ? 'timeout' : 'no_public_address' } : { reason: 'redirect_refused' });
        }
        let answer;
        try {
            answer = await ask('HEAD', url, host, addresses[0], deadline);
            // Some websites answer HEAD with an error and GET normally.
            if (answer.status >= 400) answer = await ask('GET', url, host, addresses[0], deadline);
        } catch (error) {
            if (failureOf(error) !== 'connection') return result({ reason: failureOf(error) });
            // And some drop a HEAD request without answering.
            try { answer = await ask('GET', url, host, addresses[0], deadline); } catch (again) { return result({ reason: failureOf(again) }); }
        }
        const redirected = hop > 0 ? `${url.origin}${url.pathname}` : null;
        if (answer.status >= 300 && answer.status < 400 && answer.location) {
            if (hop >= MAX_REDIRECTS) return result({ status: answer.status, reason: 'too_many_redirects', redirected_to: redirected });
            try {
                const next = vetUrl(new URL(answer.location, url).toString());
                url = next.url;
                host = next.host;
            } catch (error) {
                return result({ status: answer.status, reason: 'redirect_refused', redirected_to: redirected });
            }
            continue;
        }
        if (answer.status === 404 || answer.status === 410) return result({ status: answer.status, reason: 'not_found', redirected_to: redirected });
        if (answer.status >= 500 || answer.status < 200) return result({ status: answer.status, reason: 'server_error', redirected_to: redirected });
        return result({ reachable: true, status: answer.status, redirected_to: redirected });
    }
}

module.exports = {
    actions: {
        'artists.check_destination': checkDestination
    },
    // For tests.
    vetUrl, isPublicAddress
};
