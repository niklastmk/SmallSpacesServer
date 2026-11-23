# Dashboard queries

What the dashboard at `/insights` asks the insights database. Everything here runs in the worker thread (`../worker.js`), the only code that opens the database, so a slow query never holds up a player's request.

## Adding a card or an action

Every `.js` file in this folder except `index.js`, `common.js` and files starting with an underscore (helpers shared by several sections) is loaded by name and exports:

```js
module.exports = {
    cards:   { 'players.activity_daily': (q) => ({ data, meta }) },   // GET  /api/admin/v2/q/players.activity_daily?range=30d&platform=all&build=all
    actions: { 'stability.set_status':   (q, body) => ({ ... }) }     // POST /api/admin/v2/do/stability.set_status  (JSON body)
};
```

- Names are `section.name`, lower case with underscores. One file per section; a file that fails to load is logged and listed in the frame answer (`query_sections_failed`), the others keep working.
- A card returns the data, or `{ data, meta }`. The route answers `{ data, meta, generated_at }`. `meta` defaults to `{ collected_since, first_build, coverage: null, collecting: null }`; set `coverage: q.coverage()` on a rate that only the new builds can give, and `collecting: q.collecting(7)` on a metric that needs seven finished days. Answers are cached for 20 seconds per card and parameters; every action clears the cache. A card that is polled for what is new returns `{ data, cache: false }` and is never cached.
- An action runs inside one write transaction. Throw an error with `error.code = 'invalid'` (400), `'not_found'` (404), `'conflict'` (409) or, from a main action whose outside service failed, `'upstream'` (502) to refuse; the message is sent as `detail`.
- An action that needs the network or files the main server owns goes in `../main-actions/<section>.js` instead: `{ actions: { 'section.name': async (body, context) => result } }`, with `context = { storageDir, log, req, card(name, params), action(name, body) }`. It runs on the main thread, so it must not read large files or loop over stored data; ask the worker through `context.card` / `context.action`.

## `q`

| Member | What it is |
|---|---|
| `q.db` | `run`, `get`, `all`, `exec` (see `../db.js`). Use `?` parameters, never string-built values |
| `q.now` | request time, ms |
| `q.params` | the request's query parameters, strings |
| `q.range` | `{ key, from, to, prevFrom, prevTo, days: ['YYYY-MM-DD'], length }`. `today` is the last 24 hours and its previous period is the same 24 hours a week earlier |
| `q.platform` | `all`, `windows`, `mac` or `deck` |
| `q.build` | `all` or one build name (`newest` is already resolved) |
| `q.compare` | whether the compare switch is on |
| `q.builds` | `[{ name, released_at, note, marker }]`, newest first |
| `q.tracking` | `{ since, first_build }`: when the new protocol started arriving |
| `q.sessionWhere(alias, period)` | `{ sql, args }` for a `sessions` row: the range (`'current'`, `'previous'`, `'any'` or `{ from, to }`) and the platform and build filters |
| `q.events(names, period, { legacy: false })` | events of those names with the filters applied: `[{ name, t, session_id, install_id, build, platform, day, props }]`, props parsed |
| `q.coverage(period)` | share of sessions in the range from builds that speak the new protocol |
| `q.collecting(days)` | `null`, or `{ since, due }` while a metric needs more finished days |
| `q.paging(sortable, defaultDir)` | `{ sort, dir, per, page, offset, orderBy }` from `sort`, `dir`, `page`, `per` in the address |
| `q.file(name, fallback)` | a JSON file of the main server, read-only and cached: `metadata.json` (designs), `featured.json`, `artists.json`, `artist_clicks.json`, `moderation_rejections.json` |
| `q.log(kind, detail)` | a row in `admin_log` (change history) |
| `q.platformSql(alias)`, `q.platformOf(platform, device)` | the dashboard's platform of a session: `windows`, `mac`, `deck`, `other` |

`common.js` also exports `DAY`, `utcDay`, `dayStart`, `daysOf`, `compareBuilds`, `median`, `percentile`, `sum`, `share`, `change`, `round`, `countBy`, `groupBy`, `topList`, `histogram`.

## What the data means

- Tables and columns: `../db.js`. Events and their properties: `../events.json` (wave 2 events are not sent by the first update). What the game sends when: `Source/SmallSpaces/Backend/Private/SSTelemetrySubsystem.cpp`.
- `sessions.legacy = 1`: a session of a build from before the update. It has a start time and maybe a platform, nothing else: no install, no end, no hardware, and its `build` is a value the old game hard-coded. Count such sessions as sessions; show their build as older builds; never compute a rate that needs an end or an install from them.
- A player is an install (`install_id`). `install_days` has one row per install and UTC day it was active. `installs.existing_player` says the install had a save from before tracking.
- A session ended cleanly when `end_reason = 'clean'`, abnormally when `'abnormal'` (reported by the next launch, with `last_stage`: `startup`, `menu_loading`, `menu`, `loading:<mode>:<level>`, `room:<mode>:<level>`, `load_failed`). `NULL` means still running or never heard from again.
- `quality_preset` is the scalability level as text, `0` (low) to `4` (cinematic). `device` is `pc`, `proton`, `steam_deck`, `apple_silicon` or `intel_mac`. Modes are `unpack`, `design`, `creative`, `community`.
- Crash issues are `crash_groups` (`SS-<id>`), reports are `crashes` (`R-<id>`). `crashes.legacy = 1` came through the old route: no install, often no session. `crash_groups.status` is `new`, `open`, `fixed`, `regressed` or `ignored`; New is shown only while `first_seen` is within seven days. `crashes.context` is JSON with `callstack`, `error_message` and the hardware of the report.
- `counters(day, key, n)`: `crash_upload_stored`, `crash_upload_duplicate`, `crash_upload_abandoned`.
- Never return install IDs in bulk, network addresses, or anything a player typed.

## SQL to watch for

- Never give a result column the name of a table column and then group by it: `SELECT ${q.platformSql('s')} AS platform ... GROUP BY platform` groups by the raw `sessions.platform` column, not by the expression, and the Steam Deck silently disappears into Windows. Use another alias (`AS plat ... GROUP BY plat`).
- Crash reports of old builds usually name no session and no install. Count such a report as one session and one player of its own, or say that it is left out.

## Speed

At production size a 30-day range is about 90,000 sessions and two million events. Filter events by `name` and `t` (indexed) before touching `props`; aggregate in SQL where it is simple and in JavaScript after `q.events()` where it is not. A card should answer in well under a second on the seeded data and never read the whole `events` table.

## Trying it

```bash
node scripts/seed-insights.js /path/to/throwaway-storage
PORT=3879 RAILWAY_VOLUME_MOUNT_PATH=/path/to/throwaway-storage ADMIN_RESET_KEY=local-test node server.js
curl -s -H 'x-admin-key: local-test' 'http://127.0.0.1:3879/api/admin/v2/q/players.activity_daily?range=30d'
```

The seed script writes about 45 days of made-up data: an old build, build 1.4.0 ten days ago (first wave of events) and 1.4.1 two days ago (second wave). The worker loads query files when the server starts: restart the server after editing one.
