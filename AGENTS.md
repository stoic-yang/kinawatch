# Repository Instructions

Scope: this repository and all descendants.

## Start here

1. Read `README.md`, `docs/INTEGRATION.md`, and the nearest relevant API or
   design document.
2. Inspect `git status` before editing and preserve unrelated changes.
3. Use `config/kinawatch.example.json` for public examples. Never commit
   `config/kinawatch.local.json`, the legacy `config/dashboard.local.json`,
   personal paths, real note content, database locations, credentials, or
   generated local caches.
4. Run the smallest relevant tests while iterating, then the full Python suite
   and frontend build before publishing.

## Ownership and integration

This repository owns the local HTTP service, parsers, ActivityWatch adapter,
day aggregation, cache, frontend, KinaWatch-owned manual activity overlay,
restricted journal writers, tests, static build, and public documentation.

ActivityWatch remains authoritative for captured events and AFK status.
KinaWatch owns its managed local journal; when the Obsidian provider is
selected, the configured vault remains authoritative for journal content.
KinaWatch also owns its read-only REST adapter, user-configurable category
rules, source attribution, storage routing, and daily-note parsing contract. Do
not copy ActivityWatch server, watcher, database, or UI implementations into
this repository. Extend the explicit adapter contract when another provider is
needed.

## Safety boundaries

- The explicitly enabled MCP service center may browse configured local folder
  roots and create/start/stop authenticated external coding-tools-mcp instances
  only after user actions. Use private external profile storage, fixed runtime
  executables, OAuth, safe mode, loopback binds and validated process identities.
  No automatic folder exposure, package install, credential rotation or existing
  service migration. Never tunnel the dashboard itself. Preserve explicitly
  configured legacy services; use synthetic folders for MCP write/exec tests.
  MCP instances are user-started persistent services and survive page closure.
  See `docs/MCP_SERVICES.md`.
- The opt-in server monitor may run only the bundled read-only collector through
  existing locally configured SSH aliases. Keep host/command input out of HTTP,
  verified host keys, no agent forwarding, bounded output, visible stale/error
  states and automatic viewing-lease teardown. Never install remote files,
  mutate remote processes, persist command lines, or start collection on ordinary
  diary requests. See `docs/SERVERS.md`.
- Bind only to `127.0.0.1` or `localhost`; do not add broad CORS.
- Treat ActivityWatch, its database, and all local configuration as read-only.
- The separately authorized recovery workflow may install an explicitly selected,
  precomputed Mac activity snapshot in KinaWatch storage and configure
  `local_activity_file`. This is independent of ActivityWatch; the service only
  reads it, fills uncaptured intervals, and retains the normal AFK, classification,
  overlap and workflow rules. Do not add visible recovery labels. Existing
  fingerprint-checked corrections may target these local event identities.
- Manual activity corrections may write only the KinaWatch-owned overlay after
  an enabled, explicit save. Bind every override to one raw event fingerprint
  and the selected day; require overlay revision checks, atomic replacement,
  conflict rejection, and explicit undo. Never create or modify an
  ActivityWatch event, autosave, or edit an event that is still being captured.
- Journal writes are disabled by default and must remain configuration-gated.
- A daily-note write may update only one selected workflow description or one
  of `我的总结`, `今日产出`, `明天的计划`, and `自由记录`. Preserve legacy
  `明日第一步` read compatibility.
- The separately authorized document endpoint may update the selected daily
  Markdown body, preserving YAML properties and BOM. Its UI may autosave only
  after user editing, with serialized saves, retained drafts and conflict checks.
- The beliefs endpoint may update only the body of `journal.beliefs_note_path`
  (default `Review/我的人生信念.md`), preserving properties and requiring an
  enabled write configuration. Like the daily document editor, it may autosave
  after user editing with serialized saves, retained drafts and conflict checks.
  Reading never creates or imports a note.
- The separately authorized beliefs library stores one complete Markdown file
  per explicit save under `journal.beliefs_dir` (default `Review/Beliefs`).
  YAML properties belong to that file and may be edited. User-triggered daily
  likes and order use its own `.kinawatch.json` with revision checks and
  atomic writes. Legacy sections are projected on read and copied individually
  only on explicit save; preserve the entire legacy file. Never bulk-migrate
  on startup, accept client paths, or use real beliefs as write fixtures.
  See `docs/BELIEFS.md`.
- The authorized vocabulary module may read AnkiConnect on demand and atomically
  retain its own normalized word/review snapshot in the platform user-data
  directory. Keep the explicit read-action whitelist, loopback-only transport,
  plain-text rendering and stale-state reporting. Never write to Anki, initiate
  AnkiWeb sync, or use real cards as write fixtures. See `docs/WORDS.md`.
- Personal health imports require an explicit ZIP selection and matching
  snapshot revision. Retain only sleep and steps summaries under the platform
  user-data directory; never retain the archive, import other health metrics,
  or write health data to journals automatically. See `docs/PERSONAL_HEALTH.md`.
  The separately authorized, opt-in `health_sync` reader may ingest one fixed
  local iCloud JSON file produced by the user's iPhone shortcut. Validate its
  version, dates and contents; merge recent summaries atomically while retaining
  older history and absent metrics. Invalid or empty exports preserve history.
- The opt-in Screen Time adapter may read synchronized mobile Biome data through
  the separately installed decoder and retain its own local snapshot. Apple
  stores and ActivityWatch remain read-only. Mobile activity inspection is
  read-only; cross-device totals must use interval union. See `docs/DEVICE_SYNC.md`.
- A weekly-note write may update only the canonical `自由记录` H2 field in
  the fixed `Review/Weekly/YYYY-Www.md` note. Preserve frontmatter, headings,
  legacy sections, unknown sections, and every non-target field.
- A monthly-note write has the same single-field contract and may update only
  `自由记录` in `Review/Monthly/YYYY-MM.md`. Missing period notes may be
  created only by an enabled, explicit save.
- A permanent-note write may replace only the one configured relative Markdown
  file (`journal.permanent_note_path`, default `incoming.md`). The browser
  never supplies a path; reads never create it. A save replaces the complete
  KinaWatch-managed note only after an explicit action and fingerprint check.
- Legacy `完成复盘` checkbox lines may be ignored on read but must never be
  generated, treated as product state, or bulk-removed from historical notes.
- Keep optimistic file fingerprints, per-note locks, same-directory temporary
  files, atomic replacement, and conflict rejection on every write path.
- Except for the daily document and beliefs editors, vocabulary snapshots and opt-in local sync stores described above, never autosave or
  background-write. Never bulk-migrate or delete structured fields.
- Do not write tests against real notes. Use temporary files and repository
  fixtures only.
- Preserve missing-source, parse, uncategorized, and overlap warnings.
- Do not introduce a persistent Node, Electron, WebSocket, watcher, or daemon
  runtime for v1.

## Verification

For implementation changes, report the exact checks run. The normal release
gate is:

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
npm run build --prefix frontend
```

`python3 -m scripts.gate1` is a live, read-only integration check and requires
a valid local configuration. It is not a substitute for isolated tests.
