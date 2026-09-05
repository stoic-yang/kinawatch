from __future__ import annotations

import json
import os
import re
import selectors
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from scripts.ui_previews import BackendTarget, DEFAULT_PORTS, MAX_BODY_BYTES, MAX_DOCUMENT_BODY_BYTES, PreviewServers


class FakeBackendHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        self.respond()

    def do_PUT(self):
        self.respond()

    def respond(self):
        length = int(self.headers.get("Content-Length", "0"))
        record = {
            "method": self.command,
            "path": self.path,
            "host": self.headers.get("Host"),
            "origin": self.headers.get("Origin"),
            "fetch_site": self.headers.get("Sec-Fetch-Site"),
            "body": self.rfile.read(length).decode(),
        }
        self.server.records.append(record)
        status = 302 if "redirect=1" in self.path else 409 if "conflict=1" in self.path else 200
        payload = json.dumps(record).encode()
        self.send_response(status)
        if status == 302:
            self.send_header("Location", "http://example.invalid/should-never-be-followed")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload) + (10 if "truncate=1" in self.path else 0)))
        self.end_headers()
        self.wfile.write(payload)


class PreviewHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.dist = self.root / "dist"
        self.dist.mkdir()
        (self.dist / "assets").mkdir()
        self.index = b"<!doctype html><title>Synthetic UI preview</title>"
        (self.dist / "index.html").write_bytes(self.index)
        (self.dist / "assets" / "app.js").write_text("export const preview = true;\n")
        (self.root / "private.js").write_text("OUTSIDE_DIST_SECRET")
        (self.dist / "assets" / "escape.js").symlink_to(self.root / "private.js")
        (self.dist / "fixtures.json").write_text("FIXTURE_SECRET")
        (self.dist / "assets" / "debug.log").write_text("LOG_SECRET")
        self.backend = ThreadingHTTPServer(("127.0.0.1", 0), FakeBackendHandler)
        self.backend.daemon_threads = True
        self.backend.records = []
        self.backend_thread = threading.Thread(target=self.backend.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.backend_thread.start()
        self.backend_url = f"http://127.0.0.1:{self.backend.server_port}"
        self.previews = PreviewServers(self.dist, (0, 0), self.backend_url)
        self.thread = threading.Thread(target=self.previews.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.previews.ports[0]
        self.host = f"127.0.0.1:{self.port}"
        self.origin = f"http://{self.host}"

    def tearDown(self):
        self.previews.shutdown()
        self.thread.join(timeout=2)
        self.previews.close()
        if self.backend_thread.is_alive():
            self.backend.shutdown()
            self.backend_thread.join(timeout=2)
        self.backend.server_close()
        self.temp.cleanup()
        self.assertFalse(self.thread.is_alive())

    def request(self, method, path, headers=(), body=None, port=None):
        port = port or self.port
        connection = HTTPConnection("127.0.0.1", port, timeout=2)
        try:
            connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
            if not any(name.casefold() == "host" for name, _ in headers):
                connection.putheader("Host", f"127.0.0.1:{port}")
            for name, value in headers:
                connection.putheader(name, value)
            connection.endheaders(body)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def put_headers(self, body=b"{}"):
        return [("Origin", self.origin), ("Content-Type", "application/json"), ("Content-Length", str(len(body)))]

    def test_document_proxy_accepts_long_notes_and_preserves_conflicts(self):
        self.assertEqual(self.request("GET", "/api/journal/document?date=2026-09-03")[0], 200)
        body = json.dumps({"date": "2026-09-03", "markdown": "long note\n" * 40000}).encode()
        self.assertGreater(len(body), MAX_BODY_BYTES)
        status, _, response = self.request("PUT", "/api/journal/document?conflict=1", self.put_headers(body), body)
        self.assertEqual(status, 409)
        self.assertEqual(json.loads(response)["body"], body.decode())
        self.assertEqual(self.request("PUT", "/api/journal/document", [("Origin", self.origin), ("Content-Length", str(MAX_DOCUMENT_BODY_BYTES + 1))], b"{}")[0], 413)

    def test_beliefs_proxy_preserves_long_body_and_conflicts(self):
        self.assertEqual(self.request("GET", "/api/journal/beliefs")[0], 200)
        body = json.dumps({"markdown": "synthetic belief\n" * 40000}).encode()
        self.assertGreater(len(body), MAX_BODY_BYTES)
        status, _, response = self.request("PUT", "/api/journal/beliefs?conflict=1", self.put_headers(body), body)
        self.assertEqual(status, 409)
        self.assertEqual(json.loads(response)["body"], body.decode())

    def test_same_build_spa_fallback_and_static_confinement(self):
        for port in self.previews.ports:
            status, headers, body = self.request("GET", "/", port=port)
            self.assertEqual((status, body), (200, self.index))
            self.assertEqual(headers["Cross-Origin-Resource-Policy"], "same-origin")
            self.assertEqual(headers["Cross-Origin-Opener-Policy"], "same-origin")
            self.assertEqual(headers["X-Frame-Options"], "DENY")
            self.assertIn("connect-src 'self'", headers["Content-Security-Policy"])
            self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertEqual(self.request("GET", "/some/client/route")[2], self.index)
        self.assertIn(b"preview = true", self.request("GET", "/assets/app.js?v=1")[2])
        for path in (
            "/assets/missing.js", "/assets/escape.js", "/../private.js",
            "/assets/%2e%2e/%2e%2e/private.js", "/fixtures.json",
            "/assets/debug.log", "/.git/config", "/assets/%00.js",
        ):
            with self.subTest(path=path):
                status, _, body = self.request("GET", path)
                self.assertEqual(status, 404)
                self.assertNotIn(b"SECRET", body)
        self.assertEqual(self.backend.records, [])

    def test_get_forwards_host_origin_query_without_environment_proxy(self):
        with patch.dict(os.environ, {"HTTP_PROXY": "http://example.invalid:9", "http_proxy": "http://example.invalid:9", "NO_PROXY": "", "no_proxy": ""}):
            status, _, body = self.request("GET", "/api/day?date=2026-08-31&value=a%26b", [("Origin", self.origin), ("Sec-Fetch-Site", "same-origin")])
        record = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(record["host"], self.host)
        self.assertEqual(record["origin"], self.origin)
        self.assertEqual(record["fetch_site"], "same-origin")
        self.assertEqual(record["path"], "/api/day?date=2026-08-31&value=a%26b")

    def test_put_preserves_body_and_upstream_conflict(self):
        body = b'{"field":"freeform","markdown":"synthetic","fingerprint":"fixture-1"}'
        status, _, result = self.request("PUT", "/api/journal/review?conflict=1", self.put_headers(body), body)
        self.assertEqual(status, 409)
        record = json.loads(result)
        self.assertEqual(record["method"], "PUT")
        self.assertEqual(record["host"], self.host)
        self.assertEqual(record["origin"], self.origin)
        self.assertEqual(record["body"], body.decode())
        self.assertEqual(len(self.backend.records), 1)

    def test_authority_and_cross_origin_write_rejection(self):
        cases = [
            ([("Host", "attacker.example:8811")], 421),
            ([("Host", "127.0.0.1:1")], 421),
            ([("Host", self.host), ("Host", self.host)], 400),
            ([("Origin", "http://attacker.example")], 403),
            ([("Origin", f"http://127.0.0.1:{self.previews.ports[1]}")], 403),
            ([("Origin", "null")], 403),
            ([("Origin", self.origin + "/")], 403),
            ([("Origin", self.origin.replace("http:", "https:"))], 403),
            ([("Origin", self.origin), ("Origin", self.origin)], 400),
            ([("Origin", self.origin), ("Sec-Fetch-Site", "cross-site")], 403),
            ([], 403),
        ]
        for extra, expected in cases:
            with self.subTest(headers=extra):
                headers = extra + [("Content-Type", "application/json"), ("Content-Length", "2")]
                self.assertEqual(self.request("PUT", "/api/journal/review", headers, b"{}")[0], expected)
        self.assertEqual(self.request("GET", "/api/day", [("Sec-Fetch-Site", "cross-site")])[0], 403)
        self.assertEqual(self.backend.records, [])

    def test_malformed_and_oversized_bodies_are_not_forwarded(self):
        base = [("Origin", self.origin), ("Content-Type", "application/json")]
        for extra, expected in [
            ([], 411),
            ([("Content-Length", "-1")], 400),
            ([("Content-Length", "not-a-number")], 400),
            ([("Content-Length", "0")], 400),
            ([("Content-Length", "2"), ("Content-Length", "2")], 400),
            ([("Content-Length", str(MAX_BODY_BYTES + 1))], 413),
            ([("Content-Length", "2"), ("Transfer-Encoding", "chunked")], 400),
            ([("Content-Length", "2"), ("Expect", "100-continue")], 417),
        ]:
            with self.subTest(headers=extra):
                self.assertEqual(self.request("PUT", "/api/journal/review", base + extra, b"{}")[0], expected)
        self.assertEqual(self.request("PUT", "/api/journal/review", [("Origin", self.origin), ("Content-Length", "2"), ("Content-Type", "text/plain")], b"{}")[0], 415)
        self.assertEqual(self.request("GET", "/api/day", [("Content-Length", "2")], b"{}")[0], 400)
        self.assertEqual(self.backend.records, [])

    def test_unsupported_methods_and_api_paths(self):
        for method in ("POST", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT"):
            with self.subTest(method=method):
                self.assertEqual(self.request(method, "/api/journal/review")[0], 405)
        self.assertEqual(self.request("GET", "/api/not-supported")[0], 404)
        self.assertEqual(self.request("PUT", "/api/not-supported", self.put_headers(), b"{}")[0], 404)
        self.assertEqual(self.backend.records, [])

    def test_backend_redirect_is_blocked_and_offline_is_502(self):
        status, headers, body = self.request("GET", "/api/health?redirect=1")
        self.assertEqual(status, 502)
        self.assertNotIn("Location", headers)
        self.assertIn("redirect rejected", json.loads(body)["error"])
        self.assertEqual(len(self.backend.records), 1)
        status, _, body = self.request("GET", "/api/health?truncate=1")
        self.assertEqual(status, 502)
        self.assertIn("interrupted", json.loads(body)["error"])
        self.backend.shutdown()
        self.backend_thread.join(timeout=2)
        self.backend.server_close()
        status, _, body = self.request("GET", "/api/health")
        self.assertEqual(status, 502)
        self.assertIn("unavailable", json.loads(body)["error"])

    def test_cli_sigterm_closes_all_listeners(self):
        process = subprocess.Popen(
            [sys.executable, "-m", "scripts.ui_previews", "--dist", str(self.dist), "--ports", "0", "0", "--backend", self.backend_url],
            cwd=Path(__file__).resolve().parents[1], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                self.assertTrue(selector.select(timeout=3), "preview CLI did not report its listeners")
            line = process.stdout.readline()
            ports = [int(value) for value in re.findall(r"127\.0\.0\.1:(\d+)", line)]
            self.assertEqual(len(ports), 2, line)
            for port in ports:
                self.assertEqual(self.request("GET", "/", port=port)[0], 200)
            process.terminate()
            _, stderr = process.communicate(timeout=3)
            self.assertEqual(process.returncode, 0, stderr)
            for port in ports:
                with self.assertRaises(OSError):
                    socket.create_connection(("127.0.0.1", port), timeout=0.2)
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=3)


class PreviewConfigurationTests(unittest.TestCase):
    def test_backend_is_an_explicit_loopback_http_origin(self):
        self.assertEqual(DEFAULT_PORTS, (8811, 8812, 8813, 8814, 8815))
        self.assertEqual(BackendTarget.from_url("http://localhost:8765"), BackendTarget("127.0.0.1", 8765))
        self.assertEqual(BackendTarget.from_url("http://[::1]:8765"), BackendTarget("::1", 8765))
        for value in (
            "https://127.0.0.1:8765", "http://example.com:8765", "http://localhost.evil:8765",
            "http://user@127.0.0.1:8765", "http://127.0.0.1:8765/api", "http://127.0.0.1:0",
            "http://127.0.0.1:8765/?url=http://example.com", "http://127.0.0.1:8765/#fragment",
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                BackendTarget.from_url(value)


if __name__ == "__main__":
    unittest.main()
