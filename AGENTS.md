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
day aggregation, cache, frontend, restricted journal writers, tests, static
build, and public documentation.

ActivityWatch remains authoritative for captured events and AFK status;
Obsidian remains authoritative for journal content. KinaWatch owns its
read-only REST adapter, user-configurable category rules, source attribution,
vault routing, and daily-note parsing contract. Do not copy ActivityWatch
server, watcher, database, or UI implementations into this repository. Extend
the explicit adapter contract when another provider is needed.

## Safety boundaries

- Bind only to `127.0.0.1` or `localhost`; do not add broad CORS.
- Treat ActivityWatch, its database, and all local configuration as read-only.
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
