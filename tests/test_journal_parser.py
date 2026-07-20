from __future__ import annotations

import unittest
from pathlib import Path

from backend.journal_parser import parse_journal


FIXTURES = Path(__file__).parent / "fixtures"


class JournalParserTests(unittest.TestCase):
    def test_full_journal_preserves_user_text_and_structured_sections(self) -> None:
        content = (FIXTURES / "daily_full.md").read_text(encoding="utf-8")
        document = parse_journal(content)

        self.assertTrue(document.completion_task_exists)
        self.assertTrue(document.completion_task_checked)
        self.assertEqual(document.personal_summary_markdown, "真正推进了数据契约。")
        self.assertEqual(len(document.outputs), 2)
        self.assertIn("[[Kina]]", document.outputs[0])
        self.assertIn("跑通一个历史日期", document.next_action_markdown)
        self.assertEqual(len(document.workflow_notes), 2)
        self.assertEqual(document.workflow_notes[0].start_time, "08:59")
        self.assertEqual(document.workflow_notes[0].end_time, "09:18")
        self.assertEqual(document.workflow_notes[0].block_id, "workflow-0859")
        self.assertEqual(
            document.workflow_notes[0].note,
            "明确了只读数据契约。",
        )
        self.assertEqual(document.workflow_notes[1].start_time, "09:36")
        self.assertEqual(document.workflow_notes[1].end_time, "")
        self.assertEqual(document.workflow_notes[1].block_id, "")
        self.assertEqual(document.activity_summary_markdown, "编码/刷题 2.0h。")
        self.assertEqual(
            document.kina_advice,
            ["明天先验证历史数据。", "缓存命中后不要重复读取。"],
        )
        self.assertIn("用户在建议后的自由正文", document.body_markdown)
        self.assertIn("## 未识别标题", document.body_markdown)
        self.assertNotIn("工作流 08:59", document.body_markdown)
        self.assertEqual(len(document.offline_activities), 2)
        self.assertEqual(document.offline_activities[0].project, "矩阵代数")
        self.assertEqual(document.offline_activities[0].duration_seconds, 3000)
        self.assertTrue(document.offline_activities[1].crosses_midnight)
        self.assertEqual(document.offline_activities[1].duration_seconds, 1800)
        self.assertEqual(document.parse_warnings, [])
        self.assertEqual(
            document.projects,
            ["Kina", "Dashboard", "矩阵代数"],
        )

    def test_freeform_journal_is_not_rejected(self) -> None:
        content = (FIXTURES / "daily_freeform.md").read_text(encoding="utf-8")
        document = parse_journal(content)

        self.assertIn("今天只有自由正文", document.body_markdown)
        self.assertFalse(document.completion_task_exists)
        self.assertEqual(document.projects, ["Kina"])
        self.assertEqual(document.kina_advice, [])

    def test_malformed_offline_lines_are_retained_with_warnings(self) -> None:
        content = (FIXTURES / "daily_malformed_offline.md").read_text(
            encoding="utf-8"
        )
        document = parse_journal(content)

        self.assertEqual(document.offline_activities, [])
        self.assertEqual(len(document.offline_unparsed), 3)
        self.assertEqual(len(document.parse_warnings), 3)
        self.assertIn("HH:MM-HH:MM", document.parse_warnings[0].message)

    def test_latest_workflow_note_for_same_start_wins(self) -> None:
        document = parse_journal(
            "- **工作流 09:10–09:30**：第一版。 ^workflow-0910\n"
            "- **工作流 09:10–10:00**：修订后的解释。 ^workflow-0910\n"
        )

        self.assertEqual(len(document.workflow_notes), 1)
        self.assertEqual(document.workflow_notes[0].end_time, "10:00")
        self.assertEqual(document.workflow_notes[0].note, "修订后的解释。")

    def test_foldable_workflow_callout_is_parsed_and_removed_from_body(self) -> None:
        document = parse_journal(
            "开场文字。\n\n"
            "> [!abstract]- 08:59–09:18 · 工作流\n"
            "> 刚起床看了一眼 Dashboard 实现的情况。\n"
            ">\n"
            "> - 决定：继续收敛工作流记录格式。\n\n"
            "^workflow-0859\n\n"
            "结尾文字。\n"
        )

        self.assertEqual(len(document.workflow_notes), 1)
        note = document.workflow_notes[0]
        self.assertEqual(note.start_time, "08:59")
        self.assertEqual(note.end_time, "09:18")
        self.assertEqual(note.block_id, "workflow-0859")
        self.assertEqual(
            note.note,
            "刚起床看了一眼 Dashboard 实现的情况。\n\n"
            "- 决定：继续收敛工作流记录格式。",
        )
        self.assertIn("开场文字。", document.body_markdown)
        self.assertIn("结尾文字。", document.body_markdown)
        self.assertNotIn("[!abstract]", document.body_markdown)
        self.assertNotIn("workflow-0859", document.body_markdown)

    def test_daily_workflow_group_parses_multiple_entries_as_one_callout(self) -> None:
        document = parse_journal(
            "开场文字。\n\n"
            "> [!abstract]- 工作流\n"
            "> **08:59–09:18**\n"
            "> 起床瞄了一眼 Dashboard 完成的情况。\n"
            ">\n"
            "> **09:36–11:35**\n"
            "> 继续完善 Dashboard。\n\n"
            "结尾文字。\n"
        )

        self.assertEqual(len(document.workflow_notes), 2)
        first, second = document.workflow_notes
        self.assertEqual((first.start_time, first.end_time), ("08:59", "09:18"))
        self.assertEqual(first.note, "起床瞄了一眼 Dashboard 完成的情况。")
        self.assertEqual((second.start_time, second.end_time), ("09:36", "11:35"))
        self.assertEqual(second.note, "继续完善 Dashboard。")
        self.assertEqual(first.block_id, "")
        self.assertEqual(second.block_id, "")
        self.assertIn("开场文字。", document.body_markdown)
        self.assertIn("结尾文字。", document.body_markdown)
        self.assertNotIn("[!abstract]- 工作流", document.body_markdown)

    def test_unstructured_callout_titled_workflow_remains_user_body(self) -> None:
        content = (
            "> [!abstract]- 工作流\n"
            "> 这只是用户自己写的普通 Callout，没有时间条目。\n"
        )

        document = parse_journal(content)

        self.assertEqual(document.workflow_notes, [])
        self.assertIn("[!abstract]- 工作流", document.body_markdown)

    def test_daily_review_group_parses_all_fields_as_one_callout(self) -> None:
        document = parse_journal(
            "开场文字。\n\n"
            "> [!abstract]- 复盘\n"
            "> **我的总结**\n"
            "> 今天真正推进了 Dashboard 写回。\n"
            ">\n"
            "> **今日产出**\n"
            "> - 完成复盘编辑器\n"
            "> - 修复周复盘入口\n"
            ">\n"
            "> **明天的计划**\n"
            "> 先验证一次真实保存。\n"
            ">\n"
            "> 再整理后续任务。\n\n"
            "结尾文字。\n"
        )

        self.assertEqual(
            document.personal_summary_markdown,
            "今天真正推进了 Dashboard 写回。",
        )
        self.assertEqual(
            document.outputs,
            ["完成复盘编辑器", "修复周复盘入口"],
        )
        self.assertEqual(
            document.next_action_markdown,
            "先验证一次真实保存。\n\n再整理后续任务。",
        )
        self.assertIn("开场文字。", document.body_markdown)
        self.assertIn("结尾文字。", document.body_markdown)
        self.assertNotIn("[!abstract]- 复盘", document.body_markdown)

    def test_legacy_tomorrow_first_step_remains_readable(self) -> None:
        document = parse_journal(
            "> [!abstract]- 复盘\n"
            "> **明日第一步**\n"
            "> 旧日记仍然可以读取。\n"
        )

        self.assertEqual(
            document.next_action_markdown,
            "旧日记仍然可以读取。",
        )

    def test_unstructured_callout_titled_review_remains_user_body(self) -> None:
        content = (
            "> [!abstract]- 复盘\n"
            "> 这是普通 Callout，没有 Dashboard 字段标记。\n"
        )

        document = parse_journal(content)

        self.assertEqual(document.personal_summary_markdown, "")
        self.assertEqual(document.outputs, [])
        self.assertEqual(document.next_action_markdown, "")
        self.assertIn("[!abstract]- 复盘", document.body_markdown)

    def test_legacy_plus_encoded_workflow_note_is_recovered(self) -> None:
        document = parse_journal(
            "-+**工作流+08:59–09:18**：查看+Dashboard+实现+^workflow-0859\n"
            "这是真正的自由记录。\n"
        )

        self.assertEqual(len(document.workflow_notes), 1)
        self.assertEqual(document.workflow_notes[0].start_time, "08:59")
        self.assertEqual(document.workflow_notes[0].end_time, "09:18")
        self.assertEqual(document.workflow_notes[0].note, "查看 Dashboard 实现")
        self.assertEqual(document.workflow_notes[0].block_id, "workflow-0859")
        self.assertNotIn("工作流", document.body_markdown)
        self.assertEqual(document.body_markdown, "这是真正的自由记录。")

    def test_plus_signs_in_normal_prose_are_not_reinterpreted(self) -> None:
        content = "- C++ 与 A+B 是普通自由记录。\n"
        document = parse_journal(content)

        self.assertEqual(document.workflow_notes, [])
        self.assertEqual(document.body_markdown, content.strip())


if __name__ == "__main__":
    unittest.main()
