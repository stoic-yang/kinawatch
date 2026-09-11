"""Read an explicitly installed, immutable local Mac activity snapshot."""
from __future__ import annotations

import hashlib
import json
import math
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from .config import DashboardSettings

LOCAL_BUCKET = "kinawatch-local-activity"
LOCAL_SOURCE_TYPE = "kinawatch-local"


def timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("本地活动时间必须包含时区。")
    return parsed.astimezone(timezone.utc)


class LocalActivityStore:
    def __init__(self, settings: DashboardSettings):
        self.settings = settings
        configured = settings.raw.get("local_activity_file")
        self.path = settings.configured_path(configured) if configured else None

    def read(self) -> list[dict]:
        if self.path is None:
            return []
        if self.path.stat().st_size > 32 * 1024 * 1024:
            raise ValueError("本地活动文件过大。")
        payload = json.loads(self.path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict) or payload.get("version") != 1:
            raise ValueError("本地活动文件版本无效。")
        events = payload.get("events")
        if not isinstance(events, list) or len(events) > 100_000:
            raise ValueError("本地活动列表无效。")
        result, identities = [], set()
        for item in events:
            if not isinstance(item, dict):
                raise ValueError("本地活动事件无效。")
            identity, data = item.get("id"), item.get("data")
            duration = item.get("duration")
            if (not isinstance(identity, str) or not identity or len(identity) > 100
                    or identity in identities or not isinstance(data, dict)
                    or not isinstance(duration, (int, float)) or isinstance(duration, bool)
                    or not math.isfinite(duration) or not 0 < duration <= 86400):
                raise ValueError("本地活动身份或时长无效。")
            if not isinstance(data.get("app"), str) or not data["app"].strip():
                raise ValueError("本地活动缺少应用。")
            for field in ("app", "title", "url"):
                if not isinstance(data.get(field, ""), str):
                    raise ValueError("本地活动文本字段无效。")
            if not isinstance(item.get("timestamp"), str):
                raise ValueError("本地活动缺少时间。")
            start = timestamp(item["timestamp"])
            if start + timedelta(seconds=duration) > datetime.now(timezone.utc):
                raise ValueError("本地活动只能包含已结束的事件。")
            identities.add(identity)
            result.append({"id": identity, "timestamp": start.isoformat(),
                           "duration": float(duration), "data": data})
        result.sort(key=lambda item: item["timestamp"])
        previous_end = None
        for item in result:
            start = timestamp(item["timestamp"])
            if previous_end is not None and start < previous_end:
                raise ValueError("本地活动事件不能重叠。")
            previous_end = start + timedelta(seconds=item["duration"])
        return result

    def events(self, start: datetime, end: datetime) -> list[dict]:
        return [item for item in self.read()
                if timestamp(item["timestamp"]) < end
                and timestamp(item["timestamp"]) + timedelta(seconds=item["duration"]) > start]

    def fingerprint(self, day: date) -> str:
        # Cover both calendar and routine views, including next-day early hours.
        zone = ZoneInfo(self.settings.timezone_name())
        start = datetime.combine(day, time.min, tzinfo=zone)
        end = datetime.combine(day + timedelta(days=1),
                               time.fromisoformat(self.settings.routine_day_start), tzinfo=zone)
        try:
            events = self.events(start, end)
        except (OSError, ValueError, OverflowError) as error:
            return "local-error:" + str(error)
        if not events:
            return ""
        return hashlib.sha256(json.dumps(events, sort_keys=True).encode()).hexdigest()


def fill_unobserved_intervals(local: list[dict], captured: list[dict]) -> list[dict]:
    """Captured Mac windows take precedence; never count a recovery twice."""
    occupied = sorted((timestamp(e["timestamp"]), timestamp(e["timestamp"])
                       + timedelta(seconds=e["duration_seconds"])) for e in captured)
    result = []
    for event in local:
        start = timestamp(event["timestamp"])
        end = start + timedelta(seconds=event["duration_seconds"])
        cursor = start
        for left, right in occupied:
            if right <= cursor:
                continue
            if left >= end:
                break
            if left > cursor:
                result.append({**event, "timestamp": cursor.isoformat(),
                               "duration_seconds": (left - cursor).total_seconds()})
            cursor = max(cursor, right)
            if cursor >= end:
                break
        if cursor < end:
            result.append({**event, "timestamp": cursor.isoformat(),
                           "duration_seconds": (end - cursor).total_seconds()})
    return result
