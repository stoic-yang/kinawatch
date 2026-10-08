"""On-demand SSH streams. No remote install, persistent cache, or shell endpoint."""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import re
import selectors
import subprocess
import threading
import time
import unicodedata

LEASE_SECONDS = 15
STALE_SECONDS = 10
STARTUP_SECONDS = 45
STREAM_TIMEOUT_SECONDS = 20
MAX_RECORD_BYTES = 4 * 1024 * 1024
ALIAS = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")
PYTHON_PATH = re.compile(r"/[A-Za-z0-9_./-]{1,255}\Z")


def clean(value: object, limit: int = 240) -> str:
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", str(value))
    return "".join(c if unicodedata.category(c)[0] != "C" else " " for c in text)[:limit]


def configuration(raw: object) -> tuple[bool, list[str], str]:
    if not isinstance(raw, dict):
        raise ValueError("server_monitor 必须是配置对象")
    enabled = raw.get("enabled", False)
    if not isinstance(enabled, bool):
        raise ValueError("server_monitor.enabled 必须是布尔值")
    if not enabled:
        return False, [], ""
    hosts, jump = raw.get("hosts", []), raw.get("jump_host", "")
    if (not isinstance(hosts, list) or not 1 <= len(hosts) <= 8
            or any(not isinstance(host, str) or not ALIAS.fullmatch(host) for host in hosts)
            or len(set(hosts)) != len(hosts)):
        raise ValueError("请配置 1–8 个不重复的 SSH 主机别名")
    if not isinstance(jump, str) or (jump and not ALIAS.fullmatch(jump)):
        raise ValueError("跳板必须是一个 SSH 别名，直连时留空")
    python_paths(raw, hosts)
    return True, hosts, jump


def python_paths(raw: dict, hosts: list[str]) -> dict[str, str]:
    paths = raw.get("python_paths", {})
    if (not isinstance(paths, dict) or any(alias not in hosts or not isinstance(path, str)
            or not PYTHON_PATH.fullmatch(path) for alias, path in paths.items())):
        raise ValueError("python_paths 必须使用已配置的主机别名和无空格的绝对 Python 路径")
    return paths


def ssh_command(alias: str, jump: str, python_path: str = "/usr/bin/python3") -> list[str]:
    # Only locally configured aliases enter argv. Never accept commands from HTTP.
    command = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
               "-o", "ConnectTimeout=30", "-o", "ServerAliveInterval=10",
               "-o", "ServerAliveCountMax=2", "-o", "LogLevel=ERROR",
               "-o", "ControlMaster=no", "-o", "ControlPath=none",
               "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no"]
    if jump:
        command.extend(["-J", jump])
    else:
        command.extend(["-o", "ProxyJump=none", "-o", "ProxyCommand=none"])
    return command + [alias, python_path, "-u", "-"]


def normalize_snapshot(value: object) -> dict:
    """Validate bounded remote data before it reaches the browser."""
    def obj(item):
        if not isinstance(item, dict):
            raise ValueError("监控数据格式无效")
        return item

    def number(item):
        if item is None:
            return None
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item) or item < 0:
            raise ValueError("监控数值无效")
        return item

    def fields(item, names):
        item = obj(item)
        return {key: number(item.get(key)) for key in names.split()}

    def entries(key, limit):
        items = value.get(key, [])
        if not isinstance(items, list) or len(items) > limit:
            raise ValueError("监控列表超出限制")
        return [obj(item) for item in items]

    value = obj(value)
    if not isinstance(value.get("hostname"), str) or not value["hostname"] or not number(value.get("time")):
        raise ValueError("监控数据缺少主机或采样时间")
    result = fields(value, "time cpu cores uptime")
    result.update(hostname=clean(value["hostname"], 128),
                  memory=fields(value.get("memory"), "total used available"),
                  swap=fields(value.get("swap"), "total used"))
    for key in ("cpu_scope", "memory_scope"):
        scope = value.get(key, "host")
        if scope not in ("host", "cgroup"):
            raise ValueError("监控资源口径无效")
        result[key] = scope
    load, errors = value.get("load", []), value.get("errors", [])
    if not isinstance(load, list) or len(load) > 3 or not isinstance(errors, list) or len(errors) > 16:
        raise ValueError("监控数据格式无效")
    result["load"] = [clean(item, 24) for item in load]
    result["errors"] = [clean(item) for item in errors]
    result["disks"] = [{**fields(item, "total used free percent"), "path": clean(item.get("path", ""), 128)}
                       for item in entries("disks", 32)]
    result["gpus"] = [{**fields(item, "util used_mib total_mib temperature power"),
                       "index": clean(item.get("index", ""), 8), "name": clean(item.get("name", ""), 128)}
                      for item in entries("gpus", 64)]
    result["processes"] = [{**fields(item, "pid cpu rss age gpu_mib start"),
                            "owner": clean(item.get("owner", "?"), 64),
                            "task": clean(item.get("task", "未知任务"), 256),
                            "command": clean(item.get("command", ""), 4000),
                            "service": item.get("service") is True}
                           for item in entries("processes", 4096)]
    return result


