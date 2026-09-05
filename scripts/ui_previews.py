"""Serve one UI build on five loopback ports without a Node runtime.

The proxy preserves the browser's Host and Origin for the existing backend
authority gate. PUT requests are never retried; all journal and activity write
validation remains the backend's responsibility.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import re
import selectors
import signal
import socket
import threading
from dataclasses import dataclass
from http.client import HTTPConnection, HTTPException
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from typing import Sequence
from urllib.parse import SplitResult, unquote, urlsplit


DEFAULT_PORTS = (8811, 8812, 8813, 8814, 8815)
DEFAULT_BACKEND = "http://127.0.0.1:8765"
MAX_BODY_BYTES = 256 * 1024
MAX_DOCUMENT_BODY_BYTES = 16 * 1024 * 1024
MAX_RESPONSE_BYTES = 32 * 1024 * 1024
REQUEST_TIMEOUT = 10.0
UPSTREAM_TIMEOUT = 30.0
GET_ENDPOINTS = frozenset(
    {
        "/api/health", "/api/settings", "/api/day", "/api/range",
        "/api/activity/inspect", "/api/journal/permanent",
        "/api/journal/weekly", "/api/journal/monthly",
        "/api/journal/document", "/api/journal/beliefs",
    }
)
PUT_ENDPOINTS = frozenset(
    {
        "/api/journal/workflow", "/api/journal/review",
        "/api/journal/permanent", "/api/journal/weekly",
        "/api/journal/monthly", "/api/activity/edit", "/api/activity/undo",
        "/api/journal/document", "/api/journal/beliefs",
    }
)
ASSET_SUFFIXES = frozenset(
    {
        ".js", ".mjs", ".css", ".svg", ".png", ".jpg", ".jpeg",
        ".gif", ".webp", ".avif", ".ico", ".woff", ".woff2",
        ".ttf", ".otf", ".wasm",
    }
)
CONTENT_SECURITY_POLICY = "; ".join(
    (
        "default-src 'self'", "base-uri 'none'", "connect-src 'self'",
        "font-src 'self'", "form-action 'self'", "frame-ancestors 'none'",
        "img-src 'self' data:", "object-src 'none'", "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
    )
)


def loopback_authority(value: str) -> tuple[str, int] | None:
    if not value or any(char.isspace() for char in value) or "\\" in value:
        return None
    try:
        parsed = urlsplit("//" + value)
        if (
            parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
            or parsed.username is not None or parsed.password is not None
            or parsed.path or parsed.query or parsed.fragment
        ):
            return None
        port = parsed.port if parsed.port is not None else 80
        return (parsed.hostname, port) if 1 <= port <= 65535 else None
    except ValueError:
        return None


@dataclass(frozen=True)
class BackendTarget:
    host: str
    port: int

    @classmethod
    def from_url(cls, value: str) -> BackendTarget:
        try:
            parsed = urlsplit(value)
            authority = loopback_authority(parsed.netloc)
            if (
                parsed.scheme != "http" or authority is None
                or parsed.path not in {"", "/"} or parsed.query or parsed.fragment
                or any(char.isspace() for char in value)
            ):
                raise ValueError
        except ValueError as exc:
            raise ValueError("backend must be an HTTP loopback origin") from exc
        host, port = authority
        # Do not resolve an ambient DNS/hosts-file mapping for localhost.
        return cls("127.0.0.1" if host == "localhost" else host, port)


class PreviewHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, port: int, dist: Path, backend: BackendTarget):
        self.dist = dist
        self.backend = backend
        super().__init__(("127.0.0.1", port), PreviewHandler)
        self.timeout = 0


class PreviewHandler(BaseHTTPRequestHandler):
    server: PreviewHTTPServer
    protocol_version = "HTTP/1.1"

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(REQUEST_TIMEOUT)

    def version_string(self) -> str:
        return "KinaBoard-Preview"

    def log_message(self, format: str, *args: object) -> None:
        return

    def end_headers(self) -> None:
        self.send_header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), geolocation=(), microphone=()")
        self.send_header("Connection", "close")
        self.close_connection = True
        super().end_headers()

    def handle_expect_100(self) -> bool:
        self._error(417, "Expect is not supported")
        return False

    def _respond(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if status == 405:
            self.send_header("Allow", "GET, PUT")
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _error(self, status: int, message: str) -> None:
        self._respond(
            status, json.dumps({"ok": False, "error": message}).encode(),
            "application/json; charset=utf-8",
        )

    def _validate_authority(self) -> bool:
        hosts = self.headers.get_all("Host", [])
        origins = self.headers.get_all("Origin", [])
        fetch_sites = self.headers.get_all("Sec-Fetch-Site", [])
        if len(hosts) != 1 or len(origins) > 1 or len(fetch_sites) > 1:
            self._error(400, "exactly one Host and at most one Origin are required")
            return False
        authority = loopback_authority(hosts[0])
        if (
            authority is None or authority[0] not in {"127.0.0.1", "localhost"}
            or authority[1] != self.server.server_port
        ):
            self._error(421, "Host must match this loopback preview port")
            return False
        if fetch_sites and fetch_sites[0].strip().casefold() == "cross-site":
            self._error(403, "cross-site requests are not allowed")
            return False
        if not origins:
            if self.command == "PUT":
                self._error(403, "PUT requires the matching preview Origin")
                return False
            return True
        try:
            origin = urlsplit(origins[0])
            valid = (
                origin.scheme == "http" and not origin.path
                and not origin.query and not origin.fragment
                and not any(char.isspace() for char in origins[0])
                and loopback_authority(origin.netloc) == authority
            )
        except ValueError:
            valid = False
        if not valid:
            self._error(403, "Origin must match this preview Host")
        return valid

    def _request_target(self) -> SplitResult | None:
        try:
            parsed = urlsplit(self.path)
            if (
                not self.path.startswith("/") or self.path.startswith("//")
                or parsed.scheme or parsed.netloc or parsed.fragment
                or "\\" in self.path
            ):
                raise ValueError
            return parsed
        except ValueError:
            self._error(400, "request target must be a local path")
            return None

    def _body_length(self) -> int | None:
        if self.headers.get_all("Transfer-Encoding"):
            self._error(400, "Transfer-Encoding is not supported")
            return None
        if self.headers.get_all("Expect"):
            self._error(417, "Expect is not supported")
            return None
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]{1,10}", lengths[0])):
            self._error(400, "invalid Content-Length")
            return None
        length = int(lengths[0]) if lengths else 0
        limit = MAX_DOCUMENT_BODY_BYTES if urlsplit(self.path).path in {"/api/journal/document", "/api/journal/beliefs"} else MAX_BODY_BYTES
        if length > limit:
            self._error(413, "request body is too large")
            return None
        if self.command == "PUT" and not lengths:
            self._error(411, "PUT requires Content-Length")
            return None
        if (self.command == "PUT" and length == 0) or (self.command == "GET" and length):
            self._error(400, "unexpected request body length")
            return None
        return length

    def do_GET(self) -> None:
        if not self._validate_authority():
            return
        parsed = self._request_target()
        if parsed is None or self._body_length() is None:
            return
        if parsed.path in GET_ENDPOINTS:
            self._proxy(None)
        elif parsed.path == "/api" or parsed.path.startswith("/api/"):
            self._error(404, "API endpoint is not supported by this preview")
        else:
            self._serve_static(parsed.path)

    def do_PUT(self) -> None:
        if not self._validate_authority():
            return
        parsed = self._request_target()
        if parsed is None:
            return
        length = self._body_length()
        if length is None:
            return
        if parsed.path not in PUT_ENDPOINTS:
            self._error(404, "API endpoint is not supported by this preview")
            return
        if len(self.headers.get_all("Content-Type", [])) != 1 or self.headers.get_content_type() != "application/json":
            self._error(415, "PUT requires application/json")
            return
        try:
            body = self.rfile.read(length)
        except (TimeoutError, OSError):
            self._error(408, "request body timed out")
            return
        if len(body) != length:
            self._error(400, "request body is shorter than Content-Length")
            return
        self._proxy(body)

    def _unsupported_method(self) -> None:
        self._error(405, "only GET and supported PUT endpoints are available")

    do_POST = _unsupported_method
    do_PATCH = _unsupported_method
    do_DELETE = _unsupported_method
    do_HEAD = _unsupported_method
    do_OPTIONS = _unsupported_method
    do_TRACE = _unsupported_method
    do_CONNECT = _unsupported_method

    def _proxy(self, body: bytes | None) -> None:
        # An explicit, small header set excludes cookies, credentials, forwarding
        # headers and hop-by-hop headers. Host/Origin must NOT become backend:8765.
        headers = {"Host": self.headers["Host"], "Accept": "application/json"}
        for name in ("Origin", "Sec-Fetch-Site"):
            if name in self.headers:
                headers[name] = self.headers[name]
        if body is not None:
            headers["Content-Type"] = self.headers["Content-Type"]
            headers["Content-Length"] = str(len(body))
        connection = HTTPConnection(
            self.server.backend.host, self.server.backend.port, timeout=UPSTREAM_TIMEOUT,
        )
        try:
            connection.request(self.command, self.path, body=body, headers=headers)
            response = connection.getresponse()
            status = response.status
            if 300 <= status < 400:
                self._error(502, f"backend redirect rejected ({status})")
                return
            payload = response.read(MAX_RESPONSE_BYTES + 1)
            if len(payload) > MAX_RESPONSE_BYTES:
                self._error(502, "backend response exceeds the 32 MiB preview limit")
                return
            if response.length not in {None, 0}:
                self._error(502, "KinaWatch backend response was interrupted")
                return
            content_type = response.getheader("Content-Type", "application/json; charset=utf-8")
        except (OSError, HTTPException):
            self._error(502, "KinaWatch backend is unavailable or its response was interrupted")
            return
        finally:
            connection.close()
        self._respond(status, payload, content_type)

    def _serve_static(self, request_path: str) -> None:
        try:
            decoded = unquote(request_path, errors="strict")
            if "\\" in decoded or any(ord(char) < 32 for char in decoded):
                raise ValueError
            parts = decoded.lstrip("/").split("/")
            if any(part.startswith(".") for part in parts):
                raise ValueError
            relative = PurePosixPath(decoded.lstrip("/"))
            if decoded in {"/", "/index.html"}:
                relative = PurePosixPath("index.html")
            elif relative.parts and relative.parts[0] == "assets":
                if relative.suffix.casefold() not in ASSET_SUFFIXES:
                    raise ValueError
            elif relative.suffix:
                # A build exposes only index.html and known web assets. Never
                # expose incidental config, fixture, source or log files.
                raise ValueError
            else:
                relative = PurePosixPath("index.html")
            target = self.server.dist.joinpath(*relative.parts).resolve(strict=True)
            target.relative_to(self.server.dist)
            if not target.is_file():
                raise ValueError
            body = target.read_bytes()
        except (OSError, ValueError, UnicodeDecodeError):
            self._error(404, "static resource not found")
            return
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {"application/javascript", "image/svg+xml"}:
            content_type += "; charset=utf-8"
        self._respond(200, body, content_type)


class PreviewServers:
    """One blocking selector services every listener; idle does not poll."""

    def __init__(self, dist: Path, ports: Sequence[int] = DEFAULT_PORTS, backend: str = DEFAULT_BACKEND):
        self.dist = Path(dist).expanduser().resolve(strict=True)
        index = (self.dist / "index.html").resolve(strict=True)
        if not self.dist.is_dir() or not index.is_file() or not index.is_relative_to(self.dist):
            raise ValueError("dist must contain its own built index.html")
        if not ports or any(port < 0 or port > 65535 for port in ports):
            raise ValueError("ports must be between 1 and 65535 (0 selects a test port)")
        explicit_ports = [port for port in ports if port]
        if len(set(explicit_ports)) != len(explicit_ports):
            raise ValueError("preview ports must be distinct")
        target = BackendTarget.from_url(backend)
        self.servers: list[PreviewHTTPServer] = []
        self._selector = selectors.DefaultSelector()
        self._stop = threading.Event()
        self._closed = False
        self._reader, self._writer = socket.socketpair()
        self._writer.setblocking(False)
        try:
            self._selector.register(self._reader, selectors.EVENT_READ)
            for port in ports:
                server = PreviewHTTPServer(port, self.dist, target)
                self.servers.append(server)
                self._selector.register(server, selectors.EVENT_READ, server)
        except BaseException:
            self.close()
            raise

    @property
    def ports(self) -> tuple[int, ...]:
        return tuple(server.server_port for server in self.servers)

    def serve_forever(self) -> None:
        while not self._stop.is_set():
            for key, _ in self._selector.select():
                if self._stop.is_set():
                    break
                if key.data is not None:
                    key.data.handle_request()

    def shutdown(self) -> None:
        self._stop.set()
        try:
            self._writer.send(b"\0")
        except OSError:
            pass

    def close(self) -> None:
        if self._closed:
            return
        self.shutdown()
        self._closed = True
        for server in self.servers:
            server.server_close()
        self._selector.close()
        self._reader.close()
        self._writer.close()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, required=True, help="built directory containing index.html and assets/")
    parser.add_argument("--ports", type=int, nargs="+", default=DEFAULT_PORTS)
    parser.add_argument("--backend", default=DEFAULT_BACKEND)
    args = parser.parse_args(argv)
    try:
        previews = PreviewServers(args.dist, args.ports, args.backend)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    previous_handlers = {}
    try:
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous_handlers[signum] = signal.signal(signum, lambda *_: previews.shutdown())
        print("KinaBoard UI previews: " + " ".join(f"http://127.0.0.1:{port}/" for port in previews.ports), flush=True)
        previews.serve_forever()
    finally:
        previews.close()
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
