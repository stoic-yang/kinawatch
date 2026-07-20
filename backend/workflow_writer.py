from __future__ import annotations

import os
import re
import stat
import tempfile
import threading
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

from .config import fingerprint_file
from .journal_parser import (
    HEADING_RE,
    REVIEW_GROUP_TITLE_RE,
    SECTION_ALIASES,
    WORKFLOW_CALLOUT_HEADER_RE,
    _parse_workflow_callout,
    _parse_workflow_group_callout,
    _parse_workflow_note,
    _parse_review_group_callout,
)
from .journal_repository import JournalLocation, JournalRepository
from .models import FileFingerprint, WorkflowNote


TIME_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
MAX_NOTE_CHARACTERS = 4000
MAX_REVIEW_FIELD_CHARACTERS = 8000
WORKFLOW_DAY_START_MINUTES = 6 * 60
REVIEW_FIELD_ORDER = (
    "personal_summary",
    "outputs",
    "next_action",
    "freeform",
)
REVIEW_FIELD_LABELS = {
    "personal_summary": "我的总结",
    "outputs": "今日产出",
    "next_action": "明天的计划",
    "freeform": "自由记录",
}
WEEK_ID_RE = re.compile(r"^(?P<year>\d{4})-W(?P<week>\d{2})$")


class WorkflowWriteError(Exception):
    """Base class for safe, user-facing workflow write failures."""


class WorkflowWriteDisabled(WorkflowWriteError):
    pass


class WorkflowWriteValidation(WorkflowWriteError):
    pass


class WorkflowWriteConflict(WorkflowWriteError):
    pass


@dataclass(frozen=True)
class WorkflowSpan:
    notes: tuple[WorkflowNote, ...]
    start_offset: int
    end_offset: int


@dataclass(frozen=True)
class ReviewSpan:
    fields: dict[str, str]
    start_offset: int
    end_offset: int


def workflow_block_id(start_time: str) -> str:
    return f"workflow-{start_time.replace(':', '')}"


def normalize_note(note: str) -> str:
    if not isinstance(note, str):
        raise WorkflowWriteValidation("工作流描述必须是文字。")
    normalized = note.replace("\r\n", "\n").replace("\r", "\n")
    normalized = "\n".join(line.rstrip() for line in normalized.split("\n")).strip()
    if not normalized:
        raise WorkflowWriteValidation("工作流描述不能为空。")
    if "\x00" in normalized:
        raise WorkflowWriteValidation("工作流描述包含无效字符。")
    if len(normalized) > MAX_NOTE_CHARACTERS:
        raise WorkflowWriteValidation(
            f"工作流描述不能超过 {MAX_NOTE_CHARACTERS} 个字符。"
        )
    return normalized


def normalize_review_markdown(markdown: str) -> str:
    if not isinstance(markdown, str):
        raise WorkflowWriteValidation("复盘内容必须是文字。")
    normalized = markdown.replace("\r\n", "\n").replace("\r", "\n")
    normalized = "\n".join(
        line.rstrip() for line in normalized.split("\n")
    ).strip()
    if not normalized:
        raise WorkflowWriteValidation("复盘内容不能为空。")
    if "\x00" in normalized:
        raise WorkflowWriteValidation("复盘内容包含无效字符。")
    if len(normalized) > MAX_REVIEW_FIELD_CHARACTERS:
        raise WorkflowWriteValidation(
            f"单项复盘不能超过 {MAX_REVIEW_FIELD_CHARACTERS} 个字符。"
        )
    return normalized


def _workflow_sort_key(note: WorkflowNote) -> int:
    hour, minute = (int(value) for value in note.start_time.split(":"))
    return (hour * 60 + minute - WORKFLOW_DAY_START_MINUTES) % (24 * 60)


def render_workflow_group(notes: list[WorkflowNote]) -> str:
    if not notes:
        raise WorkflowWriteValidation("工作流总块至少需要一条描述。")
    lines = ["> [!abstract]- 工作流"]
    for index, item in enumerate(sorted(notes, key=_workflow_sort_key)):
        if not TIME_RE.fullmatch(item.start_time) or (
            item.end_time and not TIME_RE.fullmatch(item.end_time)
        ):
            raise WorkflowWriteValidation("工作流时间必须使用 HH:MM。")
        if index:
            lines.append(">")
        time_range = item.start_time
        if item.end_time:
            time_range = f"{time_range}–{item.end_time}"
        lines.append(f"> **{time_range}**")
        normalized = normalize_note(item.note)
        lines.extend(
            f"> {line}" if line else ">" for line in normalized.split("\n")
        )
    return "\n".join(lines)


