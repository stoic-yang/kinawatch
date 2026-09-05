from __future__ import annotations

import tempfile
import unittest
from datetime import date
from pathlib import Path

from backend.config import DashboardSettings
from backend.journal_parser import parse_journal
from backend.journal_repository import JournalRepository
from backend.workflow_writer import WorkflowWriteConflict, WorkflowWriter


class JournalRepositoryTests(unittest.TestCase):
    def test_new_weekly_review_template_contains_only_freeform(self) -> None:
        content = JournalRepository.weekly_review_initial_content("2026-W30")

        self.assertIn("## 自由记录", content)
        self.assertNotIn("## 本周可验证结果", content)
        self.assertNotIn("## 下周最小成果", content)

    def test_new_monthly_review_template_contains_only_freeform(self) -> None:
        content = JournalRepository.monthly_review_initial_content("2026-07")

        self.assertIn("title: 2026-07", content)
        self.assertIn("## 自由记录", content)
        self.assertNotIn("## 本月总结", content)
        self.assertNotIn("## 下月计划", content)

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
            freeform_result = writer.upsert_review(
                {
                    "date": selected_day.isoformat(),
                    "field": "freeform",
                    "markdown": "本地模式也能保存自由记录。",
                    "expected_fingerprint": review_result["journal_fingerprint"],
                }
            )
            workflow_result = writer.upsert(
                {
                    "date": selected_day.isoformat(),
                    "start_time": "09:00",
                    "end_time": "10:00",
                    "note": "记录这一小时真正推进的工作。",
                    "expected_fingerprint": freeform_result["journal_fingerprint"],
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
            self.assertEqual(
                parsed.freeform_markdown,
                "本地模式也能保存自由记录。",
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

    def test_permanent_note_is_date_independent_and_created_only_on_save(self) -> None:
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
                        "permanent_note_path": "incoming.md",
                    },
                },
            )
            repository = JournalRepository(settings)
            writer = WorkflowWriter(repository)

            read_result = writer.read_permanent_note()
            location = repository.locate_permanent()

            self.assertFalse(read_result["exists"])
            self.assertEqual(read_result["path"], "incoming.md")
            self.assertEqual(read_result["markdown"], "")
            self.assertFalse(storage_root.exists())

            saved = writer.upsert_permanent_note(
                {
                    "markdown": (
                        "# Incoming\n\n"
                        "## 待处理\n\n"
                        "- [ ] 一周后回看这条记录"
                    ),
                    "expected_fingerprint": read_result[
                        "journal_fingerprint"
                    ],
                }
            )

            self.assertTrue(saved["created"])
            self.assertFalse(saved["replaced"])
            self.assertEqual(saved["path"], "incoming.md")
            self.assertEqual(
                location.note.read_text(encoding="utf-8"),
                "# Incoming\n\n## 待处理\n\n- [ ] 一周后回看这条记录\n",
            )
            self.assertEqual(list(location.note.parent.glob(".*.tmp")), [])

            with self.assertRaises(WorkflowWriteConflict):
                writer.upsert_permanent_note(
                    {
                        "markdown": "不要覆盖较新的笔记。",
                        "expected_fingerprint": read_result[
                            "journal_fingerprint"
                        ],
                    }
                )

    def test_permanent_note_path_cannot_escape_the_storage_root(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            settings = DashboardSettings(
                config_path=root / "kinawatch.json",
                raw={
                    "host": "127.0.0.1",
                    "cache_dir": str(root / "cache"),
                    "journal": {
                        "provider": "local",
                        "storage_dir": str(root / "journal"),
                        "permanent_note_path": "../outside.md",
                    },
                },
            )

            with self.assertRaises(ValueError):
                JournalRepository(settings).locate_permanent()

    def test_period_review_reads_do_not_create_local_directories(self) -> None:
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
            writer = WorkflowWriter(JournalRepository(settings))

            weekly = writer.read_weekly_review("2026-W33")
            monthly = writer.read_monthly_review("2026-08")

            self.assertFalse(weekly["exists"])
            self.assertFalse(monthly["exists"])
            self.assertFalse(storage_root.exists())


if __name__ == "__main__":
    unittest.main()
