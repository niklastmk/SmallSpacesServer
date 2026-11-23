// The dashboard's questions to the database. Runs in the worker thread.
//
// Every other file in this folder (except common.js) exports
//   { cards:   { 'section.name': (q) => data | { data, meta } },
//     actions: { 'section.name': (q, body) => result } }
// and is picked up here by name. A card answers GET /api/admin/v2/q/<name>,
// an action POST /api/admin/v2/do/<name>. `q` is described in common.js.
// See README.md in this folder.
const fs = require('fs');
const path = require('path');
const common = require('./common');

const CACHE_MS = 20 * 1000;
const CACHE_MAX = 400;

const cards = {};
const actions = {};
const loadErrors = [];
for (const name of fs.readdirSync(__dirname).sort()) {
    // A file whose name starts with an underscore holds helpers shared by sections; they require it themselves.
    if (!name.endsWith('.js') || name === 'index.js' || name === 'common.js' || name.startsWith('_')) continue;
    try {
        const section = require(path.join(__dirname, name));
        for (const [key, fn] of Object.entries(section.cards || {})) {
            if (cards[key]) throw new Error(`card ${key} is defined twice`);
            cards[key] = fn;
        }
        for (const [key, fn] of Object.entries(section.actions || {})) {
            if (actions[key]) throw new Error(`action ${key} is defined twice`);
            actions[key] = fn;
        }
    } catch (error) {
        // One broken section must not take the others with it.
        loadErrors.push(`${name}: ${String((error && error.message) || error)}`);
        console.error('[insights] query section could not be loaded:', name, error);
    }
}

const cache = new Map(); // key -> { at, answer }

function cardAnswer(db, storageDir, message) {
    const name = String(message.card || '');
    const fn = Object.prototype.hasOwnProperty.call(cards, name) ? cards[name] : null;
    if (!fn) {
        const error = new Error(`unknown card ${JSON.stringify(name)}`);
        error.code = 'unknown_card';
        throw error;
    }
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    const key = `${name}?${JSON.stringify(Object.keys(params).sort().map((k) => [k, params[k]]))}`;
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_MS) return hit.answer;

    const q = common.makeContext(db, storageDir, params, now);
    const result = fn(q);
    const wrapped = result && typeof result === 'object' && !Array.isArray(result) && Object.prototype.hasOwnProperty.call(result, 'data')
        ? result : { data: result };
    const meta = {
        collected_since: q.tracking.since,
        first_build: q.tracking.first_build,
        coverage: null,
        collecting: null,
        ...(wrapped.meta || {})
    };
    const answer = { data: wrapped.data === undefined ? null : wrapped.data, meta, generated_at: now };
    // A card that is polled for what is new (events.live) returns cache: false.
    if (wrapped.cache !== false) {
        if (cache.size >= CACHE_MAX) cache.clear();
        cache.set(key, { at: now, answer });
    }
    return answer;
}

function actionAnswer(db, storageDir, message) {
    const name = String(message.action || '');
    const fn = Object.prototype.hasOwnProperty.call(actions, name) ? actions[name] : null;
    if (!fn) {
        const error = new Error(`unknown action ${JSON.stringify(name)}`);
        error.code = 'unknown_action';
        throw error;
    }
    common.forgetShared();
    const q = common.makeContext(db, storageDir, {}, Date.now());
    const body = message.body && typeof message.body === 'object' ? message.body : {};
    const result = db.transaction(() => fn(q, body));
    cache.clear();
    common.forgetShared();
    return { ok: true, ...(result && typeof result === 'object' ? result : {}) };
}

// What the frame of every page needs: builds, when tracking began, the count
// of new crash issues and the event names.
function frame(db) {
    const now = Date.now();
    const builds = common.listBuilds(db);
    const tracking = common.trackingStart(db);
    const fresh = db.get(`SELECT COUNT(*) AS n FROM crash_groups WHERE status = 'new' AND first_seen >= ?`, now - 7 * common.DAY);
    return {
        now,
        builds: builds.map((build) => ({ name: build.name, released_at: build.released_at, note: build.note, marker: build.marker })),
        newest_build: builds.length > 0 ? builds[0].name : null,
        tracking_since: tracking.since,
        first_tracked_build: tracking.first_build,
        new_issues: Number(fresh.n),
        events: Object.keys(common.makeContext(db, '', {}, now).registry.events || {}),
        query_sections_failed: loadErrors
    };
}

// The asks the worker registers. `need` gives the open database or throws.
function asks(need, storageDir) {
    return {
        card: (message) => cardAnswer(need(), storageDir, message),
        action: (message) => actionAnswer(need(), storageDir, message),
        frame: () => frame(need()),
        // The names of everything that can be asked, for the check script.
        list: () => ({ cards: Object.keys(cards).sort(), actions: Object.keys(actions).sort(), failed: loadErrors }),
        // Where a stored crash archive is, for the download route.
        crash_file: (message) => {
            const id = Number(String(message.id || '').replace(/^R-/i, ''));
            if (!Number.isInteger(id)) return null;
            const row = need().get('SELECT id, crash_guid, file FROM crashes WHERE id = ?', id);
            return row ? { id: Number(row.id), crash_guid: row.crash_guid, file: row.file } : null;
        }
    };
}

module.exports = { asks, cards, actions, loadErrors };