def render_workflow_block(start_time: str, end_time: str, note: str) -> str:
    """Render a one-entry daily group; retained as a focused test helper."""
    return render_workflow_group(
        [
            WorkflowNote(
                start_time=start_time,
                end_time=end_time,
                note=note,
                block_id="",
                raw="",
            )
        ]
    )


def render_review_group(fields: dict[str, str]) -> str:
    rendered_fields = [
        (name, normalize_review_markdown(fields[name]))
        for name in REVIEW_FIELD_ORDER
        if fields.get(name, "").strip()
    ]
    if not rendered_fields:
        raise WorkflowWriteValidation("复盘总块至少需要一项内容。")
    lines = ["> [!abstract]- 复盘"]
    for index, (name, markdown) in enumerate(rendered_fields):
        if index:
            lines.append(">")
        lines.append(f"> **{REVIEW_FIELD_LABELS[name]}**")
        lines.extend(
            f"> {line}" if line else ">" for line in markdown.split("\n")
        )
    return "\n".join(lines)


def workflow_spans(content: str) -> list[WorkflowSpan]:
    """Locate parsed workflow blocks while preserving all unrelated bytes."""
    kept_lines = content.splitlines(keepends=True)
    plain_lines = [line.rstrip("\r\n") for line in kept_lines]
    offsets: list[int] = []
    cursor = 0
    for line in kept_lines:
        offsets.append(cursor)
        cursor += len(line)

    spans: list[WorkflowSpan] = []
    line_index = 0
    while line_index < len(plain_lines):
        group = _parse_workflow_group_callout(plain_lines, line_index)
        if group is not None:
            workflow_notes, next_index = group
            spans.append(
                WorkflowSpan(
                    notes=tuple(workflow_notes),
                    start_offset=offsets[line_index],
                    end_offset=(
                        offsets[next_index]
                        if next_index < len(offsets)
                        else len(content)
                    ),
                )
            )
            line_index = next_index
            continue

        callout = _parse_workflow_callout(plain_lines, line_index)
        if callout is not None:
            workflow_note, next_index = callout
            spans.append(
                WorkflowSpan(
                    notes=(workflow_note,),
                    start_offset=offsets[line_index],
                    end_offset=(
                        offsets[next_index]
                        if next_index < len(offsets)
                        else len(content)
                    ),
                )
            )
            line_index = next_index
            continue

        workflow_note = _parse_workflow_note(plain_lines[line_index])
        if workflow_note is not None:
            next_index = line_index + 1
            spans.append(
                WorkflowSpan(
                    notes=(workflow_note,),
                    start_offset=offsets[line_index],
                    end_offset=(
                        offsets[next_index]
                        if next_index < len(offsets)
                        else len(content)
                    ),
                )
            )
        line_index += 1
    return spans


