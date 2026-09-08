from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from zoneinfo import ZoneInfo

from backend.activitywatch_adapter import ActivityWatchAdapter
from backend.cache import DayCache
from backend.config import fingerprint_file, load_settings
from backend.day_aggregator import DayAggregator, _device_summary
from backend.multi_device_activity import partition_devices


FIXTURES = Path(__file__).parent / "fixtures"


class CountingJournalRepository:
    def __init__(self, note: Path):
        self.note = note
        self.read_count = 0

    def locate(self, day: date) -> Any:
        return SimpleNamespace(
            relative_path=f"Review/Daily/{day.isoformat()}.md",
            note=self.note,
            obsidian_url=f"obsidian://open?vault=Studio&file=Review/Daily/{day.isoformat()}",
            fingerprint=fingerprint_file(self.note),
        )

    def read(self, location: Any) -> str:
        self.read_count += 1
        return self.note.read_text(encoding="utf-8")


class CountingActivityWatch:
    def __init__(self) -> None:
        self.load_count = 0
        self.batch_count = 0

    def timezone_name(self) -> str:
        return "Asia/Shanghai"

    def date_range(
        self,
        day: date,
        mode: str,
        timezone_name: str,
    ) -> tuple[datetime, datetime]:
        start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
        return start, start + timedelta(days=1)

    def load_day(self, day: date, mode: str) -> dict[str, Any]:
        self.load_count += 1
        return self._payload()

    def load_days(
        self, days: list[date], mode: str
    ) -> dict[date, dict[str, Any]]:
        self.batch_count += 1
        return {day: self._payload() for day in days}

    @staticmethod
    def _payload() -> dict[str, Any]:
        event = {
            "timestamp": "2026-07-15T20:45:00+08:00",
            "duration_seconds": 600.0,
            "bucket_id": "window-test",
            "event_id": "42",
            "source_fingerprint": "source-42",
            "app": "Editor",
            "title": "KinaWatch",
            "project": "Dashboard",
            "source": "mac",
            "category": "coding",
            "category_label": "编码/刷题",
        }
        return {
            "range": {
                "start_utc": "2026-07-14T16:00:00+00:00",
                "end_utc": "2026-07-15T16:00:00+00:00",
                "timezone": "Asia/Shanghai",
            },
            "sources": [{"name": "mac", "ok": True}],
            "time_accounting": {
                "policy": "split_parallel_sources_prefer_foreground",
                "wall_duration_seconds": 600.0,
                "afk_removed_seconds": 100.0,
                "background_window_removed_seconds": 0.0,
            },
            "complete": True,
            "issues": [],
            "events": [event],
            "categories": [
                {
                    "category": "coding",
                    "label": "编码/刷题",
                    "duration_seconds": 600.0,
                    "event_count": 1,
                    "share": 1.0,
                }
            ],
            "uncategorized": {"duration_seconds": 0.0},
            "coverage": 1.0,
            "total_duration_seconds": 600.0,
        }


class FlakyActivityWatch(CountingActivityWatch):
    def __init__(self) -> None:
        super().__init__()
        self.fail_day_once = True
        self.fail_batch_once = True

    def load_day(self, day: date, mode: str) -> dict[str, Any]:
        self.load_count += 1
        if self.fail_day_once:
            self.fail_day_once = False
            raise RuntimeError("temporary ActivityWatch failure")
        return self._payload()

    def load_days(
        self,
        days: list[date],
        mode: str,
    ) -> dict[date, dict[str, Any]]:
        self.batch_count += 1
        if self.fail_batch_once:
            self.fail_batch_once = False
            raise RuntimeError("temporary ActivityWatch batch failure")
        return {day: self._payload() for day in days}


class CorrectableActivityWatch(CountingActivityWatch):
    def __init__(self) -> None:
        super().__init__()
        self.corrections: dict[date, str] = {}
        self.batch_days: list[list[date]] = []

    def correction_fingerprint(self, day: date) -> str:
        return self.corrections.get(day, "none")

    def load_days(
        self,
        days: list[date],
        mode: str,
    ) -> dict[date, dict[str, Any]]:
        self.batch_days.append(list(days))
        return super().load_days(days, mode)


class DayAggregatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        temporary_path = Path(self.temporary.name)
        self.note = temporary_path / "2026-07-15.md"
        shutil.copyfile(FIXTURES / "daily_full.md", self.note)
        self.settings = load_settings()
        self.journals = CountingJournalRepository(self.note)
        self.activitywatch = CountingActivityWatch()
        self.cache = DayCache(self.settings, temporary_path / "cache")
        self.aggregator = DayAggregator(
            self.settings,
            journal_repository=self.journals,
            activitywatch=self.activitywatch,
            cache=self.cache,
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_day_combines_journal_activity_and_overlap_without_double_count(self) -> None:
        payload = self.aggregator.get_day(date(2026, 7, 15), "calendar")

        self.assertFalse(payload["cache"]["hit"])
        self.assertIsInstance(
            payload["cache"]["journal_fingerprint"]["mtime_ns"],
            str,
        )
        self.assertEqual(payload["journal"]["path"], "Review/Daily/2026-07-15.md")
        self.assertEqual(payload["journal"]["provider"], "obsidian")
        self.assertEqual(
            payload["journal"]["open_url"],
            "obsidian://open?vault=Studio&file=Review/Daily/2026-07-15",
        )
        self.assertEqual(payload["journal"]["activity_summary_markdown"], "编码/刷题 2.0h。")
        self.assertEqual(len(payload["journal"]["kina_advice"]), 2)
        self.assertIn("用户在建议后的自由正文", payload["journal"]["body_markdown"])
        self.assertTrue(payload["overview"]["review_has_content"])
        self.assertEqual(payload["overview"]["active_seconds"], 600)
        self.assertEqual(payload["overview"]["offline_seconds"], 4200)
        self.assertEqual(payload["overview"]["combined_nonoverlap_seconds"], 4200)
        self.assertEqual(sum(device["active_seconds"] for device in payload["rhythm"]["devices"]), 4200)
        self.assertEqual(next(device for device in payload["rhythm"]["devices"] if device["device"] == "offline")["active_seconds"], 3600)
        self.assertEqual(len(payload["quality"]["overlap_warnings"]), 1)
        self.assertEqual(
            payload["quality"]["overlap_warnings"][0]["overlap_seconds"],
            600,
        )
        projects = {item["project"]: item for item in payload["projects"]}
        self.assertEqual(projects["Dashboard"]["screen_seconds"], 600)
        self.assertEqual(projects["矩阵代数"]["offline_seconds"], 3000)
        screen_block = next(
            block
            for block in payload["timeline"]
            if block["kind"] == "screen"
        )
        self.assertEqual(
            screen_block["event_refs"],
            [{"bucket_id": "window-test", "event_id": "42"}],
        )

    def test_second_request_skips_note_read_and_activitywatch_load(self) -> None:
        first = self.aggregator.get_day(date(2026, 7, 15), "calendar")
        second = self.aggregator.get_day(date(2026, 7, 15), "calendar")

        self.assertFalse(first["cache"]["hit"])
        self.assertTrue(second["cache"]["hit"])
        self.assertIsInstance(
            second["cache"]["journal_fingerprint"]["mtime_ns"],
            str,
        )
        self.assertEqual(self.journals.read_count, 1)
        self.assertEqual(self.activitywatch.load_count, 1)

    def test_changed_note_invalidates_only_selected_day(self) -> None:
        self.aggregator.get_day(date(2026, 7, 15), "calendar")
        self.note.write_text(
            self.note.read_text(encoding="utf-8") + "\n新增内容\n",
            encoding="utf-8",
        )
        os.utime(self.note, None)
        refreshed = self.aggregator.get_day(date(2026, 7, 15), "calendar")

        self.assertFalse(refreshed["cache"]["hit"])
        self.assertEqual(self.journals.read_count, 2)
        self.assertEqual(self.activitywatch.load_count, 2)

    def test_range_batches_uncached_days_and_reuses_the_day_cache(self) -> None:
        selected = [date(2026, 7, 15), date(2026, 7, 16)]

        first = self.aggregator.get_days(selected, "calendar")
        second = self.aggregator.get_days(selected, "calendar")

        self.assertEqual(
            [payload["date"] for payload in first],
            [day.isoformat() for day in selected],
        )
        self.assertEqual(len(second), 2)
        self.assertEqual(self.activitywatch.batch_count, 1)
        self.assertEqual(self.activitywatch.load_count, 0)
        self.assertTrue(all(payload["cache"]["hit"] for payload in second))

    def test_activity_correction_invalidates_only_its_selected_day(self) -> None:
        selected = [date(2026, 7, 15), date(2026, 7, 16)]
        activitywatch = CorrectableActivityWatch()
        aggregator = DayAggregator(
            self.settings,
            journal_repository=self.journals,
            activitywatch=activitywatch,
            cache=self.cache,
        )
        aggregator.get_days(selected, "calendar")
        activitywatch.corrections[selected[0]] = "edited"

        refreshed = aggregator.get_days(selected, "calendar")

        self.assertFalse(refreshed[0]["cache"]["hit"])
        self.assertTrue(refreshed[1]["cache"]["hit"])
        self.assertEqual(activitywatch.batch_days, [selected, [selected[0]]])

    def test_routine_rhythm_is_aligned_to_six_am_and_deduplicates_midnight(self) -> None:
        zone = ZoneInfo("Asia/Shanghai")
        summary = self.aggregator._rhythm_summary(
            date(2026, 7, 15),
            "routine",
            "Asia/Shanghai",
            [
                (
                    datetime(2026, 7, 15, 23, 30, tzinfo=zone),
                    datetime(2026, 7, 16, 0, 30, tzinfo=zone),
                )
            ],
            [
                (
                    datetime(2026, 7, 16, 0, 0, tzinfo=zone),
                    datetime(2026, 7, 16, 1, 0, tzinfo=zone),
                )
            ],
        )

        self.assertEqual(summary["first_active"], "2026-07-15T23:30:00+08:00")
        self.assertEqual(summary["last_active"], "2026-07-16T01:00:00+08:00")
        self.assertEqual(len(summary["hourly_active_seconds"]), 24)
        self.assertEqual(summary["hourly_active_seconds"][17], 1800)
        self.assertEqual(summary["hourly_active_seconds"][18], 3600)
        self.assertEqual(sum(summary["hourly_active_seconds"]), 5400)

    def test_empty_rhythm_keeps_null_bounds_and_twenty_four_zeroes(self) -> None:
        summary = self.aggregator._rhythm_summary(
            date(2026, 7, 15),
            "calendar",
            "Asia/Shanghai",
            [],
            [],
        )

        self.assertIsNone(summary["first_active"])
        self.assertIsNone(summary["last_active"])
        self.assertEqual(summary["hourly_active_seconds"], [0] * 24)

    def test_incomplete_day_is_not_cached_and_recovers_on_next_request(self) -> None:
        flaky = FlakyActivityWatch()
        aggregator = DayAggregator(
            self.settings,
            journal_repository=self.journals,
            activitywatch=flaky,
            cache=self.cache,
        )

        failed = aggregator.get_day(date(2026, 7, 15), "calendar")
        recovered = aggregator.get_day(date(2026, 7, 15), "calendar")

        self.assertFalse(failed["quality"]["complete"])
        self.assertTrue(recovered["quality"]["complete"])
        self.assertFalse(recovered["cache"]["hit"])
        self.assertEqual(flaky.load_count, 2)

    def test_incomplete_batch_days_are_not_cached(self) -> None:
        flaky = FlakyActivityWatch()
        aggregator = DayAggregator(
            self.settings,
            journal_repository=self.journals,
            activitywatch=flaky,
            cache=self.cache,
        )
        selected = [date(2026, 7, 15), date(2026, 7, 16)]

        failed = aggregator.get_days(selected, "calendar")
        recovered = aggregator.get_days(selected, "calendar")

        self.assertTrue(all(not item["quality"]["complete"] for item in failed))
        self.assertTrue(all(item["quality"]["complete"] for item in recovered))
        self.assertEqual(flaky.batch_count, 2)

    def test_calendar_offline_activity_is_clipped_at_the_day_boundary(self) -> None:
        self.note.write_text(
            "## 离线活动\n"
            "- 23:00-01:00 | 学习 | [[夜间项目]]\n",
            encoding="utf-8",
        )

        payload = self.aggregator.get_day(
            date(2026, 7, 15),
            "calendar",
        )

        self.assertEqual(payload["overview"]["offline_seconds"], 3600)
        offline = payload["journal"]["offline_activities"][0]
        self.assertEqual(offline["duration_seconds"], 3600)
        self.assertEqual(offline["start"], "2026-07-15T23:00:00+08:00")
        self.assertEqual(offline["end"], "2026-07-16T00:00:00+08:00")
        self.assertEqual(sum(payload["rhythm"]["hourly_active_seconds"]), 4200)

    def test_overlap_attribution_preserves_each_blocks_wall_clock_end(self) -> None:
        raw_events = [
            {
                "timestamp": "2026-07-15T09:00:00+08:00",
                "duration_seconds": 600.0,
                "app": app,
                "title": app,
                "category": "coding",
                "category_label": "编码",
                "source": "mac",
            }
            for app in ("Editor", "Terminal")
        ]
        adjusted, overlap_seconds = ActivityWatchAdapter._partition_overlaps(
            raw_events
        )

        blocks = self.aggregator._screen_blocks(adjusted)

        self.assertEqual(overlap_seconds, 600)
        self.assertEqual([item["duration_seconds"] for item in blocks], [300, 300])
        self.assertEqual(
            {item["end"] for item in blocks},
            {"2026-07-15T01:10:00+00:00"},
        )



class DeviceSummaryTests(unittest.TestCase):
    def test_three_device_overlap_keeps_raw_and_allocated_durations_separate(self):
        start = datetime(2026, 9, 2, tzinfo=timezone.utc)
        def event(label, a, b):
            return {"timestamp": (start + timedelta(seconds=a)).isoformat(),
                    "wall_end_timestamp": (start + timedelta(seconds=b)).isoformat(),
                    "duration_seconds": b - a, "device_id": label, "source": label,
                    "source_type": "apple-screentime" if label != "Mac" else "activitywatch-rest"}
        events, _, _ = partition_devices([event("Mac", 0, 600), event("iPhone", 300, 900), event("iPad", 300, 600)])
        sources = [{"label": label, "type": "activitywatch-rest" if label == "Mac" else "apple-screentime",
                    "duration_seconds": duration, "ok": True} for label, duration in [("Mac", 600), ("iPhone", 600), ("iPad", 300)]]
        devices = {row["device"]: row for row in _device_summary(events, sources, 0.0)}
        self.assertEqual(devices["mac"]["active_seconds"], 400)
        self.assertEqual(devices["ipad"]["active_seconds"], 100)
        self.assertEqual(devices["iphone"]["active_seconds"], 400)
        self.assertEqual(sum(row["active_seconds"] for row in devices.values()), 900)
        self.assertEqual(sum(row["observed_seconds"] for row in devices.values()), 1500)

    def test_missing_mobile_observations_are_unknown_and_unrecognized_devices_stay_separate(self):
        sources = [{"name": "Mac", "type": "activitywatch-rest", "ok": True, "duration_seconds": 0},
                   {"name": "iPhone", "type": "apple-screentime", "ok": True, "coverage": "unknown", "duration_seconds": 0},
                   {"name": "Tablet", "type": "apple-screentime", "ok": True, "duration_seconds": 20}]
        devices = {row["device"]: row for row in _device_summary([], sources, 0.0)}
        self.assertEqual(devices["mac"]["observed_seconds"], 0)
        self.assertIsNone(devices["iphone"]["observed_seconds"])
        self.assertEqual(devices["other"]["observed_seconds"], 20)
        self.assertNotIn("ipad", devices)

    def test_unavailable_mac_is_not_reported_as_zero_usage(self):
        result = _device_summary([], [{"name": "Mac", "type": "activitywatch-rest", "ok": False}], 0.0)
        self.assertEqual(result, [{"device": "mac", "label": "Mac", "active_seconds": 0, "observed_seconds": None}])


if __name__ == "__main__":
    unittest.main()
