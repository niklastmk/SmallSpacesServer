// The one-time import of what the old routes stored in files, into the
// insights database. Runs in the worker thread: worker.js calls step() at the
// start of every pass, and each call does a small, bounded piece of work, so
// storing what the game sends is never held up for more than a moment.
//
//   crashes_metadata.json      a JSON list
//   analytics/sessions.json    a JSON list, the history from before the logs (read-only)
//   analytics/sessions.ndjson  one JSON object per line
//   analytics/events.json      a JSON list (read-only)
//   analytics/events.ndjson    one JSON object per line
//
// The old files are only read. They are never changed or deleted. Since the old
// dashboard was removed nothing writes them either: what old game versions send
// goes to the spool alone (old-game-routes.js). What follows about copied lines
// is about the days in between, when the old routes wrote both.
//
// Progress is the `import` row of the meta table: per file a byte offset and
// counters, written in the same transaction as the rows of that step. A stop
// at any moment therefore loses nothing and stores nothing twice.
//
// Where the import ends (the seam). Since the insights store exists, the old
// routes copy every new line into the spool as well, so only what was written
// before that may be imported.
//   - Crash reports are unique by their id and sessions by theirs: a report or
//     session that is already stored is left alone, so they need no seam. The
//     session log is read up to its size at the first start.
//   - Old events have no id in the database. events.ndjson is read up to the
//     first line that was copied to the spool, found by the id the old route
//     gave it: the first `legacy_events` record in the spool names it, and the
//     line with that id is looked up in the log. Lines before it were never
//     copied, lines from it on all were. Without such a record (the usual
//     case: the import starts with the store) the log is read up to its size
//     at the first start; the spool is looked at again a few seconds later to
//     catch a line that was being copied at that moment.
//   - When the database already holds copied events but the spool no longer
//     has the first of them (its file was deleted after seven days), or the
//     log no longer holds that line, the seam cannot be found. events.ndjson
//     is then not imported at all, and the health view says so.
//
// Which copy wins. A crash report or session that came through the old route
// while the store existed is in the spool with more than the old file kept
// (the platform the game sent). So the import reads no file before everything
// that waited in the spool at its first step is stored, and it leaves out
// crash reports uploaded after it began: the spool has those.
//
// Times. An old session carries the server's time of its start and is stored
// with it, as a live one is. An old event carries the game's clock (or the
// server's, from the single-event route) and nothing says when it arrived, so
// that time is used when it is believable: not before 2020 and not after the
// import began. Otherwise the event gets the time of the last believable line
// before it. An old crash is received at its upload date; when it happened is
// the minidump's time when that is within 90 days before the upload, as for a
// live one.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const spool = require('./spool');
const retention = require('./retention');

const STATE_KEY = 'import';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const FLOOR_MS = Date.UTC(2020, 0, 1);  // no old record is older than this
const AHEAD_MS = 10 * MINUTE;
const SETTLE_MS = 3000;                 // a line being copied at the first start is in the spool by then
const STEP_MS = 40;                     // work per step
const GROUP_SPAN_MS = 23 * HOUR;
const EVENTS_PER_FLUSH = 200;
const SCAN_BYTES = 16 * 1024 * 1024;    // bytes looked through per step when skipping or searching
const HEAD_BYTES = 4096;
const RETRY_MS = 2000;
const MAX_RETRIES = 5;
const PAUSE_MIN_MS = 5000;
const PAUSE_MAX_MS = 5 * MINUTE;
const MIRROR_START = Buffer.from('{"type":"legacy_events"');
const MAX_MARKERS = 8;

// The bytes read per step, and the longest entry that is still imported. An
// entry longer than this is skipped and counted. The environment variable is
// for scripts/check-insights-import.js, which wants many small steps.
const READ_BYTES = Math.max(1024, Number(process.env.INSIGHTS_IMPORT_READ_BYTES) || 1024 * 1024);

const FILES = [
    { name: 'crashes_metadata.json', path: 'crashes_metadata.json', kind: 'list', what: 'crashes', rewritten: true },
    { name: 'sessions.json', path: path.join('analytics', 'sessions.json'), kind: 'list', what: 'sessions' },
    { name: 'sessions.ndjson', path: path.join('analytics', 'sessions.ndjson'), kind: 'lines', what: 'sessions' },
    { name: 'events.json', path: path.join('analytics', 'events.json'), kind: 'list', what: 'events' },
    { name: 'events.ndjson', path: path.join('analytics', 'events.ndjson'), kind: 'lines', what: 'events', seam: true }
];
const ACTIVE = ['waiting', 'seam', 'locating', 'running'];

