# Integration contract

KinaWatch integrates with ActivityWatch through its loopback REST API. Journal
content can live in KinaWatch-managed Markdown files or, optionally, an
Obsidian vault. It does not import ActivityWatch source code, read its SQLite
database, or require a Kina workspace.

## ActivityWatch boundary

The optional [server monitor](SERVERS.md) uses existing SSH aliases and an
in-memory, read-only Linux collector. Streams exist only while the server page
is being viewed; they do not feed ActivityWatch, write journals, or require a
separate monitoring service.

The separate vocabulary page consumes AnkiConnect through an on-demand read-only
adapter. Its endpoint, local cache, field mapping and statistics are documented
in [Words](WORDS.md); it does not feed or modify ActivityWatch or journals.

The adapter uses these read-only endpoints:

- `GET /api/0/info`
- `GET /api/0/buckets/`
- `GET /api/0/buckets/<bucket_id>/events?start=...&end=...`

`activitywatch.server_url` must resolve to `localhost`, `127.0.0.1`, or `::1`.
KinaWatch disables environment proxies and rejects HTTP redirects for these
requests, so an approved loopback URL cannot become an external request hop.
It never creates, updates, or deletes buckets or events.

The adapter first uses an explicit `window_bucket_id` or `afk_bucket_id`. When
either value is empty, it discovers the standard `currentwindow` and
`afkstatus` buckets and prefers the ActivityWatch server hostname. If multiple
buckets remain ambiguous, health checks fail with an instruction to configure
the IDs explicitly.

For each requested day, KinaWatch clips window events to the day boundary,
intersects them with `not-afk` intervals, removes configured lock-screen or
background apps, and prevents overlapping events from inflating wall time.
An optional `activitywatch.media_activity` layer can then recover a captured
foreground media event even while the keyboard/mouse watcher reports AFK. It
matches only explicit local rules such as `Google Chrome` plus the captured
`Audio playing` title marker; it does not change ActivityWatch's AFK status or
write any event. `passive_media_seconds` is the non-AFK-external portion added
to screen time, while `interactive_wall_seconds` remains the input-active
subset. Paused media, unmatched windows, lock screens, and ordinary idle time
remain filtered.

The response preserves observed duration, AFK removal before and after media
recovery, passive media time, background removal, overlap adjustment, bucket
identity, and source completeness. Because the raw window events already hold
the media marker, historical cached days can be rebuilt without new capture.

For a bounded `/api/range` request, uncached days are fetched as one contiguous
interval per ActivityWatch bucket and then clipped back into the same per-day
contract before caching. Cached days still bypass ActivityWatch completely.
This keeps the statistics identical to individual day reads while avoiding two
REST round trips for every cold day.

Cold calculations share each event's category match between the annotated
timeline and category totals. Repeated matching contexts reuse a result only
within that day's calculation, including every rule field and manual override;
there is no persistent classification cache to invalidate. Overlap accounting
tracks interval starts and ends instead of rescanning every event at every
boundary, preserving equal sharing, split boundaries and original event order.
These optimizations leave the response and day-cache schema unchanged.

## Optional local Mac activity snapshot

An explicit `local_activity_file` configuration selects one precomputed local
JSON snapshot: `{"version": 1, "events": [{"id": "stable-id", "timestamp":
"2026-01-01T09:00:00Z", "duration": 60, "data": {"app": "Editor", "title":
"Document", "url": ""}}]}`. It is disabled when the path is omitted. The service
never creates or writes the snapshot. Events must have unique IDs, aware times,
finite positive durations, no mutual overlaps, and must already have ended.

Local events fill only intervals without captured Mac windows, before the same
AFK filtering, classification and multi-device union accounting. Internal source
type `kinawatch-local` and bucket identity `kinawatch-local-activity` preserve
provenance without a visible label. They join Mac workflows and support the
existing fingerprint-checked correction overlay. Local and captured blocks do
not merge their inspector identities. Per-day fingerprints include the snapshot;
invalid snapshots report an issue while retaining captured data.

