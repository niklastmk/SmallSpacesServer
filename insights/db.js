// The insights database: one SQLite file, opened only by the worker thread.
//
// Everything that knows the engine is in this file. The rest of the code uses
// the small adapter returned by open(): exec, run, get, all, transaction,
// savepoint, close. Swapping the engine later means rewriting open() only.
//
// The engine is Node's built-in `node:sqlite` (Node 22.5 or newer). On an older
// Node, or when INSIGHTS_DB_DISABLED=1, open() throws; the worker then leaves
// the spool files alone and the rest of the server is not affected.
const fs = require('fs');
const path = require('path');
const registry = require('./events.json');

const SCHEMA_VERSION = 3;

// The context columns of a session are the `session_fields` of events.json.
const COLUMN_TYPES = { s: 'TEXT', n: 'REAL', b: 'INTEGER' };
const SAFE_COLUMN = /^[a-z][a-z0-9_]{0,63}$/;
// build, steam_build and platform also arrive at the top of every batch, so
// they are always columns, whatever events.json lists.
const ALWAYS_SESSION_FIELDS = { build: 's', steam_build: 'n', platform: 's' };
// The columns the worker maintains itself; a session field cannot take their name.
const SESSION_OWN_COLUMNS = ['session_id', 'install_id', 'legacy', 'started_at', 'last_seen_at', 'ended_at',
    'end_reason', 'last_stage', 'duration_s', 'active_s', 'event_count', 'country', 'end_received_at'];
function sessionFieldColumns() {
    return Object.entries({ ...ALWAYS_SESSION_FIELDS, ...(registry.session_fields || {}) })
        .filter(([name, type]) => SAFE_COLUMN.test(name) && COLUMN_TYPES[type] && !SESSION_OWN_COLUMNS.includes(name))
        .map(([name, type]) => ({ name, type: COLUMN_TYPES[type], kind: type }));
}

