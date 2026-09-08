"""Combine already AFK-filtered Mac events with independent mobile observations."""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta

from .activitywatch_adapter import ActivityWatchAdapter
from .screen_time import ScreenTimeStore, timestamp


def partition_devices(events: list[dict]) -> tuple[list[dict], float, int]:
    starts, ends = defaultdict(list), defaultdict(list)
    for index, event in enumerate(events):
        start = timestamp(event["timestamp"])
        end = timestamp(event["wall_end_timestamp"]) if event.get("wall_end_timestamp") else start + timedelta(seconds=event["duration_seconds"])
        if end > start:
            starts[start].append(index)
            ends[end].append(index)
    boundaries = sorted(starts.keys() | ends.keys())
    active, result = set(), []
    parallel, maximum = 0.0, 0
    for start, end in zip(boundaries, boundaries[1:]):
        active.update(starts[start])
        active.difference_update(ends[start])
        devices = defaultdict(list)
        for index in sorted(active):
            devices[events[index].get("device_id", "mac")].append(index)
        if not devices:
            continue
        seconds = (end - start).total_seconds()
        maximum = max(maximum, len(devices))
        if len(devices) > 1:
            parallel += seconds
        for indices in devices.values():
            weights = []
            for index in indices:
                event = events[index]
                a = timestamp(event["timestamp"])
                b = timestamp(event["wall_end_timestamp"]) if event.get("wall_end_timestamp") else a + timedelta(seconds=event["duration_seconds"])
                weights.append(event["duration_seconds"] / (b - a).total_seconds())
            total = sum(weights)
            for index, weight in zip(indices, weights):
                # Keep the native allocation for Mac-only workflows. Within-Mac
                # overlap/AFK processing has already happened before this split.
                result.append({**events[index], "timestamp": start.isoformat(), "wall_end_timestamp": end.isoformat(),
                               "device_duration_seconds": seconds * weight,
                               "duration_seconds": seconds / len(devices) * weight / total,
                               "overlap_adjusted": len(devices) > 1 or len(indices) > 1})
    return result, parallel, maximum


class MultiDeviceActivity:
    def __init__(self, mac: ActivityWatchAdapter, mobile: ScreenTimeStore):
        self.mac, self.mobile = mac, mobile

    def timezone_name(self):
        return self.mac.timezone_name()

    def date_range(self, day, mode, timezone_name):
        return self.mac.date_range(day, mode, timezone_name)

    def correction_fingerprint(self, day):
        return self.mac.correction_fingerprint(day) + self.mobile.fingerprint(day)

    def combine(self, activity: dict) -> dict:
        start, end = timestamp(activity["range"]["start_utc"]), timestamp(activity["range"]["end_utc"])
        mobile, sources = self.mobile.read_range(start, end)
        if not mobile:
            return {**activity, "sources": [*activity.get("sources", []), *sources],
                    "issues": [*activity.get("issues", []), *([self.mobile.error] if self.mobile.error else [])]}
        classification = self.mac._classification_config()
        for event, match in self.mac._classify_events(mobile, classification):
            event.update({"category": match["category"] if match else "uncategorized",
                          "category_label": match["category_label"] if match else "未分类",
                          "classification_rule": match["rule"] if match else None})
        events, parallel, maximum = partition_devices([*activity["events"], *mobile])
        # Preserve native Mac classifications and classify mobile using the same rules.
        classified = [(e, {"category": e["category"], "category_label": e["category_label"],
                           "rule": e.get("classification_rule") or "device", "rule_label": "设备活动"}
                       if e["category"] != "uncategorized" else None) for e in events]
        aggregate = self.mac._aggregate_categories(classified, classification, 20)
        accounting = activity.get("time_accounting", {})
        wall = sum(e["duration_seconds"] for e in events)
        raw = float(accounting.get("wall_duration_seconds", 0)) + sum(s["duration_seconds"] for s in sources)
        return {**activity, **aggregate, "events": events, "event_count": len(events),
                "sources": [*activity.get("sources", []), *sources],
                "issues": [*activity.get("issues", []), *([self.mobile.error] if self.mobile.error else [])],
                "time_accounting": {**accounting, "policy": "cross_device_union_equal_share",
                    "wall_duration_seconds": wall, "raw_device_duration_seconds": raw,
                    "parallel_wall_seconds": parallel, "max_parallel_sources": maximum,
                    "overlap_adjustment_seconds": raw - wall}}

    def unavailable_mac(self, day, mode, error):
        zone = self.timezone_name()
        start, end = self.date_range(day, mode, zone)
        return {"range": {"start_utc": start.isoformat(), "end_utc": end.isoformat(), "timezone": zone},
                "complete": False, "issues": [f"Mac 活动暂时无法读取：{error}"],
                "sources": [{"name": "Mac", "label": "Mac", "type": "activitywatch-rest", "ok": False}],
                "events": [], "event_count": 0, "categories": [], "coverage": 0,
                "uncategorized": {"duration_seconds": 0}, "time_accounting": {"wall_duration_seconds": 0}}

    def load_day(self, day, mode):
        try:
            activity = self.mac.load_day(day, mode)
        except (OSError, ValueError, RuntimeError) as error:
            activity = self.unavailable_mac(day, mode, error)
        return self.combine(activity)

    def load_days(self, days, mode):
        try:
            activities = self.mac.load_days(days, mode)
        except (OSError, ValueError, RuntimeError) as error:
            activities = {day: self.unavailable_mac(day, mode, error) for day in days}
        return {day: self.combine(activity) for day, activity in activities.items()}