def review_spans(content: str) -> list[ReviewSpan]:
    """Locate canonical and legacy user-review fields without touching others."""
    kept_lines = content.splitlines(keepends=True)
    plain_lines = [line.rstrip("\r\n") for line in kept_lines]
    offsets: list[int] = []
    cursor = 0
    for line in kept_lines:
        offsets.append(cursor)
        cursor += len(line)

    spans: list[ReviewSpan] = []
    line_index = 0
    while line_index < len(plain_lines):
        group = _parse_review_group_callout(plain_lines, line_index)
        if group is not None:
            raw_fields, next_index = group
            fields = {
                name: "\n".join(line.rstrip() for line in lines).strip()
                for name, lines in raw_fields.items()
            }
            spans.append(
                ReviewSpan(
                    fields=fields,
                    start_offset=offsets[line_index],
                    end_offset=(
                        offsets[next_index]
                        if next_index < len(offsets)
                        else len(content)
                    ),
                )
            )
            line_index = next_index
            continue

        header = WORKFLOW_CALLOUT_HEADER_RE.match(plain_lines[line_index])
        if header and REVIEW_GROUP_TITLE_RE.match(header.group("title")):
            raise WorkflowWriteConflict(
                "日记中已有无法安全识别的“复盘” Callout，请先人工整理。"
            )

        heading = HEADING_RE.match(plain_lines[line_index])
        canonical = (
            SECTION_ALIASES.get(heading.group(1).strip()) if heading else None
        )
        if canonical not in REVIEW_FIELD_ORDER:
            line_index += 1
            continue

        next_index = line_index + 1
        while next_index < len(plain_lines):
            if HEADING_RE.match(plain_lines[next_index]):
                break
            workflow_group = _parse_workflow_group_callout(
                plain_lines,
                next_index,
            )
            workflow_callout = _parse_workflow_callout(
                plain_lines,
                next_index,
            )
            workflow_line = _parse_workflow_note(plain_lines[next_index])
            if workflow_group or workflow_callout or workflow_line:
                raise WorkflowWriteConflict(
                    "旧复盘小节中夹有结构化工作流，无法安全归并，请先人工整理。"
                )
            next_index += 1

        fields = {
            canonical: "\n".join(
                line.rstrip()
                for line in plain_lines[line_index + 1 : next_index]
            ).strip()
        }
        spans.append(
            ReviewSpan(
                fields=fields,
                start_offset=offsets[line_index],
                end_offset=(
                    offsets[next_index]
                    if next_index < len(offsets)
                    else len(content)
                ),
            )
        )
        line_index = next_index
    return spans


def upsert_workflow_block(
    content: str,
    start_time: str,
    end_time: str,
    note: str,
) -> tuple[str, bool]:
    """Return one daily workflow callout and whether the target was replaced."""
    normalized_note = normalize_note(note)
    spans = workflow_spans(content)
    workflow_notes = [item for span in spans for item in span.notes]
    matching = [item for item in workflow_notes if item.start_time == start_time]
    duplicate_starts = {
        item.start_time
        for item in workflow_notes
        if sum(note.start_time == item.start_time for note in workflow_notes) > 1
    }
    orphan_block_ids = [
        match
        for match in re.finditer(
            r"(?m)^\s*\^workflow-\d{4}\s*$",
            content,
        )
        if not any(
            span.start_offset <= match.start() < span.end_offset
            for span in spans
        )
    ]

    if duplicate_starts:
        raise WorkflowWriteConflict(
            "日记中存在重复开始时间的工作流描述，请先人工整理："
            + "、".join(sorted(duplicate_starts))
        )
    for item in workflow_notes:
        expected_id = workflow_block_id(item.start_time)
        if item.block_id and item.block_id != expected_id:
            raise WorkflowWriteConflict(
                f"{item.start_time} 工作流关联了不一致的旧块 ID，请先人工整理。"
            )
    if orphan_block_ids:
        raise WorkflowWriteConflict(
            "日记中存在未关联到工作流的旧块 ID，请先人工整理。"
        )

    replacement = WorkflowNote(
        start_time=start_time,
        end_time=end_time,
        note=normalized_note,
        block_id="",
        raw="",
    )
    updated_notes = [
        replacement if item.start_time == start_time else item
        for item in workflow_notes
    ]
    if not matching:
        updated_notes.append(replacement)
    block = render_workflow_group(updated_notes)

    if spans:
        ordered = sorted(spans, key=lambda span: span.start_offset)
        fragments = [content[: ordered[0].start_offset]]
        for previous, following in zip(ordered, ordered[1:]):
            fragments.append(content[previous.end_offset : following.start_offset])
        fragments.append(content[ordered[-1].end_offset :])
        pieces = []
        prefix = fragments[0].strip("\r\n")
        if prefix.strip():
            pieces.append(prefix)
        pieces.append(block)
        for fragment in fragments[1:]:
            cleaned = fragment.strip("\r\n")
            if cleaned.strip():
                pieces.append(cleaned)
        return "\n\n".join(pieces) + "\n", bool(matching)

    base = content.rstrip("\r\n")
    return f"{base}\n\n{block}\n" if base else f"{block}\n", False


