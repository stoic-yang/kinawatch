from __future__ import annotations

import copy
import hashlib
import json
import os
import stat
import tempfile
import threading
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from .config import DashboardSettings


STORE_VERSION = 1
MAX_HISTORY_ITEMS = 200
MAX_APP_CHARACTERS = 300
MAX_TITLE_CHARACTERS = 1200
MAX_CATEGORY_LABEL_CHARACTERS = 80


class ActivityEditError(Exception):
    """Base class for safe, user-facing activity edit failures."""


class ActivityEditDisabled(ActivityEditError):
    pass


class ActivityEditValidation(ActivityEditError):
    pass


class ActivityEditConflict(ActivityEditError):
    pass


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _revision_token(state: dict[str, Any]) -> str:
    return hashlib.sha256(_canonical_json(state).encode("utf-8")).hexdigest()


def activity_event_key(bucket_id: str, event_id: str) -> str:
    return f"{bucket_id}\0{event_id}"


def _empty_state() -> dict[str, Any]:
    return {
        "version": STORE_VERSION,
        "revision": 0,
        "custom_categories": {},
        "overrides": {},
        "history": [],
    }


def _normalize_state(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ActivityEditValidation("活动校正文件必须是 JSON 对象。")
    if int(value.get("version", 0)) != STORE_VERSION:
        raise ActivityEditValidation("活动校正文件版本不受支持。")
    revision = value.get("revision", 0)
    custom_categories = value.get("custom_categories", {})
    overrides = value.get("overrides", {})
    history = value.get("history", [])
    if (
        not isinstance(revision, int)
        or revision < 0
        or not isinstance(custom_categories, dict)
        or not isinstance(overrides, dict)
        or not isinstance(history, list)
    ):
        raise ActivityEditValidation("活动校正文件结构无效。")
    return {
        "version": STORE_VERSION,
        "revision": revision,
        "custom_categories": copy.deepcopy(custom_categories),
        "overrides": copy.deepcopy(overrides),
        "history": copy.deepcopy(history),
    }


class ActivityEditStore:
    """Atomic KinaWatch-owned overlay for manual ActivityWatch corrections."""

    def __init__(
        self,
        settings: DashboardSettings,
        path: Path | None = None,
    ):
        self.settings = settings
        self.path = (path or settings.activity_edit_store_path).resolve(
            strict=False
        )
        self._lock = threading.RLock()

    def _read_unlocked(self) -> dict[str, Any]:
        if not self.path.exists():
            return _empty_state()
        if self.path.is_symlink():
            raise ActivityEditValidation("不允许通过符号链接读取活动校正文件。")
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ActivityEditValidation(f"无法读取活动校正文件：{exc}") from exc
        return _normalize_state(payload)

    def snapshot(self) -> tuple[dict[str, Any], str]:
        with self._lock:
            state = self._read_unlocked()
            return state, _revision_token(state)

    def revision_token(self) -> str:
        return self.snapshot()[1]

    def fingerprint_for_day(self, day_value: date | str) -> str:
        day_key = (
            day_value.isoformat()
            if isinstance(day_value, date)
            else str(day_value)
        )
        state, _ = self.snapshot()
        relevant = {
            key: value
            for key, value in state["overrides"].items()
            if isinstance(value, dict) and value.get("day") == day_key
        }
        return hashlib.sha256(
            _canonical_json(relevant).encode("utf-8")
        ).hexdigest()

    def custom_categories(self) -> dict[str, dict[str, Any]]:
        state, _ = self.snapshot()
        result: dict[str, dict[str, Any]] = {}
        for category, metadata in state["custom_categories"].items():
            if not isinstance(category, str) or not isinstance(metadata, dict):
                continue
            label = str(metadata.get("label") or "").strip()
            if label:
                result[category] = {"label": label, "custom": True}
        return result

    def apply_event(self, event: dict[str, Any]) -> dict[str, Any]:
        event_id = event.get("event_id")
        bucket_id = str(event.get("bucket_id") or "")
        if event_id is None or not bucket_id:
            return event
        state, _ = self.snapshot()
        record = state["overrides"].get(
            activity_event_key(bucket_id, str(event_id))
        )
        if not isinstance(record, dict):
            return event
        if record.get("source_fingerprint") != event.get("source_fingerprint"):
            return {**event, "manual_edit_conflict": True}
        patch = record.get("patch")
        if not isinstance(patch, dict):
            return event

        updated = dict(event)
        start = str(patch.get("start") or updated["timestamp"])
        if "end" in patch:
            end = str(patch["end"])
            start_dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
            end_dt = datetime.fromisoformat(end.replace("Z", "+00:00"))
            updated["timestamp"] = start_dt.astimezone(timezone.utc).isoformat()
            updated["duration_seconds"] = (end_dt - start_dt).total_seconds()
        elif "start" in patch:
            original_seconds = float(updated["duration_seconds"])
            start_dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
            updated["timestamp"] = start_dt.astimezone(timezone.utc).isoformat()
            updated["duration_seconds"] = original_seconds

        for field in ("app", "title"):
            if field in patch:
                updated[field] = str(patch[field])
        if patch.get("category"):
            updated["manual_category"] = str(patch["category"])
            updated["manual_category_label"] = str(
                patch.get("category_label") or patch["category"]
            )
        updated["manual_edit"] = True
        updated["manual_edit_fields"] = sorted(
            field
            for field in ("start", "end", "app", "title", "category")
            if field in patch
        )
        return updated

    def _assert_safe_path(self) -> None:
        if self.path.is_symlink():
            raise ActivityEditValidation("不允许通过符号链接写入活动校正文件。")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ActivityEditValidation("无法创建活动校正目录。") from exc
        if not self.path.parent.is_dir():
            raise ActivityEditValidation("活动校正目录不可用。")

    @staticmethod
    def _atomic_write(path: Path, state: dict[str, Any]) -> None:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{path.name}.",
            suffix=".tmp",
            dir=path.parent,
        )
        temporary = Path(temporary_name)
        try:
            mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
            os.fchmod(descriptor, mode)
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
                descriptor = -1
                stream.write(
                    json.dumps(
                        state,
                        ensure_ascii=False,
                        sort_keys=True,
                        indent=2,
                    )
                )
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            if os.name != "nt":
                directory_fd = os.open(path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            temporary.unlink(missing_ok=True)

    def upsert(
        self,
        *,
        day: date,
        bucket_id: str,
        event_id: str,
        source_fingerprint: str,
        patch: dict[str, Any],
        expected_revision: str,
        custom_category: tuple[str, str] | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            self._assert_safe_path()
            state = self._read_unlocked()
            current_revision = _revision_token(state)
            if expected_revision != current_revision:
                raise ActivityEditConflict(
                    "活动校正已在页面加载后发生变化，请重新打开编辑器。"
                )

            key = activity_event_key(bucket_id, event_id)
            before = copy.deepcopy(state["overrides"].get(key))
            after = (
                {
                    "day": day.isoformat(),
                    "bucket_id": bucket_id,
                    "event_id": event_id,
                    "source_fingerprint": source_fingerprint,
                    "patch": copy.deepcopy(patch),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
                if patch
                else None
            )
            before_comparable = (
                {
                    "day": before.get("day"),
                    "bucket_id": before.get("bucket_id"),
                    "event_id": before.get("event_id"),
                    "source_fingerprint": before.get("source_fingerprint"),
                    "patch": before.get("patch"),
                }
                if isinstance(before, dict)
                else None
            )
            after_comparable = (
                {
                    "day": after["day"],
                    "bucket_id": after["bucket_id"],
                    "event_id": after["event_id"],
                    "source_fingerprint": after["source_fingerprint"],
                    "patch": after["patch"],
                }
                if after is not None
                else None
            )
            if before_comparable == after_comparable:
                raise ActivityEditValidation("没有需要保存的修改。")

            if after is None:
                state["overrides"].pop(key, None)
            else:
                state["overrides"][key] = after
            if custom_category is not None:
                category, label = custom_category
                state["custom_categories"][category] = {
                    "label": label,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                }

            change_id = uuid.uuid4().hex
            state["history"].append(
                {
                    "change_id": change_id,
                    "event_key": key,
                    "day": day.isoformat(),
                    "before": before,
                    "after": copy.deepcopy(after),
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "undone_at": None,
                }
            )
            state["history"] = state["history"][-MAX_HISTORY_ITEMS:]
            state["revision"] += 1
            self._atomic_write(self.path, state)
            return {
                "change_id": change_id,
                "revision": _revision_token(state),
                "override": copy.deepcopy(after),
            }

    def undo(
        self,
        *,
        change_id: str,
        expected_revision: str,
        expected_day: str,
        expected_event_key: str,
    ) -> dict[str, Any]:
        with self._lock:
            self._assert_safe_path()
            state = self._read_unlocked()
            if expected_revision != _revision_token(state):
                raise ActivityEditConflict(
                    "活动校正已发生变化，无法安全撤销，请重新打开编辑器。"
                )
            change = next(
                (
                    item
                    for item in reversed(state["history"])
                    if isinstance(item, dict)
                    and item.get("change_id") == change_id
                ),
                None,
            )
            if change is None:
                raise ActivityEditValidation("找不到要撤销的活动修改。")
            if change.get("undone_at"):
                raise ActivityEditConflict("这次活动修改已经撤销。")
            key = str(change.get("event_key") or "")
            if (
                str(change.get("day") or "") != expected_day
                or key != expected_event_key
            ):
                raise ActivityEditConflict("活动修改目标不一致，无法撤销。")
            current = state["overrides"].get(key)
            if current != change.get("after"):
                raise ActivityEditConflict(
                    "该活动在这次修改后又被编辑，无法直接撤销。"
                )
            before = copy.deepcopy(change.get("before"))
            if before is None:
                state["overrides"].pop(key, None)
            else:
                state["overrides"][key] = before
            change["undone_at"] = datetime.now(timezone.utc).isoformat()
            state["revision"] += 1
            self._atomic_write(self.path, state)
            return {
                "change_id": change_id,
                "day": str(change.get("day") or ""),
                "revision": _revision_token(state),
            }

    def health(self) -> dict[str, Any]:
        try:
            state, revision = self.snapshot()
            return {
                "available": True,
                "path": str(self.path),
                "revision": revision,
                "override_count": len(state["overrides"]),
                "custom_category_count": len(state["custom_categories"]),
                "error": "",
            }
        except Exception as exc:
            return {
                "available": False,
                "path": str(self.path),
                "revision": "",
                "override_count": 0,
                "custom_category_count": 0,
                "error": str(exc),
            }


def _normalize_text(
    value: Any,
    *,
    label: str,
    maximum: int,
    allow_empty: bool,
) -> str:
    if not isinstance(value, str):
        raise ActivityEditValidation(f"{label}必须是文字。")
    normalized = value.replace("\r", " ").replace("\n", " ").strip()
    if not normalized and not allow_empty:
        raise ActivityEditValidation(f"{label}不能为空。")
    if "\x00" in normalized:
        raise ActivityEditValidation(f"{label}包含无效字符。")
    if len(normalized) > maximum:
        raise ActivityEditValidation(f"{label}不能超过 {maximum} 个字符。")
    return normalized


def _parse_local_datetime(value: Any, zone: ZoneInfo, label: str) -> datetime:
    if not isinstance(value, str):
        raise ActivityEditValidation(f"{label}格式无效。")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ActivityEditValidation(f"{label}格式无效。") from exc
    if parsed.tzinfo is not None:
        raise ActivityEditValidation(f"{label}必须使用页面显示的本地时间。")
    return parsed.replace(tzinfo=zone).astimezone(timezone.utc)


def _custom_category_id(label: str) -> str:
    digest = hashlib.sha256(label.casefold().encode("utf-8")).hexdigest()[:12]
    return f"manual-{digest}"


class ActivityEditor:
    """Validate inspector/save/undo semantics around the ActivityWatch adapter."""

    def __init__(
        self,
        settings: DashboardSettings,
        activitywatch: Any,
        store: ActivityEditStore,
    ):
        self.settings = settings
        self.activitywatch = activitywatch
        self.store = store

    def inspect(self, parameters: dict[str, list[str]]) -> dict[str, Any]:
        raw_date = (parameters.get("date") or [""])[0]
        raw_mode = (parameters.get("mode") or [self.settings.default_mode])[0]
        bucket_id = (parameters.get("bucket_id") or [""])[0]
        event_ids = [
            str(value)
            for value in parameters.get("event_id", [])
            if str(value)
        ]
        try:
            selected_day = date.fromisoformat(raw_date)
        except ValueError as exc:
            raise ActivityEditValidation("日期必须使用 YYYY-MM-DD。") from exc
        if not bucket_id or not event_ids:
            raise ActivityEditValidation("缺少要检查的原始活动事件。")
        if len(event_ids) > 100:
            raise ActivityEditValidation("一次最多检查 100 条原始活动事件。")
        result = self.activitywatch.inspect_events(
            selected_day,
            raw_mode,
            bucket_id,
            event_ids,
        )
        result["write_enabled"] = self.settings.activity_edit_enabled
        return result

    def save(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.settings.activity_edit_enabled:
            raise ActivityEditDisabled("项目配置尚未启用活动手动校正。")
        try:
            selected_day = date.fromisoformat(str(payload["date"]))
        except (KeyError, ValueError) as exc:
            raise ActivityEditValidation("日期必须使用 YYYY-MM-DD。") from exc
        mode = str(payload.get("mode") or self.settings.default_mode)
        bucket_id = str(payload.get("bucket_id") or "")
        event_id = str(payload.get("event_id") or "")
        source_fingerprint = str(
            payload.get("expected_source_fingerprint") or ""
        )
        expected_revision = str(payload.get("expected_revision") or "")
        if not bucket_id or not event_id or not source_fingerprint:
            raise ActivityEditValidation("缺少原始活动事件版本。")
        if not expected_revision:
            raise ActivityEditValidation("缺少活动校正版本。")

        inspection = self.activitywatch.inspect_events(
            selected_day,
            mode,
            bucket_id,
            [event_id],
        )
        event = next(
            (
                item
                for item in inspection["events"]
                if str(item.get("event_id")) == event_id
            ),
            None,
        )
        if event is None:
            raise ActivityEditConflict("原始活动事件已不存在，请刷新页面。")
        if event.get("source_fingerprint") != source_fingerprint:
            raise ActivityEditConflict(
                "原始活动事件已在页面加载后发生变化，请重新打开编辑器。"
            )
        if not event.get("editable"):
            raise ActivityEditValidation("正在采集或尚未结束的活动不能修改。")

        zone = ZoneInfo(self.settings.timezone_name())
        start = _parse_local_datetime(
            payload.get("start_local"),
            zone,
            "开始时间",
        )
        end = _parse_local_datetime(
            payload.get("end_local"),
            zone,
            "结束时间",
        )
        if end <= start:
            raise ActivityEditValidation("结束时间必须晚于开始时间。")
        day_start, day_end = self.activitywatch.date_range(
            selected_day,
            mode,
            self.settings.timezone_name(),
        )
        if start < day_start or end > day_end:
            raise ActivityEditValidation("活动时间必须保留在当前作息日范围内。")
        if end > datetime.now(timezone.utc):
            raise ActivityEditValidation("活动结束时间不能晚于当前时间。")

        app = _normalize_text(
            payload.get("app"),
            label="应用名",
            maximum=MAX_APP_CHARACTERS,
            allow_empty=False,
        )
        title = _normalize_text(
            payload.get("title"),
            label="标题",
            maximum=MAX_TITLE_CHARACTERS,
            allow_empty=True,
        )
        category_override = payload.get("category_override")
        custom_category: tuple[str, str] | None = None
        category: str | None = None
        category_label: str | None = None
        if category_override is not None:
            if not isinstance(category_override, dict):
                raise ActivityEditValidation("分类修改格式无效。")
            custom_label_value = category_override.get("custom_label")
            configured_category = str(
                category_override.get("category") or ""
            ).strip()
            if custom_label_value:
                category_label = _normalize_text(
                    custom_label_value,
                    label="自定义分类",
                    maximum=MAX_CATEGORY_LABEL_CHARACTERS,
                    allow_empty=False,
                )
                category = _custom_category_id(category_label)
                custom_category = (category, category_label)
            elif configured_category:
                categories = {
                    str(item["category"]): str(item["label"])
                    for item in inspection.get("categories", [])
                }
                if configured_category not in categories:
                    raise ActivityEditValidation("所选分类不存在。")
                category = configured_category
                category_label = categories[configured_category]
            else:
                raise ActivityEditValidation("分类修改格式无效。")

        original = event["original"]
        original_start = datetime.fromisoformat(
            str(original["start"]).replace("Z", "+00:00")
        ).astimezone(timezone.utc)
        original_end = datetime.fromisoformat(
            str(original["end"]).replace("Z", "+00:00")
        ).astimezone(timezone.utc)
        patch: dict[str, Any] = {}
        if start != original_start or end != original_end:
            patch["start"] = start.isoformat()
            patch["end"] = end.isoformat()
        if app != str(original.get("app") or ""):
            patch["app"] = app
        if title != str(original.get("title") or ""):
            patch["title"] = title
        if category is not None:
            patch["category"] = category
            patch["category_label"] = category_label

        saved = self.store.upsert(
            day=selected_day,
            bucket_id=bucket_id,
            event_id=event_id,
            source_fingerprint=source_fingerprint,
            patch=patch,
            expected_revision=expected_revision,
            custom_category=custom_category,
        )
        refreshed = self.activitywatch.inspect_events(
            selected_day,
            mode,
            bucket_id,
            [event_id],
        )
        return {
            "ok": True,
            "date": selected_day.isoformat(),
            "change_id": saved["change_id"],
            "revision": refreshed["revision"],
            "event": refreshed["events"][0],
            "categories": refreshed["categories"],
        }

    def undo(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.settings.activity_edit_enabled:
            raise ActivityEditDisabled("项目配置尚未启用活动手动校正。")
        try:
            selected_day = date.fromisoformat(str(payload["date"]))
        except (KeyError, ValueError) as exc:
            raise ActivityEditValidation("日期必须使用 YYYY-MM-DD。") from exc
        mode = str(payload.get("mode") or self.settings.default_mode)
        bucket_id = str(payload.get("bucket_id") or "")
        event_id = str(payload.get("event_id") or "")
        change_id = str(payload.get("change_id") or "")
        expected_revision = str(payload.get("expected_revision") or "")
        if not bucket_id or not event_id or not change_id or not expected_revision:
            raise ActivityEditValidation("缺少撤销活动修改所需的信息。")
        result = self.store.undo(
            change_id=change_id,
            expected_revision=expected_revision,
            expected_day=selected_day.isoformat(),
            expected_event_key=activity_event_key(bucket_id, event_id),
        )
        refreshed = self.activitywatch.inspect_events(
            selected_day,
            mode,
            bucket_id,
            [event_id],
        )
        if not refreshed["events"]:
            raise ActivityEditConflict("原始活动事件已不存在，请刷新页面。")
        return {
            "ok": True,
            "date": selected_day.isoformat(),
            "change_id": change_id,
            "revision": refreshed["revision"],
            "event": refreshed["events"][0],
            "categories": refreshed["categories"],
        }
