// The insights worker thread. It is the only code that opens the database.
//
// Every two seconds, and when the main thread says a record arrived, it
// 1. reads the new lines of the spool files and stores them, remembering how
//    far it read in the same transaction as the rows;
// 2. reads crash archives that are stored but not yet parsed, and groups them;
// 3. deletes spool files that are fully stored and over seven days old.
// It also answers questions from the main thread ("ask"), such as the admin
// health view. If the database cannot be opened it says so once, leaves the
// spool alone and tries again every half minute.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const database = require('./db');
const spool = require('./spool');
const crashParse = require('./crash-parse');
const registry = require('./events.json');
const queries = require('./queries');
const legacyImport = require('./import');
const retention = require('./retention');
const { compareBuilds } = require('./queries/common');

const storageDir = workerData.storageDir;
const dbFile = path.join(storageDir, 'insights', 'insights.db');
const spoolDir = spool.spoolDir(storageDir);

const POLL_MS = 2000;
const REOPEN_MS = 30 * 1000;
const READ_BYTES = 4 * 1024 * 1024;   // spool bytes stored per transaction
const CRASHES_PER_PASS = 10;
const KEEP_SPOOL_DAYS = 7;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_CLOCK_CORRECTION_MS = DAY;
const MAX_EVENT_AGE_MS = 90 * DAY;    // raw events are kept 90 days
const MAX_EVENT_AHEAD_MS = 10 * MINUTE;

const REGISTERED = new Set(Object.keys(registry.events || {}));
const LEGACY_MAP = registry.legacy_map || {};
const SESSION_FIELDS = new Map(database.sessionFieldColumns().map((column) => [column.name, column.kind]));
const ID = /^[A-Za-z0-9_-]{16,64}$/;

let db = null;
let dbError = null;
let dbTriedAt = 0;
let stopped = false;
let timer = null;
let lastLoggedError = '';
const stats = {
    started_at: Date.now(), last_pass_at: null, last_ingest_at: null,
    lines_stored: 0, lines_failed: 0, lines_unreadable: 0,
    events_inserted: 0, events_repeated: 0, crashes_parsed: 0, crashes_unreadable: 0, last_error: null
};

const log = (...parts) => console.log('[insights]', ...parts);
const logError = (...parts) => console.error('[insights]', ...parts);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const idOrNull = (value) => (typeof value === 'string' && ID.test(value) ? value.toLowerCase() : null);
const textOrNull = (value, max = 50) => (typeof value === 'string' && value !== '' ? value.slice(0, max) : null);
// The old routes write 'unknown' where they know nothing.
const knownOrNull = (value, max = 50) => (typeof value === 'string' && value !== '' && value !== 'unknown' ? value.slice(0, max) : null);
const integerOrNull = (value) => (finite(value) && Number.isInteger(value) && value >= 0 ? value : null);
const objectOrEmpty = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

// A value for a session column of kind s, n or b; undefined when it does not fit.
function sessionFieldValue(kind, value) {
    if (kind === 's') {
        if (typeof value === 'string') return value.slice(0, 500);
        if (finite(value) || typeof value === 'boolean') return String(value);
        return undefined;
    }
    if (kind === 'n') {
        if (finite(value)) return value;
        if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
        return undefined;
    }
    if (kind === 'b') {
        if (typeof value === 'boolean') return value ? 1 : 0;
        if (finite(value)) return value ? 1 : 0;
        if (typeof value === 'string') {
            const lower = value.trim().toLowerCase();
            if (lower === 'true' || lower === '1') return 1;
            if (lower === 'false' || lower === '0') return 0;
        }
        return undefined;
    }
    return undefined;
}

function setSessionField(sessionId, name, value) {
    const kind = SESSION_FIELDS.get(name);
    if (!kind) return;
    const stored = sessionFieldValue(kind, value);
    if (stored === undefined) return;
    // `name` is one of the column names taken from events.json, checked in db.js.
    db.run(`UPDATE sessions SET ${name} = ? WHERE session_id = ?`, stored, sessionId);
}

