from __future__ import annotations

import argparse
import json
import mimetypes
import threading
import time
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

from .activity_edits import (
    ActivityEditConflict,
    ActivityEditDisabled,
    ActivityEditStore,
    ActivityEditValidation,
    ActivityEditor,
)
from .activitywatch_adapter import ActivityWatchAdapter
from .anki import AnkiStore
from .beliefs import BeliefLibrary
from .config import DashboardSettings, load_settings
from .day_aggregator import DayAggregator
from .screen_time import ScreenTimeStore
from .multi_device_activity import MultiDeviceActivity
from .journal_repository import JournalRepository
from .paths import PROJECT_ROOT
from .timetable import read_timetable
from .server_monitor import ServerMonitor
from .mcp_services import MCPServiceCenter, MCPServiceBusy, MCPServiceError
from .personal_health import HealthImportConflict, MAX_IMPORT_BYTES, PersonalHealthStore
from .workflow_writer import (
    WorkflowWriteConflict,
    WorkflowWriteDisabled,
    WorkflowWriteValidation,
    WorkflowWriter,
)


MAX_WRITE_BODY_BYTES = 256 * 1024
MAX_DOCUMENT_BODY_BYTES = 16 * 1024 * 1024
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
CONTENT_SECURITY_POLICY = "; ".join(
    (
        "default-src 'self'",
        "base-uri 'none'",
        "connect-src 'self'",
        "font-src 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "img-src 'self' data:",
        "object-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
    )
)


