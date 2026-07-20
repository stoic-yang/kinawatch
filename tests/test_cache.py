from __future__ import annotations

import tempfile
import threading
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from backend.cache import DayCache
from backend.config import load_settings
from backend.models import FileFingerprint


class DayCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.settings = load_settings()
        self.cache = DayCache(self.settings, Path(self.temporary.name))
        self.day = date(2026, 7, 15)
        self.fingerprint = FileFingerprint("/tmp/note.md", 10, 20)
        self.response = {"date": self.day.isoformat(), "cache": {"hit": False}}

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_historical_cache_hits_until_fingerprint_changes(self) -> None:
        self.cache.put(
            self.day,
            "calendar",
            self.fingerprint,
            "upstream-a",
            self.response,
            now_epoch=100,
        )
        hit = self.cache.get(
            self.day,
            "calendar",
            self.fingerprint,
            "upstream-a",
            is_today=False,
            now_epoch=10_000,
        )
        self.assertIsNotNone(hit)
        self.assertTrue(hit["cache"]["hit"])

        miss = self.cache.get(
            self.day,
            "calendar",
            FileFingerprint("/tmp/note.md", 11, 20),
            "upstream-a",
            is_today=False,
        )
        self.assertIsNone(miss)

    def test_today_cache_expires_after_ttl(self) -> None:
        self.cache.put(
            self.day,
            "calendar",
            self.fingerprint,
            "upstream-a",
            self.response,
            now_epoch=100,
        )
        self.assertIsNotNone(
            self.cache.get(
                self.day,
                "calendar",
                self.fingerprint,
                "upstream-a",
                is_today=True,
                now_epoch=100 + self.settings.today_ttl_seconds,
            )
        )
        self.assertIsNone(
            self.cache.get(
                self.day,
                "calendar",
                self.fingerprint,
                "upstream-a",
                is_today=True,
                now_epoch=101 + self.settings.today_ttl_seconds,
            )
        )

    def test_refresh_and_per_date_invalidation_are_narrow(self) -> None:
        other_day = date(2026, 7, 14)
        self.cache.put(
            self.day,
            "calendar",
            self.fingerprint,
            "upstream-a",
            self.response,
        )
        self.cache.put(
            other_day,
            "calendar",
            self.fingerprint,
            "upstream-a",
            {"date": other_day.isoformat(), "cache": {"hit": False}},
        )
        self.assertIsNone(
            self.cache.get(
                self.day,
                "calendar",
                self.fingerprint,
                "upstream-a",
                is_today=False,
                refresh=True,
            )
        )
        other = self.cache.get(
            other_day,
            "calendar",
            self.fingerprint,
            "upstream-a",
            is_today=False,
        )
        self.assertEqual(other["date"], other_day.isoformat())

    def test_explicit_invalidation_removes_only_selected_date_variants(self) -> None:
        other_day = date(2026, 7, 14)
        for mode in ("calendar", "routine"):
            self.cache.put(
                self.day,
                mode,
                self.fingerprint,
                "upstream-a",
                self.response,
            )
        self.cache.put(
            other_day,
            "routine",
            self.fingerprint,
            "upstream-a",
            {"date": other_day.isoformat(), "cache": {"hit": False}},
        )

        self.cache.invalidate(self.day)

        self.assertEqual(list(self.cache.day_root.glob(f"{self.day.isoformat()}-*.json")), [])
        self.assertTrue(self.cache._path(other_day, "routine").is_file())

    def test_parallel_writes_use_distinct_atomic_temp_files(self) -> None:
        barrier = threading.Barrier(2)
        temporary_names: list[str] = []
        errors: list[BaseException] = []
        original_write_text = Path.write_text

        def synchronized_write(path: Path, *args: object, **kwargs: object) -> int:
            written = original_write_text(path, *args, **kwargs)
            temporary_names.append(path.name)
            barrier.wait(timeout=2)
            return written

        def writer() -> None:
            try:
                self.cache.put(
                    self.day,
                    "routine",
                    self.fingerprint,
                    "upstream-a",
                    self.response,
                )
            except BaseException as exc:  # Captured for assertion in main thread.
                errors.append(exc)

        with patch.object(Path, "write_text", synchronized_write):
            threads = [threading.Thread(target=writer) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=3)

        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(errors, [])
        self.assertEqual(len(set(temporary_names)), 2)
        cached = self.cache.get(
            self.day,
            "routine",
            self.fingerprint,
            "upstream-a",
            is_today=False,
        )
        self.assertIsNotNone(cached)
        self.assertEqual(cached["date"], self.day.isoformat())


if __name__ == "__main__":
    unittest.main()
