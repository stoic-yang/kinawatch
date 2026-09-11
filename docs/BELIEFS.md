# Beliefs library

The beliefs page uses an unnumbered title list, the existing application
navigation, and a right sidebar for search, sorting and tags. Creation
lives in the page header, above the list and browsing controls at every width.
The same header action resumes an unfinished new belief when a draft exists.
Search uses a compact field with a shared focus ring and an explicit clear
button; Escape also clears the query while keeping the input focused.
All matching beliefs appear in one continuous page-scrolling list, without a
page-size cap or pagination. The library reloads on page activation, window
focus and the daily transition, retaining search, filters, sort and drafts.
There is no permanent refresh button; failed reads offer a retry action.
Each newly saved belief is a complete UTF-8 Markdown file, including optional
YAML properties. The default editor presents the belief sentence first, followed
by lightweight tag chips and an optional expandable explanation. It has no
document-frame border, filename heading or visible YAML template. An empty
draft starts with only an empty H1; a `tags` property is added when needed.
Writing, raw Markdown editing and preview share one retained draft. Switching
views does not serialize the file again. Title/body edits preserve other source
ranges; tag edits replace only the YAML value and retain unrelated properties,
comments, BOM and line endings. Structures that cannot be edited this way stay
available in source view. Uncommitted tag input is included when saving, changing
views or returning to the list. All saves remain explicit and conflict-checked.

```markdown
---
tags: [practice, reflection]
aliases: [A useful reminder]
---

# Check the evidence before deciding

> Record the observation first.

An inline #reflection tag is also indexed.
```

The first H1 supplies the list title; a string `title` property is a fallback.
Tags support YAML lists, inline YAML arrays, a single string and inline
hashtags. The sidebar lists these tags directly with saved-belief counts;
clicking one filters the list. Tags in the active draft also appear immediately,
with new tags marked pending and unavailable for filtering until saved. Saving,
editing or refreshing rebuilds the index from the current Markdown files.
New beliefs start with an empty tag list; no tags or categories are preselected.
The All beliefs control resets search and tag filters. There is no favorites feature.
Tag labels render as plain words without a hash prefix. Existing nested tags
use a readable middle dot instead of a slash; filtering keeps the complete
original identity, and Markdown editing/source views retain the original syntax.
Tag matching ignores case. Code spans, fences, escaped hashes and
Markdown link labels do not create tags. Reading supports headings, emphasis,
lists, quotes, tables, links and code. HTML is escaped, and unsafe link schemes
are rejected. The original Markdown is retained; unknown properties are never
round-tripped through a serializer. Invalid properties remain visible in source
view and must be corrected before the editor saves.

## Storage

`journal.beliefs_dir` defaults to `Review/Beliefs` below the selected local or
Obsidian storage root. The browser supplies a stable ID, never a file path.
New files have a readable title plus a generated ID suffix. Editing a title
does not rename the file or lose its likes. Existing Markdown files placed in
this directory are discovered on demand. Preserve the ID suffix when renaming
a managed file; an ordinary file without one uses its filename as identity.
There is no background directory scan or provider-to-provider migration.

The old `journal.beliefs_note_path` remains intact. H2 sections outside fences
are presented individually, with leading numeric list labels removed only
from the projected title. Collection-level properties, including its tags,
are not inherited by these sections; tags inside each section remain indexed.
A legacy file without H2 sections remains one complete document with its own
properties. Until saved, the sections continue reading the original
document. An explicit save copies that one section into a standalone Markdown
file and retains its existing votes and position. The old file is never
rewritten or deleted. Editing an already copied section in the old file does
not replace the independent file. The legacy document API remains compatible
for older clients, but the new UI uses the library API.

`.kinawatch.json` holds manual order, first-saved creation times and a set
of liked calendar dates for each ID. The current day uses the configured
ActivityWatch timezone and server clock. One day contributes at most one vote;
unliking removes only today's vote. Sorting by total likes uses manual order
to break ties. Filtering and automatic sorting do not rewrite manual order.
Retired `pinned` metadata is ignored and left intact, never exposed or changed
through the API. New records do not create it.

Likes use an outline thumb at rest and a solid accent-colored thumb when liked
today. Only the icon and count change; the button and row stay transparent on
hover and selection. Clicking updates the count immediately, with a short thumb
animation and count transition; reduced-motion preferences disable both.
Requests remain serialized with revision checks, without fading the page while
saving a like. On failure, the view reconciles with the server or restores the
previous snapshot. The accessible label describes today's action and total
count, with a keyboard focus ring and a live status message.
The restrained click feedback draws on
[YouTube's official interaction design notes](https://blog.youtube/news-and-events/youtube-new-features-2023/).

Reads create nothing. All mutations require `journal_write_enabled`, matching
storage namespace, fixed directory confinement, no symlinks, a shared process
lock and an OS lock. Markdown uses SHA-256 content fingerprints, rechecked file
versions, same-directory temporary files, fsync and atomic replacement.
Management updates also require the current metadata SHA-256 revision.
Creation reserves identity and order before publishing Markdown; an interrupted
write can leave an unused metadata entry, which is ignored until the file exists.
No partial Markdown is published. Corrupt metadata is reported and preserved.

Unsaved browser drafts are scoped to the storage namespace. Saving is serialized
and explicit; request failures retain the draft. Retry reads the file first,
reconciling an already successful write without creating a duplicate. External
edits require version comparison and an explicit choice before overwrite.
Drafts from the previous whole-document editor are not deleted.

## API

- `GET /api/beliefs`: `namespace`, `revision`, `timezone`, `today`,
  `write_enabled`, `order`, and `records`. Each record includes stable `id`,
  complete `markdown`, `fingerprint`, relative `path`, `legacy`, creation and
  modification timestamps, `liked_days`, `like_count`, `liked_today`.
- `PUT /api/beliefs/document`: exactly `namespace`, `id`, `markdown`,
  `expected_fingerprint` (null for a new ID). Maximum Markdown size: 2 MiB.
- `PUT /api/beliefs/state`: `namespace`, `expected_revision`, `action`, plus
  `order` for a complete ID permutation; or `id`, boolean `value`, `day` for
  `like`. A stale day is rejected. The retired `pin` action is rejected.

Mutations return a fresh complete library snapshot. Disabled writes return 403,
invalid inputs 400, stale fingerprints/revisions/namespaces 409. These routes
use the existing loopback Host/Origin validation and same-origin policy, and do
not invalidate activity caches or write daily notes or ActivityWatch events.

## Verification

Use `tests/test_belief_library.py` for temporary-file storage and HTTP checks,
and `frontend/tests/journal-beliefs.test.mjs` for parsing, ordering, daily
transitions and draft recovery. Browser write tests must use a temporary local
journal and isolated data directory; the live library is verified read-only.
