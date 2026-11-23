// Settings page: build markers (the release lines on every time chart, and
// the builds the filters offer). Data kept, storage, export and the danger
// area are the maintenance.* cards and actions; signing out is
// POST /api/admin/v2/sign-out.
const { DAY, utcDay, parseDay, compareBuilds } = require('./common');

const NAME = /^[A-Za-z0-9._+-]{1,50}$/; // what the build filter accepts (common.js)
const NOTE_MAX = 200;
const MARKERS_MAX = 500;
const EARLIEST = Date.UTC(2015, 0, 1);

const refuse = (code, message) => Object.assign(new Error(message), { code });

function markerOf(row) {
    return { name: row.name, released_at: Number(row.released_at), released_day: utcDay(Number(row.released_at)), note: row.note || '' };
}
const findMarker = (q, name) => q.db.get('SELECT name, released_at, note FROM build_markers WHERE name = ?', name);

function checkedName(value) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (name === '') throw refuse('invalid', 'Enter the build, for example 1.4.2.');
    if (!NAME.test(name)) throw refuse('invalid', 'A build name is up to 50 letters, digits, dots, dashes, plus signs and underscores.');
    return name;
}
// The release date: `released` as YYYY-MM-DD (the start of that UTC day), or
// `released_at` in milliseconds.
function checkedRelease(q, body) {
    let at = null;
    if (typeof body.released === 'string') {
        at = parseDay(body.released.trim());
        // 2026-02-31 parses as 3 March; a date that does not exist is refused.
        if (at !== null && utcDay(at) !== body.released.trim()) at = null;
    }
    else if (typeof body.released_at === 'number' && Number.isFinite(body.released_at)) at = Math.floor(body.released_at);
    if (at === null) throw refuse('invalid', 'Enter the release date as YYYY-MM-DD.');
    if (at < EARLIEST || at > q.now + 730 * DAY) throw refuse('invalid', 'The release date must be between 2015 and two years from now.');
    return at;
}
function checkedNote(value) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw refuse('invalid', 'The note must be text.');
    const note = value.trim();
    if (note.length > NOTE_MAX) throw refuse('invalid', `The note can have up to ${NOTE_MAX} characters.`);
    return note;
}

// Build markers, newest release first, and the builds that play but have no
// marker yet (their first session stands in for the release date elsewhere).
function buildMarkers(q) {
    const seen = new Map(q.db.all(
        `SELECT s.build AS b, COUNT(*) AS n, MIN(s.started_at) AS first_at FROM sessions s
         WHERE s.legacy = 0 AND s.build IS NOT NULL AND s.build <> '' GROUP BY s.build`)
        .map((row) => [row.b, { sessions: Number(row.n) || 0, first_seen: Number(row.first_at) }]));
    const rows = q.db.all('SELECT name, released_at, note FROM build_markers');
    const markers = rows.map((row) => ({
        ...markerOf(row),
        // Sessions of this build from the new protocol; null when it only ran before tracking.
        sessions: seen.has(row.name) ? seen.get(row.name).sessions : null,
        first_seen: seen.has(row.name) ? seen.get(row.name).first_seen : null
    })).sort((a, b) => b.released_at - a.released_at || compareBuilds(b.name, a.name));
    const marked = new Set(rows.map((row) => row.name));
    const unmarked = [...seen.entries()].filter(([name]) => !marked.has(name))
        .map(([name, facts]) => ({ name, sessions: facts.sessions, first_seen: facts.first_seen }))
        .sort((a, b) => b.first_seen - a.first_seen);
    return { markers, unmarked, max: MARKERS_MAX, note_max: NOTE_MAX };
}

// Body: { name, released: 'YYYY-MM-DD' | released_at: ms, note? }.
function addMarker(q, body) {
    const name = checkedName(body.name);
    const releasedAt = checkedRelease(q, body);
    const note = checkedNote(body.note);
    if (findMarker(q, name)) throw refuse('conflict', `Build ${name} already has a marker.`);
    if (Number(q.db.get('SELECT COUNT(*) AS n FROM build_markers').n) >= MARKERS_MAX) throw refuse('invalid', `There can be up to ${MARKERS_MAX} markers.`);
    q.db.run('INSERT INTO build_markers (name, released_at, note) VALUES (?, ?, ?)', name, releasedAt, note);
    const marker = markerOf({ name, released_at: releasedAt, note });
    q.log('settings.marker_add', marker);
    return { marker };
}

// Body: { name, new_name?, released? | released_at?, note? }. What is left out stays.
function editMarker(q, body) {
    const name = checkedName(body.name);
    const existing = findMarker(q, name);
    if (!existing) throw refuse('not_found', `Build ${name} has no marker.`);
    const newName = body.new_name === undefined || body.new_name === null ? name : checkedName(body.new_name);
    const releasedAt = body.released === undefined && body.released_at === undefined ? Number(existing.released_at) : checkedRelease(q, body);
    const note = body.note === undefined ? existing.note || '' : checkedNote(body.note);
    if (newName !== name && findMarker(q, newName)) throw refuse('conflict', `Build ${newName} already has a marker.`);
    q.db.run('UPDATE build_markers SET name = ?, released_at = ?, note = ? WHERE name = ?', newName, releasedAt, note, name);
    const marker = markerOf({ name: newName, released_at: releasedAt, note });
    q.log('settings.marker_edit', { before: markerOf(existing), after: marker });
    return { marker };
}

// Body: { name }.
function removeMarker(q, body) {
    const name = checkedName(body.name);
    const existing = findMarker(q, name);
    if (!existing) throw refuse('not_found', `Build ${name} has no marker.`);
    q.db.run('DELETE FROM build_markers WHERE name = ?', name);
    q.log('settings.marker_remove', markerOf(existing));
    return { removed: markerOf(existing) };
}

module.exports = {
    cards: {
        'settings.build_markers': buildMarkers
    },
    actions: {
        'settings.add_marker': addMarker,
        'settings.edit_marker': editMarker,
        'settings.remove_marker': removeMarker
    }
};