// ---------------------------------------------------------------------------
// Storing spool records
// ---------------------------------------------------------------------------

const UPSERT_SESSION = `
    INSERT INTO sessions (session_id, install_id, legacy, started_at, last_seen_at, build, steam_build, platform)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
        install_id   = COALESCE(sessions.install_id, excluded.install_id),
        started_at   = MIN(sessions.started_at, excluded.started_at),
        last_seen_at = MAX(sessions.last_seen_at, excluded.last_seen_at),
        build        = COALESCE(sessions.build, excluded.build),
        steam_build  = COALESCE(sessions.steam_build, excluded.steam_build),
        platform     = COALESCE(sessions.platform, excluded.platform)`;

const UPSERT_INSTALL = `
    INSERT INTO installs (install_id, first_seen, last_seen, first_build, last_build, platform)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(install_id) DO UPDATE SET
        first_seen  = MIN(installs.first_seen, excluded.first_seen),
        last_seen   = MAX(installs.last_seen, excluded.last_seen),
        first_build = CASE WHEN excluded.first_seen < installs.first_seen
                           THEN COALESCE(excluded.first_build, installs.first_build)
                           ELSE COALESCE(installs.first_build, excluded.first_build) END,
        last_build  = CASE WHEN excluded.last_seen >= installs.last_seen
                           THEN COALESCE(excluded.last_build, installs.last_build)
                           ELSE installs.last_build END,
        platform    = COALESCE(installs.platform, excluded.platform)`;

