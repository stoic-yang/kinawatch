from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from .config import DashboardSettings, load_json


class ActivityWatchError(RuntimeError):
    pass


def _timestamp(raw_value: str) -> datetime:
    parsed = datetime.fromisoformat(raw_value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _event_interval(event: dict[str, Any]) -> tuple[datetime, datetime]:
    start = _timestamp(str(event["timestamp"]))
    return start, start + timedelta(seconds=float(event["duration_seconds"]))


def _merge_intervals(
    intervals: list[tuple[datetime, datetime]],
) -> list[tuple[datetime, datetime]]:
    merged: list[list[datetime]] = []
    for start, end in sorted(intervals):
        if end <= start:
            continue
        if not merged or start > merged[-1][1]:
            merged.append([start, end])
        elif end > merged[-1][1]:
            merged[-1][1] = end
    return [(start, end) for start, end in merged]


def _duration(intervals: list[tuple[datetime, datetime]]) -> float:
    return sum((end - start).total_seconds() for start, end in intervals)


def _normalize(raw_value: Any) -> str:
    return "" if raw_value is None else str(raw_value).casefold()


class ActivityWatchRESTClient:
    def __init__(self, base_url: str, timeout_seconds: float = 10):
        normalized = base_url.rstrip("/")
        parsed = urlsplit(normalized)
        if parsed.scheme not in {"http", "https"}:
            raise ValueError("ActivityWatch server_url must use http or https")
        if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError(
                "KinaWatch only supports a loopback ActivityWatch server in v1"
            )
        self.base_url = normalized
        self.timeout_seconds = timeout_seconds

    def _get(self, path: str, parameters: dict[str, str] | None = None) -> Any:
        query = f"?{urlencode(parameters)}" if parameters else ""
        request = Request(
            f"{self.base_url}{path}{query}",
            headers={"Accept": "application/json"},
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace").strip()
            raise ActivityWatchError(
                f"ActivityWatch returned HTTP {exc.code}: {detail}"
            ) from exc
        except URLError as exc:
            raise ActivityWatchError(
                f"ActivityWatch request failed: {exc.reason}"
            ) from exc
        except (OSError, json.JSONDecodeError) as exc:
            raise ActivityWatchError(f"ActivityWatch response failed: {exc}") from exc

    def info(self) -> dict[str, Any]:
        payload = self._get("/api/0/info")
        if not isinstance(payload, dict):
            raise ActivityWatchError("ActivityWatch info response is not an object")
        return payload

    def buckets(self) -> dict[str, dict[str, Any]]:
        payload = self._get("/api/0/buckets/")
        if not isinstance(payload, dict):
            raise ActivityWatchError("ActivityWatch buckets response is not an object")
        return {
            str(bucket_id): metadata
            for bucket_id, metadata in payload.items()
            if isinstance(metadata, dict)
        }

    def events(
        self,
        bucket_id: str,
        start_utc: datetime,
        end_utc: datetime,
    ) -> list[dict[str, Any]]:
        payload = self._get(
            f"/api/0/buckets/{quote(bucket_id, safe='')}/events",
            {
                "start": start_utc.isoformat(),
                "end": end_utc.isoformat(),
            },
        )
        if not isinstance(payload, list):
            raise ActivityWatchError(
                f"ActivityWatch events response for {bucket_id} is not a list"
            )
        return [item for item in payload if isinstance(item, dict)]


class ActivityWatchAdapter:
    def __init__(
        self,
        settings: DashboardSettings,
        client: ActivityWatchRESTClient | Any | None = None,
    ):
        self.settings = settings
        self._client = client
        self._resolved: dict[str, Any] | None = None
        self._classification_cache: tuple[tuple[int, int], dict[str, Any]] | None = None

    def _activity_config(self) -> dict[str, Any]:
        return self.settings.activitywatch

    def _classification_config(self) -> dict[str, Any]:
        path = Path(self._activity_config()["categories_file"])
        if not path.is_file():
            raise ValueError(f"ActivityWatch categories file is unavailable: {path}")
        stat = path.stat()
        fingerprint = (stat.st_mtime_ns, stat.st_size)
        if (
            self._classification_cache is not None
            and self._classification_cache[0] == fingerprint
        ):
            return self._classification_cache[1]
        payload = load_json(path)
        categories = payload.get("categories")
        rules = payload.get("rules")
        if not isinstance(categories, dict) or not isinstance(rules, list):
            raise ValueError(
                "ActivityWatch categories file requires object 'categories' "
                "and array 'rules'"
            )
        self._classification_cache = (fingerprint, payload)
        return payload

    def _api(self) -> ActivityWatchRESTClient | Any:
        if self._client is None:
            config = self._activity_config()
            self._client = ActivityWatchRESTClient(
                str(config.get("server_url", "http://127.0.0.1:5600")),
                float(config.get("timeout_seconds", 10)),
            )
        return self._client

    def timezone_name(self) -> str:
        return self.settings.timezone_name()

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

    def _resolve_bucket(
        self,
        kind: str,
        buckets: dict[str, dict[str, Any]],
        hostname: str,
    ) -> str:
        config = self._activity_config()
        explicit = str(config.get(f"{kind}_bucket_id") or "").strip()
        if explicit:
            if explicit not in buckets:
                raise ActivityWatchError(
                    f"Configured ActivityWatch {kind} bucket does not exist: {explicit}"
                )
            return explicit

        target_type = "currentwindow" if kind == "window" else "afkstatus"
        client_prefix = "aw-watcher-window" if kind == "window" else "aw-watcher-afk"
        candidates = [
            bucket_id
            for bucket_id, metadata in buckets.items()
            if str(metadata.get("type", "")) == target_type
            or str(metadata.get("client", "")).startswith(client_prefix)
        ]
        configured_hostname = str(config.get("hostname") or hostname).strip()
        matching_hostname = [
            bucket_id
            for bucket_id in candidates
            if str(buckets[bucket_id].get("hostname", "")) == configured_hostname
        ]
        if len(matching_hostname) == 1:
            return matching_hostname[0]
        if len(candidates) == 1:
            return candidates[0]
        if not candidates:
            raise ActivityWatchError(
                f"No ActivityWatch {kind} bucket was found; start the standard watchers "
                f"or set activitywatch.{kind}_bucket_id"
            )
        raise ActivityWatchError(
            f"Multiple ActivityWatch {kind} buckets were found; set "
            f"activitywatch.{kind}_bucket_id explicitly"
        )

    def _resolve_buckets(self) -> dict[str, Any]:
        if self._resolved is not None:
            return self._resolved
        api = self._api()
        info = api.info()
        buckets = api.buckets()
        hostname = str(info.get("hostname", ""))
        window_bucket_id = self._resolve_bucket("window", buckets, hostname)
        config = self._activity_config()
        afk_bucket_id = ""
        if bool(config.get("filter_afk", True)):
            afk_bucket_id = self._resolve_bucket("afk", buckets, hostname)
        self._resolved = {
            "info": info,
            "buckets": buckets,
            "window_bucket_id": window_bucket_id,
            "afk_bucket_id": afk_bucket_id,
        }
        return self._resolved

    @staticmethod
    def _parse_event(
        item: dict[str, Any],
        bucket_id: str,
        source: str,
        start_utc: datetime,
        end_utc: datetime,
    ) -> dict[str, Any] | None:
        if "timestamp" not in item:
            return None
        raw_start = _timestamp(str(item["timestamp"]))
        raw_duration = float(item.get("duration", 0.0))
        raw_end = raw_start + timedelta(seconds=raw_duration)
        clipped_start = max(raw_start, start_utc)
        clipped_end = min(raw_end, end_utc)
        if clipped_end <= clipped_start:
            return None
        data = item.get("data") if isinstance(item.get("data"), dict) else {}
        return {
            "timestamp": clipped_start.isoformat(),
            "duration_seconds": (clipped_end - clipped_start).total_seconds(),
            "raw_timestamp": raw_start.isoformat(),
            "raw_duration_seconds": raw_duration,
            "app": data.get("app"),
            "title": data.get("title"),
            "url": data.get("url"),
            "project": data.get("project"),
            "file": data.get("file"),
            "language": data.get("language"),
            "status": data.get("status"),
            "source": source,
            "bucket_id": bucket_id,
        }

    def _load_events(
        self,
        bucket_id: str,
        source: str,
        start_utc: datetime,
        end_utc: datetime,
    ) -> list[dict[str, Any]]:
        return [
            event
            for item in self._api().events(bucket_id, start_utc, end_utc)
            if (
                event := self._parse_event(
                    item,
                    bucket_id,
                    source,
                    start_utc,
                    end_utc,
                )
            )
            is not None
        ]

    @staticmethod
    def _active_intervals(
        events: list[dict[str, Any]],
    ) -> list[tuple[datetime, datetime]]:
        return _merge_intervals(
            [
                _event_interval(event)
                for event in events
                if _normalize(event.get("status")) == "not-afk"
            ]
        )

    @staticmethod
    def _clip_events(
        events: list[dict[str, Any]],
        intervals: list[tuple[datetime, datetime]],
    ) -> list[dict[str, Any]]:
        clipped: list[dict[str, Any]] = []
        for event in events:
            event_start, event_end = _event_interval(event)
            for interval_start, interval_end in intervals:
                if interval_end <= event_start:
                    continue
                if interval_start >= event_end:
                    break
                start = max(event_start, interval_start)
                end = min(event_end, interval_end)
                if end > start:
                    clipped.append(
                        {
                            **event,
                            "timestamp": start.isoformat(),
                            "duration_seconds": (end - start).total_seconds(),
                            "afk_filtered": True,
                        }
                    )
        return clipped

    @staticmethod
    def _partition_overlaps(
        events: list[dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], float]:
        if not events:
            return [], 0.0
        rows = [(*_event_interval(event), event) for event in events]
        boundaries = sorted({value for start, end, _ in rows for value in (start, end)})
        adjusted: list[dict[str, Any]] = []
        overlap_seconds = 0.0
        for start, end in zip(boundaries, boundaries[1:]):
            seconds = (end - start).total_seconds()
            active = [event for left, right, event in rows if left < end and right > start]
            if not active or seconds <= 0:
                continue
            if len(active) > 1:
                overlap_seconds += seconds
            share = seconds / len(active)
            for event in active:
                adjusted.append(
                    {
                        **event,
                        "timestamp": start.isoformat(),
                        "duration_seconds": share,
                        "overlap_adjusted": len(active) > 1,
                    }
                )
        return adjusted, overlap_seconds

    @staticmethod
    def _rule_matches(event: dict[str, Any], rule: dict[str, Any]) -> bool:
        for field in ("app", "title", "url", "project", "file", "language", "status"):
            value = _normalize(event.get(field))
            equals = rule.get(f"{field}_equals")
            if isinstance(equals, list) and not any(
                value == _normalize(candidate) for candidate in equals
            ):
                return False
            contains = rule.get(f"{field}_contains")
            if isinstance(contains, list) and not any(
                _normalize(candidate) in value for candidate in contains
            ):
                return False
            patterns = rule.get(f"{field}_regex")
            if isinstance(patterns, list) and not any(
                re.search(str(pattern), str(event.get(field) or ""), re.IGNORECASE)
                for pattern in patterns
            ):
                return False
        return True

    @classmethod
    def _classify(
        cls,
        event: dict[str, Any],
        classification: dict[str, Any],
    ) -> dict[str, str] | None:
        for rule in classification.get("rules", []):
            if not isinstance(rule, dict) or not cls._rule_matches(event, rule):
                continue
            category = str(rule.get("category", ""))
            if not category:
                continue
            return {
                "category": category,
                "rule": str(rule.get("name") or category),
                "rule_label": str(rule.get("label") or rule.get("name") or category),
            }
        return None

    @staticmethod
    def _aggregate_events(
        events: list[dict[str, Any]],
        limit: int,
    ) -> dict[str, Any]:
        apps: dict[str, dict[str, Any]] = defaultdict(
            lambda: {"duration_seconds": 0.0, "event_count": 0}
        )
        titles: dict[str, dict[str, Any]] = defaultdict(
            lambda: {"duration_seconds": 0.0, "event_count": 0, "app": None}
        )
        total = 0.0
        for event in events:
            seconds = float(event["duration_seconds"])
            total += seconds
            app = str(event.get("app") or "(unknown app)")
            title = str(event.get("title") or "(no title)")
            apps[app]["duration_seconds"] += seconds
            apps[app]["event_count"] += 1
            titles[title]["duration_seconds"] += seconds
            titles[title]["event_count"] += 1
            titles[title]["app"] = app

        def rows(mapping: dict[str, dict[str, Any]], field: str) -> list[dict[str, Any]]:
            result = []
            for key, values in mapping.items():
                row = {field: key, **values}
                if total:
                    row["share"] = round(float(values["duration_seconds"]) / total, 4)
                result.append(row)
            result.sort(key=lambda item: (-float(item["duration_seconds"]), str(item[field])))
            return result[:limit]

        return {
            "top_apps": rows(apps, "app"),
            "top_titles": rows(titles, "title"),
            "total_duration_seconds": total,
        }

    @classmethod
    def _aggregate_categories(
        cls,
        events: list[dict[str, Any]],
        classification: dict[str, Any],
        limit: int,
    ) -> dict[str, Any]:
        total = sum(float(event["duration_seconds"]) for event in events)
        category_events: dict[str, list[dict[str, Any]]] = defaultdict(list)
        rule_stats: dict[str, dict[str, dict[str, Any]]] = defaultdict(
            lambda: defaultdict(
                lambda: {"duration_seconds": 0.0, "event_count": 0, "label": ""}
            )
        )
        uncategorized: list[dict[str, Any]] = []
        for event in events:
            match = cls._classify(event, classification)
            if match is None:
                uncategorized.append(event)
                continue
            category_events[match["category"]].append(event)
            stats = rule_stats[match["category"]][match["rule"]]
            stats["duration_seconds"] += float(event["duration_seconds"])
            stats["event_count"] += 1
            stats["label"] = match["rule_label"]

        metadata = classification.get("categories", {})
        categories = []
        for category, items in category_events.items():
            aggregate = cls._aggregate_events(items, limit)
            seconds = float(aggregate["total_duration_seconds"])
            top_rules = [
                {
                    "rule": rule,
                    "label": values["label"],
                    "duration_seconds": values["duration_seconds"],
                    "event_count": values["event_count"],
                    **(
                        {"share": round(float(values["duration_seconds"]) / total, 4)}
                        if total
                        else {}
                    ),
                }
                for rule, values in rule_stats[category].items()
            ]
            top_rules.sort(key=lambda item: (-float(item["duration_seconds"]), item["rule"]))
            row = {
                "category": category,
                "label": str(metadata.get(category, {}).get("label", category)),
                "duration_seconds": seconds,
                "event_count": len(items),
                "top_apps": aggregate["top_apps"],
                "top_titles": aggregate["top_titles"],
                "top_rules": top_rules[:limit],
            }
            if total:
                row["share"] = round(seconds / total, 4)
            categories.append(row)
        categories.sort(key=lambda item: (-float(item["duration_seconds"]), item["category"]))

        uncategorized_aggregate = cls._aggregate_events(uncategorized, limit)
        uncategorized_row = {
            "duration_seconds": uncategorized_aggregate["total_duration_seconds"],
            "event_count": len(uncategorized),
            "top_apps": uncategorized_aggregate["top_apps"],
            "top_titles": uncategorized_aggregate["top_titles"],
        }
        if total:
            uncategorized_row["share"] = round(
                float(uncategorized_row["duration_seconds"]) / total,
                4,
            )
        classified = sum(float(row["duration_seconds"]) for row in categories)
        return {
            "total_duration_seconds": total,
            "classified_duration_seconds": classified,
            "coverage": round(classified / total, 4) if total else 0.0,
            "categories": categories,
            "uncategorized": uncategorized_row,
        }

    def load_day(self, day: date, mode: str) -> dict[str, Any]:
        resolved = self._resolve_buckets()
        classification = self._classification_config()
        timezone_name = self.timezone_name()
        start_utc, end_utc = self.date_range(day, mode, timezone_name)
        source = str(
            self._activity_config().get("source_label")
            or resolved["info"].get("hostname")
            or "local"
        )
        window_events = self._load_events(
            resolved["window_bucket_id"], source, start_utc, end_utc
        )
        observed_seconds = sum(
            float(event["duration_seconds"]) for event in window_events
        )
        active_intervals: list[tuple[datetime, datetime]] = []
        afk_events: list[dict[str, Any]] = []
        if resolved["afk_bucket_id"]:
            afk_events = self._load_events(
                resolved["afk_bucket_id"], source, start_utc, end_utc
            )
            active_intervals = self._active_intervals(afk_events)
            active_events = self._clip_events(window_events, active_intervals)
        else:
            active_events = window_events
        active_before_background = sum(
            float(event["duration_seconds"]) for event in active_events
        )
        background = {
            _normalize(value)
            for value in self._activity_config().get("background_app_equals", [])
            if _normalize(value)
        }
        foreground = [
            event
            for event in active_events
            if _normalize(event.get("app")) not in background
        ]
        foreground_seconds = sum(
            float(event["duration_seconds"]) for event in foreground
        )
        events, overlap_seconds = self._partition_overlaps(foreground)
        wall_seconds = sum(float(event["duration_seconds"]) for event in events)

        categories_meta = classification.get("categories", {})
        annotated = []
        for event in events:
            match = self._classify(event, classification)
            if match is None:
                annotated.append(
                    {
                        **event,
                        "category": "uncategorized",
                        "category_label": "未分类",
                        "classification_rule": None,
                    }
                )
            else:
                annotated.append(
                    {
                        **event,
                        "category": match["category"],
                        "category_label": categories_meta.get(
                            match["category"], {}
                        ).get("label", match["category"]),
                        "classification_rule": match["rule"],
                    }
                )
        aggregates = self._aggregate_categories(events, classification, 20)
        afk_applied = bool(resolved["afk_bucket_id"])
        inactive_window_seconds = (
            max(0.0, (end_utc - start_utc).total_seconds() - _duration(active_intervals))
            if afk_applied
            else 0.0
        )
        time_accounting = {
            "policy": "activitywatch_rest_afk_intersection",
            "raw_device_duration_seconds": foreground_seconds,
            "wall_duration_seconds": wall_seconds,
            "overlap_adjustment_seconds": max(0.0, foreground_seconds - wall_seconds),
            "parallel_wall_seconds": 0.0,
            "background_overlap_removed_seconds": 0.0,
            "max_parallel_sources": 1 if events else 0,
            "observed_device_duration_seconds": observed_seconds,
            "afk_removed_seconds": max(0.0, observed_seconds - active_before_background),
            "inactive_window_seconds": inactive_window_seconds,
            "background_window_removed_seconds": max(
                0.0, active_before_background - foreground_seconds
            ),
            "overlap_wall_seconds": overlap_seconds,
        }
        source_payload = {
            "name": source,
            "label": source,
            "type": "activitywatch-rest",
            "ok": True,
            "bucket_id": resolved["window_bucket_id"],
            "event_count": len(events),
            "duration_seconds": wall_seconds,
            "observed_event_count": len(window_events),
            "observed_duration_seconds": observed_seconds,
            "afk_filter": {
                "applied": afk_applied,
                "bucket_id": resolved["afk_bucket_id"] or None,
                "event_count": len(afk_events),
                "active_interval_count": len(active_intervals),
                "active_interval_seconds": _duration(active_intervals),
                "afk_removed_seconds": time_accounting["afk_removed_seconds"],
                "inactive_window_seconds": inactive_window_seconds,
                "background_removed_seconds": time_accounting[
                    "background_window_removed_seconds"
                ],
            },
        }
        return {
            "bucket_id": resolved["window_bucket_id"],
            "range": {
                "start_utc": start_utc.isoformat(),
                "end_utc": end_utc.isoformat(),
                "timezone": timezone_name,
            },
            "sources": [source_payload],
            "time_accounting": time_accounting,
            "complete": True,
            "issues": [],
            "raw_event_count": len(window_events),
            "event_count": len(events),
            "events": annotated,
            **aggregates,
        }

    def health(self) -> dict[str, Any]:
        try:
            config = self._activity_config()
            self._classification_config()
            resolved = self._resolve_buckets()
            info = resolved["info"]
            return {
                "available": True,
                "api_available": True,
                "api_version": str(info.get("version", "")),
                "api_error": "",
                "server_url": str(config.get("server_url", "")),
                "window_bucket_id": resolved["window_bucket_id"],
                "afk_bucket_id": resolved["afk_bucket_id"],
                "integration": "activitywatch-rest",
            }
        except Exception as exc:
            return {
                "available": False,
                "api_available": False,
                "api_version": "",
                "api_error": str(exc),
                "server_url": "",
                "window_bucket_id": "",
                "afk_bucket_id": "",
                "integration": "activitywatch-rest",
            }
