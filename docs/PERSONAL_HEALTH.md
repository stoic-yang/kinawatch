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

The UI provides 7/30-day windows, the shared calendar picker, period navigation,
missing-data markers, and shared date selection with the journal. The title,
date range, and controls use the same page geometry as the rhythm view.
Three shared `kw-card` surfaces group sleep duration, main sleep intervals,
and daily steps. Selected-day values, period averages, the main interval,
and additional sleep appear as `kw-metric-pill` summaries in card headings.
The main-interval chart still shows the final seven days of the chosen window;
its heading makes that scope explicit in the 30-day view.

Sleep duration and steps use thin lines and circular daily markers. Lines join
only adjacent recorded days: missing dates break the line, isolated readings
remain points, and an observed zero stays distinct from missing data. Scales
start at zero and expand to rounded ticks when needed. Hover or keyboard focus
shows the exact value in the shared viewport tooltip; clicking a day selects it.
Arrow keys, Home, and End move focus between dates. The main-interval chart uses
thin horizontal lines with start/end dots instead of solid bars.

The charts use shared heat colors and the selected-date accent. Narrow screens
stack the cards and wrap the summary pills; the 30-day view reduces date-label
density. The page-header update action
refreshes the local reader; the last synchronization/export timestamp and full
ZIP import action are under the native “数据来源” disclosure. Source errors and
waiting-for-sync instructions remain visible, and the initial empty state still
offers an import action. These presentation changes preserve sleep/steps
calculations, snapshot revisions, and the diary sidebar summary.
The update and import buttons use the same neutral surface, text, border, and
height as the date control. Loading keeps the button width and uses muted text.

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