// Forward migrations, in order. Each runs once, inside a transaction, when the
// stored schema_version is lower than its version. Add a new one at the end
// and raise SCHEMA_VERSION; never edit one that has shipped.
const MIGRATIONS = [
    {
        version: 1,
        up(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS spool_offsets (
                    file        TEXT PRIMARY KEY,
                    offset      INTEGER NOT NULL,
                    updated_at  INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS installs (
                    install_id       TEXT PRIMARY KEY,
                    first_seen       INTEGER NOT NULL,
                    last_seen        INTEGER NOT NULL,
                    first_build      TEXT,
                    last_build       TEXT,
                    platform         TEXT,
                    existing_player  INTEGER
                );
                CREATE INDEX IF NOT EXISTS installs_first_seen ON installs (first_seen);

                CREATE TABLE IF NOT EXISTS sessions (
                    session_id    TEXT PRIMARY KEY,
                    install_id    TEXT,
                    legacy        INTEGER NOT NULL DEFAULT 0,
                    started_at    INTEGER NOT NULL,
                    last_seen_at  INTEGER NOT NULL,
                    ended_at      INTEGER,
                    end_reason    TEXT,
                    last_stage    TEXT,
                    duration_s    REAL,
                    active_s      REAL,
                    event_count   INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS sessions_started ON sessions (started_at);
                CREATE INDEX IF NOT EXISTS sessions_install ON sessions (install_id, started_at);

                CREATE TABLE IF NOT EXISTS events (
                    id          INTEGER PRIMARY KEY,
                    session_id  TEXT NOT NULL,
                    install_id  TEXT,
                    name        TEXT NOT NULL,
                    t           INTEGER NOT NULL,
                    seq         INTEGER,
                    build       TEXT,
                    platform    TEXT,
                    registered  INTEGER NOT NULL DEFAULT 1,
                    legacy      INTEGER NOT NULL DEFAULT 0,
                    props       TEXT,
                    UNIQUE (session_id, seq)
                );
                CREATE INDEX IF NOT EXISTS events_name_t ON events (name, t);
                CREATE INDEX IF NOT EXISTS events_t ON events (t);

                CREATE TABLE IF NOT EXISTS install_days (
                    install_id  TEXT NOT NULL,
                    day         TEXT NOT NULL,
                    platform    TEXT,
                    build       TEXT,
                    PRIMARY KEY (install_id, day)
                ) WITHOUT ROWID;
                CREATE INDEX IF NOT EXISTS install_days_day ON install_days (day);

                CREATE TABLE IF NOT EXISTS crash_groups (
                    id             INTEGER PRIMARY KEY,
                    group_key      TEXT NOT NULL UNIQUE,
                    title          TEXT,
                    category       TEXT,
                    crash_type     TEXT,
                    error_message  TEXT,
                    count          INTEGER NOT NULL DEFAULT 0,
                    first_seen     INTEGER,
                    last_seen      INTEGER,
                    builds         TEXT NOT NULL DEFAULT '[]',
                    platforms      TEXT NOT NULL DEFAULT '[]'
                );
                CREATE INDEX IF NOT EXISTS crash_groups_last_seen ON crash_groups (last_seen);

                CREATE TABLE IF NOT EXISTS crashes (
                    id                   INTEGER PRIMARY KEY,
                    crash_guid           TEXT NOT NULL UNIQUE,
                    legacy               INTEGER NOT NULL DEFAULT 0,
                    install_id           TEXT,
                    session_id           TEXT,
                    build                TEXT,
                    steam_build          INTEGER,
                    platform             TEXT,
                    received_at          INTEGER NOT NULL,
                    occurred_at          INTEGER NOT NULL,
                    file                 TEXT,
                    file_size            INTEGER,
                    parsed               INTEGER NOT NULL DEFAULT 0,
                    parse_error          TEXT,
                    has_context          INTEGER,
                    has_minidump         INTEGER,
                    group_id             INTEGER,
                    category             TEXT,
                    crash_type           TEXT,
                    error_message        TEXT,
                    callstack_hash       TEXT,
                    cpu                  TEXT,
                    gpu                  TEXT,
                    os                   TEXT,
                    ram_gb               REAL,
                    engine_version       TEXT,
                    seconds_since_start  REAL,
                    context              TEXT
                );
                CREATE INDEX IF NOT EXISTS crashes_occurred ON crashes (occurred_at);
                CREATE INDEX IF NOT EXISTS crashes_group ON crashes (group_id, occurred_at);
                CREATE INDEX IF NOT EXISTS crashes_session ON crashes (session_id);
                CREATE INDEX IF NOT EXISTS crashes_unparsed ON crashes (parsed) WHERE parsed = 0;
            `);
        }
    },
    {
        // The dashboard: issue status and notes, build markers, daily counters
        // of things that are not events (abandoned crash uploads), and a log
        // of what was changed from the dashboard.
        version: 2,
        up(db) {
            db.exec(`
                ALTER TABLE crash_groups ADD COLUMN status TEXT NOT NULL DEFAULT 'open';
                ALTER TABLE crash_groups ADD COLUMN status_at INTEGER;
                ALTER TABLE crash_groups ADD COLUMN fixed_build TEXT;
                ALTER TABLE crash_groups ADD COLUMN fixed_next INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE crash_groups ADD COLUMN opened_at INTEGER;
                ALTER TABLE crash_groups ADD COLUMN notes TEXT;
                ALTER TABLE crash_groups ADD COLUMN notes_at INTEGER;
                ALTER TABLE crash_groups ADD COLUMN summary TEXT;
                ALTER TABLE crash_groups ADD COLUMN summary_at INTEGER;
                ALTER TABLE crash_groups ADD COLUMN summary_reports INTEGER;
                CREATE INDEX IF NOT EXISTS crash_groups_status ON crash_groups (status);

                CREATE TABLE IF NOT EXISTS build_markers (
                    name         TEXT PRIMARY KEY,
                    released_at  INTEGER NOT NULL,
                    note         TEXT
                );

                CREATE TABLE IF NOT EXISTS counters (
                    day  TEXT NOT NULL,
                    key  TEXT NOT NULL,
                    n    INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (day, key)
                ) WITHOUT ROWID;

                CREATE TABLE IF NOT EXISTS admin_log (
                    id      INTEGER PRIMARY KEY,
                    t       INTEGER NOT NULL,
                    kind    TEXT NOT NULL,
                    detail  TEXT
                );
                CREATE INDEX IF NOT EXISTS admin_log_kind ON admin_log (kind, t);

                CREATE INDEX IF NOT EXISTS events_session ON events (session_id, t);
                CREATE INDEX IF NOT EXISTS sessions_last_seen ON sessions (last_seen_at);
                CREATE INDEX IF NOT EXISTS crashes_received ON crashes (received_at);
            `);
        }
    },
    {
        // The Live page: where a session is played (two letters, worked out from
        // the address while the request is handled; the address is not kept) and
        // when its end was heard of, which can be much later than the end itself.
        version: 3,
        up(db) {
            db.exec(`
                ALTER TABLE sessions ADD COLUMN country TEXT;
                ALTER TABLE sessions ADD COLUMN end_received_at INTEGER;
            `);
        }
    }
];

// node:sqlite printed an ExperimentalWarning on load in some Node versions.
// Keep that one line out of the server log; every other warning passes.
function loadEngine() {
    const original = process.emitWarning;
    process.emitWarning = function (warning, ...rest) {
        const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
        const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] && rest[0].type) || (warning && warning.name) || '';
        if (type === 'ExperimentalWarning' && /sqlite/i.test(text)) return;
        return original.call(process, warning, ...rest);
    };
    try {
        return require('node:sqlite');
    } finally {
        process.emitWarning = original;
    }
}

// SQLite takes numbers, strings, null and buffers. Booleans become 0 or 1,
// undefined and non-finite numbers become null.
function bindable(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' || typeof value === 'bigint' || Buffer.isBuffer(value)) return value;
    return String(value);
}

function migrate(db) {
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
    const row = db.get("SELECT value FROM meta WHERE key = 'schema_version'");
    let current = row ? Number(row.value) || 0 : 0;
    if (current > SCHEMA_VERSION) {
        throw new Error(`database schema ${current} is newer than this server (${SCHEMA_VERSION})`);
    }
    for (const migration of MIGRATIONS) {
        if (migration.version <= current) continue;
        db.transaction(() => {
            migration.up(db);
            db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
                'ON CONFLICT(key) DO UPDATE SET value = excluded.value', String(migration.version));
        });
        current = migration.version;
    }

    // A session field added to events.json gets its column here, without a migration.
    const existing = new Set(db.all('PRAGMA table_info(sessions)').map((column) => column.name));
    for (const column of sessionFieldColumns()) {
        if (!existing.has(column.name)) {
            db.exec(`ALTER TABLE sessions ADD COLUMN ${column.name} ${column.type}`);
        }
    }
    return current;
}

// Opens (and creates or migrates) the database. Throws when it cannot.
function open(file) {
    if (process.env.INSIGHTS_DB_DISABLED === '1') {
        throw new Error('disabled by INSIGHTS_DB_DISABLED=1');
    }
    const { DatabaseSync } = loadEngine();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const raw = new DatabaseSync(file);

    const statements = new Map(); // SQL text -> prepared statement
    const statement = (sql) => {
        let prepared = statements.get(sql);
        if (!prepared) {
            prepared = raw.prepare(sql);
            statements.set(sql, prepared);
        }
        return prepared;
    };

    let depth = 0; // savepoint counter, for unique names
    const db = {
        engine: 'node:sqlite',
        file,
        schemaVersion: 0,
        exec: (sql) => raw.exec(sql),
        run: (sql, ...params) => statement(sql).run(...params.map(bindable)),
        get: (sql, ...params) => statement(sql).get(...params.map(bindable)),
        all: (sql, ...params) => statement(sql).all(...params.map(bindable)),
        // Runs fn inside one write transaction; an error rolls everything back.
        transaction(fn) {
            raw.exec('BEGIN IMMEDIATE');
            try {
                const result = fn();
                raw.exec('COMMIT');
                return result;
            } catch (error) {
                try { raw.exec('ROLLBACK'); } catch (rollbackError) { /* already rolled back */ }
                throw error;
            }
        },
        // Inside a transaction: runs fn, and on an error undoes only what fn did.
        savepoint(fn) {
            const name = `sp_${++depth}`;
            raw.exec(`SAVEPOINT ${name}`);
            try {
                const result = fn();
                raw.exec(`RELEASE ${name}`);
                return result;
            } catch (error) {
                try { raw.exec(`ROLLBACK TO ${name}`); raw.exec(`RELEASE ${name}`); } catch (rollbackError) { /* transaction is gone */ }
                throw error;
            } finally {
                depth--;
            }
        },
        close() {
            statements.clear();
            try { raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (error) { /* best effort */ }
            raw.close();
        }
    };

    try {
        raw.exec('PRAGMA journal_mode = WAL');
        raw.exec('PRAGMA synchronous = NORMAL');
        raw.exec('PRAGMA busy_timeout = 5000');
        db.schemaVersion = migrate(db);
    } catch (error) {
        try { raw.close(); } catch (closeError) { /* nothing to close */ }
        throw error;
    }
    return db;
}

const TABLES = ['meta', 'spool_offsets', 'installs', 'sessions', 'events', 'install_days', 'crashes', 'crash_groups',
    'build_markers', 'counters', 'admin_log'];

module.exports = { open, sessionFieldColumns, TABLES, SCHEMA_VERSION };
