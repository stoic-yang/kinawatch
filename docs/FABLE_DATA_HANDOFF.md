# Fable Data Handoff

This document describes the data currently available to a frontend. It does
not prescribe the page structure, feature set, visual hierarchy, components,
charts, or which values should be prominent.

Fable may use, ignore, combine, or reinterpret the available fields. If a
design needs data that is not exposed here, request a backend addition instead
of forcing the design to fit the current response shape.

The previously generated Dashboard concept was rejected and is not a design
reference.

## Local API

Repository:

```text
<repository-root>
```

Start the backend:

```sh
cd kina-activity-dashboard
python3 -m backend.server
```

Default address:

```text
http://127.0.0.1:8765
```

The API deliberately does not enable broad CORS. During frontend development,
proxy `/api` to `http://127.0.0.1:8765` through the chosen development server.
This is a transport detail, not a frontend architecture requirement.

## Endpoints

### Health

```http
GET /api/health
```

Reports whether the local ActivityWatch source and the Obsidian daily-note
directory are available.

Important fields:

- `ok`
- `activitywatch_available`
- `journal_root_available`
- `activitywatch.api_version`
- `activitywatch.api_error`
- `journal.vault`
- `journal.daily_directory`

### One Day

```http
GET /api/day?date=YYYY-MM-DD&mode=calendar
```

Parameters:

- `date`: required local date.
- `mode=calendar`: `00:00` to the next `00:00`.
- `mode=routine`: currently `06:00` to the next `06:00`.
- `refresh=1`: refresh only the selected date instead of using its cache.

The response currently contains:

- request context and cache information;
- ActivityWatch-derived activity blocks;
- category and explicit-project aggregates;
- parsed daily-note content;
- offline activities declared in the note;
- source, classification, parsing, and overlap quality information;
- several convenience metrics.

The top-level groups are organizational response fields, not required UI
sections.

### Date Range

```http
GET /api/range?start=YYYY-MM-DD&end=YYYY-MM-DD&mode=calendar
```

- The range is inclusive.
- The current maximum is 31 days.
- Longer explorations should request consecutive chunks lazily rather than
  increasing this limit or firing a broad parallel burst. The current
  trailing-365-day and calendar-year heatmaps both use sequential chunks of at
  most 31 days and reuse the existing per-day cache. A current calendar-year
  view stops requests at today and renders later dates as empty cells; this is
  an implementation example, not a UI requirement.
- It returns compact day-level aggregates.
- It intentionally excludes full journal bodies and detailed timelines.
- Each range day may include `rhythm`, containing the first/last active
  timestamps and 24 mode-aligned hourly active-second buckets.
- Add `include=uncategorized_apps` to receive a whole-range Top 5 application
  summary for uncategorized screen time.
- It is available for any cross-day exploration; it does not imply that the
  frontend must contain a seven-day chart.

## Available Day Data

Copyable TypeScript declarations are in
`docs/fable-api-types.ts`.

### Time context

- `date`
- `mode`
- `timezone`
- `generated_at`
- `cache.hit`
- `cache.journal_fingerprint`

`journal_fingerprint.mtime_ns` is an opaque decimal string, not a JavaScript
number. Nanosecond timestamps exceed the safe integer range, so the UI must
round-trip this object unchanged when saving.

### Activity evidence

`timeline` contains chronologically ordered blocks.

A screen block can expose:

- start and end timestamps;
- duration;
- ActivityWatch source;
- application name;
- window title;
- category id and label;
- explicit project value when the upstream event contains one.

An offline block can expose:

- start and end timestamps;
- duration;
- category entered in the journal;
- optional project;
- optional note or output;
- whether it crosses midnight;
- the original Markdown line.

The current screen timeline merges immediately adjacent events only when
category, project, application, title, and source all match. It is more
detailed than category totals but is not the untouched raw ActivityWatch
event stream. If the design requires raw events, event search, grouping by
domain, or a different aggregation level, request that backend capability.

### Category data

Each item in `categories` contains:

- stable category id;
- user-facing label from Kina;
- duration;
- event count;
- share of effective active time.

`quality.uncategorized_seconds` is kept separately. A day can be complete at
the data-source level while still having low classification coverage.

