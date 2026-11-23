// Insights: the new store for what the game sends (events, sessions, crashes).
//
// server.js calls mount() once, the legacy*() functions from its old routes,
// and stop() when the process is asked to end. Nothing here can stop the
// server from starting or make an old route fail: every entry point catches
// its own errors and logs them.
//
//   spool.js        append-only day files; the main thread writes, the worker reads
//   routes.js       POST /api/v2/collect, POST /api/v2/crashes, GET /api/admin/v2/health
//   admin.js        the dashboard: sign-in, /api/admin/v2/q and /do, the pages under /insights
//   queries/        what the dashboard asks the database (worker thread)
//   main-actions/   dashboard actions that need the network or the main server's files
//   worker.js       the worker thread: spool -> database, crash archives, admin answers
//   db.js           the SQLite database and its schema (worker thread only)
//   crash-parse.js  reading a crash archive, category and group key
//   events.json     the list of events and session fields
const path = require('path');
const { Worker } = require('worker_threads');
const { createSpool } = require('./spool');
const routes = require('./routes');
const admin = require('./admin');

const LEGACY_EVENTS_PER_LINE = 100;
const RESTART_MIN_MS = 5 * 1000;
const RESTART_MAX_MS = 60 * 1000;
const POKE_GAP_MS = 200;

let storageDir = null;
let spool = null;
let worker = null;
let stopping = false;
let restartDelay = RESTART_MIN_MS;
let restartTimer = null;
let pokeTimer = null;
let nextAskId = 0;
const pendingAsks = new Map(); // id -> { resolve, reject, timer }

function failPendingAsks(reason) {
    for (const [id, pending] of pendingAsks) {
        clearTimeout(pending.timer);
        pending.reject(new Error(reason));
        pendingAsks.delete(id);
    }
}

function startWorker() {
    if (stopping || worker) return;
    let started;
    try {
        started = new Worker(path.join(__dirname, 'worker.js'), { workerData: { storageDir } });
    } catch (error) {
        console.error('Insights worker could not be started:', error.message);
        scheduleRestart();
        return;
    }
    worker = started;
    const startedAt = Date.now();

    started.on('message', (message) => {
        if (!message || message.type !== 'answer') return;
        const pending = pendingAsks.get(message.id);
        if (!pending) return; // answered after its timeout
        pendingAsks.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) {
            pending.resolve(message.result);
        } else {
            const error = new Error(message.error || 'failed');
            if (message.code) error.code = message.code;
            pending.reject(error);
        }
    });
    started.on('error', (error) => {
        console.error('Insights worker error:', error && error.stack ? error.stack : error);
    });
    started.on('exit', (code) => {
        if (worker === started) worker = null;
        failPendingAsks('insights worker stopped');
        if (stopping) return;
        // A worker that ran for a while starts again quickly; one that keeps
        // failing straight away is tried less and less often.
        if (Date.now() - startedAt > RESTART_MAX_MS) restartDelay = RESTART_MIN_MS;
        console.error(`Insights worker stopped unexpectedly (code ${code}); starting it again in ${restartDelay / 1000} s. The spool keeps what arrives.`);
        scheduleRestart();
    });
}

function scheduleRestart() {
    if (stopping || restartTimer) return;
    restartTimer = setTimeout(() => {
        restartTimer = null;
        startWorker();
    }, restartDelay);
    restartTimer.unref();
    restartDelay = Math.min(restartDelay * 2, RESTART_MAX_MS);
}

// Tells the worker that something was appended, at most five times a second.
function poke() {
    if (pokeTimer || !worker) return;
    pokeTimer = setTimeout(() => {
        pokeTimer = null;
        if (worker) worker.postMessage({ type: 'poke' });
    }, POKE_GAP_MS);
    pokeTimer.unref();
}

// Asks the worker a question and resolves with its answer. Rejects when the
// worker is not running, answers with an error, or takes longer than timeoutMs.
// The questions are the keys of `asks` in worker.js.
function ask(type, params = {}, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        if (!worker) return reject(new Error('insights worker is not running'));
        const id = ++nextAskId;
        const timer = setTimeout(() => {
            pendingAsks.delete(id);
            reject(new Error(`no answer within ${timeoutMs} ms`));
        }, timeoutMs);
        pendingAsks.set(id, { resolve, reject, timer });
        try {
            worker.postMessage({ type: 'ask', id, ask: type, params });
        } catch (error) {
            pendingAsks.delete(id);
            clearTimeout(timer);
            reject(error);
        }
    });
}