`python3 -m scripts.reconstruct_local_activity` can produce a candidate from an
explicit frozen evidence directory. It uses Computer History foreground context,
clips to not-AFK intervals, caps each observation at 120 seconds, stops at session
boundaries and unknown applications, and uses Chrome metadata only where its URL
matches an observed foreground Chrome window. It does not install the result.
Installation requires a user-requested recovery, an unchanged configuration,
an atomic replacement under an exclusive lock, and retained evidence/rollback
files outside the public repository. Never write recovered events to ActivityWatch.

## Category rules

`activitywatch.categories_file` points to a JSON object with `categories` and
ordered `rules`. Rules can match the following event fields:

```text
app title url project file language status bundle_id source_type
```

Each field supports `_equals`, `_contains`, and `_regex`. All predicates present
in one rule must match, and the first matching rule wins. The public starter is
`config/categories.example.json`; personal titles and project names should stay
in an ignored or external file.

Mobile app fallbacks use an exact `bundle_id_equals`,
`source_type_equals: ["apple-screentime"]`, and `title_regex: ["^$"]`. They
therefore survive localized/custom display names, do not match Mac events,
and yield to content rules if a future source provides titles. Classification
memoization includes both identity fields; display-name changes invalidate
mobile day fingerprints. The starter distinguishes video with unknown purpose,
social feeds, and daily-life services instead of inferring study or recreation
from a mobile video app alone.

## Manual activity correction overlay

ActivityWatch remains the immutable capture source. When
`activity_edit_enabled` is true, KinaWatch may store an explicit user correction
in its own `activity-edits.json` overlay; it never sends a write request to an
ActivityWatch bucket or database. The default path is the platform user-data
directory and can be overridden with `activity_edit_store_path`.

Every screen timeline block carries the source bucket/event references used to
derive it. `GET /api/activity/inspect` resolves those references on demand so a
merged display block does not become an ambiguous write target. Only ended raw
events are editable. A save can override start/end time, application, title,
and one category for that event; a manual category can reference a configured
category or create a KinaWatch-only custom category.

Each override is bound to the raw event's content fingerprint and the selected
calendar/routine day. Saves also require the current overlay revision. A changed
source event or stale revision produces a conflict instead of silently applying
the edit. The overlay uses one process lock, a same-directory temporary file,
atomic replacement, restrictive default permissions, and a bounded history for
immediate explicit undo. It is applied before clipping, AFK filtering,
classification, aggregation, and caching, so the corrected day is recomputed
consistently. Only that day's cache fingerprint changes.

Browsing never creates the overlay, and there is no autosave, background
migration, or bulk rewrite. Creating a completely new activity is intentionally
outside the current contract.

## Journal providers

### Generated workflow descriptions

`GET /api/day` returns `workflows: {version: 1, source: "mac", id, cutoff, min_active_seconds, sessions}`. Each
session has `id`, `start`, `end` and `active_seconds`; the backend alone groups
Mac screen events (`source_type: "activitywatch-rest"`) at gaps over 15 minutes.
Mobile events cannot start, extend or bridge workflows. After grouping, only sessions with at
least 900 active seconds qualify, including exactly 15 minutes. Idle gaps do
not count toward this minimum. Short fragments remain in the raw timeline and
daily totals; their existing descriptions are not rewritten or deleted.
Workflow time uses each block's `device_duration_seconds`: its Mac activity
allocation after AFK/background/within-Mac overlap processing, before any
cross-device equal sharing. Frontend and external consumers must use only Mac
blocks and this field for workflow app, title and category statistics (falling
back to `duration_seconds` for older blocks). The all-device timeline and daily
totals continue to use the original `duration_seconds` accounting.
IDs use the Mac source namespace and UTC start instant and remain stable while a workflow extends.
The namespace prevents old multi-device generated descriptions from attaching
to a new Mac workflow merely because their start instant matches.
The snapshot digest tracks both the source timeline and segmentation rules.
The frontend summarizes visible blocks inside these supplied boundaries instead
of regrouping or applying another minimum after category filtering.
Day cache schema version 15 invalidates older responses so historical days and
external description generators consume the same qualified workflow list.

