from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(frozen=True)
class FileFingerprint:
    path: str
    mtime_ns: int
    size: int

    def to_dict(self) -> dict[str, Any]:
        # Nanosecond timestamps exceed JavaScript's safe integer range on
        # contemporary filesystems.  Serialize the value as a decimal string
        # so a browser can round-trip the optimistic-lock token losslessly.
        return {
            "path": self.path,
            "mtime_ns": str(self.mtime_ns),
            "size": self.size,
        }


@dataclass(frozen=True)
class ParseWarning:
    line: str
    message: str

    def to_dict(self) -> dict[str, str]:
        return asdict(self)


@dataclass(frozen=True)
class OfflineActivity:
    start_time: str
    end_time: str
    category: str
    project: str
    note: str
    duration_seconds: float
    crosses_midnight: bool
    raw: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class WorkflowNote:
    start_time: str
    end_time: str
    note: str
    block_id: str
    raw: str

    def to_dict(self) -> dict[str, str]:
        return asdict(self)


@dataclass
class JournalDocument:
    body_markdown: str = ""
    personal_summary_markdown: str = ""
    outputs: list[str] = field(default_factory=list)
    next_action_markdown: str = ""
    workflow_notes: list[WorkflowNote] = field(default_factory=list)
    offline_activities: list[OfflineActivity] = field(default_factory=list)
    offline_unparsed: list[str] = field(default_factory=list)
    activity_summary_markdown: str = ""
    kina_advice: list[str] = field(default_factory=list)
    completion_task_exists: bool = False
    completion_task_checked: bool = False
    projects: list[str] = field(default_factory=list)
    parse_warnings: list[ParseWarning] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "body_markdown": self.body_markdown,
            "personal_summary_markdown": self.personal_summary_markdown,
            "outputs": list(self.outputs),
            "next_action_markdown": self.next_action_markdown,
            "workflow_notes": [note.to_dict() for note in self.workflow_notes],
            "offline_activities": [
                activity.to_dict() for activity in self.offline_activities
            ],
            "offline_unparsed": list(self.offline_unparsed),
            "activity_summary_markdown": self.activity_summary_markdown,
            "kina_advice": list(self.kina_advice),
            "completion_task_exists": self.completion_task_exists,
            "completion_task_checked": self.completion_task_checked,
            "projects": list(self.projects),
            "parse_warnings": [
                warning.to_dict() for warning in self.parse_warnings
            ],
        }
