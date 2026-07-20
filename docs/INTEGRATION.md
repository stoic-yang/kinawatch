# Integration contract

Kina Activity Dashboard currently consumes a local, Kina-compatible
ActivityWatch and Obsidian integration. This document describes the boundary
without requiring any particular absolute directory layout.

## Configuration files

`config/dashboard.local.json` points to four upstream JSON files and one Python
module directory:

- `kina_scripts_dir`: contains an importable `activitywatch_report.py`.
- `activitywatch_config`: ActivityWatch source, timezone, database, and bucket
  configuration.
- `activitywatch_categories`: category labels and classification rules.
- `obsidian_config`: contains `default_vault`.
- `daily_review_config`: contains daily-note routing and template semantics.

The public example assumes those files live below `~/Kina`; change every path
to an existing path on the current machine. Do not commit that local file.

## Python adapter surface

`activitywatch_report.py` must expose:

```python
query_configured_events_between(config, bucket, start_utc, end_utc)
aggregate_categorized_events(events, classification, limit)
classify_event(event, classification)
```

The query result must include `events`, `attributed_events`, `sources`, and
`time_accounting`. The latter preserves the upstream wall-duration, AFK
removal, background-window removal, completeness, and issue semantics.

Dashboard annotates the attributed events for presentation but does not
reimplement the upstream query or time-accounting policy.

## Obsidian routing surface

The configured Obsidian and daily-review JSON files must provide at least:

```json
{
  "default_vault": "/absolute/path/to/your/vault"
}
```

```json
{
  "daily_notes_dir": "Review/Daily",
  "daily_note_date_format": "%Y-%m-%d",
  "vault_name": "YourVault",
  "daily_note_template": []
}
```

`daily_note_template` is used only when an explicitly enabled journal write
creates a missing daily note. Weekly review creation is limited to the
configured `weekly_reviews_dir` and is create-if-absent.

## Read and write boundary

ActivityWatch and all upstream JSON files are read-only. Obsidian notes are
read-mostly. With `journal_write_enabled: true`, the API can update only:

- one workflow description keyed by its selected start time;
- one of `我的总结`, `今日产出`, or `明天的计划` for one selected day;
- one missing canonical weekly-review file.

All other note regions and dates remain outside the write contract.
