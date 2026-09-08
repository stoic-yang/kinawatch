"""Validate the small, local JSON export produced by the iPhone shortcut."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from .personal_health import ASLEEP, IN_BED, SLEEP, STEPS, HealthAccumulator

MAX_SYNC_BYTES = 16 * 1024 * 1024
SLEEP_VALUES = {
    "in bed": IN_BED, "在床": IN_BED, "卧床": IN_BED, "臥床": IN_BED, "0": IN_BED,
    "asleep": "HKCategoryValueSleepAnalysisAsleep", "睡眠": "HKCategoryValueSleepAnalysisAsleep",
    "睡着": "HKCategoryValueSleepAnalysisAsleep", "睡著": "HKCategoryValueSleepAnalysisAsleep",
    "asleep (unspecified)": "HKCategoryValueSleepAnalysisAsleep", "1": "HKCategoryValueSleepAnalysisAsleep",
    "core": "HKCategoryValueSleepAnalysisAsleepCore", "核心": "HKCategoryValueSleepAnalysisAsleepCore",
    "deep": "HKCategoryValueSleepAnalysisAsleepDeep", "深度": "HKCategoryValueSleepAnalysisAsleepDeep",
    "rem": "HKCategoryValueSleepAnalysisAsleepREM", "快速动眼": "HKCategoryValueSleepAnalysisAsleepREM",
    "快速動眼": "HKCategoryValueSleepAnalysisAsleepREM",
    "3": "HKCategoryValueSleepAnalysisAsleepCore", "4": "HKCategoryValueSleepAnalysisAsleepDeep",
    "5": "HKCategoryValueSleepAnalysisAsleepREM",
}
AWAKE = {"awake", "清醒", "2", "HKCategoryValueSleepAnalysisAwake"}


def instant(value: str, zone: ZoneInfo) -> datetime:
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None or not 2000 <= result.year <= 2200:
        raise ValueError("快捷指令导出的时间需要包含时区。")
    return result.astimezone(zone)


def parse_shortcuts(data: bytes, timezone_name: str) -> dict:
    if not data or len(data) > MAX_SYNC_BYTES:
        raise ValueError("健康同步文件为空或超过 16 MB。")
    payload = json.loads(data)
    if not isinstance(payload, dict) or payload.get("schema") != "kinawatch.health.v1":
        raise ValueError("请选择 KinaWatch 健康同步快捷指令生成的 JSON。")
    zone = ZoneInfo(timezone_name)
    exported = instant(payload["exported_at"], zone)
    if exported > datetime.now(zone) + timedelta(minutes=10):
        raise ValueError("健康同步文件的生成时间在未来。")
    accumulator = HealthAccumulator(timezone_name)
    for kind in ("sleep", "steps"):
        columns = payload.get(kind)
        if not isinstance(columns, dict):
            raise ValueError("健康同步文件缺少睡眠或步数数据列。")
        values = {}
        for key in ("start", "end", "value", "source"):
            column = columns.get(key)
            # Shortcuts explicitly combines each column with newlines. Arrays
            # are also accepted for tools producing the same versioned format.
            values[key] = column if isinstance(column, list) else str(column).splitlines() if column is not None else []
        size = len(values["start"])
        # Some imported sleep samples expose no Source through Shortcuts even
        # though their dates/value are readable. Union these intervals with an
        # explicit unknown label. Steps must retain sources to avoid summing
        # phone and wearable counts together.
        if kind == "sleep" and not values["source"]:
            values["source"] = ["来源未提供"] * size
        if size > 100000 or any(len(column) != size for column in values.values()):
            raise ValueError("健康数据列长度不一致或记录过多，请重新运行快捷指令。")
        for index in range(size):
            start = instant(str(values["start"][index]), zone)
            end = instant(str(values["end"][index]), zone)
            if end > exported or start < exported - timedelta(days=10):
                raise ValueError("健康记录超出最近同步窗口。")
            value = str(values["value"][index]).strip()
            if kind == "sleep":
                if value in AWAKE or value.lower() in AWAKE:
                    continue
                if value not in ASLEEP and value != IN_BED:
                    value = SLEEP_VALUES.get(value.lower(), "")
                if not value:
                    raise ValueError("有未识别的睡眠类型，请检查快捷指令的“值”字段。")
            accumulator.add({"type": SLEEP if kind == "sleep" else STEPS,
                             "startDate": start.strftime("%Y-%m-%d %H:%M:%S %z"),
                             "endDate": end.strftime("%Y-%m-%d %H:%M:%S %z"),
                             "sourceName": str(values["source"][index]), "value": value, "unit": "count"})
    if accumulator.counts["skipped"]:
        raise ValueError("健康同步包含无效记录，原有数据已保留。")
    if not (accumulator.counts["sleep"] or accumulator.counts["steps"]):
        raise ValueError("没有读到健康记录，请在 iPhone 上允许读取睡眠和步数后重试。")
    result = accumulator.snapshot(exported, hashlib.sha256(data).hexdigest())
    # The shortcut reads a rolling eight days; omit the first partial date.
    first_complete = (exported - timedelta(days=7)).date().isoformat()
    result["days"] = [day for day in result["days"] if day["date"] >= first_complete]
    return result


def merge_snapshot(current: dict, incoming: dict) -> dict:
    zone = ZoneInfo(incoming["timezone"])
    if current.get("exported_at") and instant(incoming["exported_at"], zone) < instant(current["exported_at"], zone):
        raise ValueError("同步文件比当前健康数据更旧，已保留当前记录。")
    days = {day["date"]: dict(day) for day in current["days"]}
    for day in incoming["days"]:
        previous = days.setdefault(day["date"], {"date": day["date"], "sleep": None, "steps": None})
        for kind in ("sleep", "steps"):
            # HealthKit conceals denied read permissions as empty results.
            # An absent metric cannot authorize deleting previously imported data.
            if day[kind] is not None:
                previous[kind] = day[kind]
    return {**incoming, "days": [days[key] for key in sorted(days)],
            "last_sync_digest": incoming["revision"],
            "revision": hashlib.sha256(json.dumps(days, sort_keys=True, ensure_ascii=False).encode()).hexdigest()}
