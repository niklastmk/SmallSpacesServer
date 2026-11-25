// Insights: the new store for what the game sends (events, sessions, crashes).
//
// server.js calls mount() once and stop() when the process is asked to end.
// Nothing here can stop the server from starting: every entry point catches its
// own errors and logs them.
//
//   spool.js        append-only day files; the main thread writes, the worker reads
//   routes.js       POST /api/v2/collect, POST /api/v2/crashes, GET /api/admin/v2/health
//   old-game-routes.js  what game versions from before November 2026 call
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
const oldGameRoutes = require('./old-game-routes');

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
// options: { storageDir, requireApiKey, requireAdmin, uploadLimiter, clientIp, rateLimit }
function mount(app, options) {
    try {
        storageDir = options.storageDir;
        spool = createSpool(storageDir, console);
        routes.register(app, { ...options, spool, ask, poke, log: console });
        oldGameRoutes.register(app, { ...options, spool, poke, log: console });
        admin.register(app, { ...options, spool, ask, poke, log: console });
        startWorker();
        console.log(`Insights store enabled (spool: ${spool.dir})`);
        return true;
    } catch (error) {
        console.error('Insights store could not be set up; the rest of the server is not affected:', error);
        return false;
    }
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

module.exports = { mount, stop, ask, hasSession: admin.hasSession, isDashboardRequest: admin.isDashboardRequest };
