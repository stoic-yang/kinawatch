from __future__ import annotations

import json
import hashlib
import re
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import (
    HTTPRedirectHandler,
    ProxyHandler,
    Request,
    build_opener,
)
from zoneinfo import ZoneInfo

from .activity_edits import ActivityEditStore
from .config import DashboardSettings, load_json

CLASSIFICATION_FIELDS = (
    "app", "title", "url", "project", "file", "language", "status",
    "bundle_id", "source_type",
)


class ActivityWatchError(RuntimeError):
    pass


class _RejectRedirects(HTTPRedirectHandler):
    """Keep an approved loopback request from being redirected elsewhere."""

    def redirect_request(
        self,
        request: Request,
        file_pointer: Any,
        code: int,
        message: str,
        headers: Any,
        new_url: str,
    ) -> Request | None:
        raise HTTPError(
            request.full_url,
            code,
            "ActivityWatch redirects are not allowed",
            headers,
            file_pointer,
        )


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


def _source_fingerprint(
    item: dict[str, Any],
    bucket_id: str,
) -> str:
    payload = {
        "bucket_id": bucket_id,
        "event_id": str(item.get("id")) if item.get("id") is not None else None,
        "timestamp": str(item.get("timestamp") or ""),
        "duration": float(item.get("duration", 0.0)),
        "data": item.get("data") if isinstance(item.get("data"), dict) else {},
    }
    return hashlib.sha256(
        json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


class ActivityWatchRESTClient:
    def __init__(self, base_url: str, timeout_seconds: float = 10):
        normalized = base_url.strip().rstrip("/")
        if not normalized or any(character.isspace() for character in normalized):
            raise ValueError("ActivityWatch server_url is invalid")
        parsed = urlsplit(normalized)
        scheme = parsed.scheme.casefold()
        hostname = (parsed.hostname or "").rstrip(".").casefold()
        if scheme not in {"http", "https"}:
            raise ValueError("ActivityWatch server_url must use http or https")
        if hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError(
                "KinaWatch only supports a loopback ActivityWatch server in v1"
            )
        if (
            parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError(
                "ActivityWatch server_url must not include credentials, a query, "
                "or a fragment"
            )
        try:
            port = parsed.port
        except ValueError as exc:
            raise ValueError("ActivityWatch server_url port is invalid") from exc
        if port is not None and not 1 <= port <= 65535:
            raise ValueError("ActivityWatch server_url port is invalid")
        self.base_url = normalized
        self.timeout_seconds = float(timeout_seconds)
        if self.timeout_seconds <= 0:
            raise ValueError("ActivityWatch timeout_seconds must be positive")
        # Environment proxy variables must never route private ActivityWatch
        # data away from the local machine. Redirects are rejected so an
        # initially valid loopback URL cannot become an SSRF hop.
        self._opener = build_opener(ProxyHandler({}), _RejectRedirects())

    def _get(self, path: str, parameters: dict[str, str] | None = None) -> Any:
        query = f"?{urlencode(parameters)}" if parameters else ""
        request = Request(  # noqa: S310 - validated loopback URL only.
            f"{self.base_url}{path}{query}",
            headers={"Accept": "application/json"},
        )
        try:
            with self._opener.open(request, timeout=self.timeout_seconds) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            try:
                detail = exc.read(4096).decode("utf-8", errors="replace").strip()
            finally:
                exc.close()
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
        edit_store: ActivityEditStore | None = None,
    ):
        self.settings = settings
        self._client = client
        self.activity_edits = edit_store or ActivityEditStore(settings)
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
            payload = self._classification_cache[1]
        else:
            payload = load_json(path)
            categories = payload.get("categories")
            rules = payload.get("rules")
            if not isinstance(categories, dict) or not isinstance(rules, list):
                raise ValueError(
                    "ActivityWatch categories file requires object 'categories' "
                    "and array 'rules'"
                )
            self._classification_cache = (fingerprint, payload)
        categories = dict(payload["categories"])
        categories.update(self.activity_edits.custom_categories())
        return {**payload, "categories": categories}

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
    def _normalize_event(
        item: dict[str, Any],
        bucket_id: str,
        source: str,
    ) -> dict[str, Any] | None:
        if "timestamp" not in item:
            return None
        raw_start = _timestamp(str(item["timestamp"]))
        raw_duration = float(item.get("duration", 0.0))
        if raw_duration <= 0:
            return None
        data = item.get("data") if isinstance(item.get("data"), dict) else {}
        return {
            "timestamp": raw_start.isoformat(),
            "duration_seconds": raw_duration,
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
            "event_id": (
                str(item["id"]) if item.get("id") is not None else None
            ),
            "source_fingerprint": _source_fingerprint(item, bucket_id),
        }

    def _parse_event(
        self,
        item: dict[str, Any],
        bucket_id: str,
        source: str,
        start_utc: datetime,
        end_utc: datetime,
    ) -> dict[str, Any] | None:
        event = self._normalize_event(item, bucket_id, source)
        if event is None:
            return None
        event = self.activity_edits.apply_event(event)
        effective_start = _timestamp(str(event["timestamp"]))
        effective_end = effective_start + timedelta(
            seconds=float(event["duration_seconds"])
        )
        clipped_start = max(effective_start, start_utc)
        clipped_end = min(effective_end, end_utc)
        if clipped_end <= clipped_start:
            return None
        return {
            **event,
            "timestamp": clipped_start.isoformat(),
            "duration_seconds": (clipped_end - clipped_start).total_seconds(),
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
    def _clip_parsed_events(
        events: list[dict[str, Any]],
        start_utc: datetime,
        end_utc: datetime,
    ) -> list[dict[str, Any]]:
        """Clip already-normalized events to one day inside a batched query."""
        clipped: list[dict[str, Any]] = []
        for event in events:
            event_start, event_end = _event_interval(event)
            start = max(event_start, start_utc)
            end = min(event_end, end_utc)
            if end <= start:
                continue
            clipped.append(
                {
                    **event,
                    "timestamp": start.isoformat(),
                    "duration_seconds": (end - start).total_seconds(),
                }
            )
        return clipped

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
        starts: dict[datetime, list[int]] = defaultdict(list)
        ends: dict[datetime, list[int]] = defaultdict(list)
        boundaries: set[datetime] = set()
        for index, event in enumerate(events):
            start, end = _event_interval(event)
            boundaries.update((start, end))
            if end > start:
                starts[start].append(index)
                ends[end].append(index)
        ordered_boundaries = sorted(boundaries)
        active_indices: set[int] = set()
        adjusted: list[dict[str, Any]] = []
        overlap_seconds = 0.0
        for start, end in zip(ordered_boundaries, ordered_boundaries[1:]):
            active_indices.update(starts.get(start, ()))
            active_indices.difference_update(ends.get(start, ()))
            seconds = (end - start).total_seconds()
            if not active_indices or seconds <= 0:
                continue
            if len(active_indices) > 1:
                overlap_seconds += seconds
            share = seconds / len(active_indices)
            # Preserve input order within overlaps, including identical events.
            for index in sorted(active_indices):
                adjusted.append(
                    {
                        **events[index],
                        "timestamp": start.isoformat(),
                        "duration_seconds": share,
                        "wall_end_timestamp": end.isoformat(),
                        "overlap_adjusted": len(active_indices) > 1,
                    }
                )
        return adjusted, overlap_seconds

    @staticmethod
    def _rule_matches(event: dict[str, Any], rule: dict[str, Any]) -> bool:
        for field in CLASSIFICATION_FIELDS:
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

    def _media_activity_rules(self) -> tuple[bool, list[dict[str, Any]]]:
        config = self._activity_config().get("media_activity") or {}
        enabled = bool(config.get("enabled", False))
        rules = [rule for rule in config.get("rules", []) if isinstance(rule, dict)]
        return enabled, rules

    @classmethod
    def _is_foreground_media(
        cls,
        event: dict[str, Any],
        rules: list[dict[str, Any]],
    ) -> bool:
        return any(cls._rule_matches(event, rule) for rule in rules)

    @classmethod
    def _apply_media_activity(
        cls,
        window_events: list[dict[str, Any]],
        active_intervals: list[tuple[datetime, datetime]],
        *,
        enabled: bool,
        rules: list[dict[str, Any]],
        afk_applied: bool,
    ) -> list[dict[str, Any]]:
        if not afk_applied:
            return [
                {
                    **event,
                    "media_playing": bool(
                        enabled and cls._is_foreground_media(event, rules)
                    ),
                }
                for event in window_events
            ]
        effective: list[dict[str, Any]] = []
        for event in window_events:
            if enabled and cls._is_foreground_media(event, rules):
                effective.append({**event, "media_playing": True})
            else:
                effective.extend(cls._clip_events([event], active_intervals))
        return effective

    @classmethod
    def _classify(
        cls,
        event: dict[str, Any],
        classification: dict[str, Any],
    ) -> dict[str, str] | None:
        manual_category = str(event.get("manual_category") or "").strip()
        if manual_category:
            return {
                "category": manual_category,
                "category_label": str(
                    event.get("manual_category_label") or manual_category
                ),
                "rule": "manual-override",
                "rule_label": "手动分类",
            }
        for rule in classification.get("rules", []):
            if not isinstance(rule, dict) or not cls._rule_matches(event, rule):
                continue
            category = str(rule.get("category", ""))
            if not category:
                continue
            return {
                "category": category,
                "category_label": str(
                    classification.get("categories", {})
                    .get(category, {})
                    .get("label", category)
                ),
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
    def _classify_events(
        cls,
        events: list[dict[str, Any]],
        classification: dict[str, Any],
    ) -> list[tuple[dict[str, Any], dict[str, str] | None]]:
        # Only reuse matches within this calculation, so changed rules or
        # manual overrides never inherit a match from a previous request.
        fields = (*CLASSIFICATION_FIELDS, "manual_category", "manual_category_label")
        matches: dict[tuple[tuple[str, bool], ...], dict[str, str] | None] = {}
        classified = []
        for event in events:
            # Rules use both str(value) and str(value or "") for matching.
            key = tuple(
                (str(event.get(field)), bool(event.get(field))) for field in fields
            )
            if key not in matches:
                matches[key] = cls._classify(event, classification)
            classified.append((event, matches[key]))
        return classified

    @classmethod
    def _aggregate_categories(
        cls,
        classified: list[tuple[dict[str, Any], dict[str, str] | None]],
        classification: dict[str, Any],
        limit: int,
    ) -> dict[str, Any]:
        total = sum(float(event["duration_seconds"]) for event, _ in classified)
        category_events: dict[str, list[dict[str, Any]]] = defaultdict(list)
        rule_stats: dict[str, dict[str, dict[str, Any]]] = defaultdict(
            lambda: defaultdict(
                lambda: {"duration_seconds": 0.0, "event_count": 0, "label": ""}
            )
        )
        uncategorized: list[dict[str, Any]] = []
        for event, match in classified:
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

    def _summarize_day(
        self,
        *,
        resolved: dict[str, Any],
        classification: dict[str, Any],
        timezone_name: str,
        source: str,
        start_utc: datetime,
        end_utc: datetime,
        window_events: list[dict[str, Any]],
        afk_events: list[dict[str, Any]],
    ) -> dict[str, Any]:
        observed_seconds = sum(
            float(event["duration_seconds"]) for event in window_events
        )
        active_intervals: list[tuple[datetime, datetime]] = []
        afk_applied = bool(resolved["afk_bucket_id"])
        if afk_applied:
            active_intervals = self._active_intervals(afk_events)
            interactive_events = self._clip_events(window_events, active_intervals)
        else:
            interactive_events = window_events
        media_enabled, media_rules = self._media_activity_rules()
        active_events = self._apply_media_activity(
            window_events,
            active_intervals,
            enabled=media_enabled,
            rules=media_rules,
            afk_applied=afk_applied,
        )
        interactive_before_background = sum(
            float(event["duration_seconds"]) for event in interactive_events
        )
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
        interactive_foreground = [
            event
            for event in interactive_events
            if _normalize(event.get("app")) not in background
        ]
        foreground_seconds = sum(
            float(event["duration_seconds"]) for event in foreground
        )
        interactive_wall_events, _ = self._partition_overlaps(
            interactive_foreground
        )
        interactive_wall_seconds = sum(
            float(event["duration_seconds"]) for event in interactive_wall_events
        )
        events, overlap_seconds = self._partition_overlaps(foreground)
        wall_seconds = sum(float(event["duration_seconds"]) for event in events)
        media_events = [event for event in foreground if event.get("media_playing")]
        media_intervals = _merge_intervals(
            [_event_interval(event) for event in media_events]
        )
        foreground_media_seconds = _duration(media_intervals)
        passive_media_seconds = max(0.0, wall_seconds - interactive_wall_seconds)

        categories_meta = classification.get("categories", {})
        classified = self._classify_events(events, classification)
        annotated = []
        for event, match in classified:
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
                        "category_label": match.get("category_label")
                        or categories_meta.get(match["category"], {}).get(
                            "label",
                            match["category"],
                        ),
                        "classification_rule": match["rule"],
                    }
                )
        aggregates = self._aggregate_categories(classified, classification, 20)
        manual_conflicts = sum(
            bool(event.get("manual_edit_conflict")) for event in events
        )
        issues = []
        if manual_conflicts:
            issues.append(
                f"{manual_conflicts} 条手动活动校正因原始事件变化而未应用。"
            )
        inactive_window_seconds = (
            max(0.0, (end_utc - start_utc).total_seconds() - _duration(active_intervals))
            if afk_applied
            else 0.0
        )
        time_accounting = {
            "policy": (
                "activitywatch_rest_afk_plus_foreground_media"
                if afk_applied and media_enabled
                else "activitywatch_rest_afk_intersection"
            ),
            "raw_device_duration_seconds": foreground_seconds,
            "wall_duration_seconds": wall_seconds,
            "interactive_wall_seconds": interactive_wall_seconds,
            "foreground_media_wall_seconds": foreground_media_seconds,
            "passive_media_seconds": passive_media_seconds,
            "media_activity_enabled": media_enabled,
            "overlap_adjustment_seconds": max(0.0, foreground_seconds - wall_seconds),
            "parallel_wall_seconds": 0.0,
            "background_overlap_removed_seconds": 0.0,
            "max_parallel_sources": 1 if events else 0,
            "observed_device_duration_seconds": observed_seconds,
            "afk_removed_before_media_seconds": max(
                0.0,
                observed_seconds - interactive_before_background,
            ),
            "afk_removed_seconds": max(
                0.0,
                observed_seconds - active_before_background,
            ),
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
            "manual_edit_conflicts": manual_conflicts,
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
            "media_activity": {
                "enabled": media_enabled,
                "matched_event_count": len(media_events),
                "foreground_media_seconds": foreground_media_seconds,
                "passive_media_seconds": passive_media_seconds,
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
            "issues": issues,
            "raw_event_count": len(window_events),
            "event_count": len(events),
            "events": annotated,
            **aggregates,
        }

    def _load_context(
        self,
    ) -> tuple[dict[str, Any], dict[str, Any], str, str]:
        resolved = self._resolve_buckets()
        classification = self._classification_config()
        timezone_name = self.timezone_name()
        source = str(
            self._activity_config().get("source_label")
            or resolved["info"].get("hostname")
            or "local"
        )
        return resolved, classification, timezone_name, source

    def load_day(self, day: date, mode: str) -> dict[str, Any]:
        resolved, classification, timezone_name, source = self._load_context()
        start_utc, end_utc = self.date_range(day, mode, timezone_name)
        window_events = self._load_events(
            resolved["window_bucket_id"], source, start_utc, end_utc
        )
        afk_events: list[dict[str, Any]] = []
        if resolved["afk_bucket_id"]:
            afk_events = self._load_events(
                resolved["afk_bucket_id"], source, start_utc, end_utc
            )
        return self._summarize_day(
            resolved=resolved,
            classification=classification,
            timezone_name=timezone_name,
            source=source,
            start_utc=start_utc,
            end_utc=end_utc,
            window_events=window_events,
            afk_events=afk_events,
        )

    def load_days(self, days: list[date], mode: str) -> dict[date, dict[str, Any]]:
        """Load a bounded group with one REST query per ActivityWatch bucket."""
        selected_days = sorted(set(days))
        if not selected_days:
            return {}

        resolved, classification, timezone_name, source = self._load_context()
        batch_start, _ = self.date_range(selected_days[0], mode, timezone_name)
        _, batch_end = self.date_range(selected_days[-1], mode, timezone_name)
        window_batch = self._load_events(
            resolved["window_bucket_id"], source, batch_start, batch_end
        )
        afk_batch: list[dict[str, Any]] = []
        if resolved["afk_bucket_id"]:
            afk_batch = self._load_events(
                resolved["afk_bucket_id"], source, batch_start, batch_end
            )

        results: dict[date, dict[str, Any]] = {}
        for day in selected_days:
            start_utc, end_utc = self.date_range(day, mode, timezone_name)
            results[day] = self._summarize_day(
                resolved=resolved,
                classification=classification,
                timezone_name=timezone_name,
                source=source,
                start_utc=start_utc,
                end_utc=end_utc,
                window_events=self._clip_parsed_events(
                    window_batch, start_utc, end_utc
                ),
                afk_events=self._clip_parsed_events(afk_batch, start_utc, end_utc),
            )
        return results

    def correction_fingerprint(self, day: date) -> str:
        return self.activity_edits.fingerprint_for_day(day)

    @staticmethod
    def _local_input_value(value: datetime, zone: ZoneInfo) -> str:
        return (
            value.astimezone(zone)
            .replace(tzinfo=None)
            .isoformat(timespec="seconds")
        )

    @classmethod
    def _category_view(
        cls,
        event: dict[str, Any],
        classification: dict[str, Any],
    ) -> dict[str, str]:
        match = cls._classify(event, classification)
        if match is None:
            return {"category": "uncategorized", "category_label": "未分类"}
        return {
            "category": match["category"],
            "category_label": match.get("category_label")
            or match["category"],
        }

    def inspect_events(
        self,
        day: date,
        mode: str,
        bucket_id: str,
        event_ids: list[str],
    ) -> dict[str, Any]:
        resolved, classification, timezone_name, source = self._load_context()
        if bucket_id != resolved["window_bucket_id"]:
            raise ValueError("只能检查当前配置的窗口活动 bucket。")
        requested = {str(value) for value in event_ids}
        start_utc, end_utc = self.date_range(day, mode, timezone_name)
        raw_items = self._api().events(bucket_id, start_utc, end_utc)
        zone = ZoneInfo(timezone_name)
        now_utc = datetime.now(timezone.utc)
        rows: list[dict[str, Any]] = []
        for item in raw_items:
            original = self._normalize_event(item, bucket_id, source)
            if original is None:
                continue
            event_id = original.get("event_id")
            if event_id is None or str(event_id) not in requested:
                continue
            effective = self.activity_edits.apply_event(original)
            original_start = _timestamp(str(original["timestamp"]))
            original_end = original_start + timedelta(
                seconds=float(original["duration_seconds"])
            )
            effective_start = _timestamp(str(effective["timestamp"]))
            effective_end = effective_start + timedelta(
                seconds=float(effective["duration_seconds"])
            )
            automatic_event = dict(effective)
            automatic_event.pop("manual_category", None)
            automatic_event.pop("manual_category_label", None)
            original_category = self._category_view(original, classification)
            automatic_category = self._category_view(
                automatic_event,
                classification,
            )
            effective_category = self._category_view(
                effective,
                classification,
            )
            rows.append(
                {
                    "bucket_id": bucket_id,
                    "event_id": str(event_id),
                    "source_fingerprint": original["source_fingerprint"],
                    "editable": original_end <= now_utc - timedelta(seconds=60),
                    "ended": original_end <= now_utc,
                    "original": {
                        "start": original_start.isoformat(),
                        "end": original_end.isoformat(),
                        "start_local": self._local_input_value(
                            original_start,
                            zone,
                        ),
                        "end_local": self._local_input_value(
                            original_end,
                            zone,
                        ),
                        "app": str(original.get("app") or ""),
                        "title": str(original.get("title") or ""),
                        **original_category,
                    },
                    "effective": {
                        "start": effective_start.isoformat(),
                        "end": effective_end.isoformat(),
                        "start_local": self._local_input_value(
                            effective_start,
                            zone,
                        ),
                        "end_local": self._local_input_value(
                            effective_end,
                            zone,
                        ),
                        "app": str(effective.get("app") or ""),
                        "title": str(effective.get("title") or ""),
                        **effective_category,
                    },
                    "automatic_category": automatic_category,
                    "manual_category": (
                        {
                            "category": str(effective["manual_category"]),
                            "label": str(
                                effective.get("manual_category_label")
                                or effective["manual_category"]
                            ),
                        }
                        if effective.get("manual_category")
                        else None
                    ),
                    "manual_edit": bool(effective.get("manual_edit")),
                    "manual_edit_fields": list(
                        effective.get("manual_edit_fields") or []
                    ),
                    "manual_edit_conflict": bool(
                        effective.get("manual_edit_conflict")
                    ),
                }
            )
        rows.sort(key=lambda item: item["original"]["start"])
        category_rows = [
            {
                "category": str(category),
                "label": str(metadata.get("label") or category),
                "custom": bool(metadata.get("custom")),
            }
            for category, metadata in classification.get("categories", {}).items()
            if isinstance(metadata, dict)
        ]
        category_rows.append(
            {
                "category": "uncategorized",
                "label": "未分类",
                "custom": False,
            }
        )
        category_rows.sort(
            key=lambda item: (
                item["category"] == "uncategorized",
                item["custom"],
                item["label"],
            )
        )
        return {
            "date": day.isoformat(),
            "mode": mode,
            "timezone": timezone_name,
            "bucket_id": bucket_id,
            "revision": self.activity_edits.revision_token(),
            "categories": category_rows,
            "events": rows,
        }

    def health(self) -> dict[str, Any]:
        try:
            config = self._activity_config()
            self._classification_config()
            resolved = self._resolve_buckets()
            info = resolved["info"]
            edit_health = self.activity_edits.health()
            return {
                "available": True,
                "api_available": True,
                "api_version": str(info.get("version", "")),
                "api_error": "",
                "server_url": str(config.get("server_url", "")),
                "window_bucket_id": resolved["window_bucket_id"],
                "afk_bucket_id": resolved["afk_bucket_id"],
                "integration": "activitywatch-rest",
                "activity_edits": edit_health,
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
                "activity_edits": self.activity_edits.health(),
            }