### Project data

`projects` currently aggregates only:

- an explicit `project` field present in an ActivityWatch event; or
- a project explicitly entered in an offline activity.

It does not infer a project from generic application names or window titles.
Empty project results are normal. If the design needs inferred topics,
Obsidian-link-based project grouping, or user-correctable attribution, treat
that as a new backend/product capability.

### Data quality

`quality` exposes:

- `complete`: whether every enabled ActivityWatch source succeeded;
- `issues`: missing-source and query errors;
- `uncategorized_seconds`;
- `parse_warnings`: malformed journal structures that were preserved;
- `overlap_warnings`: screen/offline time overlaps;
- `sources`: source-specific counts, duration, bucket and AFK information;
- `time_accounting`: AFK removal, background removal, overlap adjustment and
  the upstream accounting policy.

These fields make it possible to communicate uncertainty, but they do not
dictate a warning panel or any other presentation.

### Convenience metrics

`overview` currently supplies:

- `active_seconds`;
- `offline_seconds`;
- `combined_nonoverlap_seconds`;
- `classification_coverage`;
- `review_completed`;
- `longest_focus_seconds`;
- `meaningful_switches`.

The first values summarize existing source and overlap accounting.
`longest_focus_seconds` and `meaningful_switches` are initial heuristic
calculations based on category/project continuity and configured time gaps.
They are optional inputs, not product requirements or a productivity score.
Fable may omit them entirely.

## Information Available From Each Daily Note

Daily notes remain arbitrary Markdown. Every structured section is optional.
Missing sections return empty values rather than errors.

### Free journal body

`journal.body_markdown`

- Contains free text outside recognized structured sections.
- Preserves unknown `##` headings and their content.
- Preserves user text written after the consecutive numbered Kina advice.
- A note may consist only of this field.

### Personal summary

`journal.personal_summary_markdown`

Recognized headings:

- `## 我的总结`
- `## 今日总结`

### Outputs

`journal.outputs`

Recognized heading:

- `## 今日产出`

Returned as a list of Markdown-derived text items. Wikilinks remain in the
text.

### Next action

`journal.next_action_markdown`

Recognized heading:

- `## 明天的计划`
- `## 明日第一步`

### Workflow explanations

`journal.workflow_notes`

Workflow sessions are still derived in the frontend. A user-authored explanation
can be attached to a session by its stable start clock using this native,
collapsed-by-default daily Obsidian callout:

```markdown
> [!abstract]- 工作流
> **08:59–09:18**
> 明确了数据契约。
>
> **09:36–11:35**
> 继续完善 Dashboard。
```

Each entry's start clock is the canonical Dashboard key. Returned
fields are `start_time`, optional `end_time`, `note`, optional legacy Obsidian
`block_id`, and original `raw`. Canonical writes return an empty `block_id`.
If the same start time appears more
than once, the last line is the current interpretation. The end time is only
display context because a live session can continue growing. The parser keeps
read compatibility with multiple anchored callouts, the earlier single-line
list format, and the short-lived plus-encoded legacy signature. A user-explicit
save may consolidate all recognized workflow descriptions in that selected
daily note into the canonical group while preserving their text.

`PUT /api/journal/workflow` accepts `date`, `start_time`, `end_time`, `note`,
and the `cache.journal_fingerprint` observed by the page. It creates or replaces
only the entry matching that start time, then serializes the selected day as one
workflow callout. A stale file fingerprint, a duplicate start time, or a
conflicting legacy block id returns `409` without changing the note.
The fingerprint's `mtime_ns` field is a decimal string and must not be parsed as
a JavaScript number.
Writes are configuration-gated, per-note locked, staged beside the note and
atomically replaced. There is no autosave, background write, delete operation,
bulk migration, or browser-side note database.

### Editable review fields

`journal.personal_summary_markdown`, `journal.outputs`, and
`journal.next_action_markdown` are editable through the restricted
`PUT /api/journal/review` endpoint. The request accepts the selected `date`, one
whitelisted `field`, non-empty `markdown`, and the exact
`cache.journal_fingerprint` observed by the page. It never accepts a client file
path.

The canonical Obsidian representation is one collapsed daily callout:

