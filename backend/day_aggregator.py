from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timedelta
from typing import Any, Iterable
from zoneinfo import ZoneInfo

from .activitywatch_adapter import ActivityWatchAdapter
from .cache import DayCache
from .config import DashboardSettings
from .journal_parser import parse_journal
from .journal_repository import JournalRepository


def _timestamp(raw_value: str) -> datetime:
    return datetime.fromisoformat(raw_value.replace("Z", "+00:00"))


def _event_interval(event: dict[str, Any]) -> tuple[datetime, datetime]:
    start = _timestamp(str(event["timestamp"]))
    end = start + timedelta(seconds=float(event["duration_seconds"]))
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
    durations_by_start: dict[datetime, float] = defaultdict(float)
    for event in events:
        start = _timestamp(str(event["timestamp"]))
        durations_by_start[start] += float(event["duration_seconds"])
    return [
        (start, start + timedelta(seconds=duration_seconds))
        for start, duration_seconds in durations_by_start.items()
        if duration_seconds > 0
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
                    continue
            blocks.append(
                {
                    "kind": "screen",
                    "start": start.isoformat(),
                    "end": end.isoformat(),
                    "duration_seconds": float(event["duration_seconds"]),
                    "category": event.get("category"),
                    "category_label": event.get("category_label"),
                    "project": event.get("project") or "",
                    "app": event.get("app") or "",
                    "title": event.get("title") or "",
                    "source": event.get("source") or "",
                    "_signature": list(signature),
                }
            )
        for block in blocks:
            block.pop("_signature", None)
        return blocks

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
            item = {
                **raw_item,
                "kind": "offline",
                "start": start.isoformat(),
                "end": end.isoformat(),
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

        return {
            "date": day.isoformat(),
            "mode": mode,
            "timezone": timezone_name,
            "generated_at": datetime.now(ZoneInfo(timezone_name)).isoformat(),
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
            "rhythm": self._rhythm_summary(
                day,
                mode,
                timezone_name,
                screen_intervals,
                offline_intervals,
            ),
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
        input_fingerprint = self.settings.input_fingerprint()
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
            start_utc, end_utc = self.activitywatch.date_range(
                day,
                selected_mode,
                timezone_name,
            )
            activity = {
                "range": {
                    "start_utc": start_utc.isoformat(),
                    "end_utc": end_utc.isoformat(),
                    "timezone": timezone_name,
                },
                "complete": False,
                "issues": [str(exc)],
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
        response = self._build_response(
            day,
            selected_mode,
            journal_content,
            journal_location,
            activity,
        )
        self.cache.put(
            day,
            selected_mode,
            journal_location.fingerprint,
            input_fingerprint,
            response,
        )
        return response
