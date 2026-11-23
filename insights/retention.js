// How long the insights store keeps things, and what the dashboard deleted.
// Runs in the worker thread (worker.js calls step() once per pass).
//
// Settings (the `retention` row of the meta table): days to keep single
// events, crash reports and sessions. 0 keeps them for ever.
//
//   events_days    events older than this (by their time, `t`)
//   reports_days   crash reports received longer ago than this: the row, and
//                  the archive when it is one of ours (storage/insights/crashes).
//                  The archives of the old route (storage/crashes) are never
//                  touched; the old dashboard still serves them.
//   sessions_days  sessions last seen longer ago than this
//
// Crash issues (crash_groups) and their counts, installs, install_days and
// counters are never pruned.
//
// The prune runs once a day after 03:00 UTC, in small batches between the
// worker's normal passes, so storing what the game sends never waits for it.
// The very first one is the first 03:00 that is at least a day after the
// store's first start: the import of the old files brings in years of events,
// and the settings can be looked at before a night deletes most of them.
// Deleted rows free pages inside the database file. SQLite uses them for the
// next rows, so the file stops growing but does not shrink; no VACUUM is run.
//
// "Delete crash reports" on the Settings page leaves a mark with its time
// (maintenance.reports_deleted_at). A crash record received up to that moment
// is refused from then on, wherever it comes from: a spool line that was still
// waiting, a repeated upload line, or the import of the old files.
const fs = require('fs');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;
const OPTIONS = [30, 90, 180, 365, 0];
const DEFAULTS = { events_days: 90, reports_days: 90, sessions_days: 0 };
const KEYS = Object.keys(DEFAULTS);
const PRUNE_HOUR_UTC = 3;

// Rows per batch: a batch holds the worker for some tens of milliseconds
// (1,000 events take about 35 ms on a database of 1.5 million).
const EVENTS_PER_BATCH = 1000;
const SESSIONS_PER_BATCH = 1000;
const REPORTS_PER_BATCH = 100;
const ARCHIVES_PER_BATCH = 500;
const RETRY_MS = 60 * 1000;

const SETTINGS_KEY = 'retention';
const RUN_KEY = 'retention.run';
const WATERMARK_KEY = 'maintenance.reports_deleted_at';
const SWEEP_KEY = 'maintenance.sweep_archives_before';

let storageDir = null;
let log = () => {};
let logError = () => {};
let pausedUntil = 0;
let lastLoggedError = '';
let archiveChanges = 0; // counts archives removed, so a cached size can be dropped

function init(options) {
    storageDir = options.storageDir;
    log = options.log || log;
    logError = options.logError || logError;
}

// ---------------------------------------------------------------------------
// The meta table
// ---------------------------------------------------------------------------

function getMeta(db, key) {
    const row = db.get('SELECT value FROM meta WHERE key = ?', key);
    return row ? row.value : null;
}
function setMeta(db, key, value) {
    if (value === null || value === undefined) {
        db.run('DELETE FROM meta WHERE key = ?', key);
    } else {
        db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
    }
}
function getJson(db, key) {
    const text = getMeta(db, key);
    if (text === null) return null;
    try {
        const value = JSON.parse(text);
        return value && typeof value === 'object' ? value : null;
    } catch (error) {
        return null;
    }
}
const setJson = (db, key, value) => setMeta(db, key, value === null || value === undefined ? null : JSON.stringify(value));

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function settings(db) {
    const stored = getJson(db, SETTINGS_KEY) || {};
    const result = {};
    for (const key of KEYS) result[key] = OPTIONS.includes(stored[key]) ? stored[key] : DEFAULTS[key];
    return result;
}

function invalid(message) {
    const error = new Error(message);
    error.code = 'invalid';
    return error;
}

// changes: { events_days?, reports_days?, sessions_days? }, each one of OPTIONS.
// Call inside a transaction. Returns { before, after }.
function setSettings(db, changes) {
    const body = changes && typeof changes === 'object' && !Array.isArray(changes) ? changes : {};
    const unknown = Object.keys(body).filter((key) => !KEYS.includes(key));
    if (unknown.length > 0) throw invalid(`unknown setting ${unknown.join(', ')}; the settings are ${KEYS.join(', ')}`);
    const named = KEYS.filter((key) => body[key] !== undefined);
    if (named.length === 0) throw invalid(`name at least one of ${KEYS.join(', ')}`);
    const before = settings(db);
    const after = { ...before };
    for (const key of named) {
        if (!OPTIONS.includes(body[key])) throw invalid(`${key} must be one of ${OPTIONS.join(', ')} (0 keeps for ever)`);
        after[key] = body[key];
    }
    setJson(db, SETTINGS_KEY, after);
    return { before, after };
}

