from __future__ import annotations

import hashlib
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from typing import Any, Iterable
from zoneinfo import ZoneInfo

from .activitywatch_adapter import ActivityWatchAdapter
from .cache import DayCache
from .config import DashboardSettings
from .journal_parser import parse_journal
from .journal_repository import JournalRepository
from .workflow_sessions import build_workflow_snapshot


def _timestamp(raw_value: str) -> datetime:
    return datetime.fromisoformat(raw_value.replace("Z", "+00:00"))


def _event_interval(event: dict[str, Any]) -> tuple[datetime, datetime]:
    start = _timestamp(str(event["timestamp"]))
    wall_end = event.get("wall_end_timestamp")
    end = (
        _timestamp(str(wall_end))
        if wall_end
        else start + timedelta(seconds=float(event["duration_seconds"]))
    )
    return start, end


def _merge_intervals(
    intervals: Iterable[tuple[datetime, datetime]],
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


def _intersection_seconds(
    left: Iterable[tuple[datetime, datetime]],
    right: Iterable[tuple[datetime, datetime]],
) -> float:
    left_rows = _merge_intervals(left)
    right_rows = _merge_intervals(right)
    total = 0.0
    left_index = 0
    right_index = 0
    while left_index < len(left_rows) and right_index < len(right_rows):
        left_start, left_end = left_rows[left_index]
        right_start, right_end = right_rows[right_index]
        total += max(
            0.0,
            (min(left_end, right_end) - max(left_start, right_start)).total_seconds(),
        )
        if left_end <= right_end:
            left_index += 1
        else:
            right_index += 1
    return total


def _interval_duration(
    intervals: Iterable[tuple[datetime, datetime]],
) -> float:
    return sum(
        (end - start).total_seconds()
        for start, end in _merge_intervals(intervals)
    )


def _screen_wall_intervals(
    events: Iterable[dict[str, Any]],
) -> list[tuple[datetime, datetime]]:
    return [
        (start, end)
        for event in events
        for start, end in [_event_interval(event)]
        if end > start
    ]


def _clipped_intervals(
    intervals: Iterable[tuple[datetime, datetime]],
    range_start: datetime,
    range_end: datetime,
) -> list[tuple[datetime, datetime]]:
    return _merge_intervals(
        (
            max(start, range_start),
            min(end, range_end),
        )
        for start, end in intervals
        if end > range_start and start < range_end
    )


def _compact_seconds(value: float) -> int | float:
    rounded = round(value, 3)
    return int(rounded) if rounded.is_integer() else rounded


def _device_summary(
    events: list[dict[str, Any]],
    sources: list[dict[str, Any]],
    offline_seconds: float,
) -> list[dict[str, Any]]:
    """Keep existing equal-share accounting separate from observed device time."""
    labels = {"mac": "Mac", "ipad": "iPad", "iphone": "iPhone", "other": "其他设备", "offline": "离线活动"}
    totals: dict[str, float] = defaultdict(float)
    observed: dict[str, float | None] = {}
    intervals: dict[str, list[tuple[datetime, datetime]]] = defaultdict(list)

    def device_key(source_type: str, label: str) -> str:
        if source_type != "apple-screentime":
            return "mac"
        name = label.casefold()
        return "ipad" if "ipad" in name else "iphone" if "iphone" in name else "other"

    for source in sources:
        key = device_key(str(source.get("type", "")), str(source.get("label") or source.get("name", "")))
        known = source.get("coverage") != "unknown" and (source.get("ok") or source.get("duration_seconds", 0) > 0)
        if known:
            observed[key] = (observed.get(key) or 0) + float(source.get("duration_seconds", 0))
        else:
            observed.setdefault(key, None)
    for event in events:
        key = device_key(str(event.get("source_type", "")), str(event.get("source", "")))
        totals[key] += float(event["duration_seconds"])
        intervals[key].append(_event_interval(event))
    # Fixtures or adapters without source summaries can still report observations.
    for key, values in intervals.items():
        if key not in observed:
            observed[key] = _interval_duration(values)
    if offline_seconds > 0:
        totals["offline"] = offline_seconds
        observed["offline"] = offline_seconds
    return [
        {"device": key, "label": label, "active_seconds": _compact_seconds(totals.get(key, 0.0)),
         "observed_seconds": _compact_seconds(observed[key]) if observed.get(key) is not None else None}
        for key, label in labels.items() if key in observed or key in totals
    ]


class DayAggregator:
    def __init__(
        self,
        settings: DashboardSettings,
        journal_repository: JournalRepository | None = None,
        activitywatch: ActivityWatchAdapter | Any | None = None,
        cache: DayCache | None = None,
    ):
        self.settings = settings
        self.journals = journal_repository or JournalRepository(settings)
        self.activitywatch = activitywatch or ActivityWatchAdapter(settings)
        self.cache = cache or DayCache(settings)

    def _input_fingerprint(self, day: date) -> str:
        base = self.settings.input_fingerprint()
        correction_fingerprint = getattr(
            self.activitywatch,
            "correction_fingerprint",
            None,
        )
        if not callable(correction_fingerprint):
            return base
        overlay = str(correction_fingerprint(day))
        return hashlib.sha256(f"{base}\0{overlay}".encode("utf-8")).hexdigest()

    def _day_bounds(
        self,
        day: date,
        mode: str,
        timezone_name: str,
    ) -> tuple[datetime, datetime]:
        zone = ZoneInfo(timezone_name)
        if mode == "calendar":
            start_clock = time.min
        elif mode == "routine":
            start_clock = time.fromisoformat(self.settings.routine_day_start)
        else:
            raise ValueError("mode must be calendar or routine")
        start = datetime.combine(day, start_clock, tzinfo=zone)
        return start, start + timedelta(days=1)

    def _rhythm_summary(
        self,
        day: date,
        mode: str,
        timezone_name: str,
        screen_intervals: Iterable[tuple[datetime, datetime]],
        offline_intervals: Iterable[tuple[datetime, datetime]],
    ) -> dict[str, Any]:
        range_start, range_end = self._day_bounds(day, mode, timezone_name)
        combined = _clipped_intervals(
            [*screen_intervals, *offline_intervals],
            range_start,
            range_end,
        )
        hourly_active_seconds: list[int | float] = []
        for hour_index in range(24):
            bucket_start = range_start + timedelta(hours=hour_index)
            bucket_end = min(
                range_end,
                range_start + timedelta(hours=hour_index + 1),
            )
            hourly_active_seconds.append(
                _compact_seconds(
                    _intersection_seconds(
                        combined,
                        [(bucket_start, bucket_end)],
                    )
                )
            )
        zone = ZoneInfo(timezone_name)
        return {
            "first_active": (
                combined[0][0].astimezone(zone).isoformat() if combined else None
            ),
            "last_active": (
                combined[-1][1].astimezone(zone).isoformat() if combined else None
            ),
            "hourly_active_seconds": hourly_active_seconds,
        }

    def _offline_interval(
        self,
        day: date,
        mode: str,
        timezone_name: str,
        item: dict[str, Any],
    ) -> tuple[datetime, datetime]:
        zone = ZoneInfo(timezone_name)
        start_clock = time.fromisoformat(item["start_time"])
        end_clock = time.fromisoformat(item["end_time"])
        local_day = day
        if mode == "routine":
            routine_start = time.fromisoformat(self.settings.routine_day_start)
            if start_clock < routine_start:
                local_day += timedelta(days=1)
        start = datetime.combine(local_day, start_clock, tzinfo=zone)
        end_day = local_day + timedelta(days=1) if item["crosses_midnight"] else local_day
        end = datetime.combine(end_day, end_clock, tzinfo=zone)
        return start, end

    def _screen_blocks(
        self,
        events: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        blocks: list[dict[str, Any]] = []
        for event in sorted(events, key=lambda item: str(item["timestamp"])):
            start, end = _event_interval(event)
            signature = (
                event.get("category"),
                event.get("project"),
                event.get("app"),
                event.get("title"),
                event.get("source"),
            )
            if blocks:
                previous = blocks[-1]
                previous_end = _timestamp(previous["end"])
                previous_signature = tuple(previous["_signature"])
                gap = (start - previous_end).total_seconds()
                if (
                    signature == previous_signature
                    and gap <= self.settings.timeline_merge_gap_seconds
                    and gap >= -self.settings.timeline_merge_gap_seconds
                ):
                    previous["end"] = max(previous_end, end).isoformat()
                    previous["duration_seconds"] += float(event["duration_seconds"])
                    previous["device_duration_seconds"] += float(event.get("device_duration_seconds", event["duration_seconds"]))
                    reference = self._event_reference(event)
                    if (
                        reference is not None
                        and reference not in previous["event_refs"]
                    ):
                        previous["event_refs"].append(reference)
                    previous["manual_edit"] = bool(
                        previous["manual_edit"] or event.get("manual_edit")
                    )
                    previous["manual_edit_conflict"] = bool(
                        previous["manual_edit_conflict"]
                        or event.get("manual_edit_conflict")
                    )
                    continue
            blocks.append(
                {
                    "kind": "screen",
                    "start": start.isoformat(),
                    "end": end.isoformat(),
                    "duration_seconds": float(event["duration_seconds"]),
                    "device_duration_seconds": float(event.get("device_duration_seconds", event["duration_seconds"])),
                    "category": event.get("category"),
                    "category_label": event.get("category_label"),
                    "project": event.get("project") or "",
                    "app": event.get("app") or "",
                    "title": event.get("title") or "",
                    "source": event.get("source") or "",
                    "source_type": event.get("source_type", "activitywatch-rest"),
                    "bundle_id": event.get("bundle_id", ""),
                    "event_refs": [
                        reference
                        for reference in [self._event_reference(event)]
                        if reference is not None
                    ],
                    "manual_edit": bool(event.get("manual_edit")),
                    "manual_edit_conflict": bool(
                        event.get("manual_edit_conflict")
                    ),
                    "_signature": list(signature),
                }
            )
        for block in blocks:
            block.pop("_signature", None)
        return blocks

    @staticmethod
    def _event_reference(
        event: dict[str, Any],
    ) -> dict[str, str] | None:
        bucket_id = str(event.get("bucket_id") or "")
        event_id = event.get("event_id")
        if not bucket_id or event_id is None:
            return None
        return {"bucket_id": bucket_id, "event_id": str(event_id)}

    def _focus_metrics(
        self,
        blocks: list[dict[str, Any]],
    ) -> tuple[float, int]:
        runs: list[dict[str, Any]] = []
        for block in sorted(blocks, key=lambda item: item["start"]):
            signature = (block.get("category"), block.get("project") or "")
            start = _timestamp(block["start"])
            end = _timestamp(block["end"])
            if runs:
                previous = runs[-1]
                gap = (start - previous["end"]).total_seconds()
                if (
                    signature == previous["signature"]
                    and 0 <= gap <= self.settings.focus_gap_seconds
                ):
                    previous["end"] = max(previous["end"], end)
                    previous["duration_seconds"] += float(block["duration_seconds"])
                    continue
            runs.append(
                {
                    "signature": signature,
                    "start": start,
                    "end": end,
                    "duration_seconds": float(block["duration_seconds"]),
                }
            )
        longest = max(
            (float(run["duration_seconds"]) for run in runs),
            default=0.0,
        )
        meaningful = [
            run
            for run in runs
            if float(run["duration_seconds"]) >= self.settings.meaningful_block_seconds
        ]
        switches = sum(
            left["signature"] != right["signature"]
            for left, right in zip(meaningful, meaningful[1:])
        )
        return longest, switches

    def _project_rows(
        self,
        events: list[dict[str, Any]],
        offline_items: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        totals: dict[str, dict[str, float]] = defaultdict(
            lambda: {"screen_seconds": 0.0, "offline_seconds": 0.0}
        )
        for event in events:
            project = str(event.get("project") or "").strip()
            if project:
                totals[project]["screen_seconds"] += float(event["duration_seconds"])
        for item in offline_items:
            project = str(item.get("project") or "").strip()
            if project:
                totals[project]["offline_seconds"] += float(item["duration_seconds"])
        rows = []
        for project, values in totals.items():
            total = values["screen_seconds"] + values["offline_seconds"]
            rows.append({"project": project, **values, "duration_seconds": total})
        rows.sort(key=lambda item: (-item["duration_seconds"], item["project"]))
        return rows

    def _build_response(
        self,
        day: date,
        mode: str,
        journal_content: str,
        journal_location: Any,
        activity: dict[str, Any],
    ) -> dict[str, Any]:
        document = parse_journal(journal_content)
        journal = document.to_dict()
        timezone_name = str(activity["range"]["timezone"])
        events = list(activity.get("events", []))
        screen_blocks = self._screen_blocks(events)
        screen_intervals = _screen_wall_intervals(events)
        range_start, range_end = self._day_bounds(
            day,
            mode,
            timezone_name,
        )

        offline_items: list[dict[str, Any]] = []
        offline_intervals: list[tuple[datetime, datetime]] = []
        overlap_warnings: list[dict[str, Any]] = []
        for index, raw_item in enumerate(journal["offline_activities"]):
            start, end = self._offline_interval(
                day,
                mode,
                timezone_name,
                raw_item,
            )
            start = max(start, range_start)
            end = min(end, range_end)
            if end <= start:
                continue
            item = {
                **raw_item,
                "kind": "offline",
                "start": start.isoformat(),
                "end": end.isoformat(),
                "duration_seconds": (end - start).total_seconds(),
            }
            offline_items.append(item)
            offline_intervals.append((start, end))
            overlap_seconds = _intersection_seconds(
                [(start, end)],
                screen_intervals,
            )
            if overlap_seconds > 0:
                overlap_warnings.append(
                    {
                        "offline_index": index,
                        "start": start.isoformat(),
                        "end": end.isoformat(),
                        "overlap_seconds": overlap_seconds,
                        "message": "离线活动与屏幕活动重叠，合计时长未重复计算。",
                    }
                )

        active_seconds = float(
            activity.get("time_accounting", {}).get(
                "wall_duration_seconds",
                activity.get("total_duration_seconds", 0.0),
            )
        )
        offline_seconds = _interval_duration(offline_intervals)
        overlap_seconds = _intersection_seconds(screen_intervals, offline_intervals)
        longest_focus_seconds, meaningful_switches = self._focus_metrics(screen_blocks)
        timeline = [*screen_blocks, *offline_items]
        timeline.sort(key=lambda item: (item["start"], item["kind"]))

        journal.update(
            {
                "provider": getattr(journal_location, "provider", "obsidian"),
                "path": journal_location.relative_path,
                "absolute_path": str(journal_location.note),
                "open_url": journal_location.obsidian_url,
                "obsidian_url": journal_location.obsidian_url,
                "exists": journal_location.note.is_file(),
                "offline_activities": offline_items,
            }
        )
        categories = [
            {
                "category": item["category"],
                "label": item["label"],
                "duration_seconds": item["duration_seconds"],
                "share": item.get("share", 0.0),
                "event_count": item["event_count"],
            }
            for item in activity.get("categories", [])
        ]
        uncategorized = activity.get("uncategorized", {})
        parse_warnings = journal.get("parse_warnings", [])
        generated_at = datetime.now(ZoneInfo(timezone_name)).isoformat()

        return {
            "date": day.isoformat(),
            "mode": mode,
            "timezone": timezone_name,
            "range": {
                "start": str(activity["range"]["start_utc"]),
                "end": str(activity["range"]["end_utc"]),
            },
            "generated_at": generated_at,
            "workflows": build_workflow_snapshot(timeline, min(_timestamp(generated_at), range_end).isoformat()),
            "cache": {
                "hit": False,
                "journal_fingerprint": journal_location.fingerprint.to_dict(),
            },
            "overview": {
                "active_seconds": active_seconds,
                "offline_seconds": offline_seconds,
                "combined_nonoverlap_seconds": max(
                    0.0,
                    active_seconds + offline_seconds - overlap_seconds,
                ),
                "longest_focus_seconds": longest_focus_seconds,
                "meaningful_switches": meaningful_switches,
                "classification_coverage": float(activity.get("coverage", 0.0)),
                "review_has_content": any(
                    (
                        document.personal_summary_markdown.strip(),
                        document.outputs,
                        document.next_action_markdown.strip(),
                        document.freeform_markdown.strip(),
                        document.body_markdown.strip(),
                    )
                ),
            },
            "quality": {
                "complete": bool(activity.get("complete", False)),
                "issues": list(activity.get("issues", [])),
                "uncategorized_seconds": float(
                    uncategorized.get("duration_seconds", 0.0)
                ),
                "overlap_warnings": overlap_warnings,
                "parse_warnings": parse_warnings,
                "time_accounting": activity.get("time_accounting", {}),
                "sources": activity.get("sources", []),
            },
            "categories": categories,
            "projects": self._project_rows(events, offline_items),
            "timeline": timeline,
            "rhythm": {
                **self._rhythm_summary(day, mode, timezone_name, screen_intervals, offline_intervals),
                "devices": _device_summary(
                    events, activity.get("sources", []), max(0.0, offline_seconds - overlap_seconds)
                ),
            },
            "journal": journal,
        }

    def get_day(
        self,
        day: date,
        mode: str | None = None,
        *,
        refresh: bool = False,
    ) -> dict[str, Any]:
        selected_mode = mode or self.settings.default_mode
        journal_location = self.journals.locate(day)
        input_fingerprint = self._input_fingerprint(day)
        timezone_name = self.activitywatch.timezone_name()
        today = datetime.now(ZoneInfo(timezone_name)).date()
        cached = self.cache.get(
            day,
            selected_mode,
            journal_location.fingerprint,
            input_fingerprint,
            is_today=day == today,
            refresh=refresh,
        )
        if cached is not None:
            return cached

        journal_content = self.journals.read(journal_location)
        try:
            activity = self.activitywatch.load_day(day, selected_mode)
        except Exception as exc:
            activity = self._unavailable_activity(
                day, selected_mode, timezone_name, exc
            )
        response = self._build_response(
            day,
            selected_mode,
            journal_content,
            journal_location,
            activity,
        )
        if response["quality"]["complete"]:
            self.cache.put(
                day,
                selected_mode,
                journal_location.fingerprint,
                input_fingerprint,
                response,
            )
        return response

    def _unavailable_activity(
        self,
        day: date,
        mode: str,
        timezone_name: str,
        reason: Exception,
    ) -> dict[str, Any]:
        start_utc, end_utc = self.activitywatch.date_range(
            day,
            mode,
            timezone_name,
        )
        return {
            "range": {
                "start_utc": start_utc.isoformat(),
                "end_utc": end_utc.isoformat(),
                "timezone": timezone_name,
            },
            "complete": False,
            "issues": [str(reason)],
            "sources": [],
            "time_accounting": {
                "policy": "split_parallel_sources_prefer_foreground",
                "wall_duration_seconds": 0.0,
                "afk_removed_seconds": 0.0,
                "background_window_removed_seconds": 0.0,
            },
            "events": [],
            "categories": [],
            "uncategorized": {"duration_seconds": 0.0},
            "coverage": 0.0,
        }

    def get_days(
        self,
        days: Iterable[date],
        mode: str | None = None,
    ) -> list[dict[str, Any]]:
        """Return a bounded range while batching uncached ActivityWatch reads."""
        selected_days = list(dict.fromkeys(days))
        if not selected_days:
            return []

        selected_mode = mode or self.settings.default_mode
        timezone_name = self.activitywatch.timezone_name()
        today = datetime.now(ZoneInfo(timezone_name)).date()
        contexts: dict[date, Any] = {}
        results: dict[date, dict[str, Any]] = {}
        missing: list[date] = []

        for day in selected_days:
            input_fingerprint = self._input_fingerprint(day)
            journal_location = self.journals.locate(day)
            contexts[day] = (journal_location, input_fingerprint)
            cached = self.cache.get(
                day,
                selected_mode,
                journal_location.fingerprint,
                input_fingerprint,
                is_today=day == today,
                refresh=False,
            )
            if cached is None:
                missing.append(day)
            else:
                results[day] = cached

        activities: dict[date, dict[str, Any]] = {}
        if missing:
            batch_loader = getattr(self.activitywatch, "load_days", None)
            if callable(batch_loader):
                try:
                    activities = batch_loader(missing, selected_mode)
                except Exception as exc:
                    activities = {
                        day: self._unavailable_activity(
                            day, selected_mode, timezone_name, exc
                        )
                        for day in missing
                    }
            else:
                for day in missing:
                    try:
                        activities[day] = self.activitywatch.load_day(
                            day, selected_mode
                        )
                    except Exception as exc:
                        activities[day] = self._unavailable_activity(
                            day, selected_mode, timezone_name, exc
                        )

        for day in missing:
            journal_location, input_fingerprint = contexts[day]
            journal_content = self.journals.read(journal_location)
            activity = activities.get(day)
            if activity is None:
                activity = self._unavailable_activity(
                    day,
                    selected_mode,
                    timezone_name,
                    RuntimeError("ActivityWatch batch omitted the requested day"),
                )
            response = self._build_response(
                day,
                selected_mode,
                journal_content,
                journal_location,
                activity,
            )
            if response["quality"]["complete"]:
                self.cache.put(
                    day,
                    selected_mode,
                    journal_location.fingerprint,
                    input_fingerprint,
                    response,
                )
            results[day] = response

        return [results[day] for day in selected_days]
