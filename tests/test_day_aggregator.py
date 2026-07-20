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

from backend.cache import DayCache
from backend.config import fingerprint_file, load_settings
from backend.day_aggregator import DayAggregator


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
        event = {
            "timestamp": "2026-07-15T20:45:00+08:00",
            "duration_seconds": 600.0,
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
        self.assertTrue(payload["overview"]["review_completed"])
        self.assertEqual(payload["overview"]["active_seconds"], 600)
        self.assertEqual(payload["overview"]["offline_seconds"], 4800)
        self.assertEqual(payload["overview"]["combined_nonoverlap_seconds"], 4800)
        self.assertEqual(len(payload["quality"]["overlap_warnings"]), 1)
        self.assertEqual(
            payload["quality"]["overlap_warnings"][0]["overlap_seconds"],
            600,
        )
        projects = {item["project"]: item for item in payload["projects"]}
        self.assertEqual(projects["Dashboard"]["screen_seconds"], 600)
        self.assertEqual(projects["矩阵代数"]["offline_seconds"], 3000)

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


if __name__ == "__main__":
    unittest.main()
