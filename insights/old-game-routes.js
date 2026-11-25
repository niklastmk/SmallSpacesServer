// The routes that game versions from before the telemetry update (November
// 2026) still call. They keep the paths and the answers those versions know,
// and store only in the insights store:
//
//   POST /api/analytics/event
//   POST /api/analytics/batch
//   POST /api/analytics/session/start
//   POST /api/analytics/session/end
//   POST /api/crashes
//
// Each appends to the spool and answers; nothing stored is read. Rows from here
// have legacy = 1. The files the routes wrote before (analytics/*.json,
// analytics/*.ndjson, crashes_metadata.json, crash_groups.json) are neither
// written nor read any more; import.js took their content over once. An event
// record is called `old_game_events` so that the import, which looks for where
// the copies of events.ndjson lines (`legacy_events`) begin, passes over it.
//
// When no old version is left in use, this file and its check can be removed.
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const EVENTS_PER_LINE = 100;
const MAX_EVENTS = 500;
const MAX_PROPERTIES = 50;
const MAX_PROPERTY_VALUE_LENGTH = 500;
const MAX_CRASH_BYTES = 50 * 1024 * 1024;

const cut = (value, max) => (typeof value === 'string' ? value.slice(0, max) : undefined);
const version = (value) => (typeof value === 'string' ? value.slice(0, 50) : 'unknown');
const plainObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

// Strings (cut to 500), numbers and booleans; everything else is dropped.
function sanitizeProperties(props) {
    const sanitized = {};
    for (const key of Object.keys(plainObject(props)).slice(0, MAX_PROPERTIES)) {
        if (key.length > 100) continue;
        const value = props[key];
        if (typeof value === 'string') sanitized[key] = value.slice(0, MAX_PROPERTY_VALUE_LENGTH);
        else if (typeof value === 'number' || typeof value === 'boolean') sanitized[key] = value;
    }
    return sanitized;
}

