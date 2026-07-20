# Integration contract

KinaWatch integrates with ActivityWatch through its loopback REST API and with
Obsidian through ordinary Markdown files. It does not import ActivityWatch
source code, read its SQLite database, or require a Kina workspace.

## ActivityWatch boundary

The adapter uses these read-only endpoints:

- `GET /api/0/info`
- `GET /api/0/buckets/`
- `GET /api/0/buckets/<bucket_id>/events?start=...&end=...`

`activitywatch.server_url` must resolve to `localhost`, `127.0.0.1`, or `::1`.
KinaWatch never creates, updates, or deletes buckets or events.

The adapter first uses an explicit `window_bucket_id` or `afk_bucket_id`. When
either value is empty, it discovers the standard `currentwindow` and
`afkstatus` buckets and prefers the ActivityWatch server hostname. If multiple
buckets remain ambiguous, health checks fail with an instruction to configure
the IDs explicitly.

For each requested day, KinaWatch clips window events to the day boundary,
intersects them with `not-afk` intervals, removes configured lock-screen or
background apps, and prevents overlapping events from inflating wall time.
The response preserves observed duration, AFK removal, background removal,
overlap adjustment, bucket identity, and source completeness.

## Category rules

`activitywatch.categories_file` points to a JSON object with `categories` and
ordered `rules`. Rules can match the following event fields:

```text
app title url project file language status
```

Each field supports `_equals`, `_contains`, and `_regex`. All predicates present
in one rule must match, and the first matching rule wins. The public starter is
`config/categories.example.json`; personal titles and project names should stay
in an ignored or external file.

## Obsidian boundary

The direct v2 configuration is self-contained:

```json
{
  "journal": {
    "vault": "~/Documents/Obsidian",
    "vault_name": "Obsidian",
    "daily_notes_dir": "Daily",
    "daily_note_date_format": "%Y-%m-%d",
    "daily_note_template": []
  }
}
```

The note for a selected day is resolved below `daily_notes_dir`. If the exact
date filename does not exist, KinaWatch accepts the first date-prefixed Markdown
file for read compatibility. The vault remains the only journal source of truth.

ActivityWatch and configuration files are always read-only. With
`journal_write_enabled: true`, the API can update only:

- one workflow description keyed by its selected start time;
- one of `我的总结`, `今日产出`, or `明天的计划` for one selected day;
- one missing canonical weekly-review file.

Every daily-note write remains fingerprint-checked, per-note locked, atomic,
and conflict-rejecting. All other note regions and dates remain outside the
write contract.

## Migrating from v1 Kina integration

Existing ignored v1 configurations continue to work during migration. When no
top-level `activitywatch` or `journal` object exists, KinaWatch reads the old
`upstream` JSON paths to derive:

- ActivityWatch server timezone and bucket IDs;
- category rules and background applications;
- Obsidian vault and daily-note routing.

It deliberately ignores `kina_scripts_dir` and no longer imports
`activitywatch_report.py`. This keeps an existing installation working while
removing the private Python runtime dependency.

To finish migration:

1. Copy `config/kinawatch.example.json` to `config/kinawatch.local.json`.
2. Move the relevant values from the old ActivityWatch, categories, Obsidian,
   and daily-review JSON files into the new direct sections.
3. Point `activitywatch.categories_file` at a private categories file.
4. Run `python3 -m backend.server --check` and `python3 -m scripts.gate1`.
5. Remove the old `upstream` object only after parity is confirmed.

## Fork boundary

KinaWatch should consume an unmodified ActivityWatch release by default. If a
future feature genuinely requires an upstream server or watcher change, fork
only that ActivityWatch component in a separate repository, retain its
MPL-2.0 obligations there, and let KinaWatch consume the released component.
Do not merge the KinaWatch product repository into an ActivityWatch fork.
