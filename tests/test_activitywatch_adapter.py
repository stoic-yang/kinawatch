from __future__ import annotations

import unittest
from datetime import date, timedelta
from typing import Any

from backend.activitywatch_adapter import ActivityWatchAdapter, ActivityWatchRESTClient
from backend.config import load_settings
from backend.paths import EXAMPLE_CONFIG_PATH


class FakeActivityWatchClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any, Any]] = []

    def info(self) -> dict[str, Any]:
        return {"hostname": "test-host", "version": "v0.test"}

    def buckets(self) -> dict[str, dict[str, Any]]:
        return {
            "window-test": {
                "type": "currentwindow",
                "client": "aw-watcher-window",
                "hostname": "test-host",
            },
            "afk-test": {
                "type": "afkstatus",
                "client": "aw-watcher-afk",
                "hostname": "test-host",
            },
        }

    def events(self, bucket_id: str, start: Any, end: Any) -> list[dict[str, Any]]:
        self.calls.append((bucket_id, start, end))
        event_start = start + timedelta(hours=1)
        if bucket_id == "window-test":
            return [
                {
                    "timestamp": event_start.isoformat(),
                    "duration": 120.0,
                    "data": {"app": "Code", "title": "KinaWatch"},
                }
            ]
        if bucket_id == "afk-test":
            return [
                {
                    "timestamp": event_start.isoformat(),
                    "duration": 90.0,
                    "data": {"status": "not-afk"},
                }
            ]
        raise AssertionError(f"unexpected bucket: {bucket_id}")


class ActivityWatchAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.settings = load_settings(EXAMPLE_CONFIG_PATH)
        self.client = FakeActivityWatchClient()
        self.adapter = ActivityWatchAdapter(self.settings, client=self.client)

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

    def test_load_day_discovers_buckets_and_filters_afk_via_rest(self) -> None:
        payload = self.adapter.load_day(date(2026, 7, 15), "calendar")

        self.assertEqual([call[0] for call in self.client.calls], ["window-test", "afk-test"])
        self.assertEqual(payload["bucket_id"], "window-test")
        self.assertEqual(payload["coverage"], 1.0)
        self.assertEqual(payload["events"][0]["category"], "coding")
        self.assertEqual(payload["time_accounting"]["wall_duration_seconds"], 90.0)
        self.assertEqual(payload["time_accounting"]["afk_removed_seconds"], 30.0)
        self.assertEqual(
            payload["time_accounting"]["policy"],
            "activitywatch_rest_afk_intersection",
        )

    def test_health_reports_rest_integration_without_database_access(self) -> None:
        health = self.adapter.health()

        self.assertTrue(health["available"])
        self.assertEqual(health["api_version"], "v0.test")
        self.assertEqual(health["integration"], "activitywatch-rest")
        self.assertEqual(health["window_bucket_id"], "window-test")

    def test_remote_activitywatch_server_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "loopback"):
            ActivityWatchRESTClient("https://example.com")


if __name__ == "__main__":
    unittest.main()