const INSERT_EVENT = `
    INSERT OR IGNORE INTO events (session_id, install_id, name, t, seq, build, platform, registered, legacy, props)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// One batch from POST /api/v2/collect.
function storeCollect(record) {
    const received = finite(record.received_at) ? record.received_at : Date.now();
    const sessionId = idOrNull(record.session_id);
    const installId = idOrNull(record.install_id);
    if (!sessionId || !installId) throw new Error('collect record without install_id or session_id');

    const build = textOrNull(record.build);
    const platform = textOrNull(record.platform);
    const steamBuild = integerOrNull(record.steam_build);
    const events = Array.isArray(record.events) ? record.events.filter((event) => event && typeof event.name === 'string') : [];

    // The game's clock may be wrong. `sent_at` was read from the same clock just
    // before sending, so the difference to our receive time puts every event
    // of the batch on our clock.
    const correction = finite(record.sent_at) && Math.abs(received - record.sent_at) < MAX_CLOCK_CORRECTION_MS
        ? received - record.sent_at : null;
    const eventTime = (t) => {
        if (correction === null || !finite(t)) return received;
        const corrected = Math.round(t + correction);
        if (corrected > received + MAX_EVENT_AHEAD_MS || corrected < received - MAX_EVENT_AGE_MS) return received;
        return corrected;
    };
    const times = events.map((event) => eventTime(event.t));

    // An empty batch or one marked as heartbeat says "the game is running now".
    const alive = events.length === 0 || record.heartbeat === true;
    const firstTime = times.reduce((a, b) => Math.min(a, b), alive ? received : Infinity);
    const lastTime = times.reduce((a, b) => Math.max(a, b), alive ? received : -Infinity);

    db.run(UPSERT_SESSION, sessionId, installId, 0, firstTime, lastTime, build, steamBuild, platform);
    db.run(UPSERT_INSTALL, installId, firstTime, lastTime, build, build, platform);

    const days = new Set(times.map(spool.utcDay));
    if (alive) days.add(spool.utcDay(received));
    for (const day of days) {
        db.run('INSERT OR IGNORE INTO install_days (install_id, day, platform, build) VALUES (?, ?, ?, ?)',
            installId, day, platform, build);
    }

    let inserted = 0;
    events.forEach((event, index) => {
        const t = times[index];
        const props = objectOrEmpty(event.props);
        const result = db.run(INSERT_EVENT, sessionId, installId, event.name, t, integerOrNull(event.seq), build, platform,
            REGISTERED.has(event.name) ? 1 : 0, 0, JSON.stringify(props));
        if (result.changes > 0) inserted++; else stats.events_repeated++;

        // What an event changes on the session row. Applying it again for a
        // repeated batch changes nothing.
        if (event.name === 'session_start') {
            for (const [name, value] of Object.entries(props)) setSessionField(sessionId, name, value);
            db.run('UPDATE sessions SET started_at = MIN(started_at, ?) WHERE session_id = ?', t, sessionId);
            const existing = sessionFieldValue('b', props.existing_player);
            if (existing !== undefined) {
                db.run('UPDATE installs SET existing_player = COALESCE(existing_player, ?) WHERE install_id = ?', existing, installId);
            }
        } else if (event.name === 'menu_shown') {
            // The settings snapshot: every prop that is a session field.
            for (const [name, value] of Object.entries(props)) setSessionField(sessionId, name, value);
        } else if (event.name === 'setting_change') {
            if (typeof props.key === 'string') setSessionField(sessionId, props.key, props.to);
        } else if (event.name === 'session_end') {
            db.run(`UPDATE sessions SET ended_at = ?, end_reason = 'clean',
                        duration_s = COALESCE(?, duration_s), active_s = COALESCE(?, active_s),
                        last_seen_at = MAX(last_seen_at, ?)
                    WHERE session_id = ?`,
                t, finite(props.duration_s) ? props.duration_s : null, finite(props.active_s) ? props.active_s : null, t, sessionId);
        } else if (event.name === 'session_abnormal_end') {
            // Sent by the next session about the one before it.
            const previous = idOrNull(props.prev_session_id);
            if (previous) {
                // A game that died during startup may never have delivered a batch of
                // its own, so the session can be unknown here. It gets a row from what
                // this report says (the times are from the same clock as this batch);
                // its own first batch, which the game sends again, fills in the rest.
                const startedBefore = finite(props.prev_started_ms) ? eventTime(props.prev_started_ms) : t;
                const seenBefore = finite(props.prev_last_ms) ? Math.max(startedBefore, eventTime(props.prev_last_ms)) : startedBefore;
                db.run(UPSERT_SESSION, previous, installId, 0, Math.min(startedBefore, t), Math.min(seenBefore, t), build, steamBuild, platform);
                db.run(`UPDATE sessions SET end_reason = 'abnormal', last_stage = ?, duration_s = COALESCE(?, duration_s)
                        WHERE session_id = ? AND (end_reason IS NULL OR end_reason <> 'clean')`,
                    textOrNull(props.last_stage, 500), finite(props.seconds_alive) ? props.seconds_alive : null, previous);
            }
        }
    });
    if (inserted > 0) {
        db.run('UPDATE sessions SET event_count = event_count + ? WHERE session_id = ?', inserted, sessionId);
        stats.events_inserted += inserted;
    }
}

// A session started through the old route POST /api/analytics/session/start.
function storeLegacySession(record) {
    const received = finite(record.received_at) ? record.received_at : Date.now();
    const session = objectOrEmpty(record.session);
    const sessionId = textOrNull(session.id, 100);
    if (!sessionId) throw new Error('legacy session without id');
    db.run(UPSERT_SESSION, sessionId, null, 1, received, received,
        knownOrNull(session.client_version), null, knownOrNull(session.platform));
}

// An old event name and its properties in the new vocabulary (events.json, legacy_map).
function mapLegacyEvent(name, properties) {
    const rule = LEGACY_MAP[name];
    if (!rule || typeof rule.to !== 'string') return { name, props: properties };
    const renames = objectOrEmpty(rule.props);
    const values = objectOrEmpty(rule.values);
    const props = {};
    for (const [key, value] of Object.entries(properties)) {
        if (typeof renames[key] === 'string') {
            props[renames[key]] = typeof value === 'string' && typeof values[value] === 'string' ? values[value] : value;
        } else {
            props[key] = value;
        }
    }
    return { name: rule.to, props };
}

// Events from the old routes POST /api/analytics/batch and /api/analytics/event.
function storeLegacyEvents(record) {
    const received = finite(record.received_at) ? record.received_at : Date.now();
    const events = Array.isArray(record.events) ? record.events : [];
    const counts = new Map(); // session id -> { build, platform, last, inserted }
    for (const event of events) {
        if (!event || typeof event.event_name !== 'string' || event.event_name === '') continue;
        const sessionId = textOrNull(event.session_id, 100) || 'anonymous';
        const build = knownOrNull(event.client_version);
        const platform = knownOrNull(event.platform);
        // The old game sends its own clock and nothing to correct it with.
        const stamp = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
        const t = Number.isFinite(stamp) && Math.abs(stamp - received) < MAX_CLOCK_CORRECTION_MS ? stamp : received;
        const mapped = mapLegacyEvent(event.event_name.slice(0, 200), objectOrEmpty(event.properties));
        const result = db.run(INSERT_EVENT, sessionId, null, mapped.name, t, null, build, platform,
            REGISTERED.has(mapped.name) ? 1 : 0, 1, JSON.stringify(mapped.props));

        const entry = counts.get(sessionId) || { build, platform, first: t, last: t, inserted: 0 };
        entry.first = Math.min(entry.first, t);
        entry.last = Math.max(entry.last, t);
        entry.inserted += result.changes > 0 ? 1 : 0;
        counts.set(sessionId, entry);
        if (result.changes > 0) stats.events_inserted++;
    }
    for (const [sessionId, entry] of counts) {
        if (sessionId === 'anonymous') continue;
        db.run(UPSERT_SESSION, sessionId, null, 1, entry.first, entry.last, entry.build, null, entry.platform);
        db.run('UPDATE sessions SET event_count = event_count + ? WHERE session_id = ?', entry.inserted, sessionId);
    }
}

// The time a crash happened: the report's own time when it is believable,
// otherwise the time we received it.
function crashOccurredAt(crashTime, received) {
    const stamp = typeof crashTime === 'string' ? Date.parse(crashTime) : NaN;
    if (Number.isFinite(stamp) && stamp <= received + MAX_EVENT_AHEAD_MS && stamp >= received - MAX_EVENT_AGE_MS) return stamp;
    return received;
}

function addToList(json, value) {
    let list;
    try { list = JSON.parse(json); } catch (error) { list = []; }
    if (!Array.isArray(list)) list = [];
    if (value && !list.includes(value) && list.length < 200) list.push(value);
    return JSON.stringify(list);
}

// Writes what was read from a crash onto its row and counts it in its group.
// `crash` is { id, platform, build, received_at }.
function classifyAndGroup(crash, context, details) {
    const classified = crashParse.classifyCrash(context, crash.platform, details.hang === true);
    const occurredAt = crashOccurredAt(context && context.crash_time, crash.received_at);
    const crashType = (context && context.crash_type) || 'Unknown';
    const message = ((context && context.error_message) || details.fallback_message || '').slice(0, 2000);

    let group = db.get('SELECT id, builds, platforms, status, fixed_build FROM crash_groups WHERE group_key = ?', classified.group_key);
    if (!group) {
        // An issue nobody has looked at is New. History brought in from the old
        // files starts as Open (details.status), or everything would be New at once.
        db.run(`INSERT INTO crash_groups (group_key, title, category, crash_type, error_message, count, first_seen, last_seen, status, status_at)
                VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
            classified.group_key, classified.title, classified.category, crashType, message, occurredAt, occurredAt,
            details.status || 'new', crash.received_at);
        group = db.get('SELECT id, builds, platforms, status, fixed_build FROM crash_groups WHERE group_key = ?', classified.group_key);
    } else if (group.status === 'fixed' && group.fixed_build && crash.build && compareBuilds(crash.build, group.fixed_build) > 0) {
        // A report from a build newer than the one it was fixed in.
        db.run(`UPDATE crash_groups SET status = 'regressed', status_at = ? WHERE id = ?`, crash.received_at, group.id);
    }
    db.run(`UPDATE crash_groups SET count = count + 1, first_seen = MIN(first_seen, ?), last_seen = MAX(last_seen, ?),
                builds = ?, platforms = ? WHERE id = ?`,
        occurredAt, occurredAt, addToList(group.builds, crash.build), addToList(group.platforms, crash.platform), group.id);

    const stored = context ? { ...context, callstack: String(context.callstack || '').slice(0, 20000) } : null;
    db.run(`UPDATE crashes SET parsed = ?, parse_error = ?, has_context = ?, has_minidump = ?, group_id = ?, category = ?,
                crash_type = ?, error_message = ?, callstack_hash = ?, cpu = ?, gpu = ?, os = ?, ram_gb = ?,
                engine_version = ?, seconds_since_start = ?, occurred_at = ?, context = ?
            WHERE id = ?`,
        details.parsed, details.parse_error || null, context ? 1 : 0,
        details.has_minidump === undefined ? null : (details.has_minidump ? 1 : 0), group.id, classified.category,
        crashType, message, textOrNull(context && context.callstack_hash, 200), textOrNull(context && context.cpu, 200),
        textOrNull((context && context.gpu) || details.fallback_gpu, 200), textOrNull(context && context.os, 200),
        context && finite(context.ram_gb) && context.ram_gb > 0 ? context.ram_gb : null,
        textOrNull(context && context.engine_version, 200),
        context && finite(context.seconds_since_start) ? context.seconds_since_start : null,
        occurredAt, stored ? JSON.stringify(stored) : null, crash.id);
}

