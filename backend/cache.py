from __future__ import annotations

import copy
import json
import os
import threading
import time
from datetime import date
from pathlib import Path
from typing import Any

from .config import DashboardSettings
from .models import FileFingerprint


class DayCache:
    def __init__(self, settings: DashboardSettings, root: Path | None = None):
        self.settings = settings
        self.root = root or settings.cache_dir
        self.day_root = self.root / "days"

    def _path(self, day: date, mode: str) -> Path:
        return self.day_root / f"{day.isoformat()}-{mode}.json"

    def invalidate(self, day: date) -> None:
        """Remove only cached variants for one date after a journal write."""
        if not self.day_root.is_dir():
            return
        for path in self.day_root.glob(f"{day.isoformat()}-*.json"):
            path.unlink(missing_ok=True)

    def get(
        self,
        day: date,
        mode: str,
        journal_fingerprint: FileFingerprint,
        upstream_fingerprint: str,
        *,
        is_today: bool,
        refresh: bool = False,
        now_epoch: float | None = None,
    ) -> dict[str, Any] | None:
        if refresh:
            return None
        path = self._path(day, mode)
        if not path.is_file():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        metadata = payload.pop("_cache_meta", None)
        if not isinstance(metadata, dict):
            return None
        if metadata.get("mode") != mode:
            return None
        if metadata.get("journal_fingerprint") != journal_fingerprint.to_dict():
            return None
        if metadata.get("upstream_fingerprint") != upstream_fingerprint:
            return None
        if int(metadata.get("day_schema_version", 0)) != self.settings.day_schema_version:
            return None
        if is_today:
            now = time.time() if now_epoch is None else now_epoch
            created = float(metadata.get("created_at_epoch", 0))
            if now - created > self.settings.today_ttl_seconds:
                return None
        response = copy.deepcopy(payload)
        response.setdefault("cache", {})
        response["cache"]["hit"] = True
        return response

    def put(
        self,
        day: date,
        mode: str,
        journal_fingerprint: FileFingerprint,
        upstream_fingerprint: str,
        response: dict[str, Any],
        *,
        now_epoch: float | None = None,
    ) -> None:
        self.day_root.mkdir(parents=True, exist_ok=True)
        path = self._path(day, mode)
        payload = copy.deepcopy(response)
        payload["_cache_meta"] = {
            "mode": mode,
            "created_at_epoch": time.time() if now_epoch is None else now_epoch,
            "journal_fingerprint": journal_fingerprint.to_dict(),
            "upstream_fingerprint": upstream_fingerprint,
            "day_schema_version": self.settings.day_schema_version,
        }
        # The threaded HTTP server can aggregate the same date concurrently
        # (day, week and month requests overlap on today).  A PID-only name
        # lets those writers replace one another's temporary file and causes
        # an intermittent FileNotFoundError/HTTP 500.  Keep each thread's
        # atomic write staging file distinct.
        temporary = path.with_name(
            f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp"
        )
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        temporary.replace(path)