def upsert_review_group(
    content: str,
    field: str,
    markdown: str,
) -> tuple[str, bool]:
    """Update one review field and consolidate recognized fields once."""
    if field not in REVIEW_FIELD_ORDER:
        raise WorkflowWriteValidation("复盘字段无效。")
    normalized = normalize_review_markdown(markdown)
    spans = review_spans(content)
    fields: dict[str, str] = {}
    for span in spans:
        for name, value in span.fields.items():
            if name in fields:
                raise WorkflowWriteConflict(
                    f"日记中存在重复的“{REVIEW_FIELD_LABELS[name]}”，请先人工整理。"
                )
            fields[name] = value

    replaced = field in fields
    fields[field] = normalized
    block = render_review_group(fields)
    if spans:
        ordered = sorted(spans, key=lambda span: span.start_offset)
        fragments = [content[: ordered[0].start_offset]]
        for previous, following in zip(ordered, ordered[1:]):
            fragments.append(content[previous.end_offset : following.start_offset])
        fragments.append(content[ordered[-1].end_offset :])
        pieces: list[str] = []
        prefix = fragments[0].strip("\r\n")
        if prefix.strip():
            pieces.append(prefix)
        pieces.append(block)
        for fragment in fragments[1:]:
            cleaned = fragment.strip("\r\n")
            if cleaned.strip():
                pieces.append(cleaned)
        return "\n\n".join(pieces) + "\n", replaced

    base = content.rstrip("\r\n")
    return f"{base}\n\n{block}\n" if base else f"{block}\n", False


def _parse_expected_fingerprint(value: Any) -> FileFingerprint:
    if not isinstance(value, dict):
        raise WorkflowWriteValidation("缺少页面读取时的日记版本。")
    try:
        path = str(value["path"])
        mtime_ns = int(value["mtime_ns"])
        size = int(value["size"])
    except (KeyError, TypeError, ValueError) as exc:
        raise WorkflowWriteValidation("日记版本格式无效。") from exc
    if not path or mtime_ns < 0 or size < 0:
        raise WorkflowWriteValidation("日记版本格式无效。")
    return FileFingerprint(path=path, mtime_ns=mtime_ns, size=size)