// ---------------------------------------------------------------------------
// Our own crash archives
// ---------------------------------------------------------------------------

const archivesDir = () => path.join(storageDir, 'insights', 'crashes');

// The absolute path of a stored archive when it is one of ours, otherwise null.
// `file` is the `file` column of a crashes row: relative to the storage folder.
function ownArchive(file) {
    if (!storageDir || typeof file !== 'string' || file === '') return null;
    const dir = archivesDir();
    const resolved = path.resolve(storageDir, file);
    const inside = path.relative(dir, resolved);
    if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside) || inside.includes(path.sep)) return null;
    return resolved;
}

// Removes one of our archives. Returns the bytes freed, or -1 when there was
// nothing to remove or it could not be removed.
function removeArchive(file) {
    const resolved = ownArchive(file);
    if (!resolved) return -1;
    try {
        const size = fs.statSync(resolved).size;
        fs.unlinkSync(resolved);
        archiveChanges++;
        return size;
    } catch (error) {
        if (error.code !== 'ENOENT') logError(`archive ${path.basename(resolved)} could not be removed: ${error.message}`);
        return -1;
    }
}

// ---------------------------------------------------------------------------
// Crash reports the dashboard deleted
// ---------------------------------------------------------------------------

const reportsDeletedAt = (db) => Number(getMeta(db, WATERMARK_KEY)) || 0;

// True when a crash report received at `received` was deleted from the
// dashboard and must not come back.
function refusesCrash(db, received) {
    const mark = reportsDeletedAt(db);
    return mark > 0 && received <= mark;
}

// For worker.js, before a spool record is stored. True when the record is a
// crash report from before "Delete crash reports"; its archive, when it is one
// of ours and no row uses it, is removed with it.
function refuses(db, record) {
    if (!record || (record.type !== 'crash' && record.type !== 'legacy_crash')) return false;
    const received = typeof record.received_at === 'number' && Number.isFinite(record.received_at) ? record.received_at : Date.now();
    if (!refusesCrash(db, received)) return false;
    if (record.type === 'crash' && typeof record.crash_guid === 'string'
        && !db.get('SELECT 1 AS found FROM crashes WHERE crash_guid = ?', record.crash_guid.slice(0, 128))) {
        removeArchive(record.file);
    }
    return true;
}

// Call inside the transaction that deleted every crashes row. Crash records
// received up to `now` are refused from here on, and the archives written up
// to `now` are removed in the following passes.
function markReportsDeleted(db, now) {
    setMeta(db, WATERMARK_KEY, Math.max(reportsDeletedAt(db), now));
    setMeta(db, SWEEP_KEY, Math.max(Number(getMeta(db, SWEEP_KEY)) || 0, now));
}

