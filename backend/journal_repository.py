from __future__ import annotations

import os
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
    provider: str = "obsidian"


class JournalRepository:
    def __init__(self, settings: DashboardSettings):
        self.settings = settings

    def _runtime_config(self) -> dict[str, Any]:
        return self.settings.journal

    def locate(self, day: date) -> JournalLocation:
        config = self._runtime_config()
        provider = str(config["provider"])
        storage_root = Path(config["storage_dir"])
        daily_directory = storage_root / str(config["daily_notes_dir"])
        note_name = day.strftime(str(config["daily_note_date_format"]))
        note = daily_directory / f"{note_name}.md"
        if provider == "obsidian" and not note.exists():
            matches = sorted(daily_directory.glob(f"{note_name}*.md"))
            if matches:
                note = matches[0]
        relative_path = note.relative_to(storage_root).as_posix()
        url = ""
        if provider == "obsidian":
            vault_name = str(config.get("vault_name", storage_root.name))
            url = (
                f"obsidian://open?vault={quote(vault_name, safe='')}"
                f"&file={quote(relative_path.removesuffix('.md'), safe='/')}"
            )
        return JournalLocation(
            vault=storage_root,
            note=note,
            relative_path=relative_path,
            obsidian_url=url,
            fingerprint=fingerprint_file(note),
            provider=provider,
        )

    def read(self, location: JournalLocation) -> str:
        if not location.note.is_file():
            return ""
        return location.note.read_text(encoding="utf-8")

    def _locate_period_review(
        self,
        directory: str,
        period_id: str,
    ) -> JournalLocation:
        config = self._runtime_config()
        provider = str(config["provider"])
        storage_root = Path(config["storage_dir"])
        note = storage_root / directory / f"{period_id}.md"
        relative_path = note.relative_to(storage_root).as_posix()
        url = ""
        if provider == "obsidian":
            vault_name = str(config.get("vault_name", storage_root.name))
            url = (
                f"obsidian://open?vault={quote(vault_name, safe='')}"
                f"&file={quote(relative_path.removesuffix('.md'), safe='/')}"
            )
        return JournalLocation(
            vault=storage_root,
            note=note,
            relative_path=relative_path,
            obsidian_url=url,
            fingerprint=fingerprint_file(note),
            provider=provider,
        )

    def locate_weekly(self, week_id: str) -> JournalLocation:
        return self._locate_period_review(
            self.settings.weekly_reviews_dir,
            week_id,
        )

    def locate_monthly(self, month_id: str) -> JournalLocation:
        return self._locate_period_review(
            self.settings.monthly_reviews_dir,
            month_id,
        )

    def locate_permanent(self) -> JournalLocation:
        return self._locate_standing_note("permanent_note_path", "incoming.md")

    def locate_beliefs(self) -> JournalLocation:
        return self._locate_standing_note("beliefs_note_path", "Review/我的人生信念.md")

    def _locate_standing_note(self, key: str, default: str) -> JournalLocation:
        config = self._runtime_config()
        provider = str(config["provider"])
        storage_root = Path(config["storage_dir"])
        raw_path = str(config.get(key, default)).strip()
        relative = Path(raw_path)
        if (
            not raw_path
            or relative.is_absolute()
            or ".." in relative.parts
            or relative.suffix.casefold() != ".md"
        ):
            raise ValueError(
                f"journal.{key} must be a relative Markdown path"
            )
        note = storage_root / relative
        relative_path = note.relative_to(storage_root).as_posix()
        url = ""
        if provider == "obsidian":
            vault_name = str(config.get("vault_name", storage_root.name))
            url = (
                f"obsidian://open?vault={quote(vault_name, safe='')}"
                f"&file={quote(relative_path.removesuffix('.md'), safe='/')}"
            )
        return JournalLocation(
            vault=storage_root,
            note=note,
            relative_path=relative_path,
            obsidian_url=url,
            fingerprint=fingerprint_file(note),
            provider=provider,
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
    def period_review_initial_content(period_id: str) -> str:
        return "\n".join(
            [
                "---",
                f"title: {period_id}",
                "---",
                "",
                f"# {period_id}",
                "",
                "## 自由记录",
            ]
        )

    @staticmethod
    def weekly_review_initial_content(week_id: str) -> str:
        return JournalRepository.period_review_initial_content(week_id)

    @staticmethod
    def monthly_review_initial_content(month_id: str) -> str:
        return JournalRepository.period_review_initial_content(month_id)

    def health(self) -> dict[str, Any]:
        try:
            config = self._runtime_config()
        except Exception as exc:
            return {
                "provider": "",
                "managed_storage": False,
                "vault": "",
                "storage_root": "",
                "daily_directory": "",
                "available": False,
                "error": f"Journal configuration unavailable: {exc}",
            }
        provider = str(config["provider"])
        storage_root = Path(config["storage_dir"])
        daily_directory = storage_root / str(config["daily_notes_dir"])
        if provider == "local":
            available = self._directory_can_be_created(daily_directory)
            error = "" if available else "Local journal storage is not writable."
        else:
            available = daily_directory.is_dir()
            error = "" if available else "Obsidian daily-note directory is unavailable."
        return {
            "provider": provider,
            "managed_storage": provider == "local",
            "vault": str(storage_root) if provider == "obsidian" else "",
            "storage_root": str(storage_root),
            "daily_directory": str(daily_directory),
            "available": available,
            "error": error,
        }

    @staticmethod
    def _directory_can_be_created(path: Path) -> bool:
        candidate = path
        while not candidate.exists() and candidate != candidate.parent:
            candidate = candidate.parent
        return candidate.is_dir() and os.access(candidate, os.W_OK | os.X_OK)