const INSERT_CRASH = `
    INSERT OR IGNORE INTO crashes (crash_guid, legacy, install_id, session_id, build, steam_build, platform,
        received_at, occurred_at, file, file_size, parsed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`;

// An archive stored by POST /api/v2/crashes. Only the row is written here; the
// archive is read afterwards (parsePendingCrashes). A repeated upload of the
// same crash_guid changes nothing.
function storeCrash(record) {
    const received = finite(record.received_at) ? record.received_at : Date.now();
    const guid = textOrNull(record.crash_guid, 128);
    if (!guid) throw new Error('crash record without crash_guid');
    db.run(INSERT_CRASH, guid, 0, idOrNull(record.install_id), idOrNull(record.session_id), textOrNull(record.build),
        integerOrNull(record.steam_build), textOrNull(record.platform), received, received,
        textOrNull(record.file, 400), integerOrNull(record.size));
}

// A crash of an old game version (POST /api/crashes). With `unread` its archive
// is read afterwards like any other (parsePendingCrashes); what the game said is
// kept for a report that holds nothing readable. Without it (the import of the
// old files) the old route's own reading is used and the archive is not touched.
function storeLegacyCrash(record, details = {}) {
    const received = finite(record.received_at) ? record.received_at : Date.now();
    const metadata = objectOrEmpty(record.metadata);
    const guid = textOrNull(record.crash_id, 128) || textOrNull(metadata.id, 128);
    if (!guid) throw new Error('legacy crash without id');
    const platform = knownOrNull(record.platform);
    const build = knownOrNull(metadata.version);
    const sessionId = knownOrNull(metadata.session_id, 100);
    const result = db.run(INSERT_CRASH, guid, 1, null, sessionId, build, null, platform, received, received,
        textOrNull(record.file, 400), integerOrNull(metadata.file_size));
    if (result.changes === 0) return;
    if (record.unread === true) {
        db.run('UPDATE crashes SET error_message = ?, gpu = ? WHERE id = ?', textOrNull(metadata.error_message, 2000),
            knownOrNull(metadata.gpu, 200), Number(result.lastInsertRowid));
        return;
    }

    const context = metadata.crash_context && typeof metadata.crash_context === 'object' ? metadata.crash_context : null;
    classifyAndGroup({ id: Number(result.lastInsertRowid), platform, build, received_at: received }, context, {
        parsed: 1,
        status: details.status, // the import of the old files passes 'open'
        fallback_message: typeof metadata.error_message === 'string' ? metadata.error_message : '',
        fallback_gpu: knownOrNull(metadata.gpu, 200)
    });
}