// Removes our archives written before the mark that no row uses. A batch per
// call; true while more is waiting.
function sweepArchives(db) {
    const before = Number(getMeta(db, SWEEP_KEY)) || 0;
    if (before <= 0) return false;
    let names = [];
    try {
        names = fs.readdirSync(archivesDir());
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    let removed = 0;
    for (const name of names) {
        if (!name.endsWith('.zip')) continue;
        const file = path.join(archivesDir(), name);
        let stat;
        try { stat = fs.statSync(file); } catch (error) { continue; }
        if (!stat.isFile() || stat.mtimeMs > before) continue;
        // A report that arrived again after the mark keeps its archive.
        if (db.get('SELECT 1 AS found FROM crashes WHERE crash_guid = ?', name.slice(0, -4))) continue;
        try {
            fs.unlinkSync(file);
            archiveChanges++;
            removed++;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        if (removed >= ARCHIVES_PER_BATCH) return true;
    }
    setMeta(db, SWEEP_KEY, null);
    if (removed > 0) log('retention: the archives of the deleted crash reports are removed');
    return false;
}

// ---------------------------------------------------------------------------
// The daily prune
// ---------------------------------------------------------------------------

// The next 03:00 UTC after `now`.
function nextPruneAt(now) {
    const day = Math.floor(now / DAY) * DAY;
    const today = day + PRUNE_HOUR_UTC * 60 * 60 * 1000;
    return now < today ? today : today + DAY;
}

const cutoff = (now, days) => (days > 0 ? now - days * DAY : null);

function startRun(db, run, now) {
    const kept = settings(db);
    run.running = {
        started_at: now,
        settings: kept,
        events_before: cutoff(now, kept.events_days),
        reports_before: cutoff(now, kept.reports_days),
        sessions_before: cutoff(now, kept.sessions_days),
        phase: 'events',
        deleted: { events: 0, reports: 0, archives: 0, archives_bytes: 0, sessions: 0 }
    };
    run.due_at = nextPruneAt(now);
    db.transaction(() => setJson(db, RUN_KEY, run));
}

// One batch of the running prune. Returns true while more is waiting.
function pruneBatch(db, run, now) {
    const running = run.running;
    const save = () => setJson(db, RUN_KEY, run);

    if (running.phase === 'events') {
        if (running.events_before === null) {
            running.phase = 'reports';
        } else {
            db.transaction(() => {
                const result = db.run('DELETE FROM events WHERE id IN (SELECT id FROM events WHERE t < ? ORDER BY t LIMIT ?)',
                    running.events_before, EVENTS_PER_BATCH);
                running.deleted.events += Number(result.changes);
                if (Number(result.changes) < EVENTS_PER_BATCH) running.phase = 'reports';
                save();
            });
            return true;
        }
    }

    if (running.phase === 'reports') {
        if (running.reports_before === null) {
            running.phase = 'sessions';
        } else {
            const rows = db.all('SELECT id, legacy, file FROM crashes WHERE received_at < ? ORDER BY received_at LIMIT ?',
                running.reports_before, REPORTS_PER_BATCH);
            // The archives first: a row without its archive is deleted by the next
            // batch, an archive without its row would stay for ever.
            for (const row of rows) {
                if (Number(row.legacy) !== 0) continue;
                const freed = removeArchive(row.file);
                if (freed >= 0) {
                    running.deleted.archives++;
                    running.deleted.archives_bytes += freed;
                }
            }
            db.transaction(() => {
                for (const row of rows) db.run('DELETE FROM crashes WHERE id = ?', row.id);
                running.deleted.reports += rows.length;
                if (rows.length < REPORTS_PER_BATCH) running.phase = 'sessions';
                save();
            });
            return true;
        }
    }

    if (running.phase === 'sessions' && running.sessions_before !== null) {
        let finished = false;
        db.transaction(() => {
            const result = db.run(`DELETE FROM sessions WHERE session_id IN
                    (SELECT session_id FROM sessions WHERE last_seen_at < ? ORDER BY last_seen_at LIMIT ?)`,
                running.sessions_before, SESSIONS_PER_BATCH);
            running.deleted.sessions += Number(result.changes);
            finished = Number(result.changes) < SESSIONS_PER_BATCH;
            if (finished) running.phase = 'done';
            save();
        });
        if (!finished) return true;
    }

    run.last = { started_at: running.started_at, finished_at: now, settings: running.settings, deleted: running.deleted };
    run.running = null;
    db.transaction(save);
    const d = run.last.deleted;
    log(`retention: nightly prune done: ${d.events} events, ${d.reports} crash reports (${d.archives} archives, ${d.archives_bytes} bytes), ${d.sessions} sessions deleted`);
    return false;
}

// Called once per worker pass. `importing`: the import of the old files is
// still running, so a new prune waits for it. Returns true when there is more
// to do straight away. Never throws.
function step(db, importing = false) {
    const now = Date.now();
    if (now < pausedUntil) return false;
    try {
        if (sweepArchives(db)) return true;
        const run = getJson(db, RUN_KEY);
        if (!run || !Number.isFinite(run.due_at)) {
            // The first start: nothing is pruned during the first day.
            db.transaction(() => setJson(db, RUN_KEY, { due_at: nextPruneAt(now + DAY), running: null, last: null }));
            return false;
        }
        if (run.running) return pruneBatch(db, run, now);
        if (now < run.due_at || importing) return false;
        startRun(db, run, now);
        return true;
    } catch (error) {
        const message = String((error && error.message) || error).slice(0, 300);
        if (message !== lastLoggedError) {
            lastLoggedError = message;
            logError(`retention: a prune step failed (trying again in a minute): ${message}`);
        }
        pausedUntil = now + RETRY_MS;
        return false;
    }
}

// For the Settings page and the health view.
function status(db) {
    const run = getJson(db, RUN_KEY) || {};
    return {
        hour_utc: PRUNE_HOUR_UTC,
        next_at: Number.isFinite(run.due_at) ? run.due_at : null,
        running: Boolean(run.running),
        last_at: run.last ? run.last.finished_at : null,
        last_deleted: run.last ? run.last.deleted : null,
        removing_archives: (Number(getMeta(db, SWEEP_KEY)) || 0) > 0
    };
}

module.exports = {
    init, step, status, settings, setSettings, refuses, refusesCrash, markReportsDeleted, reportsDeletedAt,
    ownArchive, archivesDir, archiveChanges: () => archiveChanges,
    getMeta, setMeta, getJson, setJson, nextPruneAt,
    OPTIONS, DEFAULTS, KEYS, SETTINGS_KEY, RUN_KEY, WATERMARK_KEY, SWEEP_KEY
};
