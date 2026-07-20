from __future__ import annotations

import re
from datetime import datetime, timedelta

from .models import JournalDocument, OfflineActivity, ParseWarning, WorkflowNote


HEADING_RE = re.compile(r"^##\s+(.+?)\s*$")
# Older Kina templates used this checkbox as review state. It is no longer a
# product field, but silently consume the exact legacy line so historical
# notes do not surface it as ordinary journal prose.
LEGACY_COMPLETION_RE = re.compile(
    r"^\s*-\s*\[[ xX]\]\s*(?:完成复盘|完成今天的复盘回应)\s*$"
)
ADVICE_RE = re.compile(r"^\s*(?P<number>\d+)[\.\)、]\s+(?P<text>.+?)\s*$")
WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]")
TIME_RANGE_RE = re.compile(
    r"^(?P<start>[01]\d|2[0-3]):(?P<start_min>[0-5]\d)"
    r"\s*-\s*"
    r"(?P<end>[01]\d|2[0-3]):(?P<end_min>[0-5]\d)$"
)
WORKFLOW_NOTE_RE = re.compile(
    r"^\s*[-*+]\s+\*\*工作流\s+"
    r"(?P<start>[01]\d|2[0-3]):(?P<start_min>[0-5]\d)"
    r"(?:\s*[–—-]\s*(?P<end>[01]\d|2[0-3]):(?P<end_min>[0-5]\d))?"
    r"\*\*\s*[：:]\s*(?P<note>.+?)\s*$"
)
WORKFLOW_BLOCK_RE = re.compile(r"\s+\^(?P<block>workflow-\d{4})\s*$")
WORKFLOW_CALLOUT_HEADER_RE = re.compile(
    r"^\s*>\s*\[![^\]]+\][+-]?\s*(?P<title>.+?)\s*$"
)
WORKFLOW_GROUP_TITLE_RE = re.compile(r"^工作流$")
WORKFLOW_GROUP_ENTRY_RE = re.compile(
    r"^\s*\*\*(?P<start>[01]\d|2[0-3]):(?P<start_min>[0-5]\d)"
    r"(?:\s*[–—-]\s*(?P<end>[01]\d|2[0-3]):(?P<end_min>[0-5]\d))?"
    r"\*\*\s*$"
)
WORKFLOW_CALLOUT_TITLE_RES = (
    re.compile(
        r"^(?P<start>[01]\d|2[0-3]):(?P<start_min>[0-5]\d)"
        r"(?:\s*[–—-]\s*(?P<end>[01]\d|2[0-3]):(?P<end_min>[0-5]\d))?"
        r"\s*[·•]\s*工作流$"
    ),
    re.compile(
        r"^工作流\s*[·•]\s*"
        r"(?P<start>[01]\d|2[0-3]):(?P<start_min>[0-5]\d)"
        r"(?:\s*[–—-]\s*(?P<end>[01]\d|2[0-3]):(?P<end_min>[0-5]\d))?$"
    ),
)
WORKFLOW_CALLOUT_BODY_RE = re.compile(r"^\s*>\s?(?P<body>.*)$")
WORKFLOW_STANDALONE_BLOCK_RE = re.compile(
    r"^\s*\^(?P<block>workflow-\d{4})\s*$"
)
REVIEW_GROUP_TITLE_RE = re.compile(r"^复盘$")
REVIEW_GROUP_ENTRY_RE = re.compile(
    r"^\s*\*\*(?P<title>我的总结|今日总结|今日产出|明天的计划|明日第一步|自由记录)\*\*\s*$"
)
LEGACY_PLUS_WORKFLOW_RE = re.compile(
    r"^\s*-\+\*\*工作流\+"
    r"(?:[01]\d|2[0-3]):[0-5]\d"
    r"(?:[–—-](?:[01]\d|2[0-3]):[0-5]\d)?"
    r"\*\*[：:].+\+\^workflow-\d{4}\s*$"
)

SECTION_ALIASES = {
    "我的总结": "personal_summary",
    "今日总结": "personal_summary",
    "今日产出": "outputs",
    "明天的计划": "next_action",
    "明日第一步": "next_action",
    "自由记录": "freeform",
    "离线活动": "offline",
    "一天活动小总结": "activity_summary",
    "Kina 建议": "kina_advice",
}


def _clean_markdown(lines: list[str]) -> str:
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(line.rstrip() for line in lines).strip()


def _append_section(
    sections: dict[str, list[str]],
    name: str,
    lines: list[str],
) -> None:
    if sections[name] and lines:
        sections[name].append("")
    sections[name].extend(lines)


