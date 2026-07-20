from __future__ import annotations

import importlib
import json
import sys
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from types import ModuleType
from typing import Any
from urllib.request import urlopen
from zoneinfo import ZoneInfo

from .config import DashboardSettings, load_json


class ActivityWatchAdapter:
    def __init__(
        self,
        settings: DashboardSettings,
        report_module: ModuleType | Any | None = None,
    ):
        self.settings = settings
        self._report_module = report_module

    def _report(self) -> Any:
        if self._report_module is not None:
            return self._report_module
        scripts_dir = str(self.settings.upstream["kina_scripts_dir"])
        if scripts_dir not in sys.path:
            sys.path.insert(0, scripts_dir)
        self._report_module = importlib.import_module("activitywatch_report")
        return self._report_module

    def _activity_config(self) -> dict[str, Any]:
        return load_json(self.settings.upstream["activitywatch_config"])

    def _classification_config(self) -> dict[str, Any]:
        return load_json(self.settings.upstream["activitywatch_categories"])

    def timezone_name(self) -> str:
        return str(self._activity_config()["timezone"])

    def date_range(
        self,
        day: date,
        mode: str,
        timezone_name: str | None = None,
    ) -> tuple[datetime, datetime]:
        zone = ZoneInfo(timezone_name or self.timezone_name())
        if mode == "calendar":
            start_clock = time.min
        elif mode == "routine":
            start_clock = time.fromisoformat(self.settings.routine_day_start)
        else:
            raise ValueError("mode must be calendar or routine")
        start_local = datetime.combine(day, start_clock, tzinfo=zone)
        end_local = start_local + timedelta(days=1)
        return (
            start_local.astimezone(timezone.utc),
            end_local.astimezone(timezone.utc),
        )

    def load_day(self, day: date, mode: str) -> dict[str, Any]:
        report = self._report()
        activity_config = self._activity_config()
        classification = self._classification_config()
        timezone_name = str(activity_config["timezone"])
        start_utc, end_utc = self.date_range(day, mode, timezone_name)
        collection = report.query_configured_events_between(
            activity_config,
            activity_config.get("default_bucket", "window"),
            start_utc,
            end_utc,
        )
        events = collection["attributed_events"]
        aggregates = report.aggregate_categorized_events(
            events,
            classification,
            20,
        )

        annotated_events = []
        categories = classification.get("categories", {})
        for event in events:
            match = report.classify_event(event, classification)
            if match is None:
                annotated_events.append(
                    {
                        **event,
                        "category": "uncategorized",
                        "category_label": "未分类",
                        "classification_rule": None,
                    }
                )
                continue
            annotated_events.append(
                {
                    **event,
                    "category": match["category"],
                    "category_label": categories.get(
                        match["category"], {}
                    ).get("label", match["category"]),
                    "classification_rule": match["rule"],
                }
            )

        return {
            "bucket_id": collection["bucket_id"],
            "range": {
                "start_utc": start_utc.isoformat(),
                "end_utc": end_utc.isoformat(),
                "timezone": timezone_name,
            },
            "sources": collection["sources"],
            "time_accounting": collection["time_accounting"],
            "complete": collection.get("complete", True),
            "issues": collection.get("issues", []),
            "raw_event_count": len(collection["events"]),
            "event_count": len(events),
            "events": annotated_events,
            **aggregates,
        }

    def health(self) -> dict[str, Any]:
        try:
            config = self._activity_config()
            database_path = Path(str(config["database_path"])).expanduser()
        except Exception as exc:
            return {
                "available": False,
                "database_available": False,
                "database_path": "",
                "api_available": False,
                "api_version": "",
                "api_error": f"ActivityWatch configuration unavailable: {exc}",
            }
        api_available = False
        api_version = ""
        api_error = ""
        try:
            with urlopen("http://127.0.0.1:5600/api/0/info", timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8"))
            api_available = True
            api_version = str(payload.get("version", ""))
        except Exception as exc:
            api_error = str(exc)
        return {
            "available": database_path.is_file() and api_available,
            "database_available": database_path.is_file(),
            "database_path": str(database_path),
            "api_available": api_available,
            "api_version": api_version,
            "api_error": api_error,
        }