```markdown
> [!abstract]- 复盘
> **我的总结**
> 今天真正推进的内容。
>
> **今日产出**
> - 可验证产出
>
> **明天的计划**
> 明天想推进的事情、顺序和判断，可以写成多段。
```

Only non-empty fields are rendered. A user-explicit save may consolidate the
recognized legacy `## 我的总结` / `## 今日总结`, `## 今日产出`, and
`## 明日第一步` sections in that selected note. New writes use `明天的计划`,
while the API field remains `next_action`. It does not change the review
completion task, free journal body, Kina-generated sections, offline activity,
properties, workflows, or other dates. The same fingerprint, per-note lock,
atomic replacement, and `409` conflict rules as workflow saves apply. There is
no autosave, field deletion, or background migration.

### Weekly review entry

`PUT /api/journal/weekly` accepts one validated ISO `week_id` such as
`2026-W29`. It maps that value to the single canonical
`Review/Weekly/2026-W29.md` path, creates the template only when the file is
absent, and returns a stable `obsidian://open` URI. Existing weekly notes are
never rewritten by this endpoint. Repeated calls therefore open the same file
instead of asking Obsidian to create name-suffixed copies.

### Generated activity summary

`journal.activity_summary_markdown`

Recognized heading:

- `## 一天活动小总结`

This is existing Kina-generated Markdown, not a new Dashboard interpretation.

### Kina advice

`journal.kina_advice`

Recognized heading:

- `## Kina 建议`

Only consecutive numbered items starting at `1` are returned as advice.
Trailing unheaded user writing is returned to `body_markdown`.

### Review completion

- `journal.completion_task_exists`
- `journal.completion_task_checked`

Recognized task:

```markdown
- [ ] 完成复盘
- [x] 完成复盘
```

### Obsidian navigation

- `journal.exists`
- `journal.path`
- `journal.absolute_path`
- `journal.obsidian_url`

`obsidian_url` can open the selected note in the local Studio vault.

### Wikilinks

`journal.projects`

Contains unique `[[wikilink]]` targets found in the note. The name is
historical: these links are evidence present in the journal, not a guarantee
that every link represents a software project.

### Offline activities

Recognized heading:

```markdown
## 离线活动
```

Recognized line format:

```text
- HH:MM-HH:MM | 类别 | [[可选项目]] | 可选产出或备注
```

Available fields include:

- `start_time`, `end_time`;
- normalized absolute `start`, `end`;
- `duration_seconds`;
- `category`;
- optional `project`;
- optional `note`;
- `crosses_midnight`;
- original `raw` line.

Malformed lines are not discarded:

- original lines appear in `journal.offline_unparsed`;
- explanations appear in `journal.parse_warnings` and
  `quality.parse_warnings`.

Screen/offline overlap is reported but not automatically judged:

- both records remain available;
- overlap appears in `quality.overlap_warnings`;
- `combined_nonoverlap_seconds` avoids double-counting it.

## Normal States The Frontend May Encounter

- A full note with generated review, advice and free text.
- A note containing only free Markdown.
- A missing note with `journal.exists = false`.
- Empty optional sections.
- ActivityWatch available but classification coverage low.
- ActivityWatch partially or completely unavailable while the journal remains
  readable.
- No explicit project data.
- Invalid offline lines accompanied by parse warnings.
- Offline activity overlapping screen activity.
- Cached and freshly generated responses.

This list describes data states for robustness. It does not prescribe screens,
routes, components, empty-state copy, or how many of these states belong in the
first iteration.

## Local Privacy Boundary

Window titles, journal text, paths, projects, and advice are private local
data. The product remains local-only and read-mostly:

- do not send this data to external services;
- do not add analytics or remote fonts that transmit page activity;
- write daily notes only through the explicit restricted workflow-description
  and review-field endpoints, and weekly notes only through idempotent
  create-if-absent; every other note region remains read-only;
- do not modify ActivityWatch data;
- keep API access on the local machine.

## Backend Extension Rule

The current API is a starting data surface, not the final product boundary.
When Fable's design needs another capability, describe the desired user
question and required data. Backend additions can then be evaluated without
making the current endpoint groups dictate the interface.
