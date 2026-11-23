// Settings page: data kept, storage used, export and the danger area.
//
//   card   maintenance.data            retention settings and the last prune, storage used and the volume's
//                                      size, the import of the old files
//   card   maintenance.export          rows for a CSV file: ?what=sessions|events|crashes|issues
//   action maintenance.set_retention   { events_days?, reports_days?, sessions_days? }
//   action maintenance.delete          { what, confirm }
//
// What the three deletes remove:
//   reports     every crash report (the `crashes` rows) and our own archives
//               (storage/insights/crashes). Issues stay with their status,
//               notes and counts. The files of the old route (storage/crashes,
//               crashes_metadata.json) are not touched.
//   events      every single event (the `events` rows). Sessions, players,
//               active days, crash reports and counters stay, so charts built
//               on them keep working.
//   everything  all of the above plus sessions, players, active days, issues,
//               counters, build markers, the change log and the settings.
//               What waits in the spool is dropped unread.
// A crash report deleted here does not come back: see retention.js.
const fs = require('fs');
const path = require('path');
const retention = require('../retention');
const legacyImport = require('../import');
const spool = require('../spool');

const EXPORT_MAX_ROWS = 50000;
const ARCHIVE_SIZE_CACHE_MS = 60 * 1000;
const WHAT = ['reports', 'events', 'everything'];
const EXPORTS = ['sessions', 'events', 'crashes', 'issues'];
// Rows of the meta table that "delete everything" keeps: the schema, what was
// imported and deleted (so neither comes back), and when the next prune is due.
const META_KEPT = ['schema_version', legacyImport.STATE_KEY, retention.RUN_KEY, retention.WATERMARK_KEY, retention.SWEEP_KEY];

function invalid(message) {
    const error = new Error(message);
    error.code = 'invalid';
    return error;
}

const count = (db, table) => Number(db.get(`SELECT COUNT(*) AS n FROM ${table}`).n);

// ---------------------------------------------------------------------------
// Storage used
// ---------------------------------------------------------------------------

const fileSize = (file) => {
    try { return fs.statSync(file).size; } catch (error) { return 0; }
};

let archiveSize = null; // { at, changes, files, bytes }
// Our own crash archives on disk. Listing thousands of files takes a moment,
// so the answer is kept for a minute unless an archive was removed since.
function archiveUsage(now) {
    if (archiveSize && now - archiveSize.at < ARCHIVE_SIZE_CACHE_MS && archiveSize.changes === retention.archiveChanges()) return archiveSize;
    let files = 0;
    let bytes = 0;
    let names = [];
    try { names = fs.readdirSync(retention.archivesDir()); } catch (error) { names = []; }
    for (const name of names) {
        if (!name.endsWith('.zip')) continue;
        try {
            const stat = fs.statSync(path.join(retention.archivesDir(), name));
            if (!stat.isFile()) continue;
            files++;
            bytes += stat.size;
        } catch (error) {
            // removed while listing
        }
    }
    archiveSize = { at: now, changes: retention.archiveChanges(), files, bytes };
    return archiveSize;
}

function storage(q) {
    const dbFile = path.join(q.storageDir, 'insights', 'insights.db');
    const database = fileSize(dbFile) + fileSize(`${dbFile}-wal`) + fileSize(`${dbFile}-shm`);
    const archives = archiveUsage(q.now);
    const spoolBytes = spool.listSpoolFiles(spool.spoolDir(q.storageDir)).reduce((total, entry) => total + entry.size, 0);
    const pageSize = Number(Object.values(q.db.get('PRAGMA page_size') || { n: 0 })[0]) || 0;
    const freePages = Number(Object.values(q.db.get('PRAGMA freelist_count') || { n: 0 })[0]) || 0;
    // The volume the storage folder is on; null where the system does not say.
    let capacity = null;
    let free = null;
    try {
        const volume = fs.statfsSync(q.storageDir);
        capacity = Number(volume.bsize) * Number(volume.blocks);
        free = Number(volume.bsize) * Number(volume.bavail);
        if (!Number.isFinite(capacity) || !Number.isFinite(free)) capacity = free = null;
    } catch (error) {
        capacity = free = null;
    }
    return {
        database_bytes: database,
        archives_bytes: archives.bytes,
        spool_bytes: spoolBytes,
        total_bytes: database + archives.bytes + spoolBytes,
        capacity_bytes: capacity,
        free_bytes: free,
        rows: {
            events: count(q.db, 'events'),
            sessions: count(q.db, 'sessions'),
            crashes: count(q.db, 'crashes'),
            installs: count(q.db, 'installs')
        },
        // Not in the totals above, for the page's wording:
        archives: archives.files,                   // our archive files on disk
        database_free_bytes: pageSize * freePages   // inside the database file, used again by new rows
    };
}

// The three settings, when older data was last deleted and how often it is.
function retentionView(db) {
    return { ...retention.settings(db), last_run_at: retention.status(db).last_at, every_hours: 24 };
}

