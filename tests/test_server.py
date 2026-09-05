from __future__ import annotations

import json
import socket
import tempfile
import threading
import time
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

from backend.activity_edits import ActivityEditDisabled
from backend.config import DashboardSettings, load_settings
from backend.paths import EXAMPLE_CONFIG_PATH
from backend.server import (
    DashboardApplication,
    DashboardRequestHandler,
    IdleHTTPServer,
    main,
)
from backend.workflow_writer import (
    WorkflowWriteConflict,
    WorkflowWriteDisabled,
    WorkflowWriteValidation,
)


class StubApplication:
    def journal_document(self, parameters: dict[str, list[str]]) -> dict[str, Any]:
        return {"ok": True, "date": parameters["date"][0], "markdown": ""}

    def save_journal_document(self, payload: dict[str, Any]) -> dict[str, Any]:
        return {"ok": True, "date": payload["date"], "markdown": payload["markdown"]}

    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "version": 1,
            "activitywatch_available": True,
            "journal_root_available": True,
        }

    def day(self, parameters: dict[str, list[str]]) -> dict[str, Any]:
        return {"date": parameters["date"][0], "cache": {"hit": False}}

    def runtime_settings(self) -> dict[str, Any]:
        return {
            "default_mode": "routine",
            "routine_day_start": "06:00",
            "timezone": "Asia/Shanghai",
            "journal_write_enabled": True,
            "activity_edit_enabled": True,
        }

    def date_range(self, parameters: dict[str, list[str]]) -> dict[str, Any]:
        return {
            "start": parameters["start"][0],
            "end": parameters["end"][0],
            "days": [],
        }

    def save_workflow(self, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "ok": True,
            "date": payload["date"],
            "workflow_note": {"note": payload["note"]},
        }

    def save_review(self, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "ok": True,
            "date": payload["date"],
            "review_field": {
                "field": payload["field"],
                "markdown": payload["markdown"],
            },
        }

    def permanent_note(self) -> dict[str, Any]:
        return {
            "ok": True,
            "exists": False,
            "path": "incoming.md",
            "provider": "obsidian",
            "open_url": "obsidian://open?vault=Studio&file=incoming",
            "obsidian_url": "obsidian://open?vault=Studio&file=incoming",
            "write_enabled": True,
            "markdown": "",
            "journal_fingerprint": {
                "path": "/fixture/incoming.md",
                "mtime_ns": "0",
                "size": 0,
            },
        }

    def save_permanent_note(self, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            **self.permanent_note(),
            "exists": True,
            "created": True,
            "markdown": payload["markdown"],
        }

    def beliefs(self) -> dict[str, Any]:
        return {**self.permanent_note(), "path": "Review/我的人生信念.md", "has_frontmatter": False}

    def save_beliefs(self, payload: dict[str, Any]) -> dict[str, Any]:
        return {**self.beliefs(), "exists": True, "markdown": payload["markdown"]}

    def weekly_review(
        self,
        parameters: dict[str, list[str]],
    ) -> dict[str, Any]:
        week_id = parameters["week_id"][0]
        return {
            "ok": True,
            "period_id": week_id,
            "week_id": week_id,
            "exists": True,
            "created": False,
            "path": f"Review/Weekly/{week_id}.md",
            "provider": "obsidian",
            "open_url": (
                f"obsidian://open?vault=Studio&file=Review/Weekly/{week_id}"
            ),
            "obsidian_url": (
                f"obsidian://open?vault=Studio&file=Review/Weekly/{week_id}"
            ),
            "write_enabled": True,
            "fields": {"freeform": ""},
            "journal_fingerprint": {
                "path": f"/fixture/{week_id}.md",
                "mtime_ns": "1",
                "size": 10,
            },
        }

    def save_weekly_review(self, payload: dict[str, Any]) -> dict[str, Any]:
        if "field" not in payload:
            raise WorkflowWriteValidation("field 必须是 freeform。")
        return {
            **self.weekly_review({"week_id": [payload["week_id"]]}),
            "review_field": {
                "field": payload.get("field", ""),
                "markdown": payload.get("markdown", ""),
            },
        }

    def open_weekly_review(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.save_weekly_review(payload)

    def monthly_review(
        self,
        parameters: dict[str, list[str]],
    ) -> dict[str, Any]:
        month_id = parameters["month_id"][0]
        return {
            "ok": True,
            "period_id": month_id,
            "month_id": month_id,
            "exists": False,
            "path": f"Review/Monthly/{month_id}.md",
            "provider": "obsidian",
            "open_url": (
                f"obsidian://open?vault=Studio&file=Review/Monthly/{month_id}"
            ),
            "obsidian_url": (
                f"obsidian://open?vault=Studio&file=Review/Monthly/{month_id}"
            ),
            "write_enabled": True,
            "fields": {"freeform": ""},
            "journal_fingerprint": {
                "path": f"/fixture/{month_id}.md",
                "mtime_ns": "0",
                "size": 0,
            },
        }

    def save_monthly_review(self, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            **self.monthly_review({"month_id": [payload["month_id"]]}),
            "exists": True,
            "created": True,
            "review_field": {
                "field": payload["field"],
                "markdown": payload["markdown"],
            },
        }

    def inspect_activity(
        self,
        parameters: dict[str, list[str]],
    ) -> dict[str, Any]:
        return {
            "date": parameters["date"][0],
            "mode": parameters["mode"][0],
            "bucket_id": parameters["bucket_id"][0],
            "revision": "revision-1",
            "write_enabled": True,
            "categories": [{"category": "coding", "label": "编码/工程"}],
            "events": [
                {
                    "event_id": parameters["event_id"][0],
                    "source_fingerprint": "source-1",
                    "editable": True,
                }
            ],
        }

    def save_activity(self, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "ok": True,
            "date": payload["date"],
            "change_id": "change-1",
            "revision": "revision-2",
            "event": {"event_id": payload["event_id"]},
        }

    def undo_activity(self, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "ok": True,
            "date": payload["date"],
            "change_id": payload["change_id"],
            "revision": "revision-3",
            "event": {"event_id": payload["event_id"]},
        }

class ConflictApplication(StubApplication):
    def save_workflow(self, payload: dict[str, Any]) -> dict[str, Any]:
        raise WorkflowWriteConflict("日记版本冲突。")


class RangeAggregator:
    def get_day(self, day: date, mode: str) -> dict[str, Any]:
        multiplier = 1 if day.day == 15 else 2
        return {
            "date": day.isoformat(),
            "overview": {"combined_nonoverlap_seconds": 3600 * multiplier},
            "quality": {
                "complete": True,
                "issues": [],
                "uncategorized_seconds": 600 * multiplier,
            },
            "categories": [],
            "timeline": [
                {
                    "kind": "screen",
                    "category": "uncategorized",
                    "app": "Browser",
                    "duration_seconds": 400 * multiplier,
                },
                {
                    "kind": "screen",
                    "category": "uncategorized",
                    "app": "Terminal",
                    "duration_seconds": 200 * multiplier,
                },
            ],
            "rhythm": {
                "first_active": f"{day.isoformat()}T08:00:00+08:00",
                "last_active": f"{day.isoformat()}T18:00:00+08:00",
                "hourly_active_seconds": [0] * 24,
            },
        }


class BatchRangeAggregator(RangeAggregator):
    def __init__(self) -> None:
        self.calls: list[tuple[list[date], str]] = []

    def get_days(self, days: list[date], mode: str) -> list[dict[str, Any]]:
        self.calls.append((days, mode))
        return [super().get_day(day, mode) for day in days]


class ServerTests(unittest.TestCase):
    def test_unavailable_local_sources_are_reported_without_crashing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            raw = json.loads(EXAMPLE_CONFIG_PATH.read_text(encoding="utf-8"))
            raw["activitywatch"]["server_url"] = "http://127.0.0.1:9"
            raw["activitywatch"]["categories_file"] = str(
                EXAMPLE_CONFIG_PATH.parent / "categories.example.json"
            )
            raw["journal"] = {
                "provider": "obsidian",
                "vault": str(Path(temporary) / "missing-vault"),
                "daily_notes_dir": "Daily",
            }
            config_path = Path(temporary) / "kinawatch.json"
            config_path.write_text(json.dumps(raw), encoding="utf-8")
            application = DashboardApplication(load_settings(config_path))

            health = application.health()

        self.assertFalse(health["ok"])
        self.assertFalse(health["activitywatch_available"])
        self.assertFalse(health["journal_root_available"])
        self.assertEqual(health["journal_provider"], "obsidian")
        self.assertIn("ActivityWatch", health["activitywatch"]["api_error"])
        self.assertIn("unavailable", health["journal"]["error"])

    def test_local_server_returns_json_without_cors_and_exits_when_idle(self) -> None:
        server = IdleHTTPServer(
            ("127.0.0.1", 0),
            DashboardRequestHandler,
            StubApplication(),
            idle_timeout_seconds=0.5,
        )
        thread = threading.Thread(target=server.serve_until_idle)
        thread.start()
        try:
            host, port = server.server_address
            with urlopen(f"http://{host}:{port}/api/health", timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8"))
                headers = response.headers
            self.assertTrue(payload["ok"])
            self.assertIsNone(headers.get("Access-Control-Allow-Origin"))
            self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertEqual(headers["X-Frame-Options"], "DENY")
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
            self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
            self.assertEqual(headers["Server"], "KinaWatch")
            thread.join(timeout=1)
            self.assertFalse(thread.is_alive())
        finally:
            server.server_close()
            thread.join(timeout=1)

    def test_server_rejects_non_loopback_host_header(self) -> None:
        server = IdleHTTPServer(
            ("127.0.0.1", 0),
            DashboardRequestHandler,
            StubApplication(),
            idle_timeout_seconds=0.2,
        )
        thread = threading.Thread(target=server.serve_until_idle)
        thread.start()
        try:
            host, port = server.server_address
            request = Request(
                f"http://{host}:{port}/api/health",
                headers={"Host": f"attacker.example:{port}"},
            )
            with self.assertRaises(HTTPError) as captured:
                urlopen(request, timeout=2)
            error = captured.exception
            try:
                payload = json.loads(error.read().decode("utf-8"))
            finally:
                error.close()
            self.assertEqual(error.code, 421)
            self.assertIn("loopback", payload["error"])
        finally:
            thread.join(timeout=1)
            server.server_close()
            thread.join(timeout=1)
            server.server_close()
            thread.join(timeout=1)

    def test_write_rejects_origin_that_does_not_match_host(self) -> None:
        server = IdleHTTPServer(
            ("127.0.0.1", 0),
            DashboardRequestHandler,
            StubApplication(),
            idle_timeout_seconds=0.2,
        )
        thread = threading.Thread(target=server.serve_until_idle)
        thread.start()
        try:
            host, port = server.server_address
            request = Request(
                f"http://{host}:{port}/api/journal/workflow",
                data=b"{}",
                method="PUT",
                headers={
                    "Content-Type": "application/json",
                    "Origin": "https://attacker.example",
                },
            )
            with self.assertRaises(HTTPError) as captured:
                urlopen(request, timeout=2)
            error = captured.exception
            try:
                payload = json.loads(error.read().decode("utf-8"))
            finally:
                error.close()
            self.assertEqual(error.code, 403)
            self.assertIn("Origin", payload["error"])
        finally:
            thread.join(timeout=1)
            server.server_close()
            thread.join(timeout=1)

    def test_get_rejects_cross_origin_and_cross_site_api_requests(self) -> None:
        for headers in (
            {"Origin": "https://attacker.example"},
            {"Sec-Fetch-Site": "cross-site"},
        ):
            with self.subTest(headers=headers):
                server = IdleHTTPServer(
                    ("127.0.0.1", 0),
                    DashboardRequestHandler,
                    StubApplication(),
                    idle_timeout_seconds=0.2,
                )
                thread = threading.Thread(target=server.serve_until_idle)
                thread.start()
                try:
                    host, port = server.server_address
                    request = Request(
                        f"http://{host}:{port}/api/health",
                        headers=headers,
                    )
                    with self.assertRaises(HTTPError) as captured:
                        urlopen(request, timeout=2)
                    self.assertEqual(captured.exception.code, 403)
                    captured.exception.close()
                finally:
                    thread.join(timeout=1)
                    server.server_close()
                    thread.join(timeout=1)

    def test_runtime_settings_endpoint_exposes_backend_day_semantics(self) -> None:
        server = IdleHTTPServer(
            ("127.0.0.1", 0),
            DashboardRequestHandler,
            StubApplication(),
            idle_timeout_seconds=0.2,
        )
        thread = threading.Thread(target=server.serve_until_idle)
        thread.start()
        try:
            host, port = server.server_address
            with urlopen(
                f"http://{host}:{port}/api/settings",
                timeout=2,
            ) as response:
                payload = json.loads(response.read().decode("utf-8"))
            self.assertEqual(payload["default_mode"], "routine")
            self.assertEqual(payload["routine_day_start"], "06:00")
            self.assertEqual(payload["timezone"], "Asia/Shanghai")
            self.assertTrue(payload["activity_edit_enabled"])
        finally:
            thread.join(timeout=1)
            server.server_close()
            thread.join(timeout=1)

    def test_activity_inspect_edit_and_undo_routes_share_one_contract(self) -> None:
        server = IdleHTTPServer(
            ("127.0.0.1", 0),
            DashboardRequestHandler,
            StubApplication(),
            idle_timeout_seconds=0.4,
        )
        thread = threading.Thread(target=server.serve_until_idle)
        thread.start()
        try:
            host, port = server.server_address
            base = f"http://{host}:{port}/api/activity"
            with urlopen(
                (
                    f"{base}/inspect?date=2026-07-15&mode=routine"
                    "&bucket_id=window-test&event_id=42"
                ),
                timeout=2,
            ) as response:
                inspected = json.loads(response.read().decode("utf-8"))

            edit_request = Request(
                f"{base}/edit",
                data=json.dumps(
                    {
                        "date": "2026-07-15",
                        "event_id": "42",
                    }
                ).encode("utf-8"),
                method="PUT",
                headers={"Content-Type": "application/json"},
            )
            with urlopen(edit_request, timeout=2) as response:
                saved = json.loads(response.read().decode("utf-8"))

            undo_request = Request(
                f"{base}/undo",
                data=json.dumps(
                    {
                        "date": "2026-07-15",
                        "event_id": "42",
                        "change_id": saved["change_id"],
                    }
                ).encode("utf-8"),
                method="PUT",
                headers={"Content-Type": "application/json"},
            )
            with urlopen(undo_request, timeout=2) as response:
                undone = json.loads(response.read().decode("utf-8"))

            self.assertEqual(inspected["events"][0]["event_id"], "42")
            self.assertTrue(inspected["write_enabled"])
            self.assertEqual(saved["revision"], "revision-2")
            self.assertEqual(undone["revision"], "revision-3")
        finally:
            thread.join(timeout=1)
            server.server_close()
            thread.join(timeout=1)

    def test_no_request_idle_exit_uses_blocking_wait(self) -> None:
        server = IdleHTTPServer(
            ("127.0.0.1", 0),
            DashboardRequestHandler,
            StubApplication(),
            idle_timeout_seconds=0.1,
        )
        started = time.monotonic()
        server.serve_until_idle()
        elapsed = time.monotonic() - started
        server.server_close()
        self.assertGreaterEqual(elapsed, 0.08)
        self.assertLess(elapsed, 0.5)

    def test_speculative_connection_does_not_block_real_requests(self) -> None:
        server = IdleHTTPServer(
            ("127.0.0.1", 0),
            DashboardRequestHandler,
            StubApplication(),
            idle_timeout_seconds=0.2,
        )
        thread = threading.Thread(target=server.serve_until_idle)
        thread.start()
        speculative = socket.create_connection(server.server_address, timeout=1)
        try:
            host, port = server.server_address
            with urlopen(f"http://{host}:{port}/api/health", timeout=1) as response:
                payload = json.loads(response.read().decode("utf-8"))
            self.assertTrue(payload["ok"])
        finally:
            speculative.close()
            thread.join(timeout=1)
            self.assertFalse(thread.is_alive())
            server.server_close()

    def test_static_root_serves_index_assets_and_spa_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            static_root = Path(temporary)
            assets = static_root / "assets"
            assets.mkdir()
            (static_root / "index.html").write_text(
                "<!doctype html><title>一天一页</title>",
                encoding="utf-8",
            )
            (assets / "app.js").write_text(
                "document.body.dataset.ready = '1';",
                encoding="utf-8",
            )
            server = IdleHTTPServer(
                ("127.0.0.1", 0),
                DashboardRequestHandler,
                StubApplication(),
                idle_timeout_seconds=0.2,
                static_root=static_root,
            )
            thread = threading.Thread(target=server.serve_until_idle)
            thread.start()
            try:
                host, port = server.server_address
                with urlopen(f"http://{host}:{port}/", timeout=2) as response:
                    index = response.read().decode("utf-8")
                    index_headers = response.headers
                with urlopen(
                    f"http://{host}:{port}/assets/app.js",
                    timeout=2,
                ) as response:
                    asset = response.read().decode("utf-8")
                    asset_headers = response.headers
                with urlopen(
                    f"http://{host}:{port}/future/route",
                    timeout=2,
                ) as response:
                    fallback = response.read().decode("utf-8")

                self.assertIn("一天一页", index)
                self.assertEqual(index_headers["Cache-Control"], "no-cache")
                self.assertIsNone(index_headers.get("Access-Control-Allow-Origin"))
                self.assertIn("dataset.ready", asset)
                self.assertIn("javascript", asset_headers["Content-Type"])
                self.assertEqual(fallback, index)
                thread.join(timeout=1)
                self.assertFalse(thread.is_alive())
            finally:
                server.server_close()
                thread.join(timeout=1)

    def test_missing_dist_explains_build_command_without_breaking_api(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            static_root = Path(temporary) / "missing-dist"
            server = IdleHTTPServer(
                ("127.0.0.1", 0),
                DashboardRequestHandler,
                StubApplication(),
                idle_timeout_seconds=0.2,
                static_root=static_root,
            )
            thread = threading.Thread(target=server.serve_until_idle)
            thread.start()
            try:
                host, port = server.server_address
                with self.assertRaises(HTTPError) as captured:
                    urlopen(f"http://{host}:{port}/", timeout=2)
                error = captured.exception
                try:
                    missing_body = error.read().decode("utf-8")
                finally:
                    error.close()
                with urlopen(
                    f"http://{host}:{port}/api/health",
                    timeout=2,
                ) as response:
                    health = json.loads(response.read().decode("utf-8"))

                self.assertEqual(captured.exception.code, 503)
                self.assertIn("npm run build --prefix frontend", missing_body)
                self.assertTrue(health["ok"])
                thread.join(timeout=1)
                self.assertFalse(thread.is_alive())
            finally:
                server.server_close()
                thread.join(timeout=1)

    def test_restricted_workflow_put_accepts_json_without_cors(self) -> None:
        server = IdleHTTPServer(
            ("127.0.0.1", 0),
            DashboardRequestHandler,
            StubApplication(),
            idle_timeout_seconds=0.2,
        )
        thread = threading.Thread(target=server.serve_until_idle)
        thread.start()
        try:
            host, port = server.server_address
            body = json.dumps(
                {
                    "date": "2026-07-17",
                    "start_time": "08:59",
                    "end_time": "09:18",
                    "note": "页面内保存。",
                    "expected_fingerprint": {
                        "path": "/tmp/note.md",
                        "mtime_ns": "0",
                        "size": 0,
                    },
                },
                ensure_ascii=False,
            ).encode("utf-8")
            request = Request(
                f"http://{host}:{port}/api/journal/workflow",
                data=body,
                method="PUT",
                headers={"Content-Type": "application/json"},
            )
            with urlopen(request, timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8"))
                headers = response.headers

            self.assertTrue(payload["ok"])
            self.assertEqual(payload["workflow_note"]["note"], "页面内保存。")
            self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertIsNone(headers.get("Access-Control-Allow-Origin"))
        finally:
            thread.join(timeout=1)
            server.server_close()
            thread.join(timeout=1)

    def test_restricted_workflow_put_maps_conflict_to_409(self) -> None:
        server = IdleHTTPServer(
            ("127.0.0.1", 0),
            DashboardRequestHandler,
            ConflictApplication(),
            idle_timeout_seconds=0.2,
        )
        thread = threading.Thread(target=server.serve_until_idle)
        thread.start()
        try:
            host, port = server.server_address
            request = Request(
                f"http://{host}:{port}/api/journal/workflow",
                data=b"{}",
                method="PUT",
                headers={"Content-Type": "application/json"},
            )
            with self.assertRaises(HTTPError) as captured:
                urlopen(request, timeout=2)
            error = captured.exception
            try:
                payload = json.loads(error.read().decode("utf-8"))
            finally:
                error.close()
            self.assertEqual(error.code, 409)
            self.assertIn("冲突", payload["error"])
        finally:
            thread.join(timeout=1)
            server.server_close()
            thread.join(timeout=1)

    def test_restricted_review_put_accepts_one_named_field(self) -> None:
        server = IdleHTTPServer(
            ("127.0.0.1", 0),
            DashboardRequestHandler,
            StubApplication(),
            idle_timeout_seconds=0.2,
        )
        thread = threading.Thread(target=server.serve_until_idle)
        thread.start()
        try:
            host, port = server.server_address
            body = json.dumps(
                {
                    "date": "2026-07-17",
                    "field": "personal_summary",
                    "markdown": "页面内复盘。",
                    "expected_fingerprint": {
                        "path": "/tmp/note.md",
                        "mtime_ns": "0",
                        "size": 0,
                    },
                },
                ensure_ascii=False,
            ).encode("utf-8")
            request = Request(
                f"http://{host}:{port}/api/journal/review",
                data=body,
                method="PUT",
                headers={"Content-Type": "application/json"},
            )
            with urlopen(request, timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8"))

            self.assertTrue(payload["ok"])
            self.assertEqual(payload["review_field"]["field"], "personal_summary")
            self.assertEqual(payload["review_field"]["markdown"], "页面内复盘。")
        finally:
            thread.join(timeout=1)
            server.server_close()
            thread.join(timeout=1)

    def test_review_request_allows_eight_thousand_multibyte_characters(
        self,
    ) -> None:
        server = IdleHTTPServer(
            ("127.0.0.1", 0),
            DashboardRequestHandler,
            StubApplication(),
            idle_timeout_seconds=0.2,
        )
        thread = threading.Thread(target=server.serve_until_idle)
        thread.start()
        try:
            host, port = server.server_address
            markdown = "复" * 8000
            body = json.dumps(
                {
                    "date": "2026-07-17",
                    "field": "freeform",
                    "markdown": markdown,
                    "expected_fingerprint": {
                        "path": "/tmp/note.md",
                        "mtime_ns": "0",
                        "size": 0,
                    },
                },
                ensure_ascii=False,
            ).encode("utf-8")
            self.assertGreater(len(body), 16 * 1024)
            request = Request(
                f"http://{host}:{port}/api/journal/review",
                data=body,
                method="PUT",
                headers={"Content-Type": "application/json"},
            )
            with urlopen(request, timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8"))
            self.assertEqual(len(payload["review_field"]["markdown"]), 8000)
        finally:
            thread.join(timeout=1)
            server.server_close()
            thread.join(timeout=1)

    def test_permanent_note_get_and_put_use_one_date_independent_file(
        self,
    ) -> None:
        server = IdleHTTPServer(
            ("127.0.0.1", 0),
            DashboardRequestHandler,
            StubApplication(),
            idle_timeout_seconds=0.4,
        )
        thread = threading.Thread(target=server.serve_until_idle)
        thread.start()
        try:
            host, port = server.server_address
            endpoint = f"http://{host}:{port}/api/journal/permanent"
            with urlopen(endpoint, timeout=2) as response:
                read_payload = json.loads(response.read().decode("utf-8"))

            markdown = "# Incoming\n\n- [ ] 一周后回看"
            request = Request(
                endpoint,
                data=json.dumps(
                    {
                        "markdown": markdown,
                        "expected_fingerprint": read_payload[
                            "journal_fingerprint"
                        ],
                    },
                    ensure_ascii=False,
                ).encode("utf-8"),
                method="PUT",
                headers={"Content-Type": "application/json"},
            )
            with urlopen(request, timeout=2) as response:
                saved_payload = json.loads(response.read().decode("utf-8"))

            self.assertFalse(read_payload["exists"])
            self.assertEqual(read_payload["path"], "incoming.md")
            self.assertTrue(saved_payload["created"])
            self.assertEqual(saved_payload["markdown"], markdown)
        finally:
            thread.join(timeout=1)
            server.server_close()
            thread.join(timeout=1)

    def test_weekly_review_put_requires_an_explicit_field(self) -> None:
        server = IdleHTTPServer(
            ("127.0.0.1", 0),
            DashboardRequestHandler,
            StubApplication(),
            idle_timeout_seconds=0.2,
        )
        thread = threading.Thread(target=server.serve_until_idle)
        thread.start()
        try:
            host, port = server.server_address
            request = Request(
                f"http://{host}:{port}/api/journal/weekly",
                data=b'{"week_id":"2026-W29"}',
                method="PUT",
                headers={"Content-Type": "application/json"},
            )
            with self.assertRaises(HTTPError) as captured:
                urlopen(request, timeout=2)
            error = captured.exception
            try:
                payload = json.loads(error.read().decode("utf-8"))
            finally:
                error.close()
            self.assertEqual(error.code, 400)
            self.assertIn("field", payload["error"])
        finally:
            thread.join(timeout=1)
            server.server_close()
            thread.join(timeout=1)

    def test_weekly_review_get_returns_structured_fields_without_writing(self) -> None:
        server = IdleHTTPServer(
            ("127.0.0.1", 0),
            DashboardRequestHandler,
            StubApplication(),
            idle_timeout_seconds=0.2,
        )
        thread = threading.Thread(target=server.serve_until_idle)
        thread.start()
        try:
            host, port = server.server_address
            with urlopen(
                f"http://{host}:{port}/api/journal/weekly?week_id=2026-W29",
                timeout=2,
            ) as response:
                payload = json.loads(response.read().decode("utf-8"))

            self.assertTrue(payload["exists"])
            self.assertTrue(payload["write_enabled"])
            self.assertEqual(payload["fields"]["freeform"], "")
            self.assertEqual(payload["journal_fingerprint"]["mtime_ns"], "1")
        finally:
            thread.join(timeout=1)
            server.server_close()
            thread.join(timeout=1)

    def test_monthly_review_get_and_put_use_the_monthly_contract(self) -> None:
        server = IdleHTTPServer(
            ("127.0.0.1", 0),
            DashboardRequestHandler,
            StubApplication(),
            idle_timeout_seconds=0.4,
        )
        thread = threading.Thread(target=server.serve_until_idle)
        thread.start()
        try:
            host, port = server.server_address
            endpoint = f"http://{host}:{port}/api/journal/monthly"
            with urlopen(f"{endpoint}?month_id=2026-07", timeout=2) as response:
                read_payload = json.loads(response.read().decode("utf-8"))

            request = Request(
                endpoint,
                data=json.dumps(
                    {
                        "month_id": "2026-07",
                        "field": "freeform",
                        "markdown": "页面内月复盘。",
                        "expected_fingerprint": read_payload[
                            "journal_fingerprint"
                        ],
                    }
                ).encode("utf-8"),
                method="PUT",
                headers={"Content-Type": "application/json"},
            )
            with urlopen(request, timeout=2) as response:
                saved_payload = json.loads(response.read().decode("utf-8"))

            self.assertFalse(read_payload["exists"])
            self.assertEqual(read_payload["period_id"], "2026-07")
            self.assertEqual(
                read_payload["path"],
                "Review/Monthly/2026-07.md",
            )
            self.assertTrue(saved_payload["created"])
            self.assertEqual(
                saved_payload["review_field"]["markdown"],
                "页面内月复盘。",
            )
            self.assertNotIn("obsidian://new", saved_payload["open_url"])
        finally:
            thread.join(timeout=1)
            server.server_close()
            thread.join(timeout=1)

    def test_application_rejects_writes_when_config_flag_is_disabled(self) -> None:
        current = load_settings()
        disabled = DashboardSettings(
            config_path=current.config_path,
            raw={
                **current.raw,
                "journal_write_enabled": False,
                "activity_edit_enabled": False,
            },
        )
        application = DashboardApplication(
            disabled,
            aggregator=object(),
            journals=object(),
            activitywatch=object(),
            workflow_writer=object(),
        )

        with self.assertRaises(WorkflowWriteDisabled):
            application.save_workflow({})
        with self.assertRaises(WorkflowWriteDisabled):
            application.save_review({})
        with self.assertRaises(WorkflowWriteDisabled):
            application.save_journal_document({})
        with self.assertRaises(WorkflowWriteDisabled):
            application.save_permanent_note({})
        with self.assertRaises(WorkflowWriteDisabled):
            application.open_weekly_review({})
        with self.assertRaises(WorkflowWriteDisabled):
            application.save_weekly_review({})
        with self.assertRaises(WorkflowWriteDisabled):
            application.save_monthly_review({})
        with self.assertRaises(ActivityEditDisabled):
            application.save_activity({})
        with self.assertRaises(ActivityEditDisabled):
            application.undo_activity({})

    def test_range_returns_cached_rhythm_and_optional_app_summaries(self) -> None:
        settings = load_settings()
        aggregator = BatchRangeAggregator()
        application = DashboardApplication(
            settings,
            aggregator=aggregator,
            journals=object(),
            activitywatch=object(),
        )

        response = application.date_range(
            {
                "start": ["2026-07-15"],
                "end": ["2026-07-16"],
                "mode": ["routine"],
                "include": ["top_apps,uncategorized_apps,timeline"],
            }
        )

        self.assertEqual(len(response["days"]), 2)
        self.assertEqual(response["timezone"], settings.timezone_name())
        self.assertEqual(len(response["days"][0]["timeline"]), 2)
        self.assertTrue(
            all(
                block["kind"] == "screen"
                for block in response["days"][0]["timeline"]
            )
        )
        self.assertEqual(
            aggregator.calls,
            [([date(2026, 7, 15), date(2026, 7, 16)], "routine")],
        )
        self.assertEqual(len(response["days"][0]["rhythm"]["hourly_active_seconds"]), 24)
        self.assertEqual(
            response["top_apps"],
            [
                {
                    "app": "Browser",
                    "duration_seconds": 1200.0,
                    "category": "uncategorized",
                },
                {
                    "app": "Terminal",
                    "duration_seconds": 600.0,
                    "category": "uncategorized",
                },
            ],
        )
        self.assertEqual(
            response["uncategorized_apps"],
            [
                {"app": "Browser", "duration_seconds": 1200.0},
                {"app": "Terminal", "duration_seconds": 600.0},
            ],
        )

    def test_check_mode_returns_failure_when_health_is_not_ok(self) -> None:
        application = SimpleNamespace(health=lambda: {"ok": False})
        with (
            patch("backend.server.load_settings", return_value=object()),
            patch(
                "backend.server.DashboardApplication",
                return_value=application,
            ),
            patch("sys.argv", ["kinawatch", "--check"]),
        ):
            self.assertEqual(main(), 1)


if __name__ == "__main__":
    unittest.main()
