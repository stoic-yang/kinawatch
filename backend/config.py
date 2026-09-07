from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .models import FileFingerprint
from .paths import default_config_path, default_data_dir, expanded_path


CURRENT_JOURNAL_SCHEMA_VERSION = 3
CURRENT_DAY_SCHEMA_VERSION = 12


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
    def activity_edit_enabled(self) -> bool:
        return bool(self.raw.get("activity_edit_enabled", False))

    @property
    def activity_edit_store_path(self) -> Path:
        configured = self.raw.get("activity_edit_store_path")
        if configured:
            return self.configured_path(str(configured))
        return (default_data_dir() / "activity-edits.json").resolve(
            strict=False
        )

    @property
    def weekly_reviews_dir(self) -> str:
        return str(self.raw.get("weekly_reviews_dir", "Review/Weekly"))

    @property
    def monthly_reviews_dir(self) -> str:
        return str(self.raw.get("monthly_reviews_dir", "Review/Monthly"))

    @property
    def cache_dir(self) -> Path:
        return expanded_path(str(self.raw["cache_dir"]))

    @property
    def journal_schema_version(self) -> int:
        return max(
            CURRENT_JOURNAL_SCHEMA_VERSION,
            int(self.raw.get("journal_schema_version", 1)),
        )

    @property
    def activity_schema_version(self) -> int:
        return int(self.raw.get("activity_schema_version", 1))

    @property
    def day_schema_version(self) -> int:
        return max(
            CURRENT_DAY_SCHEMA_VERSION,
            int(self.raw.get("day_schema_version", 1)),
        )

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
        """Return the v1 Kina workspace paths for migration compatibility."""
        values = self.raw.get("upstream") or {}
        return {
            key: expanded_path(str(value))
            for key, value in values.items()
        }

    def configured_path(self, raw_value: str | Path) -> Path:
        path = Path(raw_value).expanduser()
        if not path.is_absolute():
            path = self.config_path.parent / path
        return path.resolve(strict=False)

    @cached_property
    def activitywatch(self) -> dict[str, Any]:
        direct = self.raw.get("activitywatch")
        if isinstance(direct, dict):
            normalized = dict(direct)
            categories_file = normalized.get("categories_file")
            if not categories_file:
                raise ValueError("activitywatch.categories_file is required")
            normalized["categories_file"] = self.configured_path(
                str(categories_file)
            )
            normalized.setdefault("server_url", "http://127.0.0.1:5600")
            normalized.setdefault("timezone", "local")
            normalized.setdefault("timeout_seconds", 10)
            normalized.setdefault("filter_afk", True)
            normalized.setdefault("background_app_equals", [])
            media_activity = normalized.get("media_activity") or {}
            if not isinstance(media_activity, dict):
                raise ValueError("activitywatch.media_activity must be an object")
            media_rules = media_activity.get("rules") or []
            if not isinstance(media_rules, list):
                raise ValueError("activitywatch.media_activity.rules must be an array")
            matcher_keys = {
                f"{field}_{operator}"
                for field in (
                    "app",
                    "title",
                    "url",
                    "project",
                    "file",
                    "language",
                    "status",
                )
                for operator in ("equals", "contains", "regex")
            }
            for rule in media_rules:
                if not isinstance(rule, dict):
                    raise ValueError(
                        "activitywatch.media_activity.rules entries must be objects"
                    )
                configured_matchers = matcher_keys.intersection(rule)
                if not configured_matchers:
                    raise ValueError(
                        "activitywatch.media_activity rules require a matcher"
                    )
                for key in configured_matchers:
                    values = rule.get(key)
                    if (
                        not isinstance(values, list)
                        or not values
                        or any(not str(value).strip() for value in values)
                    ):
                        raise ValueError(
                            f"activitywatch.media_activity rule {key} requires "
                            "non-empty values"
                        )
            normalized["media_activity"] = {
                **media_activity,
                "enabled": bool(media_activity.get("enabled", False)),
                "rules": [dict(rule) for rule in media_rules],
            }
            return normalized

        upstream = self.upstream
        activity_path = upstream.get("activitywatch_config")
        categories_path = upstream.get("activitywatch_categories")
        if activity_path is None or categories_path is None:
            raise ValueError(
                "activitywatch configuration is missing; copy "
                "config/kinawatch.example.json to config/kinawatch.local.json"
            )
        legacy = load_json(activity_path)
        aliases = legacy.get("bucket_aliases") or {}
        default_bucket = str(legacy.get("default_bucket", "window"))
        return {
            "server_url": str(
                legacy.get("base_url", "http://127.0.0.1:5600")
            ),
            "timezone": str(legacy.get("timezone", "local")),
            "timeout_seconds": float(legacy.get("timeout_seconds", 10)),
            "filter_afk": bool(legacy.get("filter_afk", True)),
            "window_bucket_id": aliases.get(default_bucket, default_bucket),
            "afk_bucket_id": aliases.get("afk", "afk"),
            "background_app_equals": list(
                legacy.get("background_app_equals") or []
            ),
            "media_activity": {"enabled": False, "rules": []},
            "categories_file": categories_path,
            "legacy_config_file": activity_path,
        }

    @cached_property
    def journal(self) -> dict[str, Any]:
        direct = self.raw.get("journal")
        if isinstance(direct, dict):
            normalized = dict(direct)
            inferred_provider = "obsidian" if normalized.get("vault") else "local"
            provider = str(
                normalized.get("provider", inferred_provider)
            ).strip().casefold()
            if provider not in {"local", "obsidian"}:
                raise ValueError("journal.provider must be 'local' or 'obsidian'")
            normalized["provider"] = provider
            normalized.setdefault("daily_notes_dir", "Daily")
            normalized.setdefault("daily_note_date_format", "%Y-%m-%d")
            normalized.setdefault("daily_note_template", [])
            normalized.setdefault("permanent_note_path", "incoming.md")
            normalized.setdefault("beliefs_note_path", "Review/我的人生信念.md")

            if provider == "local":
                storage_dir = normalized.get("storage_dir")
                storage_root = (
                    self.configured_path(str(storage_dir))
                    if storage_dir
                    else default_data_dir() / "journal"
                )
                normalized["storage_dir"] = storage_root
                # JournalRepository historically calls the storage boundary a
                # vault. Keep the internal alias while exposing provider and
                # storage_dir as the public contract.
                normalized["vault"] = storage_root
                normalized["vault_name"] = ""
                return normalized

            vault = normalized.get("vault")
            if not vault:
                raise ValueError(
                    "journal.vault is required when journal.provider is 'obsidian'"
                )
            normalized["vault"] = self.configured_path(str(vault))
            normalized["storage_dir"] = normalized["vault"]
            normalized.setdefault("vault_name", normalized["vault"].name)
            return normalized

        upstream = self.upstream
        obsidian_path = upstream.get("obsidian_config")
        review_path = upstream.get("daily_review_config")
        if obsidian_path is None or review_path is None:
            raise ValueError(
                "journal configuration is missing; copy "
                "config/kinawatch.example.json to config/kinawatch.local.json"
            )
        obsidian = load_json(obsidian_path)
        review = load_json(review_path)
        vault = expanded_path(str(obsidian["default_vault"]))
        return {
            "provider": "obsidian",
            "vault": vault,
            "storage_dir": vault,
            "vault_name": str(review.get("vault_name", vault.name)),
            "daily_notes_dir": str(review.get("daily_notes_dir", "Daily")),
            "daily_note_date_format": str(
                review.get("daily_note_date_format", "%Y-%m-%d")
            ),
            "daily_note_template": list(review.get("daily_note_template") or []),
            "permanent_note_path": "incoming.md",
            "beliefs_note_path": "Review/我的人生信念.md",
            "legacy_obsidian_config_file": obsidian_path,
            "legacy_review_config_file": review_path,
        }

    def timezone_name(self) -> str:
        configured = str(self.activitywatch.get("timezone", "local")).strip()
        if configured and configured.casefold() != "local":
            try:
                ZoneInfo(configured)
            except ZoneInfoNotFoundError as exc:
                raise ValueError(
                    f"Unknown ActivityWatch timezone: {configured}"
                ) from exc
            return configured

        environment_timezone = os.environ.get("TZ", "").strip()
        if environment_timezone:
            try:
                ZoneInfo(environment_timezone)
                return environment_timezone
            except ZoneInfoNotFoundError:
                pass
        for candidate in (Path("/etc/localtime"), Path("/var/db/timezone/localtime")):
            try:
                resolved = str(candidate.resolve(strict=True))
            except OSError:
                continue
            marker = "/zoneinfo/"
            if marker in resolved:
                timezone_name = resolved.split(marker, 1)[1]
                try:
                    ZoneInfo(timezone_name)
                    return timezone_name
                except ZoneInfoNotFoundError:
                    continue
        return "UTC"

    def input_fingerprint(self) -> str:
        paths = [self.config_path]
        activitywatch = self.activitywatch
        journal = self.journal
        for key in (
            "categories_file",
            "legacy_config_file",
            "legacy_obsidian_config_file",
            "legacy_review_config_file",
        ):
            value = activitywatch.get(key) or journal.get(key)
            if isinstance(value, Path):
                paths.append(value)
        payload = {
            "files": [fingerprint_file(path).to_dict() for path in paths],
            "journal_provider": str(journal["provider"]),
            "journal_storage_dir": str(journal["storage_dir"]),
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
