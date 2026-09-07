"""Explicit, local Apple Health imports; only sleep and steps are retained."""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
import tempfile
import threading
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from .paths import default_data_dir

MAX_IMPORT_BYTES = 64 * 1024 * 1024
MAX_XML_BYTES = 512 * 1024 * 1024
MAX_RECORDS = 2_000_000
SLEEP = "HKCategoryTypeIdentifierSleepAnalysis"
STEPS = "HKQuantityTypeIdentifierStepCount"
ASLEEP = {"HKCategoryValueSleepAnalysisAsleep", "HKCategoryValueSleepAnalysisAsleepUnspecified",
          "HKCategoryValueSleepAnalysisAsleepCore", "HKCategoryValueSleepAnalysisAsleepDeep",
          "HKCategoryValueSleepAnalysisAsleepREM"}
IN_BED = "HKCategoryValueSleepAnalysisInBed"


class HealthImportConflict(ValueError):
    pass


def _timestamp(value: str, zone: ZoneInfo) -> datetime:
    result = datetime.strptime(value, "%Y-%m-%d %H:%M:%S %z").astimezone(zone)
    if not 1900 <= result.year <= 2200:
        raise ValueError("健康记录的日期超出支持范围。")
    return result


def _merge(intervals: list[tuple[datetime, datetime]]) -> list[tuple[datetime, datetime]]:
    result: list[tuple[datetime, datetime]] = []
    for start, end in sorted(set(intervals)):
        if result and start <= result[-1][1]:
            result[-1] = (result[-1][0], max(end, result[-1][1]))
        else:
            result.append((start, end))
    return result


