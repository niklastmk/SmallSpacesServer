# Insights store

The new store for what the game sends: events, sessions, installs and crash reports. The plan is in `Docs/Analytics/REDESIGN_PLAN.md` (sections 2 and 3). This folder holds the ingest path, the database and the server side of the dashboard at `/insights`. The interface itself is `../insights-ui/`.

## How it works

1. A route the game calls checks the request and appends one line to a spool file, `storage/insights/spool/collect-YYYY-MM-DD.ndjson` (one file per UTC day). It never opens the database and never reads stored data, so a slow dashboard query cannot hold up a player.
2. A worker thread owns the database, `storage/insights/insights.db` (SQLite, write-ahead log). Every two seconds, and when the main thread tells it a line arrived, it reads the new lines and stores them. How far it has read is saved in the same transaction as the rows, so a line is never stored twice and never skipped.
3. The worker then reads crash archives that have a row but were not read yet, and puts each crash into a group.
4. A spool file is deleted once all of it is stored and it is more than seven days old.

If the database cannot be opened, the worker says so once in the log and tries again every 30 seconds. The routes keep accepting data, the spool files grow, and everything is stored once the database opens. The rest of the server is not affected.

## Files

| File | What it does |
|---|---|
| `index.js` | The only file `server.js` uses. `mount()` registers the routes and starts the worker. `legacySessionStart()`, `legacyEvents()` and `legacyCrash()` copy what the old routes receive into the spool. `ask(type, params)` sends a question to the worker and returns a promise for the answer. `stop()` ends the worker. |
| `routes.js` | `POST /api/v2/collect`, `POST /api/v2/crashes`, `GET /api/admin/v2/health`. |
| `admin.js` | The dashboard's routes: sign-in, `GET /api/admin/v2/q/<card>`, `POST /api/admin/v2/do/<action>`, thumbnails, crash archive download, and the interface files under `/insights`. |
| `import.js` | One-time import of what the old routes stored before this store existed (`crashes_metadata.json`, `analytics/sessions.*`, `analytics/events.*`). Runs in the worker in small steps, can be interrupted, never changes the old files. Progress is in the health answer (`import`). |
| `retention.js` | How long events, crash reports and sessions are kept (settings in `meta`, changed on the dashboard's Settings page), the nightly prune at 03:00 UTC, and the mark that keeps deleted crash reports from coming back. Defaults: events 90 days, crash reports 90 days, sessions for ever. |
| `queries/` | What the dashboard asks the database, one file per section. Runs in the worker. Its `README.md` says how to add a card or an action. |
| `main-actions/` | Dashboard actions that need the network or files the main server owns. Run on the main thread. |
| `spool.js` | Appending lines (main thread) and reading them from a byte offset (worker). |
| `worker.js` | The worker thread: spool to database, crash archives, old spool files, answers to `ask`. |
| `db.js` | Opens the database, holds the schema and its migrations. The only file that knows the engine (`node:sqlite`, built into Node 22.5 and newer). |
| `crash-parse.js` | Reads a crash archive: the Unreal `CrashContext.runtime-xml` and minidump, or the macOS report (`.ips`, `.crash`). Category and group key. |
| `events.json` | The list of events, their properties and the session fields. Add an event here first. |

## `POST /api/v2/collect`

JSON body, at most 64 KB and 100 events. Answered with `202 {"ok":true}`.

```json
{
  "schema": 2,
  "install_id": "uuid or 32 hex digits",
  "session_id": "uuid",
  "build": "1.4.0",
  "steam_build": 12345678,
  "platform": "Windows",
  "sent_at": 1795434000000,
  "heartbeat": true,
  "events": [
    { "name": "room_enter", "t": 1795433990000, "seq": 14, "props": { "mode": "design" } }
  ]
}
```

- `400` when `install_id` or `session_id` is missing or not an id (16 to 64 letters, digits, `-` or `_`), when `events` is not an array, or when it has more than 100 entries. `413` when the body is over 64 KB. `503` when the line could not be written; send the batch again.
- An empty `events` array is a heartbeat. It moves the session's last-seen time and stores no event. `"heartbeat": true` is optional and does the same for a batch that also has events.
- Event names must match `^[a-z][a-z0-9_]{0,63}$`; other events are dropped. Properties are flat: strings (cut to 500 characters), finite numbers and booleans, at most 50, keys up to 64 characters. `build` and `platform` are cut to 50 characters.
- Event time is `t + (received - sent_at)`, so a wrong PC clock does not misplace events. If `sent_at` is missing or more than 24 hours away from the receive time, or the result is in the future or over 90 days old, the receive time is used.
- `session_id` plus `seq` is unique. A batch sent twice is stored once. An event without `seq` cannot be recognised as a repeat.
- An event whose name is not in `events.json` is stored with `registered = 0` and listed in the health view.
- Ids are stored in lower case. The network address is not stored and not logged.

What some events do besides being stored:

| Event | Effect |
|---|---|
| any batch | Creates the session and the install if missing, moves their last-seen time, adds the install's day to `install_days`. |
| `session_start` | Every property that is a session field in `events.json` fills its column on the session. `existing_player` is also kept on the install (the first value wins). |
| `menu_shown` | Every property that is a session field updates its column (the settings in effect). |
| `setting_change` | If `key` is a session field, that column is set to `to` (as a number when the field is a number). |
| `session_end` | `ended_at`, `end_reason = 'clean'`, `duration_s`, `active_s`. |
| `session_abnormal_end` | Sent by the next session. Sets `end_reason = 'abnormal'`, `last_stage` and `duration_s` (from `seconds_alive`) on the session named by `prev_session_id`, unless it ended cleanly. A session the server never saw (the game died before its first batch arrived) gets a row from this report, with its times from `prev_started_ms` and `prev_last_ms`; the game sends that session's own first batch again right after, which fills in the hardware and settings. |

## `POST /api/v2/crashes`

The body is the archive itself (`application/zip`, at most 50 MB). The fields are in the query: `crash_guid` (required, `^[A-Za-z0-9._-]{8,128}$`), `install_id`, `session_id`, `build`, `steam_build`, `platform`.

- `200 {"ok":true,"duplicate":false}`: stored as `storage/insights/crashes/<crash_guid>.zip`.
- `200 {"ok":true,"duplicate":true}`: an archive with this `crash_guid` is already stored. It is not written again. The game can delete its copy in both cases.
- `400` for a missing or invalid `crash_guid`, an empty body, or a body that does not start with `PK`. `413` over 50 MB. `429` over 60 uploads in 15 minutes from one player (a limit of its own, not the design upload limit). `503` when it could not be stored; send it again.
- Platform is what the query says. It is never guessed.
- The worker reads the archive afterwards. A Windows archive gives the error message, call stack, hardware and the crash time from the minidump. A Mac archive holds one macOS report: the message is the exception type and signal, the group key is the exception type plus the top three frames inside the game's own binary. An archive that cannot be read, or holds nothing readable, still gets its row, without context, in a group of its own per platform.

## Country

`geo.js` turns the address of a request into two letters while the request is handled (`POST /api/v2/collect` and the old session start). Only the letters are stored (`sessions.country`, the first one heard); the address is neither stored nor logged. The table is `geo/countries.bin.gz`, made from DB-IP's free country list by `node scripts/build-geo.js <dbip-country-lite-YYYY-MM.csv.gz>` (a new list every month at db-ip.com/db/download/ip-to-country-lite). Licence CC BY 4.0: IP Geolocation by DB-IP (https://db-ip.com), credited on the Live page. Against the source it agrees on 99.97 % of range ends; the rest are ranges smaller than an IPv6 /64.

## Live page

`queries/live.js`, eight cards polled every 4 to 30 seconds. "Playing now" is an estimate from launches and the lengths of finished sessions, explained there, because the released game rarely reports while it runs (TD-TELEMETRY-528). Check: `node scripts/check-insights-live.js [port]`. To look at it: seed a throwaway store, start the server, then `node scripts/simulate-live.js <port>`.

## Old game builds

`old-game-routes.js` answers the routes that versions from before November 2026 call: `/api/analytics/event`, `/api/analytics/batch`, `/api/analytics/session/start`, `/api/analytics/session/end` and `/api/crashes`. Paths and answers are what those versions know; everything goes to the spool and nothing else. Their rows have `legacy = 1`. A session end is answered and not stored. The crash archive is stored in `storage/crashes/` and read by the worker. `TrackGameMode` is stored as `room_enter` (the `legacy_map` in `events.json`). An old crash keeps its old id as `crash_guid`; its platform is what the game sent in `metadata.platform`, otherwise empty. The old dashboard, its admin routes and the files it read are retired: `analytics/*.json`, `analytics/*.ndjson`, `crashes_metadata.json` and `crash_groups.json` are no longer written or read (the import took them over); they stay on the volume.

## Admin

`GET /api/admin/v2/health` with the `x-admin-key` header. Answered by the worker: rows per table, events of the last hour by name, time of the last event, spool backlog in bytes, unregistered event names of the last 24 hours, crash archives waiting to be read, and the state of the worker and the database. `503` when the worker does not answer within two seconds.

## Old data and retention

On its first start the worker imports the history the old routes stored, up to the point where the mirror into the spool began, so nothing is counted twice. Imported crash issues start as Open, imported reports have no platform (the old route stored `Windows` for nearly all of them, TD-SERVER-522), and imported sessions have a start time only. If the seam in `events.ndjson` cannot be found, that file is left out and the health answer says why.

The first prune runs at the first 03:00 UTC that is at least 24 hours after the store's first start, so the retention settings can be changed before anything is deleted. Deleted rows free space inside the database file; the file itself does not shrink. Only archives under `storage/insights/crashes/` are removed, never the old route's `storage/crashes/`.

Check: `node scripts/check-insights-import.js [port]`.

## Dashboard

The interface is served at `/insights` from `../insights-ui/dist` (built with `npm run build` in `../insights-ui`; the built files are committed).

- Sign-in: `POST /api/admin/v2/sign-in` with `{ "key": "<ADMIN_RESET_KEY>" }` sets the cookie `insights_session` for 30 days (HttpOnly, SameSite=Strict, Secure in production). The cookie holds an expiry time and a signature made with the admin key, not the key. Changing `ADMIN_RESET_KEY` ends every session. Ten wrong attempts per address in 15 minutes are allowed.
- A request that changes something must also carry the header `x-insights: 1`, which the interface always sends.
- Every route under `/api/admin/v2/` accepts the cookie or the `x-admin-key` header. The admin routes in `server.js` (`requireAdmin`) accept the cookie too, so the dashboard can publish the featured row and save artists through them.
- `GET /api/admin/v2/frame`: builds, when tracking began, the number of new crash issues, the event names.
- `GET /api/admin/v2/q/<card>?range=&platform=&build=&compare=`: one card of one page, `{ data, meta, generated_at }`. `POST /api/admin/v2/do/<action>`: a change. Both are answered by the worker from `queries/`; see `queries/README.md`.
- `GET /api/admin/v2/thumb/<file>` and `GET /api/admin/v2/crash-archive/R-<id>` send a stored file.

Local data to look at: `node scripts/seed-insights.js <throwaway folder>`, then start the server with `RAILWAY_VOLUME_MOUNT_PATH=<that folder>`.

## Database

Tables: `meta` (holds `schema_version` and settings), `spool_offsets`, `installs`, `sessions`, `events`, `install_days`, `crashes`, `crash_groups` (crash issues, with status and notes), `build_markers`, `counters` (per-day counts of things that are not events, such as abandoned crash uploads) and `admin_log` (what was changed from the dashboard). The schema is in `db.js`. To change it, add a migration at the end of `MIGRATIONS` and raise `SCHEMA_VERSION`. A session field added to `events.json` gets its column by itself at the next start.

`INSIGHTS_DB_DISABLED=1` makes the database refuse to open. It exists for the check below and for an emergency: the server then only writes the spool.

## Check

```
cd server
npm install
node scripts/check-insights.js [port]
```

It starts `server.js` on `127.0.0.1` with a temporary storage folder, sends requests, reads the database and prints one numbered `PASS` or `FAIL` line per check. It never contacts production. It needs Node 22.5 or newer.
