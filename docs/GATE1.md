# Gate 1 Evidence

Re-verified on 2026-07-20 during the initial open-source cleanup.

## Gate 1A: Historical Date

Command:

```sh
python3 -m scripts.gate1
```

Historical date: `2026-07-15`.

- Journal path resolved to `Review/Daily/2026-07-15.md`.
- `一天活动小总结` was present.
- Five numbered `Kina 建议` items were parsed.
- Free journal text after the advice section was preserved.
- The completion task was recognized.
- Dashboard `active_seconds` exactly matched Kina's
  `time_accounting.wall_duration_seconds`: `10925.161`.
- Classification coverage was `1.0` under the current local classification
  rules.
- ActivityWatch reported `complete: true` and no issues.

## Gate 1B: Cache

- The first forced historical request returned `cache.hit = false`.
- The second request returned `cache.hit = true`.
- Instrumented tests confirmed the second request did not reopen the daily
  note and did not call the ActivityWatch loader.
- Changing one fixture fingerprint invalidated only that date.
- `/api/range` returned day-level aggregates without journal body or timeline
  payloads.

## Gate 1C: Energy

- The HTTP server blocks while idle; it has no polling or background thread.
- An idle live process measured `0.0%` CPU after serving requests.
- A live server configured with a two-second idle timeout exited automatically.
- Unit tests verify idle exit with and without a request.

## Test Suite

```text
Ran 56 tests in 1.797s
OK
```

The tests cover parsing, malformed offline activities, arbitrary date ranges,
upstream function reuse, cache TTL and invalidation, offline overlap accounting,
local-only HTTP behavior, and idle exit.

## Gate Verdict

Gate 1 passes. Frontend exploration and implementation may proceed. Gate 1
does not prescribe the interface, required metrics, page structure, or visual
direction.
