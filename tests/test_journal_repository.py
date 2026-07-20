from __future__ import annotations

import tempfile
import unittest
from datetime import date
from pathlib import Path

from backend.config import DashboardSettings
from backend.journal_parser import parse_journal
from backend.journal_repository import JournalRepository
from backend.workflow_writer import WorkflowWriter


class JournalRepositoryTests(unittest.TestCase):
    def test_local_provider_creates_managed_markdown_on_first_explicit_save(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            storage_root = root / "managed" / "journal"
            settings = DashboardSettings(
                config_path=root / "kinawatch.json",
                raw={
                    "host": "127.0.0.1",
                    "cache_dir": str(root / "cache"),
                    "journal": {
                        "provider": "local",
                        "storage_dir": str(storage_root),
                        "daily_notes_dir": "Daily",
                    },
                },
            )
            repository = JournalRepository(settings)
            writer = WorkflowWriter(repository)
            selected_day = date(2026, 7, 20)
            location = repository.locate(selected_day)

            self.assertEqual(location.provider, "local")
            self.assertEqual(location.obsidian_url, "")
            self.assertFalse(location.note.exists())
            self.assertFalse(storage_root.exists())
            self.assertTrue(repository.health()["available"])

            review_result = writer.upsert_review(
                {
                    "date": selected_day.isoformat(),
                    "field": "personal_summary",
                    "markdown": "不使用 Obsidian 也能保存复盘。",
                    "expected_fingerprint": location.fingerprint.to_dict(),
                }
            )
            workflow_result = writer.upsert(
                {
                    "date": selected_day.isoformat(),
                    "start_time": "09:00",
                    "end_time": "10:00",
                    "note": "记录这一小时真正推进的工作。",
                    "expected_fingerprint": review_result["journal_fingerprint"],
                }
            )

            self.assertTrue(review_result["created"])
            self.assertFalse(workflow_result["created"])
            self.assertTrue(location.note.is_file())
            parsed = parse_journal(location.note.read_text(encoding="utf-8"))
            self.assertEqual(
                parsed.personal_summary_markdown,
                "不使用 Obsidian 也能保存复盘。",
            )
            self.assertEqual(parsed.workflow_notes[0].start_time, "09:00")
            self.assertEqual(
                parsed.workflow_notes[0].note,
                "记录这一小时真正推进的工作。",
            )

    def test_obsidian_provider_keeps_open_url_and_requires_daily_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            vault = root / "Notes"
            settings = DashboardSettings(
                config_path=root / "kinawatch.json",
                raw={
                    "host": "127.0.0.1",
                    "cache_dir": str(root / "cache"),
                    "journal": {
                        "provider": "obsidian",
                        "vault": str(vault),
                        "vault_name": "Notes",
                        "daily_notes_dir": "Daily",
                    },
                },
            )
            repository = JournalRepository(settings)
            unavailable = repository.health()

            self.assertFalse(unavailable["available"])
            self.assertEqual(unavailable["provider"], "obsidian")

            (vault / "Daily").mkdir(parents=True)
            location = repository.locate(date(2026, 7, 20))

            self.assertTrue(repository.health()["available"])
            self.assertEqual(location.provider, "obsidian")
            self.assertTrue(location.obsidian_url.startswith("obsidian://open?"))


if __name__ == "__main__":
    unittest.main()