class HostWorker(threading.Thread):
    def __init__(self, alias: str, jump: str, source: bytes, previous: dict | None = None,
                 python_path: str = "/usr/bin/python3"):
        super().__init__(daemon=True, name="server-monitor-" + alias)
        self.alias, self.jump, self.source = alias, jump, source
        self.python_path = python_path
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.last_viewed = time.monotonic()
        self.state = dict(previous or {}, connected=False, error="", samples=0)

    def touch(self):
        with self.lock:
            self.last_viewed = time.monotonic()

    def wanted(self):
        with self.lock:
            return not self.stop_event.is_set() and time.monotonic() - self.last_viewed < LEASE_SECONDS

    def read(self):
        with self.lock:
            state = dict(self.state)
        age = max(0, time.monotonic() - state["received"]) if state.get("received") else None
        online = state["connected"] and age is not None and age <= STALE_SECONDS
        return dict(alias=self.alias, route=self.jump or "直连", data=state.get("data"),
                    received_at=state.get("received_at"), age_seconds=age, samples=state["samples"],
                    status="online" if online else "offline" if state["error"] else "stale" if state.get("data") else "connecting",
                    error=state["error"])

    def run(self):
        try:
            while self.wanted():
                self.collect()
                # Interruptible backoff, including when the viewing lease expires.
                until = time.monotonic() + 5
                while self.wanted() and time.monotonic() < until:
                    self.stop_event.wait(.2)
        finally:
            with self.lock:
                self.state["connected"] = False

    def collect(self):
        process = None
        stderr, buffer, failure = b"", b"", "SSH 数据流已关闭"
        last_sample, remote_time, sent = time.monotonic(), None, 0
        timeout = STARTUP_SECONDS
        try:
            with self.lock:
                self.state.update(connected=False, samples=0)
            process = subprocess.Popen(ssh_command(self.alias, self.jump, self.python_path), stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            with selectors.DefaultSelector() as selector:
                for stream, event, label in ((process.stdin, selectors.EVENT_WRITE, "stdin"),
                                              (process.stdout, selectors.EVENT_READ, "stdout"),
                                              (process.stderr, selectors.EVENT_READ, "stderr")):
                    os.set_blocking(stream.fileno(), False)
                    selector.register(stream, event, label)
                while self.wanted():
                    if time.monotonic() - last_sample > timeout:
                        raise TimeoutError("等待 SSH 监控数据超时")
                    for key, _ in selector.select(.2):
                        if key.data == "stdin":
                            sent += os.write(key.fd, self.source[sent:sent + 8192])
                            if sent == len(self.source):
                                selector.unregister(key.fileobj)
                                key.fileobj.close()
                            continue
                        chunk = os.read(key.fd, 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        if key.data == "stderr":
                            stderr = (stderr + chunk)[-4096:]
                            continue
                        buffer += chunk
                        while b"\n" in buffer:
                            line, buffer = buffer.split(b"\n", 1)
                            if len(line) > MAX_RECORD_BYTES:
                                raise ValueError("监控数据超过大小限制")
                            sample = normalize_snapshot(json.loads(line))
                            if remote_time is not None and sample["time"] <= remote_time:
                                raise ValueError("服务器重复返回旧样本")
                            remote_time, last_sample, timeout = sample["time"], time.monotonic(), STREAM_TIMEOUT_SECONDS
                            with self.lock:
                                self.state.update(data=sample, received=last_sample, received_at=time.time(),
                                                  connected=True, error="", samples=self.state["samples"] + 1)
                        if len(buffer) > MAX_RECORD_BYTES:
                            raise ValueError("监控数据超过大小限制")
                    if not selector.get_map():
                        break
        except (OSError, ValueError, TypeError) as error:
            failure = clean(error)
        finally:
            if process is not None:
                if process.poll() is None:
                    process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
                for stream in (process.stdin, process.stdout, process.stderr):
                    if stream and not stream.closed:
                        stream.close()
            detail = clean(stderr.decode("utf-8", "replace").strip())
            with self.lock:
                self.state.update(connected=False, error=(failure + (" · " + detail if detail else "")) if self.wanted_unlocked() else "")

    def wanted_unlocked(self):
        return not self.stop_event.is_set() and time.monotonic() - self.last_viewed < LEASE_SECONDS


class ServerMonitor:
    def __init__(self, raw: object):
        self.enabled, self.hosts, self.jump = configuration(raw)
        self.python_paths = dict(python_paths(raw, self.hosts)) if self.enabled else {}
        self.lock = threading.Lock()
        self.workers: dict[str, HostWorker] = {}
        self.closed = False

    def read(self) -> dict:
        with self.lock:
            if self.enabled and not self.closed:
                source = Path(__file__).with_name("server_collector.py").read_bytes()
                for alias in self.hosts:
                    worker = self.workers.get(alias)
                    if worker is None or not worker.is_alive():
                        worker = HostWorker(alias, self.jump, source, worker.state if worker else None,
                                            self.python_paths.get(alias, "/usr/bin/python3"))
                        self.workers[alias] = worker
                        worker.start()
                    worker.touch()
            return dict(enabled=self.enabled, poll_seconds=3, stale_seconds=STALE_SECONDS,
                        hosts=[worker.read() for worker in self.workers.values()])

    def close(self):
        with self.lock:
            self.closed = True
            workers = list(self.workers.values())
            for worker in workers:
                worker.stop_event.set()
        for worker in workers:
            worker.join(timeout=3)