The external generator saves this snapshot and reads the document/fingerprint
pair from `GET /api/journal/document`. It submits validated descriptions through
the existing document PUT with that fingerprint; it does not write journal files
directly. Only the generated callout is replaced in the prepared document.
Generated lines may carry a trailing `<!-- kina:workflow:<16 hex characters> -->`
identity comment. The frontend uses this identity for new descriptions and keeps
the legacy clock-range matching only for historical lines without an identity.
If a workflow disappears, its generated description is not moved to another card.
Legacy descriptions must overlap a remaining workflow or share its start minute;
the nearest unrelated workflow is never used as a fallback.

KinaWatch displays timestamped generated descriptions beside their workflow
segments. The optional external generator combines Computer Use / Computer
History observations with the ActivityWatch timeline and must preserve the
screen-session boundaries (a gap greater than 15 minutes starts a new session).
Manual descriptions retain priority. The existing `一天活动小总结` / `今日轨迹`
container remains readable for compatibility; it is not a separate recap panel.
The journal view hides generated summary and legacy advice blocks while
preserving their source bytes during user edits. Automatic advice is disabled;
new output contains only descriptions for the observed workflows. Missing
evidence must be stated rather than replaced with inferred tasks or outcomes.

The public configuration defaults to KinaWatch-managed local Markdown:

```json
{
  "journal": {
    "provider": "local",
    "daily_notes_dir": "Daily",
    "daily_note_date_format": "%Y-%m-%d",
    "daily_note_template": [],
    "permanent_note_path": "incoming.md",
    "beliefs_note_path": "Review/我的人生信念.md"
  }
}
```

The storage root is selected from the platform user-data directory. It can be
overridden with `journal.storage_dir` or `KINAWATCH_DATA_DIR`. Merely starting
the service or viewing a day does not create a file; the daily directory and
Markdown record are created only after an explicit, enabled save.

To use an Obsidian vault instead:

```json
{
  "journal": {
    "provider": "obsidian",
    "vault": "~/Documents/Obsidian",
    "vault_name": "Obsidian",
    "daily_notes_dir": "Daily",
    "daily_note_date_format": "%Y-%m-%d",
    "daily_note_template": [],
    "permanent_note_path": "incoming.md",
    "beliefs_note_path": "Review/我的人生信念.md"
  }
}
```

The note for a selected day is resolved below `daily_notes_dir`. In Obsidian
mode, if the exact date filename does not exist, KinaWatch accepts the first
date-prefixed Markdown file for read compatibility. In local mode, KinaWatch
owns the exact date-named file. A direct v2 configuration that has `vault` but
no `provider` is treated as Obsidian for backward compatibility. Provider
changes take effect after restart and never copy, synchronize, or delete files
between the two storage roots.

ActivityWatch and configuration files are always read-only. The separate
activity overlay above does not widen the journal contract. With
`journal_write_enabled: true`, the journal API can update only:

- the complete Markdown body of one selected daily note through `/api/journal/document`, preserving its existing YAML properties prefix;
- one workflow description keyed by its selected start time, including an explicit empty string to clear it;
- one of `我的总结`, `今日产出`, `明天的计划`, or `自由记录` for one selected day;
- the canonical `自由记录` H2 field in one fixed weekly- or monthly-review file;
- the Markdown body of the configured beliefs note through `/api/journal/beliefs`, preserving its existing YAML properties and BOM;
- the complete contents of one configured permanent Markdown note, whose
  relative path defaults to `incoming.md`.

Every write remains fingerprint-checked, per-note locked, atomic, confined to
the selected provider's storage root, and conflict-rejecting. Period-review
frontmatter, legacy sections, unknown sections, and non-target fields remain
outside those field-specific write contracts. The document endpoint replaces only
the selected daily body; other files and dates remain untouched. Weekly
notes use `Review/Weekly/YYYY-Www.md`; monthly notes use
`Review/Monthly/YYYY-MM.md`. The permanent-note path comes only from local
configuration, must be relative and end in `.md`, and is never accepted from
the browser. Reading it never creates a file; the first enabled, explicit save
does.