let options = null;     // { storageDir, store: { session, events, crash }, log, logError }
let state = null;       // the parsed `import` row
let loadedFrom = null;  // the database object `state` was read from
let pausedUntil = 0;
let failures = 0;
let lastLoggedError = '';
let locateCursor = null; // { candidate, at }: where the search for the seam line is (memory only)
let longestStep = 0;     // ms, since this worker started: how long the import held up a pass at most

function init(given) {
    options = given;
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const cut = (value, max) => (typeof value === 'string' ? value.slice(0, max) : undefined);
const active = (progress) => Boolean(progress) && ACTIVE.includes(progress.state);

function parse(text) {
    try {
        return JSON.parse(text);
    } catch (error) {
        return undefined;
    }
}

// Errors that say the database itself is in trouble. The step is then given
// up and tried again later; any other error is one bad entry, which is counted.
function databaseTrouble(error) {
    const code = error && typeof error.errcode === 'number' ? error.errcode & 0xFF : null;
    return code !== null && [5, 6, 7, 8, 10, 11, 13, 14, 26].includes(code);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function readAt(fd, offset, length) {
    const buffer = Buffer.allocUnsafe(Math.max(0, length));
    const read = length > 0 ? fs.readSync(fd, buffer, 0, length, offset) : 0;
    return read < buffer.length ? buffer.subarray(0, read) : buffer;
}

function headHash(file, size) {
    const length = Math.min(size, HEAD_BYTES);
    const fd = fs.openSync(file, 'r');
    try {
        return crypto.createHash('sha1').update(readAt(fd, 0, length)).digest('hex');
    } finally {
        fs.closeSync(fd);
    }
}

// Whole lines from `offset`, never past `limit`. Returns
// { items: [{ text, end } | { oversized, end }], next, end, skip }.
function readLines(fd, offset, limit, fileSize) {
    const length = Math.min(limit - offset, READ_BYTES);
    if (length <= 0) return { items: [], next: offset, end: true };
    const chunk = readAt(fd, offset, length);
    const items = [];
    let start = 0;
    for (;;) {
        const lineEnd = chunk.indexOf(0x0A, start);
        if (lineEnd === -1) break;
        if (lineEnd > start) items.push({ text: chunk.toString('utf8', start, lineEnd), end: offset + lineEnd + 1 });
        start = lineEnd + 1;
    }
    if (start > 0) return { items, next: offset + start, end: offset + start >= limit };

    // No line end in this piece.
    if (offset + chunk.length >= limit) {
        // The rest up to the limit is a line without its end. When the file goes
        // on behind the limit, it is a line of the running server, which is in the
        // spool. Otherwise it is what a stopped process left half-written.
        if (limit < fileSize) return { items: [], next: limit, end: true };
        return { items: [{ text: chunk.toString('utf8'), end: limit }], next: limit, end: true };
    }
    // A line longer than one read: skipped without loading it.
    return { items: [], next: offset, end: false, skip: { at: offset + chunk.length } };
}

function skipLine(fd, skip, limit) {
    let at = skip.at;
    let scanned = 0;
    while (at < limit && scanned < SCAN_BYTES) {
        const chunk = readAt(fd, at, Math.min(limit - at, READ_BYTES));
        if (chunk.length === 0) break;
        const lineEnd = chunk.indexOf(0x0A);
        if (lineEnd !== -1) return { items: [{ oversized: true, end: at + lineEnd + 1 }], next: at + lineEnd + 1, end: at + lineEnd + 1 >= limit };
        at += chunk.length;
        scanned += chunk.length;
    }
    if (at >= limit) return { items: [{ oversized: true, end: limit }], next: limit, end: true };
    return { items: [], next: null, end: false, skip: { at } };
}

const isSpace = (byte) => byte === 0x20 || byte === 0x0A || byte === 0x0D || byte === 0x09;

// Walks over one JSON value. `value` keeps where the walk is, so it can go on
// in the next piece. Returns the index behind the value, or -1 when the piece
// ends first.
function valueEnd(chunk, index, value) {
    let i = index;
    if (!value.started) {
        value.started = true;
        const first = chunk[i];
        if (first === 0x7B || first === 0x5B) {
            value.depth = 1;
            i++;
        } else if (first === 0x22) {
            value.text = true;
            i++;
        } else {
            value.plain = true;
        }
    }
    if (value.plain) {
        for (; i < chunk.length; i++) {
            const byte = chunk[i];
            if (byte === 0x2C || byte === 0x5D || isSpace(byte)) return i;
        }
        return -1;
    }
    for (; i < chunk.length; i++) {
        const byte = chunk[i];
        if (value.text) {
            if (value.escape) {
                value.escape = false;
            } else if (byte === 0x5C) {
                value.escape = true;
            } else if (byte === 0x22) {
                value.text = false;
                if (!value.depth) return i + 1;
            }
        } else if (byte === 0x22) {
            value.text = true;
        } else if (byte === 0x7B || byte === 0x5B) {
            value.depth++;
        } else if (byte === 0x7D || byte === 0x5D) {
            value.depth--;
            if (value.depth === 0) return i + 1;
        }
    }
    return -1;
}

// The entries of a JSON list from `offset` (0, or just behind an entry).
// Returns { items, next, end, skip, notList, cutShort }. cutShort: 'entry'
// when the file ends inside an entry, 'list' when the list is never closed.
function readEntries(fd, offset, size) {
    let position = offset;
    if (position === 0) {
        const head = readAt(fd, 0, Math.min(size, HEAD_BYTES));
        let i = head.length >= 3 && head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF ? 3 : 0;
        while (i < head.length && isSpace(head[i])) i++;
        if (i >= head.length || head[i] !== 0x5B) return { items: [], next: 0, end: true, notList: true };
        position = i + 1;
    }
    const chunk = readAt(fd, position, Math.min(size - position, READ_BYTES));
    const items = [];
    let i = 0;
    for (;;) {
        while (i < chunk.length && (isSpace(chunk[i]) || chunk[i] === 0x2C)) i++;
        if (i >= chunk.length) {
            if (position + chunk.length >= size) return { items, next: position + i, end: true, cutShort: 'list' };
            return { items, next: position + i, end: false };
        }
        if (chunk[i] === 0x5D) return { items, next: position + i + 1, end: true };
        const value = {};
        const stop = valueEnd(chunk, i, value);
        if (stop !== -1) {
            items.push({ text: chunk.toString('utf8', i, stop), end: position + stop });
            i = stop;
            continue;
        }
        // The entry does not end in this piece.
        if (position + chunk.length >= size) return { items, next: position + i, end: true, cutShort: 'entry' };
        if (i > 0) return { items, next: position + i, end: false };
        // It is longer than one read: skipped without loading it.
        return { items: [], next: position, end: false, skip: { at: position + chunk.length, value } };
    }
}

function skipEntry(fd, skip, size) {
    let at = skip.at;
    let scanned = 0;
    while (at < size && scanned < SCAN_BYTES) {
        const chunk = readAt(fd, at, Math.min(size - at, READ_BYTES));
        if (chunk.length === 0) break;
        const stop = valueEnd(chunk, 0, skip.value);
        if (stop !== -1) return { items: [{ oversized: true, end: at + stop }], next: at + stop, end: false };
        at += chunk.length;
        scanned += chunk.length;
    }
    if (at >= size) return { items: [{ oversized: true, end: size }], next: size, end: true, cutShort: 'list' };
    return { items: [], next: null, end: false, skip: { at, value: skip.value } };
}

// ---------------------------------------------------------------------------
// The seam of events.ndjson
// ---------------------------------------------------------------------------

function lineAt(fd, offset, size) {
    let length = 64 * 1024;
    for (;;) {
        const chunk = readAt(fd, offset, Math.min(size - offset, length));
        const lineEnd = chunk.indexOf(0x0A);
        if (lineEnd !== -1) return chunk.toString('utf8', 0, lineEnd);
        if (offset + chunk.length >= size || length >= 64 * 1024 * 1024) return null; // still being written
        length *= 4;
    }
}

// The first events the old routes copied into the spool: null when there are
// none, otherwise { file, ids, first: { session_id, stamp, received_at } }.
function firstMirroredEvents() {
    const ids = [];
    let first = null;
    let firstFile = null;
    let records = 0;
    const done = () => (first ? { file: firstFile, ids, first } : null);
    for (const entry of spool.listSpoolFiles(spool.spoolDir(options.storageDir))) {
        const fd = fs.openSync(entry.file, 'r');
        try {
            let position = 0;
            while (position < entry.size) {
                const chunk = readAt(fd, position, Math.min(entry.size - position, 4 * 1024 * 1024));
                if (chunk.length === 0) break;
                let from = 0;
                for (;;) {
                    const hit = chunk.indexOf(MIRROR_START, from);
                    if (hit === -1) break;
                    from = hit + 1;
                    const absolute = position + hit;
                    const before = hit > 0 ? chunk[hit - 1] : (absolute > 0 ? readAt(fd, absolute - 1, 1)[0] : 0x0A);
                    if (before !== 0x0A) continue; // inside a line, not its start
                    const text = lineAt(fd, absolute, entry.size);
                    if (text === null) return done();
                    const record = parse(text);
                    if (!isObject(record) || record.type !== 'legacy_events' || !Array.isArray(record.events)) continue;
                    const events = record.events.filter((event) => isObject(event) && typeof event.event_name === 'string' && event.event_name !== '');
                    if (events.length === 0) continue;
                    if (!first) {
                        const stamp = typeof events[0].timestamp === 'string' ? Date.parse(events[0].timestamp) : NaN;
                        first = {
                            session_id: (typeof events[0].session_id === 'string' && events[0].session_id !== '' ? events[0].session_id.slice(0, 100) : null) || 'anonymous',
                            stamp: Number.isFinite(stamp) ? stamp : null,
                            received_at: typeof record.received_at === 'number' ? record.received_at : null
                        };
                        firstFile = entry.name;
                    }
                    for (const event of events) {
                        if (typeof event.id === 'string' && event.id !== '' && ids.length < MAX_MARKERS) ids.push(event.id);
                    }
                    if (++records >= 3 || ids.length >= MAX_MARKERS) return done();
                }
                if (position + chunk.length >= entry.size) break;
                position += chunk.length - (MIRROR_START.length - 1);
            }
        } finally {
            fs.closeSync(fd);
        }
    }
    return done();
}

// Whether the spool still holds the first copied events: the first old event
// the database held before the import began must be the one the spool starts with.
function seamIsKnown() {
    const stored = state.mirrored_first;
    if (!stored) return true;
    const seam = state.seam;
    if (!seam || !seam.first) return false;
    return stored.session_id === seam.first.session_id && (stored.t === seam.first.stamp || stored.t === seam.first.received_at);
}

// Decides how events.ndjson is read, once the spool has been looked at.
function settleSeam(progress, now) {
    if (!state.seam) state.seam = firstMirroredEvents();
    state.seam_settled_at = now;
    if (!seamIsKnown()) {
        progress.state = 'blocked';
        progress.note = 'not imported: the database already holds events copied from the old routes, and the spool file with the first of them is gone, so the line where the copies begin cannot be found';
    } else if (state.seam && state.seam.ids.length > 0) {
        progress.state = 'locating';
        locateCursor = null;
    } else {
        progress.state = 'waiting';
    }
}

// Looks for the line of the first copied event in events.ndjson and ends the
// import in front of it. A bounded piece per call.
function locateSeam(fd, progress, size) {
    const ids = state.seam.ids;
    if (!locateCursor) locateCursor = { candidate: 0, at: 0 };
    const pattern = Buffer.from(`{"id":${JSON.stringify(ids[locateCursor.candidate])},`);
    let scanned = 0;
    while (locateCursor.at < size && scanned < SCAN_BYTES) {
        const at = locateCursor.at;
        const chunk = readAt(fd, at, Math.min(size - at, 4 * 1024 * 1024));
        if (chunk.length === 0) break;
        let from = 0;
        for (;;) {
            const hit = chunk.indexOf(pattern, from);
            if (hit === -1) break;
            from = hit + 1;
            const before = hit > 0 ? chunk[hit - 1] : (at > 0 ? readAt(fd, at - 1, 1)[0] : 0x0A);
            if (before !== 0x0A) continue;
            progress.limit = Math.min(progress.limit, at + hit);
            progress.seam_at = at + hit;
            progress.state = 'waiting';
            locateCursor = null;
            return;
        }
        scanned += chunk.length;
        if (at + chunk.length >= size) {
            locateCursor.at = size;
            break;
        }
        locateCursor.at = at + chunk.length - (pattern.length - 1);
    }
    if (locateCursor.at < size) return; // more to look through in the next step
    if (locateCursor.candidate + 1 < ids.length) {
        locateCursor = { candidate: locateCursor.candidate + 1, at: 0 };
        return;
    }
    locateCursor = null;
    progress.state = 'blocked';
    progress.note = 'not imported: the first events copied to the spool are no longer in the log (it was rewritten), so the line where the copies begin cannot be found';
}

// ---------------------------------------------------------------------------
// Storing
// ---------------------------------------------------------------------------

// The time of an old record: its own when believable, otherwise that of the
// last believable record before it in the file.
function believable(text) {
    const stamp = typeof text === 'string' ? Date.parse(text) : NaN;
    return Number.isFinite(stamp) && stamp >= FLOOR_MS && stamp <= state.started_at + AHEAD_MS ? stamp : null;
}
function timeOf(text, progress) {
    const stamp = believable(text);
    if (stamp !== null) {
        progress.last_t = stamp;
        return stamp;
    }
    progress.times_replaced = (progress.times_replaced || 0) + 1;
    return progress.last_t || state.started_at;
}

// Runs one store call; an entry that cannot be stored is counted and left out.
function tryStore(db, progress, count, fn) {
    try {
        db.savepoint(fn);
        return true;
    } catch (error) {
        if (databaseTrouble(error)) throw error;
        progress.failed = (progress.failed || 0) + count;
        progress.last_error = String((error && error.message) || error).slice(0, 200);
        return false;
    }
}

function sessionHandler(db, progress) {
    const end = (id, endTime) => {
        const t = believable(endTime);
        if (t === null) return;
        db.run('UPDATE sessions SET last_seen_at = MAX(last_seen_at, ?) WHERE session_id = ? AND legacy = 1', t, id.slice(0, 100));
    };
    return {
        add(text) {
            const record = parse(text);
            if (!isObject(record)) {
                progress.unreadable++;
                return;
            }
            // A line of the session log saying a session ended.
            if (typeof record.ended === 'string' && record.ended !== '') {
                end(record.ended, record.end_time);
                progress.ends = (progress.ends || 0) + 1;
                return;
            }
            if (typeof record.id !== 'string' || record.id === '') {
                progress.unreadable++;
                return;
            }
            const started = timeOf(record.start_time, progress);
            const stored = tryStore(db, progress, 1, () => {
                options.store.session({
                    type: 'legacy_session', legacy: true, received_at: started,
                    session: { id: cut(record.id, 100), client_version: cut(record.client_version, 50), platform: cut(record.platform, 50) }
                });
                // The history holds the end of a session with it; a live old
                // session never reports one. It moves the last-seen time only.
                end(record.id, record.end_time);
            });
            if (stored) progress.imported++;
        },
        flush() {}
    };
}

function eventHandler(db, progress) {
    let group = null; // { received_at, events }
    let waiting = 0;
    const groups = [];
    const flush = () => {
        for (const entry of groups) {
            const stored = tryStore(db, progress, entry.events.length, () => {
                options.store.events({ type: 'legacy_events', legacy: true, received_at: entry.received_at, events: entry.events });
            });
            if (stored) progress.imported += entry.events.length;
        }
        groups.length = 0;
        group = null;
        waiting = 0;
    };
    return {
        add(text) {
            const record = parse(text);
            if (!isObject(record) || typeof record.event_name !== 'string' || record.event_name === '') {
                progress.unreadable++;
                return;
            }
            const event = {
                session_id: cut(record.session_id, 100) || 'anonymous',
                event_name: cut(record.event_name, 200),
                properties: isObject(record.properties) ? record.properties : {},
                timestamp: cut(record.timestamp, 40),
                client_version: cut(record.client_version, 50),
                platform: cut(record.platform, 50)
            };
            const own = believable(event.timestamp);
            const t = timeOf(event.timestamp, progress);
            if (own === null) {
                // The store function then uses the record's time for it.
                event.timestamp = undefined;
                groups.push({ received_at: t, events: [event] });
                group = null;
            } else if (group && Math.abs(t - group.received_at) < GROUP_SPAN_MS) {
                group.events.push(event);
            } else {
                group = { received_at: t, events: [event] };
                groups.push(group);
            }
            if (++waiting >= EVENTS_PER_FLUSH) flush();
        },
        flush
    };
}

function crashHandler(db, progress) {
    return {
        add(text) {
            const entry = parse(text);
            if (!isObject(entry) || typeof entry.id !== 'string' || entry.id === '') {
                progress.unreadable++;
                return;
            }
            const guid = entry.id.slice(0, 128);
            // The upload date is the server's clock; without it, the minidump's time.
            const received = believable(entry.upload_date) !== null
                ? timeOf(entry.upload_date, progress)
                : (believable(entry.crash_context && entry.crash_context.crash_time) || timeOf(null, progress));
            if (retention.refusesCrash(db, received)) {
                progress.refused = (progress.refused || 0) + 1;
                return;
            }
            // Uploaded after the import began: the old route put it into the spool too.
            const uploaded = typeof entry.upload_date === 'string' ? Date.parse(entry.upload_date) : NaN;
            if ((Number.isFinite(uploaded) && uploaded > state.started_at) || db.get('SELECT 1 AS found FROM crashes WHERE crash_guid = ?', guid)) {
                progress.already = (progress.already || 0) + 1;
                return;
            }
            const stored = typeof entry.stored_filename === 'string' && /^[^/\\]{1,300}$/.test(entry.stored_filename)
                ? `crashes/${entry.stored_filename}` : null;
            const ok = tryStore(db, progress, 1, () => {
                // No platform: the old route stored "Windows" for nearly every report
                // (TD-SERVER-522) and did not keep what the game had sent.
                options.store.crash({
                    type: 'legacy_crash', legacy: true, received_at: received, crash_id: guid, file: stored, platform: null, metadata: entry
                }, { status: 'open' });
            });
            if (ok) progress.imported++;
        },
        flush() {}
    };
}

const HANDLERS = { sessions: sessionHandler, events: eventHandler, crashes: crashHandler };

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

const save = (db) => retention.setJson(db, STATE_KEY, state);

function load(db) {
    if (loadedFrom === db && state) return;
    state = retention.getJson(db, STATE_KEY);
    loadedFrom = db;
    locateCursor = null;
}

function forget() {
    state = null;
    loadedFrom = null;
}

const counted = (progress) => (progress.imported || 0) + (progress.unreadable || 0) + (progress.oversized || 0)
    + (progress.already || 0) + (progress.refused || 0) + (progress.failed || 0) + (progress.ends || 0);

function describeProblems(def, progress) {
    const parts = [];
    if (progress.unreadable) parts.push(`${progress.unreadable} unreadable ${def.kind === 'lines' ? 'lines' : 'entries'} skipped`);
    if (progress.oversized) parts.push(`${progress.oversized} over ${READ_BYTES} bytes skipped`);
    if (progress.failed) parts.push(`${progress.failed} could not be stored (${progress.last_error || 'no reason recorded'})`);
    if (progress.refused) parts.push(`${progress.refused} crash reports left out because crash reports were deleted from the dashboard`);
    if (progress.note) parts.push(progress.note);
    return parts;
}

// Ends the import of one file. Says one line when something was left out.
function finishFile(def, progress, fileState, note, now) {
    progress.state = fileState;
    if (note) progress.note = note;
    progress.finished_at = now;
    delete progress.skip;
    const problems = describeProblems(def, progress);
    if (problems.length > 0) options.logError(`import: ${def.name}: ${problems.join('; ')}`);
}

function finishIfDone(now) {
    if (FILES.some((def) => active(state.files[def.name]))) return;
    const totals = { sessions: 0, events: 0, crashes: 0 };
    let anything = 0;
    for (const def of FILES) {
        const progress = state.files[def.name];
        totals[def.what] += progress.imported || 0;
        anything += counted(progress) + (['done', 'missing'].includes(progress.state) ? 0 : 1);
    }
    state.state = anything > 0 ? 'done' : 'none';
    state.finished_at = now;
    delete state.seam;
    options.log(state.state === 'none'
        ? 'import: the old files hold nothing to import'
        : `import: the old files are imported: ${totals.sessions} sessions, ${totals.events} events, ${totals.crashes} crash reports, in ${((now - state.started_at) / 1000).toFixed(1)} s`);
}

// The first step: notes what is there, and what the old routes have already
// copied, before this pass stores or deletes anything.
function prepare(db, now) {
    const files = {};
    for (const def of FILES) {
        const file = path.join(options.storageDir, def.path);
        let stat;
        try {
            stat = fs.statSync(file);
        } catch (error) {
            files[def.name] = { state: 'missing', imported: 0, unreadable: 0, oversized: 0 };
            continue;
        }
        if (stat.size === 0) {
            files[def.name] = { state: 'done', offset: 0, size: 0, limit: 0, imported: 0, unreadable: 0, oversized: 0 };
            continue;
        }
        const progress = { state: def.seam ? 'seam' : 'waiting', offset: 0, size: stat.size, limit: stat.size, imported: 0, unreadable: 0, oversized: 0 };
        if (def.rewritten) {
            progress.signature = `${stat.size}:${stat.mtimeMs}`;
        } else {
            progress.head = headHash(file, stat.size);
        }
        files[def.name] = progress;
    }
    const stored = db.get('SELECT session_id, t FROM events WHERE legacy = 1 ORDER BY id LIMIT 1');
    const waiting = {};
    for (const entry of spool.listSpoolFiles(spool.spoolDir(options.storageDir))) waiting[entry.name] = entry.size;
    state = {
        version: 1, state: 'running', started_at: now, finished_at: null, files, spool_first: waiting,
        mirrored_first: stored ? { session_id: stored.session_id, t: Number(stored.t) } : null,
        seam: null
    };
    loadedFrom = db;
    state.seam = firstMirroredEvents();
    finishIfDone(now);
    db.transaction(() => save(db));
    if (state.state === 'running') options.log('import: reading the files of the old routes');
}

// Whether everything that was in the spool at the first step is stored.
function spoolStored(db) {
    if (!state.spool_first) return true;
    for (const [name, size] of Object.entries(state.spool_first)) {
        const row = db.get('SELECT offset FROM spool_offsets WHERE file = ?', name);
        if ((row ? Number(row.offset) : 0) < size && fs.existsSync(path.join(spool.spoolDir(options.storageDir), name))) return false;
    }
    return true;
}

// The file as it is now against what was noted at the first step.
function changed(file, stat, def, progress) {
    if (def.kind === 'lines' ? stat.size < progress.limit : stat.size !== progress.size) return true;
    return headHash(file, progress.size) !== progress.head;
}

// One bounded piece of one file. Returns 'worked', or 'waits' when this file
// has nothing to do right now.
function stepFile(db, def, progress, now) {
    const file = path.join(options.storageDir, def.path);
    let stat;
    try {
        stat = fs.statSync(file);
    } catch (error) {
        db.transaction(() => {
            finishFile(def, progress, 'stopped', `stopped at byte ${progress.offset}: the file is gone`, now);
            finishIfDone(now);
            save(db);
        });
        return 'worked';
    }

    if (def.rewritten) {
        if (progress.retry_at && now < progress.retry_at) return 'waits';
        // The old route rewrites this file on every upload. Its entries are
        // unique by id, so after a change it is simply read again from the start.
        const signature = `${stat.size}:${stat.mtimeMs}`;
        if (signature !== progress.signature) {
            progress.signature = signature;
            progress.offset = 0;
            progress.unreadable = 0;
            progress.oversized = 0;
            progress.already = 0;
            progress.refused = 0;
            progress.failed = 0;
            delete progress.skip;
        }
    } else if (changed(file, stat, def, progress)) {
        db.transaction(() => {
            finishFile(def, progress, 'stopped', `stopped at byte ${progress.offset}: the file was changed after the import began`, now);
            finishIfDone(now);
            save(db);
        });
        return 'worked';
    }

    if (progress.state === 'seam') {
        if (!state.seam && now - state.started_at < SETTLE_MS) return 'waits';
        settleSeam(progress, now);
        db.transaction(() => {
            if (!active(progress)) finishFile(def, progress, progress.state, null, now);
            finishIfDone(now);
            save(db);
        });
        return 'worked';
    }

    const limit = def.kind === 'lines' ? progress.limit : stat.size;
    const fd = fs.openSync(file, 'r');
    let read;
    try {
        if (progress.state === 'locating') {
            locateSeam(fd, progress, stat.size);
            db.transaction(() => {
                if (!active(progress)) finishFile(def, progress, progress.state, null, now);
                finishIfDone(now);
                save(db);
            });
            return 'worked';
        }
        if (progress.skip) {
            read = def.kind === 'lines' ? skipLine(fd, progress.skip, limit) : skipEntry(fd, progress.skip, limit);
        } else {
            read = def.kind === 'lines' ? readLines(fd, progress.offset, limit, stat.size) : readEntries(fd, progress.offset, limit);
        }
    } finally {
        fs.closeSync(fd);
    }

    if (progress.last_t === undefined) {
        // Goes on from the times of the file before it (the history, then its log).
        const earlier = FILES.slice(0, FILES.indexOf(def)).reverse().find((other) => other.what === def.what && state.files[other.name].last_t);
        if (earlier) progress.last_t = state.files[earlier.name].last_t;
    }
    progress.state = 'running';
    const deadline = Date.now() + STEP_MS;
    const handler = HANDLERS[def.what](db, progress);
    db.transaction(() => {
        let whole = true;
        for (let i = 0; i < read.items.length; i++) {
            const item = read.items[i];
            if (item.oversized) progress.oversized++; else handler.add(item.text);
            progress.offset = item.end;
            if ((i & 15) === 15 && i + 1 < read.items.length && Date.now() > deadline) {
                whole = false;
                break;
            }
        }
        handler.flush();
        if (whole) {
            if (read.next !== null) progress.offset = read.next;
            if (read.skip) progress.skip = read.skip; else delete progress.skip;
            if (read.notList) {
                finishFile(def, progress, 'unreadable', 'not imported: the file is not a JSON list', now);
            } else if (read.cutShort && def.rewritten && (progress.retries || 0) < MAX_RETRIES) {
                // Probably read while the old route was rewriting it: look again shortly.
                progress.retries = (progress.retries || 0) + 1;
                progress.retry_at = now + RETRY_MS;
            } else if (read.cutShort) {
                if (read.cutShort === 'entry') progress.unreadable++;
                finishFile(def, progress, 'done', read.cutShort === 'entry' ? 'the file ends in the middle of an entry' : 'the list is not closed', now);
            } else if (read.end) {
                finishFile(def, progress, 'done', null, now);
            }
            if (!read.cutShort) {
                delete progress.retries;
                delete progress.retry_at;
            }
        }
        finishIfDone(now);
        save(db);
    });
    return 'worked';
}

// ---------------------------------------------------------------------------
// For the worker
// ---------------------------------------------------------------------------

// One step of the import. Returns true when there is more to do straight
// away. Never throws: a failed step is logged once and tried again later.
function step(db) {
    if (!options) return false;
    const now = Date.now();
    if (now < pausedUntil) return false;
    try {
        return advance(db, now);
    } finally {
        longestStep = Math.max(longestStep, Date.now() - now);
    }
}

function advance(db, now) {
    try {
        load(db);
        if (!state) {
            prepare(db, now);
            return state.state === 'running';
        }
        if (state.state !== 'running') return false;
        if (state.spool_first) {
            // The worker stores a piece of the spool in every pass; look again in the next.
            if (!spoolStored(db)) return false;
            delete state.spool_first;
            db.transaction(() => save(db));
        }
        for (const def of FILES) {
            const progress = state.files[def.name];
            if (!active(progress)) continue;
            if (stepFile(db, def, progress, now) === 'worked') {
                failures = 0;
                return state.state === 'running';
            }
        }
        return false; // every file left is waiting for something
    } catch (error) {
        forget(); // what is in memory may be ahead of what was saved
        failures++;
        pausedUntil = now + Math.min(PAUSE_MAX_MS, PAUSE_MIN_MS * 2 ** Math.min(failures - 1, 10));
        const message = String((error && error.message) || error).slice(0, 300);
        if (message !== lastLoggedError) {
            lastLoggedError = message;
            options.logError(`import: a step failed (it is tried again, the old files are untouched): ${(error && error.stack) || message}`);
        }
        return false;
    }
}

const running = () => Boolean(state) && state.state === 'running';

// For the health view and the Settings page. `state` is 'none' (nothing to
// import, or not looked yet), 'running' or 'done'.
function status(db) {
    const current = loadedFrom === db && state ? state : retention.getJson(db, STATE_KEY);
    if (!current) return { state: 'none', pending: true, started_at: null, finished_at: null };
    const imported = { sessions: 0, events: 0, crashes: 0 };
    const skipped = { unreadable: 0, oversized: 0, failed: 0, already_stored: 0, deleted_before: 0 };
    const problems = [];
    let bytesDone = 0;
    let bytesTotal = 0;
    const files = FILES.map((def) => {
        const progress = current.files[def.name] || { state: 'missing' };
        const total = progress.state === 'missing' ? 0 : (def.kind === 'lines' ? progress.limit : progress.size) || 0;
        const done = active(progress) ? Math.min(progress.offset || 0, total) : total;
        bytesDone += done;
        bytesTotal += total;
        imported[def.what] += progress.imported || 0;
        skipped.unreadable += progress.unreadable || 0;
        skipped.oversized += progress.oversized || 0;
        skipped.failed += progress.failed || 0;
        skipped.already_stored += progress.already || 0;
        skipped.deleted_before += progress.refused || 0;
        for (const problem of describeProblems(def, progress)) problems.push(`${def.name}: ${problem}`);
        return {
            name: def.name, what: def.what, state: progress.state, bytes_done: done, bytes_total: total,
            imported: progress.imported || 0, unreadable: progress.unreadable || 0, oversized: progress.oversized || 0,
            failed: progress.failed || 0, already_stored: progress.already || 0, session_ends: progress.ends || 0,
            times_replaced: progress.times_replaced || 0, note: progress.note || null
        };
    });
    return {
        state: current.state,
        started_at: current.started_at,
        finished_at: current.finished_at || null,
        progress: current.state === 'running' ? (bytesTotal > 0 ? bytesDone / bytesTotal : 0) : 1,
        bytes_done: bytesDone,
        bytes_total: bytesTotal,
        longest_step_ms: longestStep,
        imported, skipped, files, problems
    };
}

// The dashboard deleted data: the import does not bring it back. `what` is
// 'reports', 'events' or 'everything'. Call inside the action's transaction.
function cancel(db, what, now) {
    if (!options) return false;
    const current = retention.getJson(db, STATE_KEY);
    forget();
    if (!current || current.state !== 'running') return false;
    state = current;
    let stopped = 0;
    for (const def of FILES) {
        const progress = state.files[def.name];
        if (!active(progress)) continue;
        if (what !== 'everything' && !(what === 'reports' && def.what === 'crashes') && !(what === 'events' && def.what === 'events')) continue;
        finishFile(def, progress, 'cancelled', `stopped at byte ${progress.offset || 0}: ${what === 'everything' ? 'everything was' : what === 'reports' ? 'crash reports were' : 'usage events were'} deleted from the dashboard`, now);
        stopped++;
    }
    finishIfDone(now);
    save(db);
    forget(); // read again from the database once the action has committed
    return stopped > 0;
}

module.exports = { init, step, status, running, cancel, STATE_KEY, FILES, READ_BYTES };