def _parse_outputs(markdown: str) -> list[str]:
    outputs: list[str] = []
    for raw_line in markdown.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        line = re.sub(r"^[-*+]\s+", "", line)
        outputs.append(line)
    return outputs


def _split_advice(lines: list[str]) -> tuple[list[str], list[str]]:
    advice: list[str] = []
    trailing: list[str] = []
    expected_number = 1
    started = False
    trailing_started = False

    for raw_line in lines:
        line = raw_line.rstrip()
        if trailing_started:
            trailing.append(line)
            continue
        if not line.strip():
            if started:
                continue
            continue
        match = ADVICE_RE.match(line)
        if match and int(match.group("number")) == expected_number:
            started = True
            advice.append(match.group("text").strip())
            expected_number += 1
            continue
        trailing_started = True
        trailing.append(line)
    return advice, trailing


def _time_seconds(hour: int, minute: int) -> int:
    return hour * 3600 + minute * 60


def _parse_offline_line(raw_line: str) -> tuple[OfflineActivity | None, str | None]:
    line = raw_line.strip()
    if not line:
        return None, None
    if not re.match(r"^[-*+]\s+", line):
        return None, "离线活动必须使用 Markdown 列表项。"

    payload = re.sub(r"^[-*+]\s+", "", line, count=1)
    parts = [part.strip() for part in payload.split("|")]
    if len(parts) < 2 or len(parts) > 4:
        return None, "离线活动应包含时间、类别，以及可选的项目和备注。"

    time_match = TIME_RANGE_RE.match(parts[0])
    if not time_match:
        return None, "离线活动时间必须使用 HH:MM-HH:MM。"
    category = parts[1]
    if not category:
        return None, "离线活动类别不能为空。"

    start_seconds = _time_seconds(
        int(time_match.group("start")),
        int(time_match.group("start_min")),
    )
    end_seconds = _time_seconds(
        int(time_match.group("end")),
        int(time_match.group("end_min")),
    )
    crosses_midnight = end_seconds <= start_seconds
    duration_seconds = end_seconds - start_seconds
    if crosses_midnight:
        duration_seconds += int(timedelta(days=1).total_seconds())

    project = ""
    note = ""
    optional = parts[2:]
    if len(optional) == 1:
        links = WIKILINK_RE.findall(optional[0])
        if links:
            project = links[0].strip()
            remainder = WIKILINK_RE.sub("", optional[0]).strip(" ：:")
            note = remainder
        else:
            note = optional[0]
    elif len(optional) == 2:
        project_links = WIKILINK_RE.findall(optional[0])
        project = (
            project_links[0].strip()
            if project_links
            else optional[0].strip()
        )
        note = optional[1]

    return (
        OfflineActivity(
            start_time=parts[0].split("-", 1)[0].strip(),
            end_time=parts[0].split("-", 1)[1].strip(),
            category=category,
            project=project,
            note=note,
            duration_seconds=float(duration_seconds),
            crosses_midnight=crosses_midnight,
            raw=raw_line.rstrip(),
        ),
        None,
    )


def _extract_projects(content: str) -> list[str]:
    return list(dict.fromkeys(link.strip() for link in WIKILINK_RE.findall(content)))


def _parse_workflow_note(raw_line: str) -> WorkflowNote | None:
    # A short-lived frontend bug used URLSearchParams for Obsidian `content`.
    # Obsidian preserved form-encoded spaces as literal plus signs, producing
    # `-+**工作流+...+^workflow-0859`.  Interpret only that exact machine
    # signature as the intended Markdown; arbitrary user prose is untouched.
    normalized_line = raw_line
    if LEGACY_PLUS_WORKFLOW_RE.match(raw_line):
        normalized_line = raw_line.replace("+", " ")

    match = WORKFLOW_NOTE_RE.match(normalized_line)
    if not match:
        return None
    start_time = f"{match.group('start')}:{match.group('start_min')}"
    end_time = ""
    if match.group("end") is not None:
        end_time = f"{match.group('end')}:{match.group('end_min')}"
    note = match.group("note").strip()
    block_match = WORKFLOW_BLOCK_RE.search(note)
    block_id = block_match.group("block") if block_match else ""
    if block_match:
        note = WORKFLOW_BLOCK_RE.sub("", note).strip()
    if not note:
        return None
    return WorkflowNote(
        start_time=start_time,
        end_time=end_time,
        note=note,
        block_id=block_id,
        raw=raw_line.rstrip(),
    )