// Something that is not an event but is counted per day (an abandoned crash
// upload, a duplicate): { type: 'count', key, n }.
function storeCount(record) {
    const received = finite(record.received_at) ? record.received_at : Date.now();
    const key = textOrNull(record.key, 64);
    if (!key) throw new Error('count record without key');
    const n = Number.isInteger(record.n) && record.n > 0 ? record.n : 1;
    db.run(`INSERT INTO counters (day, key, n) VALUES (?, ?, ?)
            ON CONFLICT(day, key) DO UPDATE SET n = n + excluded.n`, spool.utcDay(received), key, n);
}

function storeRecord(record) {
    if (retention.refuses(db, record)) return; // a crash report from before "Delete crash reports"
    switch (record.type) {
        case 'count': return storeCount(record);
        case 'collect': return storeCollect(record);
        case 'crash': return storeCrash(record);
        case 'legacy_session': return storeLegacySession(record);
        case 'legacy_events':   // copied by the first version of this store; import.js looks for these
        case 'old_game_events': return storeLegacyEvents(record);
        case 'legacy_crash': return storeLegacyCrash(record);
        default: throw new Error(`unknown record type ${JSON.stringify(record.type)}`);
    }
}

// ---------------------------------------------------------------------------
// The three steps of a pass
// ---------------------------------------------------------------------------

