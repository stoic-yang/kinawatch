# Repository Instructions

Scope: this repository and all descendants.

## Start here

1. Read `README.md`, `docs/INTEGRATION.md`, and the nearest relevant API or
   design document.
2. Inspect `git status` before editing and preserve unrelated changes.
3. Use `config/dashboard.example.json` for public examples. Never commit
   `config/dashboard.local.json`, personal paths, real note content, database
   locations, credentials, or generated local caches.
4. Run the smallest relevant tests while iterating, then the full Python suite
   and frontend build before publishing.

## Ownership and integration

This repository owns the local HTTP service, parsers, ActivityWatch adapter,
day aggregation, cache, frontend, restricted journal writers, tests, static
build, and public documentation.

The configured upstream remains authoritative for ActivityWatch querying, AFK
filtering, source attribution, categories, vault routing, and daily-note
semantics. Do not copy those implementations into this repository merely to
make a test pass. Add or extend an explicit adapter contract instead.

## Safety boundaries

- Bind only to `127.0.0.1` or `localhost`; do not add broad CORS.
- Treat ActivityWatch, its database, and upstream configuration as read-only.
- Journal writes are disabled by default and must remain configuration-gated.
- A daily-note write may update only one selected workflow description or one
  of `我的总结`, `今日产出`, and `明天的计划`. Preserve legacy
  `明日第一步` read compatibility.
- Keep optimistic file fingerprints, per-note locks, same-directory temporary
  files, atomic replacement, and conflict rejection on every write path.
- Never autosave, background-write, bulk-migrate, or delete structured fields.
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
