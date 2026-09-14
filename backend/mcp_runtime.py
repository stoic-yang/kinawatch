"""Detached lifecycle for authenticated coding-tools-mcp instances (POSIX)."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

TUNNEL_URL = re.compile(r"https://[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b")
CHILDREN: dict[int, subprocess.Popen] = {}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def read_json(path: Path, default=None):
    if not path.exists():
        return {} if default is None else default
    with path.open("rb") as handle:
        raw = handle.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError("服务配置超出大小限制")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("服务配置格式不正确")
    return value


def write_json(path: Path, value: dict):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".mcp-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n"); handle.flush(); os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


@contextmanager
def locked(path: Path, blocking=True):
    import fcntl
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(fd, "a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        yield


def process_identity(pid: int) -> str | None:
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1:
        return None
    try:
        # Python launcher paths can change immediately after exec on macOS.
        # Birth time, owner and session group remain stable across that transition.
        result = subprocess.run(["ps", "-p", str(pid), "-o", "lstart=,uid=,pgid=,stat="],
                                capture_output=True, text=True, timeout=2)
        text = result.stdout.strip()
        if result.returncode or not text or text.split()[-1].startswith("Z"):
            return None
        return hashlib.sha256(" ".join(text.split()[:-1]).encode()).hexdigest()
    except (OSError, subprocess.TimeoutExpired):
        return None


def alive(identity: dict | None) -> bool:
    return bool(identity and identity.get("fingerprint") and
                process_identity(identity.get("pid")) == identity["fingerprint"])


def tail(path: Path, limit=16384) -> str:
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            handle.seek(max(0, handle.tell() - limit))
            return handle.read(limit).decode("utf-8", "replace")
    except FileNotFoundError:
        return ""


def endpoint(path: Path) -> str | None:
    matches = TUNNEL_URL.findall(tail(path))
    if not matches:
        try:
            with path.open("rb") as handle:
                matches = TUNNEL_URL.findall(handle.read(16384).decode("utf-8", "replace"))
        except FileNotFoundError:
            pass
    return matches[-1] if matches else None


def metadata(origin: str, timeout=2) -> bool:
    try:
        with OPENER.open(origin + "/.well-known/oauth-authorization-server", timeout=timeout) as response:
            body = json.loads(response.read(65536))
            return body.get("issuer") == origin and body.get("registration_endpoint") == origin + "/oauth/register"
    except (OSError, ValueError, urllib.error.URLError):
        return False


def launch(command: list[str], directory: Path, role: str, env: dict | None = None) -> dict:
    fd = os.open(directory / (role + ".log"), os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as log:
        process = subprocess.Popen(command, cwd=directory, env=env, stdin=subprocess.DEVNULL,
                                   stdout=log, stderr=log, start_new_session=True)
    CHILDREN[process.pid] = process
    identity = {"pid": process.pid, "fingerprint": process_identity(process.pid)}
    if not identity["fingerprint"]:
        if process.poll() is None:
            process.terminate(); process.wait(timeout=3)
        raise RuntimeError("服务进程未能启动，请查看日志")
    return identity


def stop(identity: dict | None):
    if not alive(identity):
        return
    pid = identity["pid"]
    if os.getpgid(pid) != pid:
        raise RuntimeError("进程归属不匹配，未停止其他程序")
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    until = time.monotonic() + 4
    while alive(identity) and time.monotonic() < until:
        time.sleep(.1)
    if alive(identity):
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    # Reap when this supervisor also started the child; adoption after restart is OK.
    child = CHILDREN.pop(pid, None)
    if child is not None:
        child.wait(timeout=3)


def workspace_unchanged(config: dict):
    workspace = Path(config["workspace"])
    if workspace.resolve(strict=True) != workspace or not workspace.is_dir():
        raise ValueError("原工作文件夹已移动，请重新选择")
    current = workspace.stat()
    if [current.st_dev, current.st_ino] != config["workspace_identity"]:
        raise ValueError("原工作文件夹已被替换，请重新选择")


def runtime_environment(config: dict, directory: Path) -> dict:
    # Do not pass the dashboard's credentials, startup hooks or provider keys onward.
    env = {key: os.environ[key] for key in ("HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR") if key in os.environ}
    env["PATH"] = str(Path(config["runtime_python"]).parent) + os.pathsep + "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    env.update(CODING_TOOLS_MCP_AUTH_MODE="oauth", CODING_TOOLS_MCP_OAUTH_PASSWORD=config["oauth_password"],
               CODING_TOOLS_MCP_OAUTH_TOKEN_SECRET=config["token_secret"], CODING_TOOLS_MCP_TELEMETRY="off",
               CODING_TOOLS_MCP_RUNTIME_ROOT=str(directory / "runtime"), PYTHONNOUSERSITE="1")
    return env


def run_action(directory: Path, action: str):
    with locked(directory / "action.lock", blocking=False):
        config = read_json(directory / "config.json")
        state = read_json(directory / "state.json")
        state.update(operation=action, busy=True, error="", controller={"pid": os.getpid(), "fingerprint": process_identity(os.getpid())})
        write_json(directory / "state.json", state)
        created = []
        try:
            if action == "stop":
                for role in ("tunnel", "server"):
                    stop(state.get(role)); state.pop(role, None)
                state.update(url=None, verified_at=None)
            elif action == "start":
                workspace_unchanged(config)
                origin = f"http://127.0.0.1:{config['port']}"
                if not alive(state.get("server")):
                    # A surviving old tunnel must never expose a new/unrelated listener.
                    stop(state.get("tunnel")); state.pop("tunnel", None)
                    with socket.socket() as sock:
                        if sock.connect_ex(("127.0.0.1", config["port"])) == 0:
                            raise RuntimeError("本机端口已被其他程序占用，未修改现有进程")
                    command = [config["runtime_python"], "-m", "coding_tools_mcp", "--workspace", config["workspace"],
                               "--host", "127.0.0.1", "--port", str(config["port"]), "--oauth-mode", "--permission-mode", "safe"]
                    state["server"] = launch(command, directory, "server", runtime_environment(config, directory))
                    created.append("server"); state.update(url=None, verified_at=None)
                    write_json(directory / "state.json", state)
                until = time.monotonic() + 15
                while not metadata(origin):
                    if not alive(state.get("server")) or time.monotonic() > until:
                        raise RuntimeError("MCP 本地服务未就绪，请查看日志后重试")
                    time.sleep(.3)
                if not alive(state.get("tunnel")):
                    state["tunnel"] = launch([config["cloudflared"], "tunnel", "--no-autoupdate", "--protocol", "http2", "--url", origin], directory, "tunnel")
                    created.append("tunnel"); state.update(url=None, verified_at=None)
                    write_json(directory / "state.json", state)
                until = time.monotonic() + 45
                while True:
                    url = endpoint(directory / "tunnel.log")
                    if url and metadata(url, timeout=3):
                        state.update(url=url + "/mcp", verified_at=time.time())
                        break
                    if not alive(state.get("tunnel")) or time.monotonic() > until:
                        raise RuntimeError("HTTPS 通道未就绪，请检查网络后重试")
                    time.sleep(1)
            else:
                raise ValueError("不支持的服务操作")
        except (OSError, ValueError, RuntimeError) as exc:
            for role in reversed(created):
                stop(state.get(role)); state.pop(role, None)
            state.update(error=str(exc), url=None, verified_at=None)
        finally:
            state.update(busy=False, operation=None, finished_at=time.time())
            write_json(directory / "state.json", state)


def guard_pair(directory: Path):
    """Keep a failed MCP listener from leaving a tunnel aimed at a reusable port."""
    original = read_json(directory / "state.json")
    pair = {role: original.get(role) for role in ("server", "tunnel")}
    if original.get("error") or not all(pair.values()):
        return
    while True:
        state = read_json(directory / "state.json")
        if any(state.get(role) != pair[role] for role in pair):
            return
        if state.get("busy"):
            time.sleep(1); continue
        running = {role: CHILDREN[item["pid"]].poll() is None if item["pid"] in CHILDREN else alive(item) for role, item in pair.items()}
        if not all(running.values()):
            with locked(directory / "action.lock"):
                state = read_json(directory / "state.json")
                if state.get("busy") or any(state.get(role) != pair[role] for role in pair):
                    return
                for role in ("tunnel", "server"):
                    stop(pair[role]); state.pop(role, None)
                state.update(url=None, verified_at=None, error="MCP 或 HTTPS 进程已退出，连接已停止，可重新启动")
                write_json(directory / "state.json", state)
            return
        time.sleep(1)


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in {"start", "stop"}:
        raise SystemExit("Use start|stop PROFILE_DIRECTORY")
    directory = Path(sys.argv[2]).resolve(strict=True)
    run_action(directory, sys.argv[1])
    if sys.argv[1] == "start":
        guard_pair(directory)