// Registers the routes and starts the worker. Returns true when that worked.
// options: { storageDir, requireApiKey, requireAdmin, clientIp, rateLimit }
function mount(app, options) {
    try {
        storageDir = options.storageDir;
        spool = createSpool(storageDir, console);
        routes.register(app, { ...options, spool, ask, poke, log: console });
        admin.register(app, { ...options, spool, ask, poke, log: console });
        startWorker();
        console.log(`Insights store enabled (spool: ${spool.dir})`);
        return true;
    } catch (error) {
        console.error('Insights store could not be set up; the rest of the server is not affected:', error);
        return false;
    }
}

// Appends a record from an old route. Never throws and never rejects.
function appendLegacy(what, build) {
    try {
        if (!spool) return;
        const records = build();
        for (const record of records) {
            spool.append(record).catch((error) => console.error(`Insights: ${what} was not added to the spool:`, error.message));
        }
        if (records.length > 0) poke();
    } catch (error) {
        console.error(`Insights: ${what} was not added to the spool:`, error.message);
    }
}

const cut = (value, max) => (typeof value === 'string' ? value.slice(0, max) : undefined);
const plainObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

// From POST /api/analytics/session/start, with the session it stored.
function legacySessionStart(session) {
    appendLegacy('legacy session', () => [{
        type: 'legacy_session',
        legacy: true,
        received_at: Date.now(),
        session: {
            id: cut(session.id, 100),
            start_time: cut(session.start_time, 40),
            client_version: cut(session.client_version, 50),
            platform: cut(session.platform, 50),
            metadata: plainObject(session.metadata)
        }
    }]);
}

// From POST /api/analytics/batch and /api/analytics/event, with the events they stored.
function legacyEvents(events) {
    appendLegacy('legacy events', () => {
        const receivedAt = Date.now();
        const records = [];
        const list = Array.isArray(events) ? events : [];
        for (let i = 0; i < list.length; i += LEGACY_EVENTS_PER_LINE) {
            records.push({
                type: 'legacy_events',
                legacy: true,
                received_at: receivedAt,
                events: list.slice(i, i + LEGACY_EVENTS_PER_LINE).map((event) => ({
                    id: cut(event.id, 100),
                    session_id: cut(event.session_id, 100) || 'anonymous',
                    event_name: cut(event.event_name, 200),
                    properties: plainObject(event.properties),
                    timestamp: cut(event.timestamp, 40),
                    client_version: cut(event.client_version, 50),
                    platform: cut(event.platform, 50)
                }))
            });
        }
        return records;
    });
}

// From POST /api/crashes after it saved the report: the metadata it stored,
// the `metadata` object the game sent, and where the archive was written.
function legacyCrash(crashMetadata, clientMetadata, crashPath) {
    appendLegacy('legacy crash', () => {
        const relative = path.relative(storageDir, crashPath);
        const sent = plainObject(clientMetadata);
        return [{
            type: 'legacy_crash',
            legacy: true,
            received_at: Date.now(),
            crash_id: cut(crashMetadata.id, 128),
            // Inside the storage folder the path is kept relative, so it survives a moved volume.
            file: relative.startsWith('..') || path.isAbsolute(relative) ? crashPath : relative.split(path.sep).join('/'),
            // Only what the game said. The old route's own `platform` is not used.
            platform: typeof sent.platform === 'string' && sent.platform !== '' ? sent.platform.slice(0, 50) : null,
            metadata: crashMetadata
        }];
    });
}

// Stops the worker (it closes the database first). Resolves when it has
// stopped, or after two seconds.
function stop() {
    stopping = true;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    failPendingAsks('insights is stopping');
    const running = worker;
    if (!running) return Promise.resolve();
    return new Promise((resolve) => {
        const giveUp = setTimeout(() => {
            running.terminate().then(resolve, resolve);
        }, 2000);
        giveUp.unref();
        running.once('exit', () => {
            clearTimeout(giveUp);
            resolve();
        });
        try {
            running.postMessage({ type: 'stop' });
        } catch (error) {
            clearTimeout(giveUp);
            resolve();
        }
    });
}

module.exports = { mount, stop, ask, legacySessionStart, legacyEvents, legacyCrash, hasSession: admin.hasSession,
    isDashboardRequest: admin.isDashboardRequest };
