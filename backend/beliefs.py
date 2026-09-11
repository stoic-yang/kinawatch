from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from .config import fingerprint_file
from .journal_document import split_document
from .journal_repository import JournalRepository
from .workflow_writer import (
    WorkflowWriteConflict, WorkflowWriteDisabled, WorkflowWriteValidation, WorkflowWriter,
)


NEW_ID = re.compile(r"b-[a-f0-9]{32}\Z")
FILE_ID = re.compile(r"--((?:b-[a-f0-9]{32})|(?:l-[a-f0-9]{24}))\.md\Z")
MAX_DOCUMENT_BYTES = 2 * 1024 * 1024
_locks_guard = threading.Lock()
_locks: dict[str, threading.RLock] = {}


def digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def legacy_entries(content: bytes) -> list[tuple[str, str]]:
    """Project H2 sections without writing or discarding the original document."""
    _, body, _ = split_document(content)
    lines = body.splitlines(keepends=True)
    sections: list[tuple[int, str]] = []
    fence = ""
    for index, line in enumerate(lines):
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        if marker:
            value = marker[1]
            if not fence:
                fence = value
            elif value[0] == fence[0] and len(value) >= len(fence):
                fence = ""
            continue
        match = re.match(r"^##[ \t]+(.+?)[ \t]*(?:\r?\n)?$", line)
        if match and not fence:
            title = re.sub(r"^\d+[.、．][ \t]*", "", match[1]).strip()
            sections.append((index, title))
    if not sections:
        return [("l-" + digest(b"document")[:24], content.decode("utf-8"))] if body.strip() else []
    result = []
    occurrences: dict[str, int] = {}
    for position, (start, title) in enumerate(sections):
        occurrences[title] = occurrences.get(title, 0) + 1
        key = digest(f"{title}\0{occurrences[title]}".encode())[:24]
        end = sections[position + 1][0] if position + 1 < len(sections) else len(lines)
        ending = "\r\n" if lines[start].endswith("\r\n") else "\n"
        # Whole-document properties describe the collection, not each section.
        markdown = "# " + title + ending + "".join(lines[start + 1:end])
        result.append(("l-" + key, markdown))
    return result