// Stores the new lines of every spool file. Returns true when more is waiting.
function ingestSpool() {
    let more = false;
    for (const entry of spool.listSpoolFiles(spoolDir)) {
        const row = db.get('SELECT offset FROM spool_offsets WHERE file = ?', entry.name);
        let offset = row ? Number(row.offset) : 0;
        if (offset > entry.size) {
            logError(`spool ${entry.name} is shorter than what was read from it (${entry.size} < ${offset}); reading it from the start`);
            offset = 0;
        }
        if (offset >= entry.size) continue;
        const piece = spool.readSpoolLines(entry.file, offset, entry.size, READ_BYTES);
        if (piece.nextOffset === offset) continue; // the last line is still being written

        db.transaction(() => {
            for (const line of piece.lines) {
                if (!line.record) {
                    stats.lines_unreadable++;
                    continue;
                }
                try {
                    db.savepoint(() => storeRecord(line.record));
                    stats.lines_stored++;
                } catch (error) {
                    stats.lines_failed++;
                    stats.last_error = String(error.message || error).slice(0, 300);
                    if (stats.lines_failed <= 20) logError(`spool ${entry.name}: a ${line.record.type} record was not stored: ${stats.last_error}`);
                }
            }
            db.run(`INSERT INTO spool_offsets (file, offset, updated_at) VALUES (?, ?, ?)
                    ON CONFLICT(file) DO UPDATE SET offset = excluded.offset, updated_at = excluded.updated_at`,
                entry.name, piece.nextOffset, Date.now());
        });
        stats.last_ingest_at = Date.now();
        if (piece.more) more = true;
    }
    return more;
}