def parse_export(data: bytes, timezone_name: str) -> dict[str, Any]:
    """Stream the main XML. CDA is an alternate representation, never another source."""
    if not data or len(data) > MAX_IMPORT_BYTES:
        raise ValueError("请选择不超过 64 MB 的 Apple 健康导出 ZIP。")
    zone = ZoneInfo(timezone_name)
    sleep: dict = defaultdict(lambda: defaultdict(list))
    hours: dict = defaultdict(lambda: defaultdict(float))
    source_labels: dict[str, str] = {}
    seen_steps: set[tuple] = set()
    counts = {"sleep": 0, "steps": 0, "skipped": 0}
    exported_at = None
    total = 0
    stack: list[ET.Element] = []
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = [x for x in archive.infolist()
                       if x.filename in {"apple_health_export/export.xml", "export.xml"}]
            if len(entries) != 1:
                raise ValueError("压缩包中需要有一份 Apple 健康 export.xml。")
            entry = entries[0]
            if entry.file_size > MAX_XML_BYTES or entry.flag_bits & 1:
                raise ValueError("健康 XML 过大或压缩包已加密。")
            with archive.open(entry) as stream:
                prefix = stream.read(65536)
                if b"<!ENTITY" in prefix or b" SYSTEM " in prefix or b" PUBLIC " in prefix:
                    raise ValueError("不支持包含外部引用的健康 XML。")
            with archive.open(entry) as stream:
                for event, element in ET.iterparse(stream, events=("start", "end")):
                    if event == "start":
                        if not stack and element.tag != "HealthData":
                            raise ValueError("这不是 Apple 健康导出文件。")
                        stack.append(element)
                        continue
                    if len(stack) == 2:
                        if element.tag == "ExportDate":
                            exported_at = _timestamp(element.attrib["value"], zone)
                        elif element.tag == "Record":
                            total += 1
                            if total > MAX_RECORDS:
                                raise ValueError("健康记录过多，请缩小导出范围。")
                            a = element.attrib
                            kind = a.get("type")
                            if kind in {SLEEP, STEPS}:
                                try:
                                    start, end = _timestamp(a["startDate"], zone), _timestamp(a["endDate"], zone)
                                    seconds = (end - start).total_seconds()
                                    if seconds <= 0 or seconds > 48 * 3600:
                                        raise ValueError("invalid interval")
                                    source = a.get("sourceName", "未知来源")[:120]
                                    label = "iPhone" if "model:iPhone" in a.get("device", "").replace(" ", "") else source
                                    source_key = source + "|" + a.get("device", "")
                                    source_labels[source_key] = label
                                    if kind == SLEEP:
                                        value = a.get("value")
                                        if value in ASLEEP or value == IN_BED:
                                            basis = "asleep" if value in ASLEEP else "in_bed"
                                            sleep[source][basis].append((start, end))
                                            counts["sleep"] += 1
                                    else:
                                        value = float(a["value"])
                                        if a.get("unit") != "count" or not math.isfinite(value) or not 0 <= value <= 200000:
                                            raise ValueError("invalid step count")
                                        key = (source_key, start, end, value)
                                        if key not in seen_steps:
                                            seen_steps.add(key)
                                            counts["steps"] += 1
                                            cursor = start
                                            while cursor < end:
                                                hour = cursor.replace(minute=0, second=0, microsecond=0)
                                                boundary = min(end, hour + timedelta(hours=1))
                                                hours[hour][source_key] += value * (boundary - cursor).total_seconds() / seconds
                                                cursor = boundary
                                except (ValueError, KeyError, OverflowError):
                                    counts["skipped"] += 1
                        element.clear()
                        stack[0].remove(element)
                    stack.pop()
    except (zipfile.BadZipFile, ET.ParseError, KeyError, RuntimeError) as exc:
        raise ValueError("无法读取健康导出，请重新选择 Apple 健康生成的 ZIP。") from exc
    if exported_at is None or not (counts["sleep"] or counts["steps"]):
        raise ValueError("这份导出没有可用的睡眠或步数记录。")

    days: dict[str, dict] = {}
    def day_for(day: str) -> dict:
        return days.setdefault(day, {"date": day, "sleep": None, "steps": None})

    sleep_days: dict = defaultdict(lambda: defaultdict(dict))
    for source, bases in sleep.items():
        for basis, raw_intervals in bases.items():
            sessions: list[tuple[datetime, datetime, float]] = []
            for start, end in _merge(raw_intervals):
                minutes = (end - start).total_seconds() / 60
                # Join nearby stages for timing; awake gaps never add to duration.
                if sessions and (start - sessions[-1][1]).total_seconds() <= 90 * 60:
                    sessions[-1] = (sessions[-1][0], end, sessions[-1][2] + minutes)
                else:
                    sessions.append((start, end, minutes))
            for session in sessions:
                day = session[1].date().isoformat()
                sleep_days[day][source].setdefault(basis, []).append(session)
    for day, sources in sleep_days.items():
        if day > exported_at.date().isoformat():
            continue
        # Prefer actual asleep samples, then wearable data, then the longest coverage.
        choices = []
        for source, bases in sources.items():
            basis = "asleep" if bases.get("asleep") else "in_bed"
            sessions = bases[basis]
            minutes = sum(item[2] for item in sessions)
            choices.append(((basis == "asleep", "mi fitness" in source.lower(), minutes), source, basis, sessions))
        _, source, basis, sessions = max(choices, key=lambda item: item[0])
        main = max(sessions, key=lambda item: item[2])
        day_for(day)["sleep"] = {
            "minutes": round(sum(item[2] for item in sessions), 1),
            "main_minutes": round(main[2], 1), "start": main[0].isoformat(), "end": main[1].isoformat(),
            "source": source, "basis": basis,
            "sessions": [{"start": a.isoformat(), "end": b.isoformat(), "minutes": round(m, 1)} for a, b, m in sessions],
        }
    by_day: dict = defaultdict(lambda: {"count": 0.0, "sources": defaultdict(float)})
    for hour, sources in hours.items():
        if hour >= exported_at:
            continue
        daily = by_day[hour.date().isoformat()]
        daily["count"] += max(sources.values())
        for source, count in sources.items():
            daily["sources"][source_labels[source]] += count
    for day, values in by_day.items():
        day_for(day)["steps"] = {"count": round(values["count"]), "method": "hourly_max_estimate",
                                 "sources": {key: round(value) for key, value in sorted(values["sources"].items())}}
    return {"version": 1, "revision": hashlib.sha256(data).hexdigest(), "available": True,
            "exported_at": exported_at.isoformat(), "timezone": timezone_name,
            "imported_at": datetime.now(zone).isoformat(), "record_counts": counts,
            "days": [days[key] for key in sorted(days)]}


class PersonalHealthStore:
    def __init__(self, timezone_name: str, path: Path | None = None):
        self.timezone_name = timezone_name
        self.path = path or default_data_dir() / "health" / "snapshot.json"
        self._lock = threading.RLock()

    def read(self) -> dict:
        with self._lock:
            if not self.path.exists():
                return {"version": 1, "revision": "empty", "available": False,
                        "timezone": self.timezone_name, "days": []}
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            if payload.get("version") != 1:
                raise ValueError("健康数据版本不受支持，请重新导入。")
            return payload

    def import_archive(self, data: bytes, expected_revision: str) -> dict:
        # Serialize imports; parsing and failure never alter the previous snapshot.
        with self._lock:
            current = self.read()
            if not expected_revision or current["revision"] != expected_revision:
                raise HealthImportConflict("健康数据已有更新，请刷新页面后重新导入。")
            parsed = parse_export(data, self.timezone_name)
            if current["available"] and parsed["exported_at"] < current["exported_at"]:
                raise ValueError("这份导出比当前数据更旧，请选择更新的完整导出。")
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            name = None
            try:
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent, delete=False) as stream:
                    name = stream.name
                    json.dump(parsed, stream, ensure_ascii=False, separators=(",", ":"))
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(name, self.path)
            finally:
                if name and os.path.exists(name):
                    os.unlink(name)
            return parsed