class DashboardApplication:
    def __init__(
        self,
        settings: DashboardSettings,
        aggregator: DayAggregator | Any | None = None,
        journals: JournalRepository | None = None,
        activitywatch: ActivityWatchAdapter | None = None,
        workflow_writer: WorkflowWriter | Any | None = None,
        activity_editor: ActivityEditor | Any | None = None,
    ):
        self.settings = settings
        self._personal_health: PersonalHealthStore | None = None
        self._personal_health_lock = threading.Lock()
        self._anki: AnkiStore | None = None
        self._anki_lock = threading.Lock()
        self._server_monitor: ServerMonitor | None = None
        self._server_monitor_lock = threading.Lock()
        self._mcp_services: MCPServiceCenter | None = None
        self._mcp_services_lock = threading.Lock()
        self.journals = journals or JournalRepository(settings)
        edit_store = (
            getattr(activitywatch, "activity_edits", None)
            if activitywatch is not None
            else ActivityEditStore(settings)
        )
        if edit_store is None:
            edit_store = ActivityEditStore(settings)
        self.activitywatch = activitywatch or ActivityWatchAdapter(
            settings,
            edit_store=edit_store,
        )
        mobile_config = settings.raw.get("screen_time", {})
        self.screen_time = ScreenTimeStore(mobile_config) if mobile_config.get("enabled") else None
        self.aggregator = aggregator or DayAggregator(
            settings,
            journal_repository=self.journals,
            activitywatch=MultiDeviceActivity(self.activitywatch, self.screen_time) if self.screen_time else self.activitywatch,
        )
        self.workflow_writer = workflow_writer or WorkflowWriter(self.journals)
        self.activity_editor = activity_editor or ActivityEditor(
            settings,
            self.activitywatch,
            edit_store,
        )

    @property
    def personal_health(self) -> PersonalHealthStore:
        # Resolve health-specific settings only when this endpoint is used.
        with self._personal_health_lock:
            if self._personal_health is None:
                self._personal_health = PersonalHealthStore(self.settings.timezone_name())
            return self._personal_health

    def health_snapshot(self) -> dict:
        config = self.settings.raw.get("health_sync", {})
        if config.get("enabled") and config.get("file"):
            return self.personal_health.sync_file(self.settings.configured_path(config["file"]))
        return self.personal_health.read()

    def words(self, parameters: dict[str, list[str]]) -> dict:
        with self._anki_lock:
            if self._anki is None:
                self._anki = AnkiStore(self.settings.raw.get("anki", {}), self.settings.timezone_name())
        return self._anki.read(refresh=_first(parameters, "refresh") == "1")

    def timetable(self) -> dict:
        configured = self.settings.raw.get("timetable", {}).get("file")
        return read_timetable(self.settings.configured_path(configured) if configured else None)

    def servers(self) -> dict:
        with self._server_monitor_lock:
            if self._server_monitor is None:
                self._server_monitor = ServerMonitor(self.settings.raw.get("server_monitor", {}))
        return self._server_monitor.read()

    def close(self) -> None:
        with self._server_monitor_lock:
            if self._server_monitor is not None:
                self._server_monitor.close()

    @property
    def mcp_services(self) -> MCPServiceCenter:
        with self._mcp_services_lock:
            if self._mcp_services is None:
                self._mcp_services = MCPServiceCenter(self.settings.raw.get("mcp_services", {}))
            return self._mcp_services

    def health(self) -> dict[str, Any]:
        journal_health = self.journals.health()
        activity_health = self.activitywatch.health()
        return {
            "ok": journal_health["available"] and activity_health["available"],
            "version": 1,
            "activitywatch_available": activity_health["available"],
            "journal_root_available": journal_health["available"],
            "journal_provider": journal_health.get("provider", ""),
            "journal_write_enabled": self.settings.journal_write_enabled,
            "activity_edit_enabled": self.settings.activity_edit_enabled,
            "screen_time": self.screen_time.status() if self.screen_time else {"enabled": False},
            "activitywatch": activity_health,
            "activity_edits": activity_health.get("activity_edits", {}),
            "journal": journal_health,
        }

    def runtime_settings(self) -> dict[str, Any]:
        return {
            "default_mode": self.settings.default_mode,
            "routine_day_start": self.settings.routine_day_start,
            "timezone": self.settings.timezone_name(),
            "journal_write_enabled": self.settings.journal_write_enabled,
            "activity_edit_enabled": self.settings.activity_edit_enabled,
        }

    def day(self, parameters: dict[str, list[str]]) -> dict[str, Any]:
        raw_date = _first(parameters, "date")
        if not raw_date:
            raise ValueError("date is required")
        mode = _first(parameters, "mode") or self.settings.default_mode
        refresh = (_first(parameters, "refresh") or "") == "1"
        return self.aggregator.get_day(
            date.fromisoformat(raw_date),
            mode,
            refresh=refresh,
        )

    def date_range(self, parameters: dict[str, list[str]]) -> dict[str, Any]:
        raw_start = _first(parameters, "start")
        raw_end = _first(parameters, "end")
        if not raw_start or not raw_end:
            raise ValueError("start and end are required")
        start = date.fromisoformat(raw_start)
        end = date.fromisoformat(raw_end)
        if end < start:
            raise ValueError("end must be on or after start")
        day_count = (end - start).days + 1
        if day_count > self.settings.max_range_days:
            raise ValueError(
                f"range cannot exceed {self.settings.max_range_days} days"
        )
        mode = _first(parameters, "mode") or self.settings.default_mode
        includes = {
            item.strip()
            for raw_value in parameters.get("include", [])
            for item in raw_value.split(",")
            if item.strip()
        }
        unsupported_includes = includes - {
            "top_apps",
            "uncategorized_apps",
            "timeline",
        }
        if unsupported_includes:
            unsupported = ", ".join(sorted(unsupported_includes))
            raise ValueError(f"unsupported include value: {unsupported}")
        requested_days = [
            start + timedelta(days=offset) for offset in range(day_count)
        ]
        batch_loader = getattr(self.aggregator, "get_days", None)
        if callable(batch_loader):
            day_payloads = batch_loader(requested_days, mode)
        else:
            day_payloads = [
                self.aggregator.get_day(requested_day, mode)
                for requested_day in requested_days
            ]

        days = []
        top_apps: dict[str, float] = {}
        top_app_categories: dict[str, dict[str, float]] = {}
        uncategorized_apps: dict[str, float] = {}
        for payload in day_payloads:
            range_day = {
                "date": payload["date"],
                "overview": payload["overview"],
                "quality": {
                    "complete": payload["quality"]["complete"],
                    "issues": payload["quality"]["issues"],
                    "uncategorized_seconds": payload["quality"][
                        "uncategorized_seconds"
                    ],
                },
                "categories": payload["categories"],
            }
            if isinstance(payload.get("rhythm"), dict):
                range_day["rhythm"] = payload["rhythm"]
            screen_timeline = [
                block
                for block in payload.get("timeline", [])
                if block.get("kind") == "screen"
            ]
            if "timeline" in includes:
                range_day["timeline"] = screen_timeline
            days.append(range_day)
            if includes & {"top_apps", "uncategorized_apps"}:
                for block in screen_timeline:
                    app = str(block.get("app") or "(未知应用)")
                    category = str(block.get("category") or "uncategorized")
                    duration_seconds = float(block.get("duration_seconds", 0.0))
                    if "top_apps" in includes:
                        top_apps[app] = top_apps.get(app, 0.0) + duration_seconds
                        category_totals = top_app_categories.setdefault(app, {})
                        category_totals[category] = (
                            category_totals.get(category, 0.0) + duration_seconds
                        )
                    if (
                        "uncategorized_apps" in includes
                        and category == "uncategorized"
                    ):
                        uncategorized_apps[app] = (
                            uncategorized_apps.get(app, 0.0)
                            + duration_seconds
                        )
        response = {
            "start": start.isoformat(),
            "end": end.isoformat(),
            "mode": mode,
            "timezone": self.settings.timezone_name(),
            "days": days,
        }
        if "top_apps" in includes:
            response["top_apps"] = [
                {
                    "app": app,
                    "duration_seconds": round(duration_seconds, 3),
                    "category": sorted(
                        top_app_categories[app].items(),
                        key=lambda item: (-item[1], item[0]),
                    )[0][0],
                }
                for app, duration_seconds in sorted(
                    top_apps.items(),
                    key=lambda item: (-item[1], item[0]),
                )[:6]
            ]
        if "uncategorized_apps" in includes:
            response["uncategorized_apps"] = [
                {
                    "app": app,
                    "duration_seconds": round(duration_seconds, 3),
                }
                for app, duration_seconds in sorted(
                    uncategorized_apps.items(),
                    key=lambda item: (-item[1], item[0]),
                )[:5]
            ]
        return response

    def save_workflow(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.settings.journal_write_enabled:
            raise WorkflowWriteDisabled("项目配置尚未启用日记受限写入。")
        result = self.workflow_writer.upsert(payload)
        self._invalidate_written_day(result)
        return result

    def save_review(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.settings.journal_write_enabled:
            raise WorkflowWriteDisabled("项目配置尚未启用日记受限写入。")
        result = self.workflow_writer.upsert_review(payload)
        self._invalidate_written_day(result)
        return result

    def journal_document(self, parameters: dict[str, list[str]]) -> dict[str, Any]:
        result = self.workflow_writer.read_document(_first(parameters, "date"))
        result["write_enabled"] = self.settings.journal_write_enabled
        return result

    def save_journal_document(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.settings.journal_write_enabled:
            raise WorkflowWriteDisabled("项目配置尚未启用日记写入。")
        result = self.workflow_writer.upsert_document(payload)
        result["write_enabled"] = True
        if result["changed"]:
            self._invalidate_written_day(result)
        return result

    def permanent_note(self) -> dict[str, Any]:
        result = self.workflow_writer.read_permanent_note()
        result["write_enabled"] = self.settings.journal_write_enabled
        return result

    def beliefs(self) -> dict[str, Any]:
        result = self.workflow_writer.read_beliefs()
        result["write_enabled"] = self.settings.journal_write_enabled
        return result

    def belief_library(self) -> dict[str, Any]:
        return BeliefLibrary(self.journals).read()

    def save_belief_document(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.settings.journal_write_enabled:
            raise WorkflowWriteDisabled("项目配置尚未启用信念写入。")
        return BeliefLibrary(self.journals).save(payload)

    def save_belief_state(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.settings.journal_write_enabled:
            raise WorkflowWriteDisabled("项目配置尚未启用信念写入。")
        return BeliefLibrary(self.journals).manage(payload)

    def save_beliefs(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.settings.journal_write_enabled:
            raise WorkflowWriteDisabled("项目配置尚未启用笔记写入。")
        result = self.workflow_writer.upsert_beliefs(payload)
        result["write_enabled"] = True
        return result

    def save_permanent_note(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.settings.journal_write_enabled:
            raise WorkflowWriteDisabled("项目配置尚未启用日记受限写入。")
        result = self.workflow_writer.upsert_permanent_note(payload)
        result["write_enabled"] = True
        return result

    def weekly_review(
        self,
        parameters: dict[str, list[str]],
    ) -> dict[str, Any]:
        result = self.workflow_writer.read_weekly_review(
            _first(parameters, "week_id"),
        )
        result["write_enabled"] = self.settings.journal_write_enabled
        return result

    def save_weekly_review(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.settings.journal_write_enabled:
            raise WorkflowWriteDisabled("项目配置尚未启用日记受限写入。")
        result = self.workflow_writer.upsert_weekly_review(payload)
        result["write_enabled"] = True
        return result

    def open_weekly_review(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Compatibility alias for the former create-and-open action."""
        return self.save_weekly_review(payload)

    def monthly_review(
        self,
        parameters: dict[str, list[str]],
    ) -> dict[str, Any]:
        result = self.workflow_writer.read_monthly_review(
            _first(parameters, "month_id"),
        )
        result["write_enabled"] = self.settings.journal_write_enabled
        return result

    def save_monthly_review(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.settings.journal_write_enabled:
            raise WorkflowWriteDisabled("项目配置尚未启用日记受限写入。")
        result = self.workflow_writer.upsert_monthly_review(payload)
        result["write_enabled"] = True
        return result

    def inspect_activity(
        self,
        parameters: dict[str, list[str]],
    ) -> dict[str, Any]:
        return self.activity_editor.inspect(parameters)

    def save_activity(self, payload: dict[str, Any]) -> dict[str, Any]:
        result = self.activity_editor.save(payload)
        self._invalidate_activity_day(result)
        return result

    def undo_activity(self, payload: dict[str, Any]) -> dict[str, Any]:
        result = self.activity_editor.undo(payload)
        self._invalidate_activity_day(result)
        return result

    def _invalidate_written_day(self, result: dict[str, Any]) -> None:
        try:
            selected_day = date.fromisoformat(str(result["date"]))
            cache = getattr(self.aggregator, "cache", None)
            if cache is not None:
                cache.invalidate(selected_day)
        except (AttributeError, KeyError, OSError, TypeError, ValueError):
            # A successful writer response is already durable. Cache
            # invalidation is best-effort and fingerprints still prevent a
            # stale cache hit, so never turn it into a second write attempt.
            pass

    def _invalidate_activity_day(self, result: dict[str, Any]) -> None:
        try:
            selected_day = date.fromisoformat(str(result["date"]))
            cache = getattr(self.aggregator, "cache", None)
            if cache is not None:
                cache.invalidate(selected_day)
        except (AttributeError, KeyError, OSError, TypeError, ValueError):
            # The correction overlay is already durable and its per-day
            # fingerprint prevents future stale hits. Keep invalidation
            # best-effort so a cache failure never retries the write.
            pass


def _first(parameters: dict[str, list[str]], key: str) -> str:
    values = parameters.get(key) or []
    return values[0] if values else ""


class IdleHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        server_address: tuple[str, int],
        handler: type[BaseHTTPRequestHandler],
        application: DashboardApplication,
        idle_timeout_seconds: float,
        static_root: Path | None = None,
    ):
        super().__init__(server_address, handler)
        self.application = application
        self.idle_timeout_seconds = idle_timeout_seconds
        self.last_request_monotonic = time.monotonic()
        self.static_root = (static_root or PROJECT_ROOT / "dist").resolve()

    def touch(self) -> None:
        self.last_request_monotonic = time.monotonic()

    def server_close(self) -> None:
        close = getattr(self.application, "close", None)
        if close:
            close()
        super().server_close()

    def serve_until_idle(self) -> None:
        if self.idle_timeout_seconds == 0:
            self.serve_forever(poll_interval=1.0)
            return
        while True:
            remaining = self.idle_timeout_seconds - (
                time.monotonic() - self.last_request_monotonic
            )
            if remaining <= 0:
                return
            self.timeout = remaining
            self.handle_request()


class DashboardRequestHandler(BaseHTTPRequestHandler):
    server: IdleHTTPServer

    def version_string(self) -> str:
        return "KinaWatch"

    def end_headers(self) -> None:
        self.send_header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Permissions-Policy", "camera=(), geolocation=(), microphone=()")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        super().end_headers()

    def do_GET(self) -> None:
        self.server.touch()
        if not self._validate_request_authority():
            return
        parsed = urlparse(self.path)
        parameters = parse_qs(parsed.query)
        try:
            if parsed.path == "/api/health":
                payload = self.server.application.health()
            elif parsed.path == "/api/personal-health":
                payload = self.server.application.health_snapshot()
            elif parsed.path == "/api/words":
                payload = self.server.application.words(parameters)
            elif parsed.path == "/api/timetable":
                payload = self.server.application.timetable()
            elif parsed.path == "/api/servers":
                payload = self.server.application.servers()
            elif parsed.path == "/api/mcp/services":
                payload = self.server.application.mcp_services.read()
            elif parsed.path == "/api/mcp/folders":
                payload = self.server.application.mcp_services.browse(_first(parameters, "path"))
            elif parsed.path == "/api/mcp/logs":
                payload = self.server.application.mcp_services.logs(_first(parameters, "id"))
            elif parsed.path == "/api/settings":
                payload = self.server.application.runtime_settings()
            elif parsed.path == "/api/day":
                payload = self.server.application.day(parameters)
            elif parsed.path == "/api/range":
                payload = self.server.application.date_range(parameters)
            elif parsed.path == "/api/activity/inspect":
                payload = self.server.application.inspect_activity(parameters)
            elif parsed.path == "/api/journal/document":
                payload = self.server.application.journal_document(parameters)
            elif parsed.path == "/api/journal/permanent":
                payload = self.server.application.permanent_note()
            elif parsed.path == "/api/journal/beliefs":
                payload = self.server.application.beliefs()
            elif parsed.path == "/api/beliefs":
                payload = self.server.application.belief_library()
            elif parsed.path == "/api/journal/weekly":
                payload = self.server.application.weekly_review(parameters)
            elif parsed.path == "/api/journal/monthly":
                payload = self.server.application.monthly_review(parameters)
            elif parsed.path == "/api" or parsed.path.startswith("/api/"):
                self._write_json({"ok": False, "error": "not found"}, status=404)
                return
            else:
                self._serve_static(parsed.path)
                return
            self._write_json(payload)
        except PermissionError as exc:
            self._write_json({"ok": False, "error": str(exc)}, status=403)
        except (
            ValueError,
            KeyError,
            ActivityEditValidation,
            WorkflowWriteValidation,
        ) as exc:
            self._write_json({"ok": False, "error": str(exc)}, status=400)
        except (ActivityEditConflict, WorkflowWriteConflict) as exc:
            self._write_json({"ok": False, "error": str(exc)}, status=409)
        except Exception as exc:
            self._write_json({"ok": False, "error": str(exc)}, status=500)

    def do_POST(self) -> None:
        self.server.touch()
        if not self._validate_request_authority():
            return
        if urlparse(self.path).path.startswith("/api/mcp/"):
            self._mcp_action()
            return
        if urlparse(self.path).path != "/api/personal-health/import":
            self._write_json({"ok": False, "error": "not found"}, status=404)
            return
        try:
            if self.headers.get_content_type() != "application/zip":
                raise ValueError("请选择 Apple 健康导出的 ZIP 文件。")
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= MAX_IMPORT_BYTES:
                raise ValueError("请选择不超过 64 MB 的健康导出 ZIP。")
            if self.headers.get("Transfer-Encoding"):
                raise ValueError("不支持此上传方式。")
            self.connection.settimeout(60)
            body = self.rfile.read(size)
            if len(body) != size:
                raise ValueError("文件上传未完成，请重试。")
            result = self.server.application.personal_health.import_archive(
                body, self.headers.get("If-Match", ""),
            )
            self._write_json(result)
        except HealthImportConflict as exc:
            self._write_json({"ok": False, "error": str(exc)}, status=409)
        except (ValueError, TimeoutError) as exc:
            self._write_json({"ok": False, "error": str(exc)}, status=400)
        except Exception:
            self._write_json({"ok": False, "error": "健康数据导入失败，原有记录已保留。"}, status=500)

    def _mcp_action(self) -> None:
        if self.headers.get("X-KinaWatch-MCP") != "1":
            self._write_json({"error": "请从 KinaWatch 服务管理页面操作"}, status=403)
            return
        if self.headers.get_content_type() != "application/json" or self.headers.get("Transfer-Encoding"):
            self._write_json({"error": "需要 JSON 请求"}, status=400)
            return
        try:
            self.connection.settimeout(8)
            payload = self._read_json(8192)
            center = self.server.application.mcp_services
            actions = {"/api/mcp/services": center.create, "/api/mcp/action": center.action, "/api/mcp/password": center.password}
            action = actions.get(urlparse(self.path).path)
            if action is None:
                self._write_json({"error": "not found"}, status=404)
                return
            self._write_json(action(payload))
        except PermissionError as exc:
            self._write_json({"error": str(exc)}, status=403)
        except MCPServiceBusy as exc:
            self._write_json({"error": str(exc)}, status=409)
        except (MCPServiceError, WorkflowWriteValidation) as exc:
            self._write_json({"error": str(exc)}, status=400)
        except (OSError, ValueError, TypeError, KeyError):
            self._write_json({"error": "服务操作未完成，请检查配置或日志后重试"}, status=400)

    def do_PUT(self) -> None:
        self.server.touch()
        if not self._validate_request_authority():
            return
        parsed = urlparse(self.path)
        actions = {
            "/api/journal/document": self.server.application.save_journal_document,
            "/api/journal/workflow": self.server.application.save_workflow,
            "/api/journal/review": self.server.application.save_review,
            "/api/journal/permanent": self.server.application.save_permanent_note,
            "/api/journal/beliefs": self.server.application.save_beliefs,
            "/api/beliefs/document": self.server.application.save_belief_document,
            "/api/beliefs/state": self.server.application.save_belief_state,
            "/api/journal/weekly": self.server.application.save_weekly_review,
            "/api/journal/monthly": self.server.application.save_monthly_review,
            "/api/activity/edit": self.server.application.save_activity,
            "/api/activity/undo": self.server.application.undo_activity,
        }
        action = actions.get(parsed.path)
        if action is None:
            self._write_json({"ok": False, "error": "not found"}, status=404)
            return
        try:
            payload = self._read_json(
                MAX_DOCUMENT_BODY_BYTES
                if parsed.path in {"/api/journal/document", "/api/journal/beliefs", "/api/beliefs/document"}
                else MAX_WRITE_BODY_BYTES
            )
            result = action(payload)
            self._write_json(result)
        except (ActivityEditDisabled, WorkflowWriteDisabled) as exc:
            self._write_json({"ok": False, "error": str(exc)}, status=403)
        except (ActivityEditConflict, WorkflowWriteConflict) as exc:
            self._write_json({"ok": False, "error": str(exc)}, status=409)
        except (ActivityEditValidation, WorkflowWriteValidation) as exc:
            self._write_json({"ok": False, "error": str(exc)}, status=400)
        except Exception as exc:
            self._write_json({"ok": False, "error": str(exc)}, status=500)

    def _validate_request_authority(
        self,
    ) -> bool:
        host = self.headers.get("Host", "")
        host_authority = _parse_loopback_authority(host, default_port=80)
        if host_authority is None:
            self._write_json(
                {"ok": False, "error": "request Host must be loopback"},
                status=421,
            )
            return False

        fetch_site = self.headers.get("Sec-Fetch-Site", "").strip().casefold()
        request_path = urlparse(self.path).path
        if fetch_site == "cross-site" and (
            request_path == "/api" or request_path.startswith("/api/")
        ):
            self._write_json(
                {"ok": False, "error": "cross-site API requests are not allowed"},
                status=403,
            )
            return False

        origin = self.headers.get("Origin")
        if origin is None:
            return True
        parsed_origin = None
        try:
            parsed_origin = urlparse(origin)
            default_port = 443 if parsed_origin.scheme == "https" else 80
            origin_authority = _parse_loopback_authority(
                parsed_origin.netloc,
                default_port=default_port,
            )
        except ValueError:
            origin_authority = None
        if (
            parsed_origin is None
            or parsed_origin.scheme not in {"http", "https"}
            or parsed_origin.path
            or parsed_origin.params
            or parsed_origin.query
            or parsed_origin.fragment
            or origin_authority is None
            or origin_authority != host_authority
        ):
            self._write_json(
                {"ok": False, "error": "request Origin must match Host"},
                status=403,
            )
            return False
        return True

    def _read_json(self, max_bytes: int = MAX_WRITE_BODY_BYTES) -> dict[str, Any]:
        if self.headers.get_content_type() != "application/json":
            raise WorkflowWriteValidation("请求必须使用 application/json。")
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise WorkflowWriteValidation("Content-Length 无效。") from exc
        if content_length <= 0:
            raise WorkflowWriteValidation("请求正文不能为空。")
        if content_length > max_bytes:
            raise WorkflowWriteValidation("请求正文过大。")
        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise WorkflowWriteValidation("请求正文不是有效 JSON。") from exc
        if not isinstance(payload, dict):
            raise WorkflowWriteValidation("请求必须是 JSON 对象。")
        return payload

    def _write_json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, request_path: str) -> None:
        decoded_path = unquote(request_path)
        relative_path = PurePosixPath(decoded_path.lstrip("/"))
        if ".." in relative_path.parts:
            self._write_text("not found\n", status=404)
            return

        static_root = self.server.static_root
        index_path = static_root / "index.html"
        requested_path = static_root.joinpath(*relative_path.parts).resolve()
        if requested_path != static_root and static_root not in requested_path.parents:
            self._write_text("not found\n", status=404)
            return

        if decoded_path == "/":
            target = index_path
        elif requested_path.is_file():
            target = requested_path
        elif decoded_path.startswith("/assets/"):
            self._write_text("not found\n", status=404)
            return
        else:
            # SPA fallback: unknown non-API paths render the frontend entrypoint.
            target = index_path

        if not target.is_file():
            self._write_text(
                (
                    "KinaWatch frontend is not built.\n"
                    "Run: npm run build --prefix frontend\n"
                ),
                status=503,
            )
            return

        body = target.read_bytes()
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {
            "application/javascript",
            "application/json",
            "image/svg+xml",
        }:
            content_type = f"{content_type}; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _write_text(self, message: str, status: int = 200) -> None:
        body = message.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        return


def _parse_loopback_authority(
    authority: str,
    *,
    default_port: int,
) -> tuple[str, int] | None:
    if not authority or any(character.isspace() for character in authority):
        return None
    try:
        parsed = urlparse(f"//{authority}")
        hostname = (parsed.hostname or "").rstrip(".").casefold()
        if (
            parsed.username is not None
            or parsed.password is not None
            or parsed.path
            or parsed.query
            or parsed.fragment
            or hostname not in LOOPBACK_HOSTS
        ):
            return None
        return hostname, parsed.port if parsed.port is not None else default_port
    except ValueError:
        return None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the KinaWatch local API.")
    parser.add_argument("--config")
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    parser.add_argument(
        "--idle-timeout",
        type=float,
        help="Exit after this many idle seconds; 0 disables idle exit.",
    )
    parser.add_argument("--check", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    settings = load_settings(args.config) if args.config else load_settings()
    application = DashboardApplication(settings)
    if args.check:
        health = application.health()
        print(json.dumps(health, ensure_ascii=False, indent=2))
        return 0 if health.get("ok") else 1

    host = args.host or settings.host
    if host not in {"127.0.0.1", "localhost"}:
        raise SystemExit("Dashboard may only bind to 127.0.0.1 or localhost.")
    port = settings.port if args.port is None else args.port
    idle_timeout = (
        settings.idle_timeout_seconds
        if args.idle_timeout is None
        else args.idle_timeout
    )
    server = IdleHTTPServer(
        (host, port),
        DashboardRequestHandler,
        application,
        idle_timeout,
    )
    actual_host, actual_port = server.server_address
    print(
        json.dumps(
            {
                "ok": True,
                "host": actual_host,
                "port": actual_port,
                "idle_timeout_seconds": idle_timeout,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    try:
        server.serve_until_idle()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