function data(q) {
    const imported = legacyImport.status(q.db);
    const prune = retention.status(q.db);
    const answer = { retention: retentionView(q.db), options: retention.OPTIONS, storage: storage(q), import: imported, prune };
    // While something is moving the page asks again and again: not from the cache then.
    return imported.state === 'running' || prune.running || prune.removing_archives ? { data: answer, cache: false } : answer;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

function setRetention(q, body) {
    const { before, after } = retention.setSettings(q.db, body);
    q.log('maintenance.set_retention', { before, after });
    return { retention: retentionView(q.db), options: retention.OPTIONS };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

// Where the last whole line of a spool file ends.
function lastLineEnd(file, size) {
    if (size === 0) return 0;
    const length = Math.min(size, 1024 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try {
        fs.readSync(fd, buffer, 0, length, size - length);
    } finally {
        fs.closeSync(fd);
    }
    const end = buffer.lastIndexOf(0x0A);
    return end === -1 ? size : size - length + end + 1;
}

function deleteReports(q, deleted) {
    const archives = archiveUsage(q.now);
    deleted.reports = count(q.db, 'crashes');
    deleted.archives = archives.files;
    deleted.archives_bytes = archives.bytes;
    q.db.run('DELETE FROM crashes');
    retention.markReportsDeleted(q.db, q.now); // the archives go in the worker's next passes
    archiveSize = null;
}

function deleteData(q, body) {
    const what = body.what;
    if (!WHAT.includes(what)) throw invalid(`what must be one of ${WHAT.join(', ')}`);
    if (body.confirm !== `delete ${what}`) throw invalid(`type "delete ${what}" to confirm`);
    const db = q.db;
    const deleted = {};

    if (what === 'reports' || what === 'everything') deleteReports(q, deleted);
    if (what === 'events' || what === 'everything') {
        deleted.events = count(db, 'events');
        db.run('DELETE FROM events');
    }
    if (what === 'everything') {
        for (const [key, table] of [['sessions', 'sessions'], ['installs', 'installs'], ['install_days', 'install_days'],
            ['issues', 'crash_groups'], ['counters', 'counters'], ['build_markers', 'build_markers'], ['log_entries', 'admin_log']]) {
            deleted[key] = count(db, table);
            db.run(`DELETE FROM ${table}`);
        }
        // Settings: everything in the meta table except what must outlive the delete.
        const settings = db.all('SELECT key FROM meta').map((row) => row.key).filter((key) => !META_KEPT.includes(key));
        for (const key of settings) db.run('DELETE FROM meta WHERE key = ?', key);
        deleted.settings = settings.length;
        // What is in the spool and not stored yet was received before the delete.
        let dropped = 0;
        for (const entry of spool.listSpoolFiles(spool.spoolDir(q.storageDir))) {
            const end = lastLineEnd(entry.file, entry.size);
            const row = db.get('SELECT offset FROM spool_offsets WHERE file = ?', entry.name);
            dropped += Math.max(0, end - (row ? Number(row.offset) : 0));
            db.run(`INSERT INTO spool_offsets (file, offset, updated_at) VALUES (?, ?, ?)
                    ON CONFLICT(file) DO UPDATE SET offset = MAX(spool_offsets.offset, excluded.offset), updated_at = excluded.updated_at`,
                entry.name, end, q.now);
        }
        deleted.spool_bytes = dropped;
    }
    legacyImport.cancel(db, what, q.now);
    q.log('maintenance.delete', { what, deleted });
    return { deleted };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());
// An install id is never exported whole: its first eight characters tell two
// players apart inside one file and say nothing outside it.
const shortId = (id) => (typeof id === 'string' && id !== '' ? id.slice(0, 8) : null);
const cell = (value) => (value === undefined || value === null ? null
    : typeof value === 'bigint' ? Number(value)
        : typeof value === 'number' || typeof value === 'string' ? value : String(value));

// The crash's own platform as the dashboard names it.
const CRASH_PLATFORM = `(CASE WHEN lower(c.platform) LIKE 'mac%' THEN 'mac' WHEN lower(c.platform) LIKE 'win%' THEN 'windows'
                              WHEN lower(c.platform) LIKE 'linux%' THEN 'deck' ELSE 'other' END)`;

function finish(columns, found) {
    const truncated = found.length > EXPORT_MAX_ROWS;
    return { columns, rows: (truncated ? found.slice(0, EXPORT_MAX_ROWS) : found).map((row) => row.map(cell)), truncated };
}

function exportSessions(q, everything) {
    const where = q.sessionWhere('s', everything ? 'any' : 'current');
    const times = ['started_at', 'last_seen_at', 'ended_at'];
    const names = q.db.all('PRAGMA table_info(sessions)').map((column) => column.name);
    const found = q.db.all(`SELECT * FROM sessions s WHERE ${where.sql} ORDER BY s.started_at DESC LIMIT ${EXPORT_MAX_ROWS + 1}`, ...where.args);
    const columns = names.map((name) => (name === 'install_id' ? 'install' : name));
    return finish(columns, found.map((row) => names.map((name) => (name === 'install_id' ? shortId(row[name])
        : times.includes(name) ? iso(row[name]) : row[name]))));
}

function exportEvents(q, everything) {
    const parts = [];
    const args = [];
    if (!everything) {
        parts.push('e.t >= ? AND e.t < ?');
        args.push(q.range.from, q.range.to);
    }
    if (q.platform !== 'all') {
        parts.push(`${q.platformSql('s')} = ?`);
        args.push(q.platform);
    }
    if (q.build !== 'all') {
        parts.push('e.build = ?');
        args.push(q.build);
    }
    const found = q.db.all(
        `SELECT e.id, e.t, e.name, e.session_id, e.install_id, e.build, e.platform, e.legacy, e.registered, e.seq, e.props
         FROM events e ${q.platform !== 'all' ? 'LEFT JOIN sessions s ON s.session_id = e.session_id' : ''}
         WHERE ${parts.length > 0 ? parts.join(' AND ') : '1 = 1'} ORDER BY e.t DESC LIMIT ${EXPORT_MAX_ROWS + 1}`, ...args);
    return finish(['id', 'time', 'name', 'session_id', 'install', 'build', 'platform', 'legacy', 'registered', 'seq', 'props'],
        found.map((row) => [row.id, iso(row.t), row.name, row.session_id, shortId(row.install_id), row.build, row.platform,
            row.legacy, row.registered, row.seq, row.props]));
}

function exportCrashes(q, everything) {
    const parts = [];
    const args = [];
    if (!everything) {
        parts.push('c.occurred_at >= ? AND c.occurred_at < ?');
        args.push(q.range.from, q.range.to);
    }
    if (q.platform !== 'all') {
        parts.push(`${CRASH_PLATFORM} = ?`);
        args.push(q.platform);
    }
    if (q.build !== 'all') {
        parts.push('c.build = ?');
        args.push(q.build);
    }
    const found = q.db.all(
        `SELECT c.*, g.title AS issue_title FROM crashes c LEFT JOIN crash_groups g ON g.id = c.group_id
         WHERE ${parts.length > 0 ? parts.join(' AND ') : '1 = 1'} ORDER BY c.occurred_at DESC LIMIT ${EXPORT_MAX_ROWS + 1}`, ...args);
    return finish(['report', 'issue', 'issue_title', 'crash_guid', 'legacy', 'occurred_at', 'received_at', 'build', 'steam_build', 'platform',
        'category', 'crash_type', 'error_message', 'cpu', 'gpu', 'os', 'ram_gb', 'engine_version', 'seconds_since_start',
        'session_id', 'install', 'archive_bytes'],
    found.map((row) => [`R-${row.id}`, row.group_id === null ? null : `SS-${row.group_id}`, row.issue_title, row.crash_guid, row.legacy,
        iso(row.occurred_at), iso(row.received_at), row.build, row.steam_build, row.platform, row.category, row.crash_type,
        row.error_message, row.cpu, row.gpu, row.os, row.ram_gb, row.engine_version, row.seconds_since_start,
        row.session_id, shortId(row.install_id), row.file_size]));
}

// Issues seen in the range. The platform and build filters do not apply: an
// issue is not of one platform or build.
function exportIssues(q, everything) {
    const where = everything ? { sql: '1 = 1', args: [] } : { sql: 'g.last_seen >= ? AND g.first_seen < ?', args: [q.range.from, q.range.to] };
    const found = q.db.all(`SELECT g.* FROM crash_groups g WHERE ${where.sql} ORDER BY g.last_seen DESC LIMIT ${EXPORT_MAX_ROWS + 1}`, ...where.args);
    const list = (json) => {
        try { return JSON.parse(json).join(', '); } catch (error) { return ''; }
    };
    return finish(['issue', 'title', 'category', 'crash_type', 'status', 'reports', 'first_seen', 'last_seen', 'builds', 'platforms',
        'fixed_build', 'error_message', 'notes'],
    found.map((row) => [`SS-${row.id}`, row.title, row.category, row.crash_type, row.status, row.count, iso(row.first_seen), iso(row.last_seen),
        list(row.builds), list(row.platforms), row.fixed_build, row.error_message, row.notes]));
}

// ?what=sessions|events|crashes|issues, with the shared range, platform and
// build filters; range=all exports everything. At most 50,000 rows, newest
// first; `truncated` says there were more.
function exportRows(q) {
    const what = q.params.what;
    if (!EXPORTS.includes(what)) throw invalid(`what must be one of ${EXPORTS.join(', ')}`);
    const everything = q.params.range === 'all';
    const rows = what === 'sessions' ? exportSessions(q, everything)
        : what === 'events' ? exportEvents(q, everything)
            : what === 'crashes' ? exportCrashes(q, everything) : exportIssues(q, everything);
    // Up to 50,000 rows: too large to keep in the cache of card answers.
    return { data: rows, cache: false };
}

module.exports = {
    cards: {
        'maintenance.data': data,
        'maintenance.export': exportRows
    },
    actions: {
        'maintenance.set_retention': setRetention,
        'maintenance.delete': deleteData
    },
    EXPORT_MAX_ROWS
};