// Reads stored archives that have a row but were not read yet.
function parsePendingCrashes() {
    if (!crashParse.available()) return false; // rows stay pending until adm-zip is there
    const rows = db.all('SELECT id, crash_guid, file, platform, build, received_at, error_message, gpu FROM crashes WHERE parsed = 0 ORDER BY id LIMIT ?',
        CRASHES_PER_PASS + 1);
    for (const row of rows.slice(0, CRASHES_PER_PASS)) {
        // The slow part (reading and unpacking the file) happens outside the transaction.
        const archive = row.file
            ? crashParse.parseCrashArchive(path.resolve(storageDir, row.file))
            : { ok: false, error: 'no file recorded', context: null, has_minidump: false, hang: false };
        try {
            db.transaction(() => {
                classifyAndGroup(row, archive.context, {
                    parsed: archive.ok ? 1 : 2,
                    parse_error: archive.error,
                    has_minidump: archive.has_minidump,
                    hang: archive.hang,
                    fallback_message: row.error_message || '',
                    fallback_gpu: row.gpu
                });
            });
            if (archive.ok) stats.crashes_parsed++; else stats.crashes_unreadable++;
        } catch (error) {
            // Keep the row, mark it, and go on with the next one.
            stats.crashes_unreadable++;
            stats.last_error = String((error && error.message) || error).slice(0, 300);
            logError(`crash ${row.crash_guid} could not be grouped: ${stats.last_error}`);
            db.run('UPDATE crashes SET parsed = 2, parse_error = ? WHERE id = ?', stats.last_error, row.id);
        }
    }
    return rows.length > CRASHES_PER_PASS;
}

// Deletes spool files that are fully stored and over a week old.
function removeOldSpoolFiles() {
    const cutoff = spool.utcDay(Date.now() - KEEP_SPOOL_DAYS * DAY);
    for (const entry of spool.listSpoolFiles(spoolDir)) {
        if (entry.day >= cutoff) continue;
        const row = db.get('SELECT offset FROM spool_offsets WHERE file = ?', entry.name);
        if (entry.size > 0 && (!row || Number(row.offset) < entry.size)) continue;
        fs.unlinkSync(entry.file);
        db.run('DELETE FROM spool_offsets WHERE file = ?', entry.name);
        log(`spool ${entry.name} is stored and over ${KEEP_SPOOL_DAYS} days old; deleted`);
    }
}

function openDatabase() {
    if (db) return true;
    if (dbTriedAt && Date.now() - dbTriedAt < REOPEN_MS) return false;
    dbTriedAt = Date.now();
    try {
        db = database.open(dbFile);
        if (dbError) log('database opened after earlier failures');
        dbError = null;
        log(`database ready (${db.engine}, schema ${db.schemaVersion}): ${dbFile}`);
        return true;
    } catch (error) {
        const message = String((error && error.message) || error);
        if (!dbError) {
            logError(`database cannot be opened: ${message}. What the game sends stays in the spool files and is stored once the database opens.`);
        }
        dbError = message;
        return false;
    }
}

// One pass. Returns true when there is more to do straight away.
function pass() {
    stats.last_pass_at = Date.now();
    if (!openDatabase()) return false;
    // A bounded piece of the import of the old files. It comes first because its
    // first step notes where the old files end before this pass stores anything.
    let more = legacyImport.step(db);
    more = ingestSpool() || more;
    more = parsePendingCrashes() || more;
    removeOldSpoolFiles();
    more = retention.step(db, legacyImport.running()) || more;
    return more;
}

// ---------------------------------------------------------------------------
// Questions from the main thread
// ---------------------------------------------------------------------------

