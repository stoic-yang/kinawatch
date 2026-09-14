"""Local service profiles, folder selection and the existing MCP center adapter."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys
import threading
import time

from . import mcp_runtime as runtime
from .paths import default_data_dir

SERVICE_ID = re.compile(r"(?:[a-f0-9]{32}|legacy-[a-z0-9-]{1,48})\Z")


class MCPServiceError(ValueError):
    pass


class MCPServiceBusy(MCPServiceError):
    pass


class MCPServiceCenter:
    def __init__(self, config: dict):
        if not isinstance(config, dict):
            raise MCPServiceError("MCP 服务配置格式不正确")
        self.enabled = config.get("enabled") is True
        self.root = Path(config.get("store_dir") or default_data_dir() / "mcp-services").expanduser().resolve()
        self.python = str(Path(config["runtime_python"]).expanduser().absolute()) if config.get("runtime_python") else ""
        self.cloudflared = str(Path(config["cloudflared"]).expanduser().absolute()) if config.get("cloudflared") else ""
        roots = config.get("folder_roots") or [str(Path.home())]
        self.roots = [Path(root).expanduser().resolve() for root in roots]
        self.legacy = {}
        for item in config.get("legacy_services", []):
            key = "legacy-" + item["id"]
            if not SERVICE_ID.fullmatch(key):
                raise MCPServiceError("旧服务标识无效")
            self.legacy[key] = {"directory": Path(item["directory"]).expanduser().resolve(), "name": item["name"]}
        self.lock = threading.Lock()
        self.operations = {}
        self.controllers = {}
        self.cache = None
        self.cached_at = 0
        self.dependency_cache = None

    def require_enabled(self):
        if not self.enabled:
            raise PermissionError("请先在本机配置中启用 MCP 服务管理")
        if os.name != "posix":
            raise MCPServiceError("MCP 服务管理目前支持 macOS 和 Linux")

    def dependencies(self):
        if self.dependency_cache is not None:
            return self.dependency_cache
        if not self.python or not self.cloudflared or not all(os.path.isfile(p) and os.access(p, os.X_OK) for p in (self.python, self.cloudflared)):
            return {"ready": False, "error": "尚未配置 coding-tools-mcp 的 Python 环境和 cloudflared"}
        try:
            result = subprocess.run([self.python, "-I", "-c", "import importlib.metadata; print(importlib.metadata.version('coding-tools-mcp'))"],
                                    capture_output=True, text=True, timeout=5)
            if result.returncode:
                raise ValueError()
            self.dependency_cache = {"ready": True, "version": result.stdout.strip()[:40], "error": ""}
        except (OSError, ValueError, subprocess.TimeoutExpired):
            return {"ready": False, "error": "配置的 Python 环境无法加载 coding-tools-mcp"}
        return self.dependency_cache

    def protected_roots(self):
        paths = [self.root]
        paths += [item["directory"] for item in self.legacy.values()]
        if self.python:
            paths.append(Path(self.python).resolve().parent)
        return paths

    def folder(self, raw: str, *, select=False) -> Path:
        self.require_enabled()
        if not isinstance(raw, str) or not raw.strip() or len(raw) > 4096 or any(ord(c) < 32 for c in raw):
            raise MCPServiceError("请选择有效的文件夹")
        try:
            path = Path(raw).expanduser().resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise MCPServiceError("文件夹不存在或无法读取") from exc
        if not path.is_dir() or not any(path.is_relative_to(root) for root in self.roots):
            raise MCPServiceError("请选择允许浏览位置中的文件夹")
        if select and any(path.is_relative_to(root) or root.is_relative_to(path) for root in self.protected_roots()):
            raise MCPServiceError("这个位置包含服务程序或凭据，请选择具体的工作文件夹")
        if not os.access(path, os.R_OK | os.X_OK):
            raise MCPServiceError("当前用户无法读取此文件夹")
        return path

    def browse(self, raw: str = "") -> dict:
        self.require_enabled()
        path = self.folder(raw or str(self.roots[0]))
        folders, truncated = [], False
        try:
            with os.scandir(path) as entries:
                for index, item in enumerate(entries):
                    if index >= 5000:
                        truncated = True; break
                    if item.name.startswith(".") or not item.is_dir():
                        continue
                    try:
                        resolved = self.folder(item.path)
                    except (OSError, MCPServiceError):
                        continue
                    folders.append({"name": item.name, "path": str(resolved)})
        except OSError as exc:
            raise MCPServiceError("无法列出这个文件夹") from exc
        folders.sort(key=lambda item: item["name"].casefold())
        reason = ""
        try:
            self.folder(str(path), select=True)
        except MCPServiceError as exc:
            reason = str(exc)
        parent = path.parent if any(path.parent.is_relative_to(root) for root in self.roots) else None
        return {"path": str(path), "parent": str(parent) if parent else None, "folders": folders[:300],
                "truncated": truncated or len(folders) > 300, "selectable": not reason, "reason": reason,
                "roots": [{"name": p.name or str(p), "path": str(p)} for p in self.roots]}

    def profiles(self):
        return sorted((self.root / "services").glob("*/config.json"))[:32] if (self.root / "services").exists() else []

    def resolve(self, key: str):
        self.require_enabled()
        if not isinstance(key, str) or not SERVICE_ID.fullmatch(key):
            raise MCPServiceError("服务不存在")
        if key in self.legacy:
            return self.legacy[key]["directory"], True
        directory = self.root / "services" / key
        if not (directory / "config.json").is_file() or directory.resolve() != directory:
            raise MCPServiceError("服务不存在")
        return directory, False

    def _legacy_running(self, directory: Path, role: str, config: dict) -> bool:
        try:
            pid = int((directory / (role + ".pid")).read_text())
            result = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True, timeout=2)
            command = result.stdout.strip()
            if role == "server":
                return "coding-tools-mcp" in command and f"--workspace {config['workspace']} " in command and f"--port {config['port']} " in command
            return "cloudflared tunnel" in command and f"http://127.0.0.1:{config['port']}" in command
        except (OSError, ValueError, subprocess.TimeoutExpired):
            return False

    def snapshot(self, key: str) -> dict:
        directory, legacy = self.resolve(key)
        config = runtime.read_json(directory / ("settings.json" if legacy else "config.json"))
        if legacy:
            running = self._legacy_running(directory, "server", config)
            tunnel = self._legacy_running(directory, "tunnel", config)
            origin = runtime.endpoint(directory / "logs/tunnel.stderr.log") if tunnel else None
            operation = self.operations.get(key, {})
            state = {"url": origin + "/mcp" if origin else None, **operation}
            name = self.legacy[key]["name"]
        else:
            state = runtime.read_json(directory / "state.json")
            running, tunnel = runtime.alive(state.get("server")), runtime.alive(state.get("tunnel"))
            name = config["name"]
            if state.get("busy") and not runtime.alive(state.get("controller")) and time.time() - state.get("started_at", 0) > 10:
                state = {**state, "busy": False, "error": "上次操作已中断，可重新启动或停止"}
        ready = running and runtime.metadata(f"http://127.0.0.1:{config['port']}", timeout=1)
        busy = state.get("busy", False)
        status = ("starting" if state.get("operation") == "start" else "stopping") if busy else "running" if ready and tunnel and state.get("url") else "error" if state.get("error") or running or tunnel else "stopped"
        return {"id": key, "name": name, "workspace": config["workspace"], "port": config["port"],
                "status": status, "busy": busy, "local_ready": ready, "server_running": running, "tunnel_running": tunnel,
                "url": state.get("url") if ready and tunnel else None, "verified_at": state.get("verified_at"),
                "error": state.get("error", ""), "legacy": legacy}

    def read(self) -> dict:
        if not self.enabled:
            return {"enabled": False, "runtime": {"ready": False, "error": ""}, "services": []}
        self.require_enabled()
        with self.lock:
            self.controllers = {key: process for key, process in self.controllers.items() if process.poll() is None}
            if self.cache is not None and time.monotonic() - self.cached_at < 2:
                return self.cache
            keys = [*self.legacy, *(p.parent.name for p in self.profiles())]
            def get(key):
                try:
                    return self.snapshot(key)
                except (OSError, ValueError, KeyError):
                    return {"id": key, "name": self.legacy.get(key, {}).get("name", "服务配置异常"), "workspace": "", "status": "error",
                            "error": "服务配置无法读取，请检查本机配置", "busy": False, "url": None, "legacy": key in self.legacy}
            with ThreadPoolExecutor(max_workers=4) as pool:
                services = list(pool.map(get, keys))
            self.cache = {"enabled": True, "runtime": self.dependencies(), "services": services}
            self.cached_at = time.monotonic()
            return self.cache

    def create(self, payload: dict) -> dict:
        self.require_enabled()
        if set(payload) != {"name", "workspace"} or not isinstance(payload["name"], str):
            raise MCPServiceError("请填写服务名称并选择工作文件夹")
        name = payload["name"].strip()
        if not 1 <= len(name) <= 80 or any(ord(c) < 32 for c in name):
            raise MCPServiceError("服务名称应为 1–80 个字符")
        workspace = self.folder(payload["workspace"], select=True)
        if not self.dependencies()["ready"]:
            raise MCPServiceError(self.dependencies()["error"])
        with runtime.locked(self.root / "registry.lock"):
            for key in self.legacy:
                config = runtime.read_json(self.legacy[key]["directory"] / "settings.json")
                if Path(config["workspace"]).resolve() == workspace:
                    return {"ok": True, "id": key, "existing": True, **self.action({"id": key, "action": "start"})}
            profiles = self.profiles()
            for path in profiles:
                if runtime.read_json(path)["workspace"] == str(workspace):
                    return {"ok": True, "id": path.parent.name, "existing": True, **self.action({"id": path.parent.name, "action": "start"})}
            if len(profiles) >= 24:
                raise MCPServiceError("最多保存 24 个服务")
            key = secrets.token_hex(16)
            directory = self.root / "services" / key
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]
            stat = workspace.stat()
            config = {"id": key, "name": name, "workspace": str(workspace), "workspace_identity": [stat.st_dev, stat.st_ino], "port": port,
                      "runtime_python": self.python, "cloudflared": self.cloudflared, "oauth_password": secrets.token_urlsafe(24),
                      "token_secret": secrets.token_hex(32), "created_at": time.time()}
            runtime.write_json(directory / "config.json", config)
        return {"ok": True, "id": key, **self.action({"id": key, "action": "start"})}

    def action(self, payload: dict) -> dict:
        if set(payload) != {"id", "action"} or payload["action"] not in {"start", "stop"}:
            raise MCPServiceError("不支持的服务操作")
        key, action = payload["id"], payload["action"]
        directory, legacy = self.resolve(key)
        with self.lock:
            current = self.snapshot(key)
            if current["busy"]:
                raise MCPServiceBusy("该服务正在处理上一次操作，请稍候")
            if action == "start" and current["status"] == "running":
                return {"ok": True, "id": key}
            if legacy:
                self.operations[key] = {"busy": True, "operation": action}
                threading.Thread(target=self._legacy_action, args=(key, directory, action), daemon=True).start()
            else:
                if action == "start":
                    config = runtime.read_json(directory / "config.json")
                    self.folder(config["workspace"], select=True)
                    runtime.workspace_unchanged(config)
                with runtime.locked(directory / "dispatch.lock"):
                    state = runtime.read_json(directory / "state.json")
                    if state.get("busy") and (runtime.alive(state.get("controller")) or time.time() - state.get("started_at", 0) < 10):
                        raise MCPServiceBusy("该服务正在处理上一次操作，请稍候")
                    state.update(busy=True, operation=action, started_at=time.time(), controller=None, error="")
                    runtime.write_json(directory / "state.json", state)
                    fd = os.open(directory / "manager.log", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                    with os.fdopen(fd, "wb") as log:
                        env = {key: os.environ[key] for key in ("HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "PATH") if key in os.environ}
                        controller = subprocess.Popen([sys.executable, "-I", str(Path(runtime.__file__).resolve()), action, str(directory)],
                                         cwd=directory, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
                        self.controllers[controller.pid] = controller
            self.cache = None
            return {"ok": True, "id": key}

    def _legacy_action(self, key, directory, action):
        error = ""
        try:
            result = subprocess.run([sys.executable, str(directory / "manage.py"), action], cwd=directory,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=95, start_new_session=True)
            if result.returncode:
                error = "操作未完成，请查看此服务的原始日志"
        except (OSError, subprocess.TimeoutExpired):
            error = "操作未完成，请查看此服务的原始日志"
        with self.lock:
            self.operations[key] = {"busy": False, "operation": None, "error": error}
            self.cache = None

    def password(self, payload: dict) -> dict:
        if set(payload) != {"id"}:
            raise MCPServiceError("服务不存在")
        directory, legacy = self.resolve(payload["id"])
        config = runtime.read_json(directory / ("settings.json" if legacy else "config.json"))
        return {"password": config["oauth_password"]}

    def logs(self, key: str) -> dict:
        directory, legacy = self.resolve(key)
        config = runtime.read_json(directory / ("settings.json" if legacy else "config.json"))
        files = [directory / "logs/server.stderr.log", directory / "logs/tunnel.stderr.log"] if legacy else [directory / "manager.log", directory / "server.log", directory / "tunnel.log"]
        text = "\n".join(runtime.tail(path, 6000) for path in files)
        for secret in (config.get("oauth_password"), config.get("token_secret")):
            if secret:
                text = text.replace(secret, "[已隐藏]")
        return {"text": re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)[-18000:]}
