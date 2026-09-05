from __future__ import annotations

import unittest
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
from typing import Any

from backend.activitywatch_adapter import (
    ActivityWatchAdapter,
    ActivityWatchError,
    ActivityWatchRESTClient,
)
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
                    "id": 42,
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


class FakeMediaActivityWatchClient(FakeActivityWatchClient):
    def __init__(self, title: str) -> None:
        super().__init__()
        self.title = title

    def events(self, bucket_id: str, start: Any, end: Any) -> list[dict[str, Any]]:
        self.calls.append((bucket_id, start, end))
        event_start = start + timedelta(hours=1)
        if bucket_id == "window-test":
            return [
                {
                    "id": 84,
                    "timestamp": event_start.isoformat(),
                    "duration": 600.0,
                    "data": {"app": "Google Chrome", "title": self.title},
                }
            ]
        if bucket_id == "afk-test":
            return [
                {
                    "timestamp": event_start.isoformat(),
                    "duration": 120.0,
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

    def test_foreground_media_is_recovered_without_disabling_afk(self) -> None:
        self.settings.activitywatch["media_activity"] = {
            "enabled": True,
            "rules": [
                {
                    "app_equals": ["Google Chrome"],
                    "title_contains": ["Audio playing"],
                }
            ],
        }
        client = FakeMediaActivityWatchClient("Lecture - Audio playing")
        adapter = ActivityWatchAdapter(self.settings, client=client)

        payload = adapter.load_day(date(2026, 7, 15), "calendar")
        accounting = payload["time_accounting"]

        self.assertEqual(accounting["wall_duration_seconds"], 600.0)
        self.assertEqual(accounting["interactive_wall_seconds"], 120.0)
        self.assertEqual(accounting["foreground_media_wall_seconds"], 600.0)
        self.assertEqual(accounting["passive_media_seconds"], 480.0)
        self.assertEqual(accounting["afk_removed_before_media_seconds"], 480.0)
        self.assertEqual(accounting["afk_removed_seconds"], 0.0)
        self.assertEqual(
            accounting["policy"],
            "activitywatch_rest_afk_plus_foreground_media",
        )
        self.assertTrue(payload["events"][0]["media_playing"])

    def test_paused_media_title_remains_afk_filtered(self) -> None:
        self.settings.activitywatch["media_activity"] = {
            "enabled": True,
            "rules": [
                {
                    "app_equals": ["Google Chrome"],
                    "title_contains": ["Audio playing"],
                }
            ],
        }
        client = FakeMediaActivityWatchClient("Lecture paused")
        adapter = ActivityWatchAdapter(self.settings, client=client)

        payload = adapter.load_day(date(2026, 7, 15), "calendar")
        accounting = payload["time_accounting"]

        self.assertEqual(accounting["wall_duration_seconds"], 120.0)
        self.assertEqual(accounting["passive_media_seconds"], 0.0)
        self.assertEqual(accounting["afk_removed_seconds"], 480.0)
        self.assertFalse(payload["events"][0].get("media_playing", False))

    def test_load_days_queries_each_bucket_once_and_splits_the_batch(self) -> None:
        self.settings.activitywatch["timezone"] = "Asia/Shanghai"
        first = date(2026, 7, 15)
        second = date(2026, 7, 16)

        payloads = self.adapter.load_days([first, second], "calendar")

        self.assertEqual(
            [call[0] for call in self.client.calls],
            ["window-test", "afk-test"],
        )
        self.assertEqual(
            self.client.calls[0][1].isoformat(),
            "2026-07-14T16:00:00+00:00",
        )
        self.assertEqual(
            self.client.calls[0][2].isoformat(),
            "2026-07-16T16:00:00+00:00",
        )
        self.assertEqual(
            payloads[first]["time_accounting"]["wall_duration_seconds"], 90.0
        )
        self.assertEqual(
            payloads[second]["time_accounting"]["wall_duration_seconds"], 0
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

    def test_activitywatch_redirect_is_rejected_before_leaving_loopback(self) -> None:
        class RedirectHandler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                self.send_response(302)
                self.send_header("Location", "http://127.0.0.1:1/not-activitywatch")
                self.end_headers()

            def log_message(self, format: str, *args: Any) -> None:
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            host, port = server.server_address
            client = ActivityWatchRESTClient(f"http://{host}:{port}")
            with self.assertRaisesRegex(ActivityWatchError, "HTTP 302"):
                client.info()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_activitywatch_url_rejects_credentials_query_and_fragment(self) -> None:
        invalid_urls = (
            "http://user:secret@127.0.0.1:5600",
            "http://127.0.0.1:5600?target=remote",
            "http://127.0.0.1:5600#redirect",
        )
        for value in invalid_urls:
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "must not include"):
                    ActivityWatchRESTClient(value)


if __name__ == "__main__":
    unittest.main()
