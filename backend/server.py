from __future__ import annotations

import argparse
import json
import mimetypes
import time
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

from .activitywatch_adapter import ActivityWatchAdapter
from .config import DashboardSettings, load_settings
from .day_aggregator import DayAggregator
from .journal_repository import JournalRepository
from .paths import PROJECT_ROOT
from .workflow_writer import (
    WorkflowWriteConflict,
    WorkflowWriteDisabled,
    WorkflowWriteValidation,
    WorkflowWriter,
)


MAX_WRITE_BODY_BYTES = 16 * 1024


class DashboardApplication:
    def __init__(
        self,
        settings: DashboardSettings,
        aggregator: DayAggregator | Any | None = None,
        journals: JournalRepository | None = None,
        activitywatch: ActivityWatchAdapter | None = None,
        workflow_writer: WorkflowWriter | Any | None = None,
    ):
        self.settings = settings
        self.journals = journals or JournalRepository(settings)
        self.activitywatch = activitywatch or ActivityWatchAdapter(settings)
        self.aggregator = aggregator or DayAggregator(
            settings,
            journal_repository=self.journals,
            activitywatch=self.activitywatch,
        )
        self.workflow_writer = workflow_writer or WorkflowWriter(self.journals)

    def health(self) -> dict[str, Any]:
        journal_health = self.journals.health()
        activity_health = self.activitywatch.health()
        return {
            "ok": journal_health["available"] and activity_health["available"],
            "version": 1,
            "activitywatch_available": activity_health["available"],
            "journal_root_available": journal_health["available"],
            "journal_write_enabled": self.settings.journal_write_enabled,
            "activitywatch": activity_health,
            "journal": journal_health,
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
        unsupported_includes = includes - {"uncategorized_apps"}
        if unsupported_includes:
            unsupported = ", ".join(sorted(unsupported_includes))
            raise ValueError(f"unsupported include value: {unsupported}")
        days = []
        uncategorized_apps: dict[str, float] = {}
        for offset in range(day_count):
            payload = self.aggregator.get_day(start + timedelta(days=offset), mode)
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
            days.append(range_day)
            if "uncategorized_apps" in includes:
                for block in payload.get("timeline", []):
                    if (
                        block.get("kind") == "screen"
                        and block.get("category") == "uncategorized"
                    ):
                        app = str(block.get("app") or "(未知应用)")
                        uncategorized_apps[app] = (
                            uncategorized_apps.get(app, 0.0)
                            + float(block.get("duration_seconds", 0.0))
                        )
        response = {
            "start": start.isoformat(),
            "end": end.isoformat(),
            "mode": mode,
            "days": days,
        }
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

    def open_weekly_review(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.settings.journal_write_enabled:
            raise WorkflowWriteDisabled("项目配置尚未启用日记受限写入。")
        return self.workflow_writer.ensure_weekly_review(payload)

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

    def serve_until_idle(self) -> None:
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

    def do_GET(self) -> None:
        self.server.touch()
        parsed = urlparse(self.path)
        parameters = parse_qs(parsed.query)
        try:
            if parsed.path == "/api/health":
                payload = self.server.application.health()
            elif parsed.path == "/api/day":
                payload = self.server.application.day(parameters)
            elif parsed.path == "/api/range":
                payload = self.server.application.date_range(parameters)
            elif parsed.path == "/api" or parsed.path.startswith("/api/"):
                self._write_json({"ok": False, "error": "not found"}, status=404)
                return
            else:
                self._serve_static(parsed.path)
                return
            self._write_json(payload)
        except (ValueError, KeyError) as exc:
            self._write_json({"ok": False, "error": str(exc)}, status=400)
        except Exception as exc:
            self._write_json({"ok": False, "error": str(exc)}, status=500)

    def do_PUT(self) -> None:
        self.server.touch()
        parsed = urlparse(self.path)
        actions = {
            "/api/journal/workflow": self.server.application.save_workflow,
            "/api/journal/review": self.server.application.save_review,
            "/api/journal/weekly": self.server.application.open_weekly_review,
        }
        action = actions.get(parsed.path)
        if action is None:
            self._write_json({"ok": False, "error": "not found"}, status=404)
            return
        try:
            payload = self._read_json()
            result = action(payload)
            self._write_json(result)
        except WorkflowWriteDisabled as exc:
            self._write_json({"ok": False, "error": str(exc)}, status=403)
        except WorkflowWriteConflict as exc:
            self._write_json({"ok": False, "error": str(exc)}, status=409)
        except WorkflowWriteValidation as exc:
            self._write_json({"ok": False, "error": str(exc)}, status=400)
        except Exception as exc:
            self._write_json({"ok": False, "error": str(exc)}, status=500)

    def _read_json(self) -> dict[str, Any]:
        if self.headers.get_content_type() != "application/json":
            raise WorkflowWriteValidation("请求必须使用 application/json。")
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise WorkflowWriteValidation("Content-Length 无效。") from exc
        if content_length <= 0:
            raise WorkflowWriteValidation("请求正文不能为空。")
        if content_length > MAX_WRITE_BODY_BYTES:
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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the KinaWatch local API.")
    parser.add_argument("--config")
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    parser.add_argument("--idle-timeout", type=float)
    parser.add_argument("--check", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    settings = load_settings(args.config) if args.config else load_settings()
    application = DashboardApplication(settings)
    if args.check:
        print(json.dumps(application.health(), ensure_ascii=False, indent=2))
        return 0

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
