# Annual activity

Both the rolling year and calendar year use
`overview.mac_non_entertainment_seconds` from the day/range API. Totals, active
days, daily averages, heat levels and cell tooltips share this metric.

It sums Mac screen events (`activitywatch-rest` and the configured
`kinawatch-local` recovery source) after AFK/background filtering, explicit
foreground-media recovery and category corrections. Events whose final category
is `entertainment` are excluded. Other categories, including coursework and
uncategorized activity, remain included; this is screen time, not a claim that
every included minute was productive work.

Use `device_duration_seconds`, falling back to `duration_seconds` for native
events without mobile partitioning. This retains within-Mac overlap allocation
without reducing Mac time when a phone or tablet is used concurrently. Mobile
and journal offline activities contribute nothing to this metric. The all-device
daily totals, weekly device rows and workflows keep their existing semantics.

Day cache schema 16 invalidates historical totals. Missing or invalid annual
values remain incomplete in the UI and never fall back to multi-device totals.
The existing routine-day boundary, fixed heat scale and incomplete-source
handling continue to apply.