function health() {
    const now = Date.now();
    const files = spool.listSpoolFiles(spoolDir);
    const spoolBytes = files.reduce((sum, entry) => sum + entry.size, 0);
    const answer = {
        now,
        worker: { status: 'running', node: process.version, ...stats },
        database: { status: db ? 'ok' : 'unavailable', error: dbError, file: path.basename(dbFile) },
        spool: { files: files.length, bytes: spoolBytes, backlog_bytes: spoolBytes },
        crash_archive_reader: crashParse.available()
    };
    if (!db) return answer;

    const offsets = new Map(db.all('SELECT file, offset FROM spool_offsets').map((row) => [row.file, Number(row.offset)]));
    answer.spool.backlog_bytes = files.reduce((sum, entry) => sum + Math.max(0, entry.size - Math.min(entry.size, offsets.get(entry.name) || 0)), 0);
    answer.database.engine = db.engine;
    answer.database.schema_version = db.schemaVersion;
    try { answer.database.bytes = fs.statSync(dbFile).size; } catch (error) { answer.database.bytes = null; }

    answer.tables = {};
    for (const table of database.TABLES) {
        answer.tables[table] = Number(db.get(`SELECT COUNT(*) AS n FROM ${table}`).n);
    }
    answer.events_last_hour = db.all('SELECT name, COUNT(*) AS count FROM events WHERE t >= ? GROUP BY name ORDER BY count DESC, name', now - HOUR);
    const last = db.get('SELECT MAX(t) AS t FROM events');
    answer.last_event_at = last && last.t !== null ? Number(last.t) : null;
    answer.unregistered_last_24h = db.all(
        `SELECT name, legacy, COUNT(*) AS count, MAX(t) AS last_seen FROM events
         WHERE registered = 0 AND t >= ? GROUP BY name, legacy ORDER BY count DESC, name LIMIT 200`, now - DAY);
    answer.crashes_waiting = Number(db.get('SELECT COUNT(*) AS n FROM crashes WHERE parsed = 0').n);
    answer.import = legacyImport.status(db);
    answer.retention = { ...retention.settings(db), ...retention.status(db) };
    return answer;
}

// type -> function(params). The dashboard's questions are in queries/; the
// main thread reaches all of them with insights.ask(type, params).
function openDb() {
    if (!db) {
        const error = new Error(dbError ? `database unavailable: ${dbError}` : 'database unavailable');
        error.code = 'no_database';
        throw error;
    }
    return db;
}
const asks = { health, ...queries.asks(openDb, storageDir) };

legacyImport.init({ storageDir, log, logError, store: { session: storeLegacySession, events: storeLegacyEvents, crash: storeLegacyCrash } });
retention.init({ storageDir, log, logError });

// ---------------------------------------------------------------------------
// Scheduling and messages
// ---------------------------------------------------------------------------

function schedule(delay) {
    if (stopped) return;
    if (timer) {
        if (timer.due <= Date.now() + delay) return;
        clearTimeout(timer.handle);
    }
    timer = { due: Date.now() + delay, handle: setTimeout(tick, delay) };
}

function tick() {
    timer = null;
    if (stopped) return;
    let more = false;
    try {
        more = pass();
    } catch (error) {
        const message = String((error && error.stack) || error);
        stats.last_error = String((error && error.message) || error).slice(0, 300);
        if (stats.last_error !== lastLoggedError) {
            lastLoggedError = stats.last_error;
            logError('pass failed (will try again):', message);
        }
    }
    schedule(more ? 0 : POLL_MS);
}

function shutdown() {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer.handle);
    timer = null;
    if (db) {
        try { db.close(); } catch (error) { logError('closing the database failed:', error.message); }
        db = null;
    }
    parentPort.postMessage({ type: 'stopped' });
    parentPort.close();
}

parentPort.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'poke') {
        schedule(0);
    } else if (message.type === 'ask') {
        let reply;
        try {
            const handler = Object.prototype.hasOwnProperty.call(asks, message.ask) ? asks[message.ask] : null;
            if (!handler) throw new Error(`unknown question ${JSON.stringify(message.ask)}`);
            reply = { type: 'answer', id: message.id, ok: true, result: handler(message.params || {}) };
        } catch (error) {
            reply = { type: 'answer', id: message.id, ok: false, error: String((error && error.message) || error).slice(0, 500),
                code: error && typeof error.code === 'string' ? error.code : null };
            if (!reply.code) logError(`question ${JSON.stringify(message.ask)} failed:`, (error && error.stack) || error);
        }
        parentPort.postMessage(reply);
    } else if (message.type === 'stop') {
        shutdown();
    }
});

schedule(0);