class BeliefLibrary:
    def __init__(self, repository: JournalRepository):
        self.repository = repository
        config = repository.settings.journal
        self.root = Path(config["storage_dir"])
        relative = Path(str(config.get("beliefs_dir", "Review/Beliefs")))
        if relative.is_absolute() or ".." in relative.parts or str(relative) in {".", ""}:
            raise WorkflowWriteValidation("journal.beliefs_dir 必须是存储目录内的相对目录。")
        self.directory = self.root / relative
        self.metadata = self.directory / ".kinawatch.json"
        self.zone = ZoneInfo(repository.settings.timezone_name())
        self.namespace = digest(str(self.directory).encode())[:24]
        with _locks_guard:
            self.lock = _locks.setdefault(str(self.directory), threading.RLock())

    def _safe(self, path: Path) -> None:
        if self.root.resolve() not in path.resolve(strict=False).parents:
            raise WorkflowWriteValidation("信念文件不在已配置的存储目录中。")
        current = path
        while current != self.root and self.root in current.parents:
            if current.is_symlink():
                raise WorkflowWriteValidation("信念目录和文件不能使用符号链接。")
            current = current.parent

    def _bytes(self, path: Path) -> bytes:
        self._safe(path)
        if not path.exists():
            return b""
        if not path.is_file() or path.stat().st_size > MAX_DOCUMENT_BYTES:
            raise WorkflowWriteValidation("信念文件无效或超过 2 MB。")
        return path.read_bytes()

    @contextmanager
    def _writing(self):
        if not self.repository.settings.journal_write_enabled:
            raise WorkflowWriteDisabled("项目配置尚未启用信念写入。")
        with self.lock:
            self._safe(self.directory)
            self.directory.mkdir(parents=True, exist_ok=True)
            self._safe(self.directory)
            path = self.directory / ".kinawatch.lock"
            self._safe(path)
            descriptor = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
            try:
                if os.name == "nt":
                    import msvcrt
                    if os.fstat(descriptor).st_size == 0:
                        os.write(descriptor, b"0")
                    os.lseek(descriptor, 0, os.SEEK_SET)
                    msvcrt.locking(descriptor, msvcrt.LK_LOCK, 1)
                else:
                    import fcntl
                    fcntl.flock(descriptor, fcntl.LOCK_EX)
                yield
            finally:
                os.close(descriptor)

    def _state(self) -> tuple[dict, str]:
        raw = self._bytes(self.metadata)
        try:
            state = json.loads(raw) if raw else {"version": 1, "order": [], "items": {}}
            if not isinstance(state, dict) or state.get("version") != 1:
                raise ValueError()
            if not isinstance(state.get("order"), list) or not all(isinstance(x, str) for x in state["order"]):
                raise ValueError()
            if len(set(state["order"])) != len(state["order"]) or not isinstance(state.get("items"), dict):
                raise ValueError()
            for value in state["items"].values():
                if not isinstance(value, dict):
                    raise ValueError()
                days = value.get("liked_days", [])
                if not isinstance(days, list) or any(not isinstance(day, str) or datetime.strptime(day, "%Y-%m-%d").strftime("%Y-%m-%d") != day for day in days):
                    raise ValueError()
                if len(set(days)) != len(days):
                    raise ValueError()
        except (ValueError, TypeError, UnicodeError) as exc:
            raise WorkflowWriteValidation("信念管理记录格式有误，已保留原文件。") from exc
        return state, digest(raw)

    def _snapshot(self) -> tuple[dict, dict[str, Path], dict]:
        self._safe(self.directory)
        state, revision = self._state()
        today = datetime.now(self.zone).date().isoformat()
        files: dict[str, Path] = {}
        records = []
        paths = sorted(self.directory.glob("*.md")) if self.directory.exists() else []
        for path in paths:
            raw = self._bytes(path)
            match = FILE_ID.search(path.name)
            identifier = match[1] if match else "e-" + digest(path.name.encode())[:24]
            if identifier in files:
                raise WorkflowWriteValidation("有两份信念文件使用了同一标识，请先检查文件名。")
            files[identifier] = path
            info = path.stat()
            records.append({"id": identifier, "markdown": raw.decode("utf-8"), "fingerprint": digest(raw),
                            "path": path.relative_to(self.root).as_posix(), "legacy": False,
                            "created_at": info.st_ctime_ns, "updated_at": info.st_mtime_ns})
        legacy = self.repository.locate_beliefs()
        raw = self._bytes(legacy.note)
        if raw:
            info = legacy.note.stat()
            for offset, (identifier, markdown) in enumerate(legacy_entries(raw)):
                if identifier not in files:
                    records.append({"id": identifier, "markdown": markdown, "fingerprint": digest(raw),
                                    "path": legacy.relative_path, "legacy": True,
                                    "created_at": offset, "updated_at": info.st_mtime_ns})
        for item in records:
            extra = state["items"].get(item["id"], {})
            days = extra.get("liked_days", [])
            item.update(liked_days=days, like_count=len(days), liked_today=today in days, created_at=extra.get("created_at", item["created_at"]))
        known = {item["id"] for item in records}
        missing = sorted((item for item in records if item["id"] not in state["order"]), key=lambda item: item["created_at"], reverse=True)
        order = [item["id"] for item in missing] + [identifier for identifier in state["order"] if identifier in known]
        return {"ok": True, "namespace": self.namespace, "write_enabled": self.repository.settings.journal_write_enabled,
                "timezone": str(self.zone), "today": today, "revision": revision, "records": records, "order": order}, files, state

    def read(self) -> dict:
        with self.lock:
            return self._snapshot()[0]

    def save(self, payload: dict[str, Any]) -> dict:
        if set(payload) != {"namespace", "id", "markdown", "expected_fingerprint"}:
            raise WorkflowWriteValidation("保存信念只接受标识、Markdown 和文件版本。")
        if payload["namespace"] != self.namespace:
            raise WorkflowWriteConflict("信念存储位置已改变，请刷新后再保存。")
        identifier, markdown = payload["id"], payload["markdown"]
        expected = payload["expected_fingerprint"]
        if not isinstance(identifier, str) or not isinstance(markdown, str) or not markdown.strip() or "\0" in markdown:
            raise WorkflowWriteValidation("请填写有效的 Markdown 信念。")
        if len(markdown.encode("utf-8")) > MAX_DOCUMENT_BYTES or not (expected is None or isinstance(expected, str)):
            raise WorkflowWriteValidation("Markdown 超过 2 MB 或文件版本无效。")
        with self._writing():
            snapshot, files, state = self._snapshot()
            current = next((item for item in snapshot["records"] if item["id"] == identifier), None)
            if not current and not NEW_ID.fullmatch(identifier):
                raise WorkflowWriteValidation("信念标识无效。")
            if expected != (current["fingerprint"] if current else None):
                raise WorkflowWriteConflict("文件已变化；你的草稿已保留，请核对后再保存。")
            path = files.get(identifier)
            if path is None:
                _, body, _ = split_document(markdown.encode("utf-8"))
                match = re.search(r"(?m)^#[ \t]+(.+)$", body)
                title = match[1] if match else "信念"
                title = re.sub(r'[\\/:*?"<>|\x00-\x1f#`]', "-", title).strip(". ")[:64] or "信念"
                path = self.directory / f"{title}--{identifier}.md"
            self._safe(path)
            version = fingerprint_file(path)
            if current and not current["legacy"] and digest(self._bytes(path)) != expected:
                raise WorkflowWriteConflict("文件在保存过程中变化，请核对后重试。")
            if current and current["legacy"] and digest(self._bytes(self.repository.locate_beliefs().note)) != expected:
                raise WorkflowWriteConflict("原文稿在保存过程中变化，请核对后重试。")
            # Reserve identity/order before publishing the file. If the file
            # write fails, absent IDs are ignored; no partial Markdown is read.
            state["order"] = snapshot["order"] if current else [identifier, *snapshot["order"]]
            extra = state["items"].setdefault(identifier, {"liked_days": []})
            extra.setdefault("created_at", current["created_at"] if current else time.time_ns())
            self._safe(self.metadata)
            metadata_version = fingerprint_file(self.metadata)
            if digest(self._bytes(self.metadata)) != snapshot["revision"]:
                raise WorkflowWriteConflict("管理记录在保存过程中变化，请刷新后重试。")
            WorkflowWriter._atomic_write(self.metadata, json.dumps(state, ensure_ascii=False, indent=2) + "\n", metadata_version)
            self._safe(path)
            WorkflowWriter._atomic_write(path, markdown, version)
            return self._snapshot()[0]

    def manage(self, payload: dict[str, Any]) -> dict:
        action = payload.get("action")
        fields = {"namespace", "action", "expected_revision", "order"} if action == "order" else {"namespace", "action", "expected_revision", "id", "value"}
        if action == "like":
            fields.add("day")
        if action not in {"like", "order"} or set(payload) != fields:
            raise WorkflowWriteValidation("信念管理请求格式无效。")
        if payload["namespace"] != self.namespace:
            raise WorkflowWriteConflict("信念存储位置已改变，请刷新后重试。")
        with self._writing():
            snapshot, _, state = self._snapshot()
            if payload["expected_revision"] != snapshot["revision"]:
                raise WorkflowWriteConflict("点赞或顺序已在其他页面更新，请刷新后重试。")
            identifiers = {item["id"] for item in snapshot["records"]}
            if action == "order":
                order = payload["order"]
                if not isinstance(order, list) or not all(isinstance(item, str) for item in order) or len(order) != len(identifiers) or set(order) != identifiers:
                    raise WorkflowWriteValidation("排序必须完整且不重复地包含当前所有信念。")
                state["order"] = order
            else:
                identifier, value = payload["id"], payload["value"]
                if not isinstance(identifier, str) or identifier not in identifiers or type(value) is not bool:
                    raise WorkflowWriteValidation("信念标识或状态无效。")
                extra = state["items"].setdefault(identifier, {"liked_days": []})
                if payload["day"] != snapshot["today"]:
                    raise WorkflowWriteConflict("日期已变化，请刷新后再点赞。")
                days = set(extra.get("liked_days", []))
                if value:
                    days.add(snapshot["today"])
                else:
                    days.discard(snapshot["today"])
                extra["liked_days"] = sorted(days)
            self._safe(self.metadata)
            version = fingerprint_file(self.metadata)
            if digest(self._bytes(self.metadata)) != snapshot["revision"]:
                raise WorkflowWriteConflict("管理记录在保存过程中变化，请刷新后重试。")
            WorkflowWriter._atomic_write(self.metadata, json.dumps(state, ensure_ascii=False, indent=2) + "\n", version)
            return self._snapshot()[0]
