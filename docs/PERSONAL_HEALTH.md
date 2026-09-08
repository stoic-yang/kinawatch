# Personal health: sleep and steps

The `#health` page emphasizes sleep duration and the main sleep interval, with
steps as supporting context. It shares the selected date with the journal and
adds a compact, read-only health summary to the journal's right sidebar. There
are no heart-rate scores, medical thresholds, or generated journal entries.

## Import and storage

- An explicit file selection imports an Apple Health `export.zip`. This is a
  complete snapshot. Updates should use a newer full
  export; successful imports replace the previous derived snapshot.
- Only `apple_health_export/export.xml` (or root `export.xml`) is parsed. CDA
  is an alternate representation and is never counted again. ZIP paths are
  not extracted to disk. Limits: 64 MiB archive, 512 MiB XML, two million records.
- Only sleep and steps summaries are retained. Other health records, personal
  profile attributes, and the original ZIP/XML are not persisted by KinaWatch.
- The store is `health/snapshot.json` under the platform user-data directory
  returned by `backend.paths.default_data_dir()`. It is independent of the
  code checkout and journal provider. Reads with synchronization disabled never create the store.
- The service serializes imports, checks the prior revision, rejects older
  exports, and replaces the snapshot atomically using a private temporary file.
  Failed imports preserve the previous snapshot. No data leaves the loopback
  service, and no additional daemon is installed.

## One-click iCloud sync

The opt-in `health_sync` integration accepts the native iPhone shortcut export.
It updates recent summaries while preserving earlier history. See
[DEVICE_SYNC.md](DEVICE_SYNC.md) for setup, schema, permissions and limits.

## Calculation rules

All dates use the configured timezone and natural calendar days, independently
of the journal's optional shifted day boundary.

**Sleep:** actual asleep samples take precedence over in-bed samples. If
multiple sources remain, prefer Mi Fitness, then the source with longer daily
coverage. Within one source and basis, union overlapping intervals. Join stages
separated by at most 90 minutes into one session for display, without adding
the intervening gap to the duration. Assign each session to its ending date.
The longest session supplies the main interval; other sessions are shown as
additional sleep. Daily duration includes all selected sessions. In-bed-only
data retains its `in_bed` basis and must not be interpreted as measured time
asleep. Missing days remain unknown and are excluded from means.

**Steps:** remove identical source/device/interval/value records. Apportion
interval counts across natural hours by their elapsed duration, then sum them
into each source's natural-day total. Use the largest daily source total as
the day's count (`daily_source_max`), including on days with just one source.
Do not combine phone-only and band-only periods. This conservative rule can
omit activity captured only by the other device; it is not Apple's
source-priority aggregation. Retain source totals in the snapshot, while the
UI displays a single count. Exclude the incomplete export day from the mean.

Version 1 snapshots using `hourly_max_estimate` already contain daily source
totals. Reads derive the daily maximum from those totals in memory, preserving
the stored file and import revision. Existing imports therefore use the same
rule as new imports without requiring another export.

The UI provides 7/30-day windows, a themed calendar picker, period navigation,
missing-data markers, and shared date selection with the journal. Controls
share the title row. The five data regions sit in a centered, open layout with
no card outlines, more whitespace, subtle separators and bounded chart sizes.
The overview uses matching label/value/average rows for sleep and steps;
the main sleep interval follows below. The sleep overview has no journal link,
duplicate date or coverage badge, and device subtotals are hidden.
Short desktop windows use
tighter spacing so all five regions remain visible at 1280 by 720.
The on-page explanation footer has been removed; the calculation contract
remains documented here. Narrow layouts wrap and scroll naturally.

## API

- `GET /api/personal-health`: current snapshot, or `available: false` and
  revision `empty`. Distinct from the existing service-liveness `/api/health`.
- `POST /api/personal-health/import`: ZIP body, `Content-Type: application/zip`,
  bounded `Content-Length`, and `If-Match` containing the last snapshot revision.
  Returns the derived snapshot. Stale revisions return 409; invalid imports
  return 400. Existing Host, Origin, and Fetch Metadata checks apply.

The frontend holds one shared snapshot, blocks duplicate submissions, and
prevents a stale read from overwriting an import response. Refreshing the page
reads the persisted snapshot. Health imports never write ActivityWatch or notes.

## Verification

Use synthetic ZIP archives and temporary stores for write tests:

```sh
python3 -m unittest tests.test_personal_health -v
npm run test:journal --prefix frontend
python3 -m unittest discover -s tests -p 'test_*.py' -v
npm run build --prefix frontend
```

Browser checks cover initial import, 7/30-day navigation, missing days, journal
date handoff, narrow layouts, and light/dark palettes. Never commit real health
snapshots, exports, or screenshots containing personal records.
