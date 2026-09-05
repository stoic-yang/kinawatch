from __future__ import annotations

import json
import tempfile
import unittest
from datetime import date
from pathlib import Path
from typing import Any

from backend.activity_edits import (
    ActivityEditConflict,
    ActivityEditStore,
    ActivityEditor,
    activity_event_key,
)
from backend.activitywatch_adapter import ActivityWatchAdapter
from backend.config import load_settings
from backend.paths import EXAMPLE_CONFIG_PATH


class EditableActivityWatchClient:
    def __init__(self) -> None:
        self.title = "KinaWatch"

    def info(self) -> dict[str, Any]:
        return {"hostname": "test-host", "version": "v0.test"}

    def buckets(self) -> dict[str, dict[str, Any]]:
        return {
            "window-test": {
                "type": "currentwindow",
                "client": "aw-watcher-window",
                "hostname": "test-host",
            }
        }

    def events(self, bucket_id: str, start: Any, end: Any) -> list[dict[str, Any]]:
        if bucket_id != "window-test":
            raise AssertionError(f"unexpected bucket: {bucket_id}")
        return [
            {
                "id": 42,
                "timestamp": "2026-07-15T10:00:00+00:00",
                "duration": 600.0,
                "data": {"app": "Code", "title": self.title},
            }
        ]


class ActivityEditTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        raw = json.loads(EXAMPLE_CONFIG_PATH.read_text(encoding="utf-8"))
        raw["activity_edit_enabled"] = True
        raw["cache_dir"] = str(self.root / "cache")
        raw["activitywatch"] = {
            **raw["activitywatch"],
            "timezone": "UTC",
            "filter_afk": False,
            "window_bucket_id": "window-test",
            "categories_file": str(
                EXAMPLE_CONFIG_PATH.parent / "categories.example.json"
            ),
        }
        raw["journal"] = {
            "provider": "local",
            "storage_dir": str(self.root / "journal"),
            "daily_notes_dir": "Daily",
            "daily_note_date_format": "%Y-%m-%d",
            "daily_note_template": [],
        }
        config_path = self.root / "kinawatch.json"
        config_path.write_text(json.dumps(raw), encoding="utf-8")
        self.settings = load_settings(config_path)
        self.store = ActivityEditStore(
            self.settings,
            self.root / "activity-edits.json",
        )
        self.client = EditableActivityWatchClient()
        self.adapter = ActivityWatchAdapter(
            self.settings,
            client=self.client,
            edit_store=self.store,
        )
        self.editor = ActivityEditor(
            self.settings,
            self.adapter,
            self.store,
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _inspect(self) -> dict[str, Any]:
        return self.editor.inspect(
            {
                "date": ["2026-07-15"],
                "mode": ["calendar"],
                "bucket_id": ["window-test"],
                "event_id": ["42"],
            }
        )

    def test_atomic_overlay_applies_and_undo_restores_the_raw_event(self) -> None:
        revision = self.store.revision_token()
        saved = self.store.upsert(
            day=date(2026, 7, 15),
            bucket_id="window-test",
            event_id="42",
            source_fingerprint="source-a",
            patch={
                "start": "2026-07-15T10:05:00+00:00",
                "end": "2026-07-15T10:20:00+00:00",
                "app": "Terminal",
                "category": "manual-focus",
                "category_label": "专注",
            },
            expected_revision=revision,
            custom_category=("manual-focus", "专注"),
        )
        event = {
            "bucket_id": "window-test",
            "event_id": "42",
            "source_fingerprint": "source-a",
            "timestamp": "2026-07-15T10:00:00+00:00",
            "duration_seconds": 600.0,
            "app": "Code",
            "title": "KinaWatch",
        }

        edited = self.store.apply_event(event)

        self.assertEqual(edited["app"], "Terminal")
        self.assertEqual(edited["duration_seconds"], 900.0)
        self.assertEqual(edited["manual_category_label"], "专注")
        self.assertNotEqual(
            self.store.fingerprint_for_day("2026-07-15"),
            self.store.fingerprint_for_day("2026-07-16"),
        )
        with self.assertRaises(ActivityEditConflict):
            self.store.upsert(
                day=date(2026, 7, 15),
                bucket_id="window-test",
                event_id="42",
                source_fingerprint="source-a",
                patch={"app": "Safari"},
                expected_revision=revision,
            )

        self.store.undo(
            change_id=saved["change_id"],
            expected_revision=saved["revision"],
            expected_day="2026-07-15",
            expected_event_key=activity_event_key("window-test", "42"),
        )

        self.assertFalse(self.store.apply_event(event).get("manual_edit", False))

    def test_editor_updates_time_content_and_custom_category_without_aw_write(
        self,
    ) -> None:
        inspected = self._inspect()
        event = inspected["events"][0]

        saved = self.editor.save(
            {
                "date": "2026-07-15",
                "mode": "calendar",
                "bucket_id": "window-test",
                "event_id": "42",
                "expected_source_fingerprint": event["source_fingerprint"],
                "expected_revision": inspected["revision"],
                "start_local": "2026-07-15T10:05:00",
                "end_local": "2026-07-15T10:20:00",
                "app": "Terminal",
                "title": "手动修正标题",
                "category_override": {"custom_label": "深度工作"},
            }
        )

        effective = saved["event"]["effective"]
        self.assertEqual(effective["app"], "Terminal")
        self.assertEqual(effective["title"], "手动修正标题")
        self.assertEqual(effective["start_local"], "2026-07-15T10:05:00")
        self.assertEqual(effective["end_local"], "2026-07-15T10:20:00")
        self.assertEqual(effective["category_label"], "深度工作")
        payload = self.adapter.load_day(date(2026, 7, 15), "calendar")
        self.assertEqual(payload["time_accounting"]["wall_duration_seconds"], 900.0)
        self.assertEqual(payload["events"][0]["category_label"], "深度工作")
        # The fake source remains unchanged: all writes landed in KinaWatch's
        # overlay rather than the ActivityWatch client.
        self.assertEqual(self.client.title, "KinaWatch")

        undone = self.editor.undo(
            {
                "date": "2026-07-15",
                "mode": "calendar",
                "bucket_id": "window-test",
                "event_id": "42",
                "change_id": saved["change_id"],
                "expected_revision": saved["revision"],
            }
        )
        self.assertEqual(undone["event"]["effective"]["app"], "Code")
        self.assertFalse(undone["event"]["manual_edit"])

    def test_source_change_rejects_a_stale_editor(self) -> None:
        inspected = self._inspect()
        event = inspected["events"][0]
        self.client.title = "Changed upstream"

        with self.assertRaises(ActivityEditConflict):
            self.editor.save(
                {
                    "date": "2026-07-15",
                    "mode": "calendar",
                    "bucket_id": "window-test",
                    "event_id": "42",
                    "expected_source_fingerprint": event[
                        "source_fingerprint"
                    ],
                    "expected_revision": inspected["revision"],
                    "start_local": "2026-07-15T10:00:00",
                    "end_local": "2026-07-15T10:10:00",
                    "app": "Code",
                    "title": "KinaWatch",
                    "category_override": None,
                }
            )


if __name__ == "__main__":
    unittest.main()
