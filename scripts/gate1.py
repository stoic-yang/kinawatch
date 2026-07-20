#!/usr/bin/env python3
from __future__ import annotations

import json
import tempfile
from datetime import date
from pathlib import Path

from backend.activitywatch_adapter import ActivityWatchAdapter
from backend.cache import DayCache
from backend.config import load_settings
from backend.day_aggregator import DayAggregator
from backend.journal_repository import JournalRepository


class CountingJournalRepository(JournalRepository):
    def __init__(self, settings):
        super().__init__(settings)
        self.read_count = 0

    def read(self, location):
        self.read_count += 1
        return super().read(location)


class CountingActivityWatch(ActivityWatchAdapter):
    def __init__(self, settings):
        super().__init__(settings)
        self.load_count = 0

    def load_day(self, day, mode):
        self.load_count += 1
        return super().load_day(day, mode)


def main() -> int:
    settings = load_settings()
    historical_day = date(2026, 7, 15)
    journals = CountingJournalRepository(settings)
    activitywatch = CountingActivityWatch(settings)

    with tempfile.TemporaryDirectory(prefix="kinawatch-gate1-") as directory:
        aggregator = DayAggregator(
            settings,
            journal_repository=journals,
            activitywatch=activitywatch,
            cache=DayCache(settings, Path(directory)),
        )
        first = aggregator.get_day(historical_day, "calendar", refresh=True)
        first_read_count = journals.read_count
        first_activity_count = activitywatch.load_count
        second = aggregator.get_day(historical_day, "calendar")
        direct_reload = activitywatch.load_day(historical_day, "calendar")

    checks = {
        "journal_path": first["journal"]["path"]
        == "Review/Daily/2026-07-15.md",
        "activity_summary_present": bool(
            first["journal"]["activity_summary_markdown"]
        ),
        "kina_advice_present": bool(first["journal"]["kina_advice"]),
        "free_body_present": bool(first["journal"]["body_markdown"]),
        "completion_task_recognized": first["journal"][
            "completion_task_exists"
        ],
        "activitywatch_total_is_stable": abs(
            first["overview"]["active_seconds"]
            - direct_reload["time_accounting"]["wall_duration_seconds"]
        )
        < 1e-6,
        "second_request_cache_hit": second["cache"]["hit"] is True,
        "second_request_skipped_journal_read": journals.read_count
        == first_read_count,
        "second_request_skipped_activitywatch_load": activitywatch.load_count
        == first_activity_count + 1,
    }
    payload = {
        "ok": all(checks.values()),
        "date": historical_day.isoformat(),
        "checks": checks,
        "active_seconds": first["overview"]["active_seconds"],
        "coverage": first["overview"]["classification_coverage"],
        "issues": first["quality"]["issues"],
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
