from __future__ import annotations

import json
import tempfile
import threading
import unittest
from datetime import date
from pathlib import Path

from backend.config import fingerprint_file
from backend.journal_parser import parse_journal
from backend.journal_repository import JournalLocation
from backend.workflow_writer import (
    WorkflowWriteConflict,
    WorkflowWriteValidation,
    WorkflowWriter,
    render_review_group,
    render_workflow_block,
    upsert_review_group,
    upsert_workflow_block,
)


class FixtureJournalRepository:
    def __init__(self, root: Path):
        self.vault = root.resolve()
        self.daily = self.vault / "Review" / "Daily"
        self.daily.mkdir(parents=True)

    def locate(self, selected_day: date) -> JournalLocation:
        note = self.daily / f"{selected_day.isoformat()}.md"
        return JournalLocation(
            vault=self.vault,
            note=note,
            relative_path=f"Review/Daily/{note.name}",
            obsidian_url="obsidian://open?vault=Fixture",
            fingerprint=fingerprint_file(note),
        )

    def locate_weekly(self, week_id: str) -> JournalLocation:
        note = self.vault / "Review" / "Weekly" / f"{week_id}.md"
        note.parent.mkdir(parents=True, exist_ok=True)
        return JournalLocation(
            vault=self.vault,
            note=note,
            relative_path=f"Review/Weekly/{note.name}",
            obsidian_url=(
                f"obsidian://open?vault=Fixture&file=Review/Weekly/{week_id}"
            ),
            fingerprint=fingerprint_file(note),
        )

    @staticmethod
    def read(location: JournalLocation) -> str:
        return location.note.read_text(encoding="utf-8") if location.note.is_file() else ""

    @staticmethod
    def initial_content() -> str:
        return "## 一天活动小总结\n## Kina 建议"

    @staticmethod
    def weekly_review_initial_content(week_id: str) -> str:
        return f"---\ntitle: {week_id}\n---\n\n# {week_id}\n"