class WorkflowWriter:
    def __init__(self, repository: JournalRepository):
        self.repository = repository
        self._locks_guard = threading.Lock()
        self._locks: dict[Path, threading.Lock] = {}

    def _lock_for(self, note: Path) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(note, threading.Lock())

    @staticmethod
    def _assert_safe_location(location: JournalLocation) -> None:
        storage_root = location.vault.resolve()
        note = location.note.resolve(strict=False)
        if note != storage_root and storage_root not in note.parents:
            raise WorkflowWriteValidation("目标日记不在已配置的存储目录中。")
        if getattr(location, "provider", "obsidian") == "local":
            try:
                note.parent.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                raise WorkflowWriteValidation("无法创建 KinaWatch 本地日记目录。") from exc
        if not note.parent.is_dir():
            raise WorkflowWriteValidation("已配置的日记目录不存在。")
        if location.note.is_symlink():
            raise WorkflowWriteValidation("不允许通过符号链接写入日记。")

    @staticmethod
    def _atomic_write(path: Path, content: str, expected: FileFingerprint) -> None:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{path.name}.",
            suffix=".tmp",
            dir=path.parent,
        )
        temporary = Path(temporary_name)
        try:
            mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o644
            os.fchmod(descriptor, mode)
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
                descriptor = -1
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())

            if fingerprint_file(path) != expected:
                raise WorkflowWriteConflict(
                    "日记在保存过程中发生了变化，请刷新页面后再试。"
                )
            os.replace(temporary, path)
            # Windows does not support opening a directory with os.open. The
            # same-directory os.replace remains atomic there; POSIX systems
            # additionally fsync the directory entry for crash durability.
            if os.name != "nt":
                directory_fd = os.open(path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            temporary.unlink(missing_ok=True)

    def upsert(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise WorkflowWriteValidation("请求必须是 JSON 对象。")
        try:
            selected_day = date.fromisoformat(str(payload["date"]))
        except (KeyError, ValueError) as exc:
            raise WorkflowWriteValidation("日期必须使用 YYYY-MM-DD。") from exc
        start_time = str(payload.get("start_time", ""))
        end_time = str(payload.get("end_time", ""))
        if not TIME_RE.fullmatch(start_time) or not TIME_RE.fullmatch(end_time):
            raise WorkflowWriteValidation("工作流时间必须使用 HH:MM。")
        normalized_note = normalize_note(payload.get("note", ""))
        expected = _parse_expected_fingerprint(payload.get("expected_fingerprint"))

        location = self.repository.locate(selected_day)
        self._assert_safe_location(location)
        with self._lock_for(location.note):
            existed = location.note.is_file()
            current = fingerprint_file(location.note)
            if current != expected:
                raise WorkflowWriteConflict(
                    "日记已在页面加载后发生变化，请刷新后重新编辑。"
                )
            original = self.repository.read(location)
            if not original:
                original = self.repository.initial_content()
            updated, replaced = upsert_workflow_block(
                original,
                start_time,
                end_time,
                normalized_note,
            )
            self._atomic_write(location.note, updated, current)
            written = fingerprint_file(location.note)

        return {
            "ok": True,
            "date": selected_day.isoformat(),
            "created": not existed,
            "replaced": replaced,
            "workflow_note": {
                "start_time": start_time,
                "end_time": end_time,
                "note": normalized_note,
                # Canonical callouts are keyed by their start clock.  A native
                # A legacy Obsidian block id must sit outside a quote/callout
                # and would render as a visually separate block, so new writes
                # omit it for both storage providers.
                "block_id": "",
            },
            "journal_fingerprint": written.to_dict(),
        }

    def upsert_review(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise WorkflowWriteValidation("请求必须是 JSON 对象。")
        try:
            selected_day = date.fromisoformat(str(payload["date"]))
        except (KeyError, ValueError) as exc:
            raise WorkflowWriteValidation("日期必须使用 YYYY-MM-DD。") from exc
        field = str(payload.get("field", ""))
        if field not in REVIEW_FIELD_ORDER:
            raise WorkflowWriteValidation("复盘字段无效。")
        markdown = normalize_review_markdown(payload.get("markdown", ""))
        expected = _parse_expected_fingerprint(payload.get("expected_fingerprint"))

        location = self.repository.locate(selected_day)
        self._assert_safe_location(location)
        with self._lock_for(location.note):
            existed = location.note.is_file()
            current = fingerprint_file(location.note)
            if current != expected:
                raise WorkflowWriteConflict(
                    "日记已在页面加载后发生变化，请刷新后重新编辑。"
                )
            original = self.repository.read(location)
            if not original:
                original = self.repository.initial_content()
            updated, replaced = upsert_review_group(
                original,
                field,
                markdown,
            )
            self._atomic_write(location.note, updated, current)
            written = fingerprint_file(location.note)

        return {
            "ok": True,
            "date": selected_day.isoformat(),
            "created": not existed,
            "replaced": replaced,
            "review_field": {
                "field": field,
                "markdown": markdown,
            },
            "journal_fingerprint": written.to_dict(),
        }

    def ensure_weekly_review(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise WorkflowWriteValidation("请求必须是 JSON 对象。")
        week_id = str(payload.get("week_id", ""))
        match = WEEK_ID_RE.fullmatch(week_id)
        if match is None:
            raise WorkflowWriteValidation("周复盘编号必须使用 YYYY-Www。")
        try:
            date.fromisocalendar(
                int(match.group("year")),
                int(match.group("week")),
                1,
            )
        except ValueError as exc:
            raise WorkflowWriteValidation("周复盘编号不是有效的 ISO 周。") from exc

        location = self.repository.locate_weekly(week_id)
        self._assert_safe_location(location)
        with self._lock_for(location.note):
            created = not location.note.is_file()
            if created:
                expected = fingerprint_file(location.note)
                content = self.repository.weekly_review_initial_content(week_id)
                self._atomic_write(location.note, f"{content}\n", expected)

        return {
            "ok": True,
            "week_id": week_id,
            "created": created,
            "path": location.relative_path,
            "provider": getattr(location, "provider", "obsidian"),
            "open_url": location.obsidian_url,
            "obsidian_url": location.obsidian_url,
        }