function register(app, options) {
    const { storageDir, requireApiKey, uploadLimiter, spool, poke, log } = options;
    const crashesDir = path.join(storageDir, 'crashes');
    fs.mkdirSync(crashesDir, { recursive: true });

    async function storeEvents(events) {
        const receivedAt = Date.now();
        for (let i = 0; i < events.length; i += EVENTS_PER_LINE) {
            await spool.append({ type: 'old_game_events', legacy: true, received_at: receivedAt, events: events.slice(i, i + EVENTS_PER_LINE) });
        }
        if (events.length > 0) poke();
    }

    app.post('/api/analytics/event', requireApiKey, async (req, res) => {
        try {
            const { session_id, event_name, properties, client_version, platform } = plainObject(req.body);
            if (!event_name || typeof event_name !== 'string') return res.status(400).json({ error: 'event_name is required' });
            if (event_name.length > 200) return res.status(400).json({ error: 'event_name too long' });
            const event = {
                id: uuidv4(),
                session_id: cut(session_id, 100) || 'anonymous',
                event_name,
                properties: sanitizeProperties(properties),
                timestamp: new Date().toISOString(),
                client_version: version(client_version),
                platform: version(platform)
            };
            await storeEvents([event]);
            res.json({ success: true, event_id: event.id });
        } catch (error) {
            log.error('Analytics event error:', error.message);
            res.status(500).json({ error: 'Failed to track event' });
        }
    });

    app.post('/api/analytics/batch', requireApiKey, async (req, res) => {
        try {
            const { events: sent, session_id, client_version, platform } = plainObject(req.body);
            if (!Array.isArray(sent)) return res.status(400).json({ error: 'events array is required' });
            if (sent.length > MAX_EVENTS) return res.status(400).json({ error: `Batch too large (max ${MAX_EVENTS} events)` });
            const events = sent.map(plainObject)
                .filter((event) => typeof event.event_name === 'string' && event.event_name !== '' && event.event_name.length <= 200)
                .map((event) => ({
                    id: uuidv4(),
                    session_id: cut(event.session_id, 100) || cut(session_id, 100) || 'anonymous',
                    event_name: event.event_name,
                    properties: sanitizeProperties(event.properties),
                    timestamp: cut(event.timestamp, 40) || new Date().toISOString(),
                    client_version: version(event.client_version || client_version),
                    platform: version(event.platform || platform)
                }));
            await storeEvents(events);
            res.json({ success: true, event_ids: events.map((event) => event.id), count: events.length });
        } catch (error) {
            log.error('Analytics batch error:', error.message);
            res.status(500).json({ error: 'Failed to track batch' });
        }
    });

    app.post('/api/analytics/session/start', requireApiKey, async (req, res) => {
        try {
            const { client_version, platform, metadata } = plainObject(req.body);
            const session = {
                id: uuidv4(),
                start_time: new Date().toISOString(),
                client_version: version(client_version),
                platform: version(platform),
                metadata: sanitizeProperties(metadata)
            };
            await spool.append({ type: 'legacy_session', legacy: true, received_at: Date.now(), session });
            poke();
            res.json({ success: true, session_id: session.id });
        } catch (error) {
            log.error('Session start error:', error.message);
            res.status(500).json({ error: 'Failed to start session' });
        }
    });

    // An old version's session has a start only in the insights store, so the
    // end is answered and not stored.
    app.post('/api/analytics/session/end', requireApiKey, (req, res) => {
        const { session_id } = plainObject(req.body);
        if (!session_id) return res.status(400).json({ error: 'session_id is required' });
        if (typeof session_id !== 'string' || session_id.length > 100) return res.status(404).json({ error: 'Session not found' });
        res.json({ success: true, session: { id: session_id, start_time: null, client_version: 'unknown', platform: 'unknown', metadata: {},
            end_time: new Date().toISOString(), event_count: 0 } });
    });

    // The archive comes as base64 in a JSON body. It is stored as before, in
    // storage/crashes/, and the worker reads it afterwards.
    app.post('/api/crashes', uploadLimiter, requireApiKey, async (req, res) => {
        try {
            const { crashData, filename, sessionId, errorMessage, metadata } = plainObject(req.body);
            if (!crashData || typeof crashData !== 'string') return res.status(400).json({ error: 'crashData is required' });
            const buffer = Buffer.from(crashData, 'base64');
            if (buffer.length > MAX_CRASH_BYTES) {
                return res.status(413).json({ error: `Crash file too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB, max ${MAX_CRASH_BYTES / 1024 / 1024} MB)` });
            }
            const sent = plainObject(metadata);
            const id = uuidv4();
            const original = path.basename(typeof filename === 'string' && filename !== '' ? filename : `crash_${id}.zip`).replace(/[^\w.\-]/g, '_').slice(-120);
            const name = `${id}_${original}`;
            const file = path.join(crashesDir, name);
            await fs.promises.writeFile(file, buffer);
            try {
                await spool.append({
                    type: 'legacy_crash',
                    legacy: true,
                    received_at: Date.now(),
                    crash_id: id,
                    file: path.posix.join('crashes', name),
                    // Only what the game said; an old version that says nothing leaves it empty.
                    platform: typeof sent.platform === 'string' && sent.platform !== '' ? sent.platform.slice(0, 50) : null,
                    unread: true,
                    metadata: {
                        id,
                        file_size: buffer.length,
                        session_id: cut(sessionId, 100) || 'unknown',
                        version: cut(sent.version, 50) || 'unknown',
                        gpu: cut(sent.gpu, 200) || 'unknown',
                        error_message: cut(errorMessage, 2000) || ''
                    }
                });
            } catch (error) {
                await fs.promises.unlink(file).catch(() => {}); // without its line the report would never be seen
                throw error;
            }
            poke();
            log.log(`Crash report of an old game version stored: ${id} (${(buffer.length / 1024).toFixed(1)} KB)`);
            res.json({ success: true, crash_id: id, message: 'Crash report uploaded successfully' });
        } catch (error) {
            log.error('Crash upload error:', error.message);
            res.status(500).json({ error: 'Failed to upload crash report' });
        }
    });
}

module.exports = { register };
