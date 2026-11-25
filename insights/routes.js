// The routes of the insights store.
//
//   POST /api/v2/collect          events and heartbeats from the game
//   POST /api/v2/crashes          one crash archive from the game
//   GET  /api/admin/v2/health     is the data arriving (admin key)
//
// The two game routes only append: they check the request, write one line to
// the spool (and, for a crash, the archive file) and answer. They never open
// the database and never read stored data. The network address is used by the
// rate limiters and to work out the country (geo.js); it is not stored and not
// logged, only the two letters of the country are.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const geo = require('./geo');

const MAX_COLLECT_BYTES = 64 * 1024;
const MAX_EVENTS = 100;
const MAX_PROPERTIES = 50;
const MAX_PROPERTY_KEY_LENGTH = 64;
const MAX_PROPERTY_VALUE_LENGTH = 500;
const MAX_CRASH_BYTES = 50 * 1024 * 1024;

// An install or session id: a UUID with or without dashes, or another short
// token of letters, digits, dash and underscore. Nothing that could be a path.
const ID = /^[A-Za-z0-9_-]{16,64}$/;
const EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const CRASH_GUID = /^[A-Za-z0-9._-]{8,128}$/;

const plausibleId = (value) => (typeof value === 'string' && ID.test(value) ? value.toLowerCase() : null);
const shortText = (value, max = 50) => (typeof value === 'string' && value !== '' ? value.slice(0, max) : null);
const finiteNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// Flat properties only: strings (cut to 500), finite numbers and booleans, at
// most 50 of them, keys up to 64 characters. Everything else is dropped.
function sanitizeProps(props) {
    if (!props || typeof props !== 'object' || Array.isArray(props)) return {};
    const sanitized = {};
    for (const key of Object.keys(props).slice(0, MAX_PROPERTIES)) {
        if (key.length === 0 || key.length > MAX_PROPERTY_KEY_LENGTH) continue;
        const value = props[key];
        if (typeof value === 'string') {
            sanitized[key] = value.slice(0, MAX_PROPERTY_VALUE_LENGTH);
        } else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
            sanitized[key] = value;
        }
    }
    return sanitized;
}

// Checks a collect body. Returns { error } or { record } (the spool line
// without its receive time).
function readCollectBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'A JSON object is required' };
    const installId = plausibleId(body.install_id);
    const sessionId = plausibleId(body.session_id);
    if (!installId) return { error: 'install_id is missing or not an id' };
    if (!sessionId) return { error: 'session_id is missing or not an id' };
    if (!Array.isArray(body.events)) return { error: 'events must be an array' };
    if (body.events.length > MAX_EVENTS) return { error: `Too many events (max ${MAX_EVENTS})` };

    const events = [];
    let dropped = 0;
    for (const event of body.events) {
        if (!event || typeof event !== 'object' || typeof event.name !== 'string' || !EVENT_NAME.test(event.name)) {
            dropped++;
            continue;
        }
        events.push({
            name: event.name,
            t: finiteNumber(event.t),
            seq: Number.isSafeInteger(event.seq) && event.seq >= 0 ? event.seq : null,
            props: sanitizeProps(event.props)
        });
    }

    const record = {
        type: 'collect',
        schema: finiteNumber(body.schema),
        install_id: installId,
        session_id: sessionId,
        build: shortText(body.build),
        steam_build: Number.isSafeInteger(body.steam_build) && body.steam_build >= 0 ? body.steam_build : null,
        platform: shortText(body.platform),
        sent_at: finiteNumber(body.sent_at),
        events
    };
    if (body.heartbeat === true) record.heartbeat = true;
    if (dropped > 0) record.dropped = dropped;
    return { record };
}