## Beliefs note

The current beliefs UI uses the standalone-file library documented in
[Beliefs](BELIEFS.md): explicit full-Markdown saves, YAML and inline tags,
persistent manual order, pins and one reversible vote per calendar day.
The legacy document endpoint below remains for older clients; the new UI does
not autosave or rewrite the original multi-section note.

`GET /api/journal/beliefs` reads the fixed `journal.beliefs_note_path`, which
defaults to `Review/我的人生信念.md` under the selected provider's root.
`PUT /api/journal/beliefs` accepts only `markdown` and `expected_fingerprint`;
the client cannot choose a path or date. An empty body is valid. Both responses
include the body, file fingerprint, provider, path, existence, properties flag,
write capability, and the stable Obsidian open URI when applicable. The JSON
request limit is 16 MiB, shared with the daily document endpoint.

The beliefs body is directly editable and autosaves about 700 ms after user input
pauses when writes are enabled. Saves are serialized; typing during a request is
retained and saved against the returned fingerprint. Unsynced drafts stay in
browser-local storage, including their original file fingerprint and any
unconfirmed request. Failures pause automatic writes; retry reads the file before
reconciling an uncertain response. The daily and beliefs editors share this logic.
External changes require comparison and explicit resolution. Reading never creates the file or imports other notes;
saving changes only this note's body, preserving properties and other files.
Both providers use the same configuration gate, confined path, per-note lock,
fingerprint check and atomic replacement as daily document writes. Beliefs saves
do not invalidate date-specific activity caches.

## Daily document editing

The journal calendar, day navigation and date URLs accept future dates, including
dates beyond the configured routine-day boundary. Opening or reloading a future
date keeps that date selected; only editing creates or changes its note. Activity
summary ranges remain bounded by the current day. Future notes use the same
write gate, fingerprints and conflict handling as other dates.

The scheme 1 Journal editor reads `GET /api/journal/document?date=YYYY-MM-DD`
and writes `PUT /api/journal/document` with `date`, `markdown`, and
`expected_fingerprint`. The browser never supplies a file path. Both responses
contain the exact body, file fingerprint, provider, path, existence and write
capability. Existing YAML frontmatter and BOM remain byte-preserved; all body
content, including unknown paragraphs and historical callouts, stays in the
same Markdown document without field consolidation. A newly typed body that
itself looks like YAML properties receives an empty properties envelope so its
text remains visible on the next read.

The user-authorized Journal experience saves 700 ms after typing pauses and
flushes when leaving the editor. It does not write on an initial read or create
files while browsing. Saves are serialized per date, use the last acknowledged
fingerprint, and preserve edits made while a request is pending. Failed or
conflicting drafts are retained in origin-local browser storage. Reopening a
conflicting draft does not grant permission to overwrite the file; the editor
offers comparison and an explicit choice of version. A lost response is
reconciled by reading before retrying. The other field editors keep their
explicit-save behavior.

Recognized managed workflow descriptions are projected out of the Journal prose
editor and its outline. They remain available from the timeline's workflow
entries. Editing or clearing visible prose preserves the original workflow
source, as it does for the separate Kina summary sidebar; an ordinary user
callout named `工作流` without a recognized timed entry remains visible.

Saving an empty workflow description retains its timed marker and an empty
`workflow_notes` record. This explicit clear suppresses the generated-summary
fallback without changing the generated source. A missing or non-string `note`
is rejected, and stale clears still fail the fingerprint check. The parser and
day cache versions are 3 and 10 respectively.

The document editor has no character counter or 8,000-character limit. Its
endpoint and preview proxy use a 16 MiB JSON transport ceiling; other endpoints
retain their existing request limits. Empty body saves are valid. All new write
verification uses temporary notes or mocked browser APIs, never real notes.

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
