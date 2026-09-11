# Beliefs library

The beliefs page uses an unnumbered title list, the existing application
navigation, and a right sidebar for search, sorting, scope, tags and creation.
All matching beliefs appear in one continuous page-scrolling list, without a
page-size cap or pagination. The header refresh action reloads the library while
retaining the current search, filters, sort and unsaved drafts.
Each newly saved belief is a complete UTF-8 Markdown file, including optional
YAML properties. Reading, source viewing and explicit editing are separate.

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
hashtags. Tag matching ignores case. Code spans, fences, escaped hashes and
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
from the projected title. Until saved, they continue reading the original
document. An explicit save copies that one section into a standalone Markdown
file and retains its existing votes, pin and position. The old file is never
rewritten or deleted. Editing an already copied section in the old file does
not replace the independent file. The legacy document API remains compatible
for older clients, but the new UI uses the library API.

`.kinawatch.json` holds manual order, first-saved creation times, pins and a set
of liked calendar dates for each ID. The current day uses the configured
ActivityWatch timezone and server clock. One day contributes at most one vote;
unliking removes only today's vote. Sorting by total likes uses manual order
to break ties. Filtering and automatic sorting do not rewrite manual order.

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
  modification timestamps, `liked_days`, `like_count`, `liked_today`, `pinned`.
- `PUT /api/beliefs/document`: exactly `namespace`, `id`, `markdown`,
  `expected_fingerprint` (null for a new ID). Maximum Markdown size: 2 MiB.
- `PUT /api/beliefs/state`: `namespace`, `expected_revision`, `action`, plus
  `order` for a complete ID permutation; or `id`, boolean `value` for `pin`;
  or `id`, boolean `value`, `day` for `like`. A stale day is rejected.

Mutations return a fresh complete library snapshot. Disabled writes return 403,
invalid inputs 400, stale fingerprints/revisions/namespaces 409. These routes
use the existing loopback Host/Origin validation and same-origin policy, and do
not invalidate activity caches or write daily notes or ActivityWatch events.

## Verification

Use `tests/test_belief_library.py` for temporary-file storage and HTTP checks,
and `frontend/tests/journal-beliefs.test.mjs` for parsing, ordering, daily
transitions and draft recovery. Browser write tests must use a temporary local
journal and isolated data directory; the live library is verified read-only.