function register(app, options) {
    const { storageDir, requireApiKey, requireAdmin, clientIp, rateLimit, spool, ask, poke, log } = options;
    const crashesDir = path.join(storageDir, 'insights', 'crashes');
    fs.mkdirSync(crashesDir, { recursive: true });

    // ------------------------------------------------------------------
    // POST /api/v2/collect
    // ------------------------------------------------------------------
    app.post('/api/v2/collect', requireApiKey, async (req, res) => {
        try {
            // The body was parsed by the global JSON parser (50 MB limit), so the
            // size is checked from the header here.
            const declared = Number(req.headers['content-length']);
            if (Number.isFinite(declared) && declared > MAX_COLLECT_BYTES) {
                return res.status(413).json({ error: 'Batch too large (max 64 KB)' });
            }
            const { error, record } = readCollectBody(req.body);
            if (error) return res.status(400).json({ error });

            record.received_at = Date.now();
            const country = geo.countryOf(clientIp(req));
            if (country) record.country = country;
            // A body sent without a length (chunked): measure what would be stored.
            if (!Number.isFinite(declared) && Buffer.byteLength(JSON.stringify(record)) > MAX_COLLECT_BYTES) {
                return res.status(413).json({ error: 'Batch too large (max 64 KB)' });
            }
            await spool.append(record);
            poke();
            res.status(202).json({ ok: true });
        } catch (error) {
            log.error('Insights collect error:', error.message);
            res.status(503).json({ error: 'Could not store the batch, send it again later' });
        }
    });

    // ------------------------------------------------------------------
    // POST /api/v2/crashes
    // ------------------------------------------------------------------

    // Crash uploads only, per player. Not the design upload limit: a player who
    // has several reports waiting must not use up their design uploads.
    const crashLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 60,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: clientIp,
        validate: { xForwardedForHeader: false },
        message: { error: 'Too many crash uploads, please try again later' }
    });

    // The archive itself is the body. Any content type is taken as raw bytes
    // (the game sends application/zip); a JSON body was already parsed by the
    // global parser and is refused below as "not a ZIP".
    const rawBody = express.raw({ type: () => true, limit: MAX_CRASH_BYTES });
    const readArchive = (req, res, next) => {
        rawBody(req, res, (error) => {
            if (!error) return next();
            // The game went away before the archive was complete (it quit or died
            // again). Counted per day for the dashboard's pipeline page.
            if (error.type === 'request.aborted' || req.aborted) {
                count('crash_upload_abandoned');
                return;
            }
            if (error.type === 'entity.too.large' || error.status === 413) {
                return res.status(413).json({ error: 'Crash archive too large (max 50 MB)' });
            }
            res.status(400).json({ error: 'Crash archive could not be read' });
        });
    };

    const count = (key) => {
        spool.append({ type: 'count', key, received_at: Date.now() }).then(poke, () => {});
    };

    const writing = new Map(); // crash_guid -> promise of the write in progress

    async function storeArchive(file, buffer) {
        const temporary = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        try {
            await fs.promises.writeFile(temporary, buffer);
            await fs.promises.rename(temporary, file);
        } catch (error) {
            await fs.promises.unlink(temporary).catch(() => {});
            throw error;
        }
    }

    const exists = (file) => fs.promises.access(file).then(() => true, () => false);

    app.post('/api/v2/crashes', crashLimiter, requireApiKey, readArchive, async (req, res) => {
        try {
            const guid = typeof req.query.crash_guid === 'string' ? req.query.crash_guid : '';
            if (!CRASH_GUID.test(guid)) {
                return res.status(400).json({ error: 'crash_guid is missing or not valid' });
            }
            const buffer = req.body;
            if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
                return res.status(400).json({ error: 'The body must be the crash archive (application/zip)' });
            }
            if (buffer.length > MAX_CRASH_BYTES) {
                return res.status(413).json({ error: 'Crash archive too large (max 50 MB)' });
            }
            if (buffer[0] !== 0x50 || buffer[1] !== 0x4B) { // "PK"
                return res.status(400).json({ error: 'The body is not a ZIP archive' });
            }

            const name = `${guid}.zip`;
            const file = path.join(crashesDir, name);
            const steamBuild = typeof req.query.steam_build === 'string' && /^\d{1,15}$/.test(req.query.steam_build)
                ? Number(req.query.steam_build) : null;
            const record = {
                type: 'crash',
                received_at: Date.now(),
                crash_guid: guid,
                install_id: plausibleId(req.query.install_id),
                session_id: plausibleId(req.query.session_id),
                build: shortText(req.query.build),
                steam_build: steamBuild,
                platform: shortText(req.query.platform),
                file: path.posix.join('insights', 'crashes', name),
                size: buffer.length
            };

            // The same report arriving twice at once: the second waits for the first.
            if (writing.has(guid)) await writing.get(guid).catch(() => {});
            const duplicate = await exists(file);
            if (duplicate) {
                // The archive is kept as it is. The line is still written: if an
                // earlier process stopped between storing the file and its line,
                // this is what gives the report its row. An existing row ignores it.
                record.duplicate = true;
                count('crash_upload_duplicate');
                await spool.append(record);
                poke();
                return res.json({ ok: true, duplicate: true });
            }

            const write = storeArchive(file, buffer);
            writing.set(guid, write);
            try {
                await write;
            } finally {
                writing.delete(guid);
            }
            try {
                await spool.append(record);
            } catch (error) {
                // Without its line the report would never be seen: take the file
                // back, so the game's next attempt is not answered "duplicate".
                await fs.promises.unlink(file).catch(() => {});
                throw error;
            }
            count('crash_upload_stored');
            poke();
            log.log(`Insights crash stored: ${guid} (${(buffer.length / 1024).toFixed(1)} KB, ${record.platform || 'no platform'}, build ${record.build || 'unknown'})`);
            res.json({ ok: true, duplicate: false });
        } catch (error) {
            log.error('Insights crash upload error:', error.message);
            res.status(503).json({ error: 'Could not store the crash report, send it again later' });
        }
    });

    // ------------------------------------------------------------------
    // GET /api/admin/v2/health
    // ------------------------------------------------------------------
    app.get('/api/admin/v2/health', requireAdmin, async (req, res) => {
        try {
            res.json(await ask('health', {}, 2000));
        } catch (error) {
            res.status(503).json({ error: 'Insights worker did not answer', detail: String(error.message || error).slice(0, 200) });
        }
    });
}

module.exports = { register, readCollectBody, sanitizeProps, MAX_COLLECT_BYTES, MAX_EVENTS };
