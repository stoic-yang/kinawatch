from __future__ import annotations

import json
import socket
import tempfile
import threading
import time
import unittest
from datetime import date
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from backend.config import DashboardSettings, load_settings
from backend.paths import EXAMPLE_CONFIG_PATH
from backend.server import (
    DashboardApplication,
    DashboardRequestHandler,
    IdleHTTPServer,
)
from backend.workflow_writer import WorkflowWriteConflict, WorkflowWriteDisabled


class StubApplication:
    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "version": 1,
            "activitywatch_available": True,
            "journal_root_available": True,
        }

    def day(self, parameters: dict[str, list[str]]) -> dict[str, Any]:
        return {"date": parameters["date"][0], "cache": {"hit": False}}

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

    def open_weekly_review(self, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "ok": True,
            "week_id": payload["week_id"],
            "created": False,
            "obsidian_url": (
                f"obsidian://open?vault=Studio&file=Review/Weekly/{payload['week_id']}"
            ),
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
            idle_timeout_seconds=0.2,
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
            thread.join(timeout=1)
            self.assertFalse(thread.is_alive())
        finally:
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

    def test_weekly_review_put_returns_one_stable_open_uri(self) -> None:
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
            with urlopen(request, timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8"))

            self.assertFalse(payload["created"])
            self.assertEqual(
                payload["obsidian_url"],
                "obsidian://open?vault=Studio&file=Review/Weekly/2026-W29",
            )
            self.assertNotIn("obsidian://new", payload["obsidian_url"])
        finally:
            thread.join(timeout=1)
            server.server_close()
            thread.join(timeout=1)

    def test_application_rejects_writes_when_config_flag_is_disabled(self) -> None:
        current = load_settings()
        disabled = DashboardSettings(
            config_path=current.config_path,
            raw={**current.raw, "journal_write_enabled": False},
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
            application.open_weekly_review({})

    def test_range_returns_cached_rhythm_and_optional_uncategorized_top_apps(self) -> None:
        settings = load_settings()
        application = DashboardApplication(
            settings,
            aggregator=RangeAggregator(),
            journals=object(),
            activitywatch=object(),
        )

        response = application.date_range(
            {
                "start": ["2026-07-15"],
                "end": ["2026-07-16"],
                "mode": ["routine"],
                "include": ["uncategorized_apps"],
            }
        )

        self.assertEqual(len(response["days"]), 2)
        self.assertEqual(len(response["days"][0]["rhythm"]["hourly_active_seconds"]), 24)
        self.assertEqual(
            response["uncategorized_apps"],
            [
                {"app": "Browser", "duration_seconds": 1200.0},
                {"app": "Terminal", "duration_seconds": 600.0},
            ],
        )


if __name__ == "__main__":
    unittest.main()