class WorkflowFormattingTests(unittest.TestCase):
    def test_render_uses_one_daily_callout_with_a_timed_entry(self) -> None:
        rendered = render_workflow_block(
            "08:59",
            "09:18",
            "看完当前实现。\n\n- 决定：继续收敛格式。",
        )

        self.assertEqual(
            rendered,
            "> [!abstract]- 工作流\n"
            "> **08:59–09:18**\n"
            "> 看完当前实现。\n"
            ">\n"
            "> - 决定：继续收敛格式。",
        )
        parsed = parse_journal(rendered)
        self.assertEqual(parsed.workflow_notes[0].note, "看完当前实现。\n\n- 决定：继续收敛格式。")
        self.assertEqual(parsed.workflow_notes[0].block_id, "")

    def test_upsert_replaces_only_target_and_migrates_legacy_format(self) -> None:
        original = (
            "开场文字。\n\n"
            "- **工作流 08:59–09:18**：旧说明。 ^workflow-0859\n\n"
            "这是两个工作流块之间的普通日记正文，必须保留。\n\n"
            "> [!abstract]- 09:36–10:00 · 工作流\n"
            "> 另一段保持不变。\n\n"
            "^workflow-0936\n\n"
            "结尾文字。\n"
        )

        updated, replaced = upsert_workflow_block(
            original,
            "08:59",
            "09:20",
            "新的多行说明。\n\n- 结论：完成。",
        )

        self.assertTrue(replaced)
        self.assertEqual(updated.count("^workflow-0859"), 0)
        self.assertEqual(updated.count("^workflow-0936"), 0)
        self.assertEqual(updated.count("> [!abstract]- 工作流"), 1)
        self.assertNotIn("· 工作流", updated)
        self.assertNotIn("- **工作流 08:59", updated)
        self.assertIn("这是两个工作流块之间的普通日记正文，必须保留。", updated)
        self.assertIn("另一段保持不变。", updated)
        self.assertIn("结尾文字。", updated)
        self.assertLess(updated.index("**08:59–09:20**"), updated.index("**09:36–10:00**"))
        parsed = parse_journal(updated)
        by_start = {item.start_time: item for item in parsed.workflow_notes}
        self.assertEqual(by_start["08:59"].end_time, "09:20")
        self.assertEqual(by_start["08:59"].note, "新的多行说明。\n\n- 结论：完成。")
        self.assertEqual(by_start["09:36"].note, "另一段保持不变。")

    def test_callout_without_anchor_remains_associated_by_start_time(self) -> None:
        original = (
            "> [!abstract]- 08:59–09:18 · 工作流\n"
            "> 用户已经手动删掉可见锚点。\n"
        )

        updated, replaced = upsert_workflow_block(
            original,
            "08:59",
            "09:22",
            "仍然可以在 Dashboard 中精确更新。",
        )

        self.assertTrue(replaced)
        self.assertNotIn("^workflow-0859", updated)
        self.assertIn("> [!abstract]- 工作流", updated)
        self.assertIn("> **08:59–09:22**", updated)
        parsed = parse_journal(updated)
        self.assertEqual(len(parsed.workflow_notes), 1)
        self.assertEqual(parsed.workflow_notes[0].start_time, "08:59")
        self.assertEqual(parsed.workflow_notes[0].end_time, "09:22")
        self.assertEqual(
            parsed.workflow_notes[0].note,
            "仍然可以在 Dashboard 中精确更新。",
        )

    def test_ambiguous_duplicate_workflows_are_rejected(self) -> None:
        content = (
            "- **工作流 08:59–09:18**：第一份。 ^workflow-0859\n"
            "- **工作流 08:59–09:20**：第二份。 ^workflow-0859\n"
        )
        with self.assertRaises(WorkflowWriteConflict):
            upsert_workflow_block(content, "08:59", "09:30", "不要猜。")

    def test_empty_description_cannot_delete_a_block(self) -> None:
        with self.assertRaises(WorkflowWriteValidation):
            render_workflow_block("08:59", "09:18", "  \n")

    def test_render_review_uses_one_daily_callout(self) -> None:
        rendered = render_review_group(
            {
                "personal_summary": "今天完成了安全写回。",
                "outputs": "- 复盘编辑器\n- 周复盘幂等入口",
                "next_action": "验证真实页面。",
                "freeform": "记住：简单的界面更容易持续使用。",
            }
        )

        self.assertEqual(
            rendered,
            "> [!abstract]- 复盘\n"
            "> **我的总结**\n"
            "> 今天完成了安全写回。\n"
            ">\n"
            "> **今日产出**\n"
            "> - 复盘编辑器\n"
            "> - 周复盘幂等入口\n"
            ">\n"
            "> **明天的计划**\n"
            "> 验证真实页面。\n"
            ">\n"
            "> **自由记录**\n"
            "> 记住：简单的界面更容易持续使用。",
        )
        parsed = parse_journal(rendered)
        self.assertEqual(parsed.personal_summary_markdown, "今天完成了安全写回。")
        self.assertEqual(parsed.outputs, ["复盘编辑器", "周复盘幂等入口"])
        self.assertEqual(parsed.next_action_markdown, "验证真实页面。")
        self.assertEqual(
            parsed.freeform_markdown,
            "记住：简单的界面更容易持续使用。",
        )

    def test_review_upsert_migrates_legacy_sections_and_preserves_other_text(self) -> None:
        original = (
            "开场文字。\n\n"
            "## 今日总结\n旧总结。\n\n"
            "## 未识别标题\n这段普通正文必须保留。\n\n"
            "## 今日产出\n- 旧产出\n\n"
            "## 明日第一步\n旧行动。\n\n"
            "## 自由记录\n旧自由记录。\n\n"
            "## Kina 建议\n1. 不要改这里。\n"
        )

        updated, replaced = upsert_review_group(
            original,
            "personal_summary",
            "新的总结。",
        )

        self.assertTrue(replaced)
        self.assertEqual(updated.count("> [!abstract]- 复盘"), 1)
        self.assertNotIn("## 今日总结", updated)
        self.assertNotIn("## 今日产出", updated)
        self.assertNotIn("## 明日第一步", updated)
        self.assertNotIn("## 自由记录", updated)
        self.assertIn("> **明天的计划**", updated)
        self.assertIn("> **自由记录**", updated)
        self.assertIn("## 未识别标题\n这段普通正文必须保留。", updated)
        self.assertIn("## Kina 建议\n1. 不要改这里。", updated)
        parsed = parse_journal(updated)
        self.assertEqual(parsed.personal_summary_markdown, "新的总结。")
        self.assertEqual(parsed.outputs, ["旧产出"])
        self.assertEqual(parsed.next_action_markdown, "旧行动。")
        self.assertEqual(parsed.freeform_markdown, "旧自由记录。")

    def test_unstructured_review_callout_rejects_ambiguous_write(self) -> None:
        content = (
            "> [!abstract]- 复盘\n"
            "> 用户自己写的普通内容。\n"
        )
        with self.assertRaises(WorkflowWriteConflict):
            upsert_review_group(content, "personal_summary", "不要猜。")


class WorkflowWriterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.repository = FixtureJournalRepository(Path(self.temporary.name))
        self.writer = WorkflowWriter(self.repository)  # type: ignore[arg-type]
        self.day = date(2026, 7, 17)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def payload(self, **overrides: object) -> dict[str, object]:
        location = self.repository.locate(self.day)
        payload: dict[str, object] = {
            "date": self.day.isoformat(),
            "start_time": "08:59",
            "end_time": "09:18",
            "note": "在页面里写下这段工作的含义。",
            "expected_fingerprint": location.fingerprint.to_dict(),
        }
        payload.update(overrides)
        return payload

    def test_missing_note_is_created_from_template_without_touching_real_notes(self) -> None:
        result = self.writer.upsert(self.payload())
        location = self.repository.locate(self.day)
        content = location.note.read_text(encoding="utf-8")

        self.assertTrue(result["created"])
        self.assertFalse(result["replaced"])
        self.assertTrue(content.startswith("## 一天活动小总结\n"))
        self.assertNotIn("完成复盘", content)
        self.assertIn("> [!abstract]- 工作流", content)
        self.assertIn("> **08:59–09:18**", content)
        self.assertEqual(content.count("^workflow-0859"), 0)
        self.assertEqual(
            parse_journal(content).workflow_notes[0].note,
            "在页面里写下这段工作的含义。",
        )
        self.assertEqual(list(location.note.parent.glob(".*.tmp")), [])

    def test_browser_json_round_trip_preserves_nanosecond_fingerprint(self) -> None:
        target = self.repository.daily / f"{self.day.isoformat()}.md"
        target.write_text(self.repository.initial_content(), encoding="utf-8")
        location = self.repository.locate(self.day)
        fingerprint = location.fingerprint.to_dict()
        self.assertGreater(location.fingerprint.mtime_ns, 2**53)
        self.assertIsInstance(fingerprint["mtime_ns"], str)
        self.assertEqual(int(fingerprint["mtime_ns"]), location.fingerprint.mtime_ns)

        browser_payload = json.loads(json.dumps(self.payload(), ensure_ascii=False))
        result = self.writer.upsert(browser_payload)

        self.assertTrue(result["ok"])
        self.assertIsInstance(result["journal_fingerprint"]["mtime_ns"], str)

    def test_existing_block_is_updated_atomically(self) -> None:
        first = self.writer.upsert(self.payload())
        second_payload = self.payload(
            note="修改后的描述。",
            end_time="09:22",
            expected_fingerprint=first["journal_fingerprint"],
        )
        result = self.writer.upsert(second_payload)
        content = self.repository.locate(self.day).note.read_text(encoding="utf-8")

        self.assertFalse(result["created"])
        self.assertTrue(result["replaced"])
        self.assertEqual(content.count("^workflow-0859"), 0)
        note = parse_journal(content).workflow_notes[0]
        self.assertEqual(note.end_time, "09:22")
        self.assertEqual(note.note, "修改后的描述。")

    def test_stale_fingerprint_rejects_write_and_preserves_file(self) -> None:
        location = self.repository.locate(self.day)
        location.note.write_text("用户在别处写下的内容。\n", encoding="utf-8")
        stale = location.fingerprint.to_dict()
        original = location.note.read_text(encoding="utf-8")

        with self.assertRaises(WorkflowWriteConflict):
            self.writer.upsert(self.payload(expected_fingerprint=stale))

        self.assertEqual(location.note.read_text(encoding="utf-8"), original)

    def test_same_revision_allows_only_one_of_two_concurrent_saves(self) -> None:
        payload = self.payload()
        barrier = threading.Barrier(2)
        results: list[dict[str, object]] = []
        errors: list[BaseException] = []

        def save(note: str) -> None:
            try:
                barrier.wait(timeout=2)
                results.append(self.writer.upsert({**payload, "note": note}))
            except BaseException as exc:
                errors.append(exc)

        threads = [
            threading.Thread(target=save, args=("版本 A",)),
            threading.Thread(target=save, args=("版本 B",)),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=3)

        self.assertEqual(len(results), 1)
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], WorkflowWriteConflict)
        content = self.repository.locate(self.day).note.read_text(encoding="utf-8")
        self.assertEqual(content.count("^workflow-0859"), 0)
        self.assertIn(parse_journal(content).workflow_notes[0].note, {"版本 A", "版本 B"})

    def test_review_field_is_created_and_updated_with_same_safety_contract(self) -> None:
        first = self.writer.upsert_review(
            {
                "date": self.day.isoformat(),
                "field": "personal_summary",
                "markdown": "第一版总结。",
                "expected_fingerprint": self.repository.locate(self.day).fingerprint.to_dict(),
            }
        )
        second = self.writer.upsert_review(
            {
                "date": self.day.isoformat(),
                "field": "outputs",
                "markdown": "- 完成网页编辑器",
                "expected_fingerprint": first["journal_fingerprint"],
            }
        )
        third = self.writer.upsert_review(
            {
                "date": self.day.isoformat(),
                "field": "freeform",
                "markdown": "一个不属于固定栏目但值得留下的观察。",
                "expected_fingerprint": second["journal_fingerprint"],
            }
        )
        content = self.repository.locate(self.day).note.read_text(encoding="utf-8")

        self.assertTrue(first["created"])
        self.assertFalse(second["created"])
        self.assertEqual(content.count("> [!abstract]- 复盘"), 1)
        parsed = parse_journal(content)
        self.assertEqual(parsed.personal_summary_markdown, "第一版总结。")
        self.assertEqual(parsed.outputs, ["完成网页编辑器"])
        self.assertEqual(
            parsed.freeform_markdown,
            "一个不属于固定栏目但值得留下的观察。",
        )
        self.assertEqual(third["review_field"]["field"], "freeform")
        self.assertIn("## 一天活动小总结", content)
        self.assertIn("## Kina 建议", content)

    def test_weekly_review_creation_is_idempotent_and_never_rewrites_existing(self) -> None:
        first = self.writer.ensure_weekly_review({"week_id": "2026-W29"})
        location = self.repository.locate_weekly("2026-W29")
        original = location.note.read_text(encoding="utf-8")
        location.note.write_text(
            original + "\n用户已经填写的周复盘。\n",
            encoding="utf-8",
        )

        second = self.writer.ensure_weekly_review({"week_id": "2026-W29"})
        preserved = location.note.read_text(encoding="utf-8")

        self.assertTrue(first["created"])
        self.assertFalse(second["created"])
        self.assertEqual(first["path"], "Review/Weekly/2026-W29.md")
        self.assertEqual(first["provider"], "obsidian")
        self.assertEqual(first["open_url"], first["obsidian_url"])
        self.assertEqual(first["obsidian_url"], second["obsidian_url"])
        self.assertIn("用户已经填写的周复盘。", preserved)

    def test_invalid_iso_week_is_rejected(self) -> None:
        with self.assertRaises(WorkflowWriteValidation):
            self.writer.ensure_weekly_review({"week_id": "2026-W54"})


if __name__ == "__main__":
    unittest.main()
