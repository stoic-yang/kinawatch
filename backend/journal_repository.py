from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any
from urllib.parse import quote

from .config import DashboardSettings, fingerprint_file
from .models import FileFingerprint


@dataclass(frozen=True)
class JournalLocation:
    vault: Path
    note: Path
    relative_path: str
    obsidian_url: str
    fingerprint: FileFingerprint


class JournalRepository:
    def __init__(self, settings: DashboardSettings):
        self.settings = settings

    def _runtime_config(self) -> dict[str, Any]:
        return self.settings.journal

    def locate(self, day: date) -> JournalLocation:
        config = self._runtime_config()
        vault = Path(config["vault"])
        daily_directory = vault / str(config["daily_notes_dir"])
        note_name = day.strftime(str(config["daily_note_date_format"]))
        note = daily_directory / f"{note_name}.md"
        if not note.exists():
            matches = sorted(daily_directory.glob(f"{note_name}*.md"))
            if matches:
                note = matches[0]
        relative_path = str(note.relative_to(vault))
        vault_name = str(config.get("vault_name", vault.name))
        url = (
            f"obsidian://open?vault={quote(vault_name, safe='')}"
            f"&file={quote(relative_path.removesuffix('.md'), safe='/')}"
        )
        return JournalLocation(
            vault=vault,
            note=note,
            relative_path=relative_path,
            obsidian_url=url,
            fingerprint=fingerprint_file(note),
        )

    def read(self, location: JournalLocation) -> str:
        if not location.note.is_file():
            return ""
        return location.note.read_text(encoding="utf-8")

    def locate_weekly(self, week_id: str) -> JournalLocation:
        config = self._runtime_config()
        vault = Path(config["vault"])
        note = vault / self.settings.weekly_reviews_dir / f"{week_id}.md"
        relative_path = str(note.relative_to(vault))
        vault_name = str(config.get("vault_name", vault.name))
        url = (
            f"obsidian://open?vault={quote(vault_name, safe='')}"
            f"&file={quote(relative_path.removesuffix('.md'), safe='/')}"
        )
        return JournalLocation(
            vault=vault,
            note=note,
            relative_path=relative_path,
            obsidian_url=url,
            fingerprint=fingerprint_file(note),
        )

    def initial_content(self) -> str:
        """Return the configured daily-note skeleton for a newly created note."""
        config = self._runtime_config()
        raw_template = config.get("daily_note_template") or []
        if not isinstance(raw_template, list) or not all(
            isinstance(line, str) for line in raw_template
        ):
            raise ValueError("daily_note_template must be a list of strings")
        return "\n".join(line.rstrip() for line in raw_template).strip()

    @staticmethod
    def weekly_review_initial_content(week_id: str) -> str:
        return "\n".join(
            [
                "---",
                f"title: {week_id}",
                "---",
                "",
                f"# {week_id}",
                "",
                "## 本周可验证结果",
                "",
                "## 六个系统的投入",
                "",
                "## 有效做法与失效模式",
                "",
                "## 需要回写的系统",
                "",
                "## 下周最小成果",
            ]
        )

    def health(self) -> dict[str, Any]:
        try:
            config = self._runtime_config()
        except Exception as exc:
            return {
                "vault": "",
                "daily_directory": "",
                "available": False,
                "error": f"Journal configuration unavailable: {exc}",
            }
        vault = Path(config["vault"])
        daily_directory = vault / str(config["daily_notes_dir"])
        return {
            "vault": str(vault),
            "daily_directory": str(daily_directory),
            "available": daily_directory.is_dir(),
            "error": "" if daily_directory.is_dir() else "Daily-note directory is unavailable.",
        }
