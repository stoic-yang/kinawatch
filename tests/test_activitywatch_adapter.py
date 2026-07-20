from __future__ import annotations

import unittest
from datetime import date
from typing import Any

from backend.activitywatch_adapter import ActivityWatchAdapter
from backend.config import load_settings


class FakeReport:
    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []

    def query_configured_events_between(
        self,
        config: dict[str, Any],
        bucket: str,
        start: Any,
        end: Any,
    ) -> dict[str, Any]:
        self.calls.append((bucket, start, end))
        event = {
            "timestamp": start.isoformat(),
            "duration_seconds": 120.0,
            "app": "Editor",
            "title": "Dashboard",
            "project": "Kina",
            "source": "mac",
        }
        return {
            "bucket_id": "window",
            "sources": [{"name": "mac", "ok": True}],
            "events": [event],
            "attributed_events": [event],
            "time_accounting": {
                "policy": "split_parallel_sources_prefer_foreground",
                "wall_duration_seconds": 120.0,
                "afk_removed_seconds": 30.0,
                "background_window_removed_seconds": 0.0,
            },
            "complete": True,
            "issues": [],
        }

    def aggregate_categorized_events(
        self,
        events: list[dict[str, Any]],
        classification: dict[str, Any],
        limit: int,
    ) -> dict[str, Any]:
        return {
            "total_duration_seconds": 120.0,
            "classified_duration_seconds": 120.0,
            "coverage": 1.0,
            "categories": [
                {
                    "category": "coding",
                    "label": "编码",
                    "duration_seconds": 120.0,
                    "event_count": 1,
                    "share": 1.0,
                }
            ],
            "uncategorized": {"duration_seconds": 0.0, "event_count": 0},
        }

    def classify_event(
        self,
        event: dict[str, Any],
        classification: dict[str, Any],
    ) -> dict[str, str]:
        return {"category": "coding", "rule": "editor", "rule_label": "编辑器"}


class TestAdapter(ActivityWatchAdapter):
    def _activity_config(self) -> dict[str, Any]:
        return {
            "timezone": "Asia/Shanghai",
            "default_bucket": "window",
        }

    def _classification_config(self) -> dict[str, Any]:
        return {"categories": {"coding": {"label": "编码"}}, "rules": []}


class ActivityWatchAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.settings = load_settings()
        self.report = FakeReport()
        self.adapter = TestAdapter(self.settings, report_module=self.report)

    def test_calendar_range_is_converted_to_utc(self) -> None:
        start, end = self.adapter.date_range(
            date(2026, 7, 15),
            "calendar",
            "Asia/Shanghai",
        )
        self.assertEqual(start.isoformat(), "2026-07-14T16:00:00+00:00")
        self.assertEqual(end.isoformat(), "2026-07-15T16:00:00+00:00")

    def test_routine_range_uses_configured_start(self) -> None:
        start, end = self.adapter.date_range(
            date(2026, 7, 15),
            "routine",
            "Asia/Shanghai",
        )
        self.assertEqual(start.isoformat(), "2026-07-14T22:00:00+00:00")
        self.assertEqual(end.isoformat(), "2026-07-15T22:00:00+00:00")

    def test_load_day_reuses_upstream_query_and_classification(self) -> None:
        payload = self.adapter.load_day(date(2026, 7, 15), "calendar")
        self.assertEqual(len(self.report.calls), 1)
        self.assertEqual(payload["coverage"], 1.0)
        self.assertEqual(payload["events"][0]["category"], "coding")
        self.assertEqual(payload["time_accounting"]["wall_duration_seconds"], 120)


if __name__ == "__main__":
    unittest.main()