def _parse_workflow_callout(
    lines: list[str],
    start_index: int,
) -> tuple[WorkflowNote, int] | None:
    """Parse one foldable Obsidian callout and return its next line index."""
    header_match = WORKFLOW_CALLOUT_HEADER_RE.match(lines[start_index])
    if not header_match:
        return None

    title_match = None
    for pattern in WORKFLOW_CALLOUT_TITLE_RES:
        title_match = pattern.match(header_match.group("title"))
        if title_match is not None:
            break
    if title_match is None:
        return None

    body_lines: list[str] = []
    index = start_index + 1
    while index < len(lines):
        body_match = WORKFLOW_CALLOUT_BODY_RE.match(lines[index])
        if body_match is None:
            break
        body_lines.append(body_match.group("body").rstrip())
        index += 1

    note = _clean_markdown(body_lines)
    if not note:
        return None

    # Obsidian requires block ids for structured blocks (including callouts) on
    # a separate line, with a blank line before it. Accept the id only when it
    # immediately follows this callout apart from whitespace.
    block_id = ""
    block_index = index
    while block_index < len(lines) and not lines[block_index].strip():
        block_index += 1
    if block_index < len(lines):
        block_match = WORKFLOW_STANDALONE_BLOCK_RE.match(lines[block_index])
        if block_match is not None:
            block_id = block_match.group("block")
            index = block_index + 1

    start_time = f"{title_match.group('start')}:{title_match.group('start_min')}"
    end_time = ""
    if title_match.group("end") is not None:
        end_time = f"{title_match.group('end')}:{title_match.group('end_min')}"
    return (
        WorkflowNote(
            start_time=start_time,
            end_time=end_time,
            note=note,
            block_id=block_id,
            raw="\n".join(lines[start_index:index]).rstrip(),
        ),
        index,
    )


def _parse_workflow_group_callout(
    lines: list[str],
    start_index: int,
) -> tuple[list[WorkflowNote], int] | None:
    """Parse one daily workflow callout containing multiple timed entries."""
    header_match = WORKFLOW_CALLOUT_HEADER_RE.match(lines[start_index])
    if not header_match or not WORKFLOW_GROUP_TITLE_RE.match(
        header_match.group("title")
    ):
        return None

    body_lines: list[str] = []
    index = start_index + 1
    while index < len(lines):
        body_match = WORKFLOW_CALLOUT_BODY_RE.match(lines[index])
        if body_match is None:
            break
        body_lines.append(body_match.group("body").rstrip())
        index += 1

    entries: list[WorkflowNote] = []
    entry_index = 0
    while entry_index < len(body_lines):
        if not body_lines[entry_index].strip():
            entry_index += 1
            continue
        entry_match = WORKFLOW_GROUP_ENTRY_RE.match(body_lines[entry_index])
        if entry_match is None:
            # Do not consume a user-authored callout that merely happens to be
            # titled "工作流" unless every non-empty part follows our format.
            return None
        next_entry = entry_index + 1
        while next_entry < len(body_lines):
            if WORKFLOW_GROUP_ENTRY_RE.match(body_lines[next_entry]):
                break
            next_entry += 1
        note = _clean_markdown(body_lines[entry_index + 1 : next_entry])
        if not note:
            return None
        start_time = (
            f"{entry_match.group('start')}:{entry_match.group('start_min')}"
        )
        end_time = ""
        if entry_match.group("end") is not None:
            end_time = f"{entry_match.group('end')}:{entry_match.group('end_min')}"
        entries.append(
            WorkflowNote(
                start_time=start_time,
                end_time=end_time,
                note=note,
                block_id="",
                raw="\n".join(
                    [
                        f"> {body_lines[entry_index]}",
                        *[
                            f"> {line}" if line else ">"
                            for line in body_lines[entry_index + 1 : next_entry]
                        ],
                    ]
                ).rstrip(),
            )
        )
        entry_index = next_entry

    if not entries:
        return None
    return entries, index


def _parse_review_group_callout(
    lines: list[str],
    start_index: int,
) -> tuple[dict[str, list[str]], int] | None:
    """Parse one daily review callout containing named review fields."""
    header_match = WORKFLOW_CALLOUT_HEADER_RE.match(lines[start_index])
    if not header_match or not REVIEW_GROUP_TITLE_RE.match(
        header_match.group("title")
    ):
        return None

    body_lines: list[str] = []
    index = start_index + 1
    while index < len(lines):
        body_match = WORKFLOW_CALLOUT_BODY_RE.match(lines[index])
        if body_match is None:
            break
        body_lines.append(body_match.group("body").rstrip())
        index += 1

    fields: dict[str, list[str]] = {}
    entry_index = 0
    while entry_index < len(body_lines):
        if not body_lines[entry_index].strip():
            entry_index += 1
            continue
        entry_match = REVIEW_GROUP_ENTRY_RE.match(body_lines[entry_index])
        if entry_match is None:
            # A user-authored callout may legitimately use the same visible
            # title. Consume it only when every part follows our field format.
            return None
        canonical = SECTION_ALIASES[entry_match.group("title")]
        if canonical in fields:
            return None
        next_entry = entry_index + 1
        while next_entry < len(body_lines):
            if REVIEW_GROUP_ENTRY_RE.match(body_lines[next_entry]):
                break
            next_entry += 1
        fields[canonical] = body_lines[entry_index + 1 : next_entry]
        entry_index = next_entry

    if not fields:
        return None
    return fields, index


