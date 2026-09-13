"""Read a single local timetable. Personal course data never ships in the build."""
from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path
from zoneinfo import ZoneInfo

from .paths import default_data_dir

MAX_BYTES = 512 * 1024


def _text(value, field: str, limit: int = 200) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError(f"课表的 {field} 无效。")
    return value.strip()


def _date(value) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("课表日期须为 YYYY-MM-DD。")
    date.fromisoformat(value)
    return value


def _integer(value, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError("课表周次或星期无效。")
    return value


def validate_timetable(raw: dict) -> dict:
    if not isinstance(raw, dict) or raw.get("version") != 1:
        raise ValueError("课表格式版本无效。")
    monday = _date(raw["week1_monday"])
    if date.fromisoformat(monday).weekday() != 0:
        raise ValueError("教学第 1 周须从周一开始。")
    weeks = _integer(raw["weeks"], 1, 54)
    timezone = _text(raw["timezone"], "timezone", 100)
    ZoneInfo(timezone)
    slots, slot_ids, previous_end = [], set(), "00:00"
    if not isinstance(raw["slots"], list) or not 1 <= len(raw["slots"]) <= 24:
        raise ValueError("课表节次无效。")
    for slot in raw["slots"]:
        item = {key: _text(slot[key], key, 40) for key in ("id", "label", "start", "end")}
        if not all(re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", item[key]) for key in ("start", "end")):
            raise ValueError("课表时间须为 HH:MM。")
        if item["id"] in slot_ids or not previous_end <= item["start"] < item["end"]:
            raise ValueError("课表节次重复或时间重叠。")
        slot_ids.add(item["id"])
        previous_end = item["end"]
        slots.append(item)
    if not isinstance(raw["courses"], list) or len(raw["courses"]) > 500:
        raise ValueError("课程列表无效。")
    courses, identities = [], set()
    for course in raw["courses"]:
        item = {key: _text(course[key], key) for key in ("id", "name", "slot", "room", "teacher", "weeks_label")}
        if item["id"] in identities or item["slot"] not in slot_ids:
            raise ValueError("课程标识重复或节次不存在。")
        identities.add(item["id"])
        item["weekday"] = _integer(course["weekday"], 1, 7)
        if not isinstance(course["weeks"], list) or not 1 <= len(course["weeks"]) <= weeks:
            raise ValueError("课程周次无效。")
        item["weeks"] = sorted({_integer(week, 1, weeks) for week in course["weeks"]})
        courses.append(item)
    exceptions = []
    seen_dates = set()
    raw_exceptions = raw.get("exceptions", [])
    if not isinstance(raw_exceptions, list) or len(raw_exceptions) > 400:
        raise ValueError("调课日期无效。")
    for entry in raw_exceptions:
        actual = _date(entry["date"])
        if actual in seen_dates:
            raise ValueError("调课日期重复。")
        seen_dates.add(actual)
        follows = _date(entry["follows"]) if entry.get("follows") is not None else None
        if follows is not None and not 0 <= (date.fromisoformat(follows) - date.fromisoformat(monday)).days < weeks * 7:
            raise ValueError("调课所对应的课程日期超出教学周。")
        exceptions.append({"date": actual, "follows": follows, "label": _text(entry["label"], "label")})
    sources = []
    for source in raw.get("sources", [])[:10]:
        title = _text(source["title"], "source")
        url = _text(source["url"], "source URL", 1000)
        if not url.startswith("https://"):
            raise ValueError("来源链接须使用 HTTPS。")
        sources.append({"title": title, "url": url})
    return {"version": 1, "term": _text(raw["term"], "term"), "school": _text(raw["school"], "school"),
            "timezone": timezone, "week1_monday": monday, "weeks": weeks, "slots": slots,
            "courses": courses, "exceptions": exceptions, "sources": sources}


def read_timetable(path: Path | None = None) -> dict:
    path = path if path is not None else default_data_dir() / "timetable.json"
    try:
        with path.open("rb") as stream:
            content = stream.read(MAX_BYTES + 1)
        if len(content) > MAX_BYTES:
            raise ValueError("课表文件过大。")
        snapshot = validate_timetable(json.loads(content))
    except FileNotFoundError:
        return {"status": "empty", "snapshot": None, "error": None}
    except (ValueError, KeyError, TypeError, OSError, AttributeError):
        return {"status": "error", "snapshot": None, "error": "课表文件无法读取或格式不正确，请检查本机课表数据。"}
    return {"status": "ready", "snapshot": snapshot, "error": None}
