from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .models import FileFingerprint
from .paths import default_config_path, expanded_path


def load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected a JSON object in {path}")
    return payload


def fingerprint_file(path: Path) -> FileFingerprint:
    if not path.is_file():
        return FileFingerprint(path=str(path), mtime_ns=0, size=0)
    stat = path.stat()
    return FileFingerprint(
        path=str(path),
        mtime_ns=stat.st_mtime_ns,
        size=stat.st_size,
    )


@dataclass(frozen=True)
class DashboardSettings:
    config_path: Path
    raw: dict[str, Any]

    @property
    def host(self) -> str:
        return str(self.raw.get("host", "127.0.0.1"))

    @property
    def port(self) -> int:
        return int(self.raw.get("port", 8765))

    @property
    def idle_timeout_seconds(self) -> int:
        return int(self.raw.get("idle_timeout_seconds", 900))

    @property
    def today_ttl_seconds(self) -> int:
        return int(self.raw.get("today_ttl_seconds", 300))

    @property
    def max_range_days(self) -> int:
        return int(self.raw.get("max_range_days", 31))

    @property
    def default_mode(self) -> str:
        return str(self.raw.get("default_mode", "calendar"))

    @property
    def routine_day_start(self) -> str:
        return str(self.raw.get("routine_day_start", "06:00"))

    @property
    def journal_write_enabled(self) -> bool:
        return bool(self.raw.get("journal_write_enabled", False))

    @property
    def weekly_reviews_dir(self) -> str:
        return str(self.raw.get("weekly_reviews_dir", "Review/Weekly"))

    @property
    def cache_dir(self) -> Path:
        return expanded_path(str(self.raw["cache_dir"]))

    @property
    def journal_schema_version(self) -> int:
        return int(self.raw.get("journal_schema_version", 1))

    @property
    def activity_schema_version(self) -> int:
        return int(self.raw.get("activity_schema_version", 1))

    @property
    def day_schema_version(self) -> int:
        return int(self.raw.get("day_schema_version", 1))

    @property
    def timeline_merge_gap_seconds(self) -> float:
        return float(self.raw.get("timeline_merge_gap_seconds", 2))

    @property
    def focus_gap_seconds(self) -> float:
        return float(self.raw.get("focus_gap_seconds", 120))

    @property
    def meaningful_block_seconds(self) -> float:
        return float(self.raw.get("meaningful_block_seconds", 60))

    @property
    def upstream(self) -> dict[str, Path]:
        values = self.raw.get("upstream") or {}
        return {
            key: expanded_path(str(value))
            for key, value in values.items()
        }

    def upstream_fingerprint(self) -> str:
        paths = [
            self.config_path,
            self.upstream["activitywatch_config"],
            self.upstream["activitywatch_categories"],
            self.upstream["obsidian_config"],
            self.upstream["daily_review_config"],
        ]
        payload = {
            "files": [fingerprint_file(path).to_dict() for path in paths],
            "journal_schema_version": self.journal_schema_version,
            "activity_schema_version": self.activity_schema_version,
            "day_schema_version": self.day_schema_version,
        }
        encoded = json.dumps(payload, sort_keys=True).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()


def load_settings(
    config_path: str | Path | None = None,
) -> DashboardSettings:
    path = (
        Path(config_path).expanduser().resolve()
        if config_path is not None
        else default_config_path()
    )
    raw = load_json(path)
    if str(raw.get("host", "127.0.0.1")) not in {"127.0.0.1", "localhost"}:
        raise ValueError("Dashboard host must remain local-only.")
    return DashboardSettings(config_path=path, raw=raw)