def parse_journal(content: str) -> JournalDocument:
    sections = {name: [] for name in set(SECTION_ALIASES.values())}
    body_lines: list[str] = []
    current_section: str | None = None
    current_lines: list[str] = []
    workflow_notes_by_start: dict[str, WorkflowNote] = {}

    def flush_current() -> None:
        nonlocal current_section, current_lines
        if current_section is None:
            current_lines = []
            return
        if current_section == "kina_advice":
            advice, trailing = _split_advice(current_lines)
            sections[current_section].extend(advice)
            if trailing:
                if body_lines and body_lines[-1].strip():
                    body_lines.append("")
                body_lines.extend(trailing)
        else:
            _append_section(sections, current_section, current_lines)
        current_lines = []

    raw_lines = content.splitlines()
    line_index = 0
    while line_index < len(raw_lines):
        review_result = _parse_review_group_callout(raw_lines, line_index)
        if review_result is not None:
            flush_current()
            review_fields, line_index = review_result
            for name, lines in review_fields.items():
                _append_section(sections, name, lines)
            current_section = None
            continue

        group_result = _parse_workflow_group_callout(raw_lines, line_index)
        if group_result is not None:
            workflow_notes, line_index = group_result
            for workflow_note in workflow_notes:
                workflow_notes_by_start[workflow_note.start_time] = workflow_note
            continue

        callout_result = _parse_workflow_callout(raw_lines, line_index)
        if callout_result is not None:
            workflow_note, line_index = callout_result
            # The start clock is stable while a live session's end clock can
            # continue moving. The last record is the current interpretation.
            workflow_notes_by_start[workflow_note.start_time] = workflow_note
            continue

        raw_line = raw_lines[line_index]
        line_index += 1
        workflow_note = _parse_workflow_note(raw_line)
        if workflow_note is not None:
            # The start clock is stable while a live session's end clock can
            # continue moving.  If a user intentionally records the same
            # start twice, the last note is the current interpretation.
            workflow_notes_by_start[workflow_note.start_time] = workflow_note
            continue

        if LEGACY_COMPLETION_RE.match(raw_line):
            continue

        heading_match = HEADING_RE.match(raw_line)
        if heading_match:
            flush_current()
            canonical = SECTION_ALIASES.get(heading_match.group(1).strip())
            if canonical is not None:
                current_section = canonical
            else:
                current_section = None
                body_lines.append(raw_line.rstrip())
            continue

        if current_section is None:
            body_lines.append(raw_line.rstrip())
        else:
            current_lines.append(raw_line.rstrip())
    flush_current()

    offline_activities: list[OfflineActivity] = []
    offline_unparsed: list[str] = []
    warnings: list[ParseWarning] = []
    for raw_line in sections["offline"]:
        activity, error = _parse_offline_line(raw_line)
        if activity is not None:
            offline_activities.append(activity)
        elif error is not None:
            offline_unparsed.append(raw_line.rstrip())
            warnings.append(ParseWarning(line=raw_line.rstrip(), message=error))

    personal_summary = _clean_markdown(sections["personal_summary"])
    outputs_markdown = _clean_markdown(sections["outputs"])
    next_action = _clean_markdown(sections["next_action"])
    freeform = _clean_markdown(sections["freeform"])
    activity_summary = _clean_markdown(sections["activity_summary"])
    body = _clean_markdown(body_lines)
    project_source = "\n".join(
        [
            content,
            personal_summary,
            outputs_markdown,
            next_action,
            freeform,
            activity_summary,
            body,
        ]
    )

    return JournalDocument(
        body_markdown=body,
        personal_summary_markdown=personal_summary,
        outputs=_parse_outputs(outputs_markdown),
        next_action_markdown=next_action,
        freeform_markdown=freeform,
        workflow_notes=list(workflow_notes_by_start.values()),
        offline_activities=offline_activities,
        offline_unparsed=offline_unparsed,
        activity_summary_markdown=activity_summary,
        kina_advice=list(sections["kina_advice"]),
        projects=_extract_projects(project_source),
        parse_warnings=warnings,
    )
