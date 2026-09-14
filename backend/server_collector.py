"""Linux metrics collector: streamed through SSH stdin, never installed remotely."""
import csv
import io
import json
import os
import pwd
import re
import resource
import socket
import subprocess
import sys
import time


def read_text(path, limit=65536):
    with open(path, "r", errors="replace") as handle:
        return handle.read(limit)


def number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def task_label(argv):
    """Labels come from this process's argv, never inferred from a parent run."""
    options = {}
    for index, token in enumerate(argv):
        if token.startswith("--"):
            key, separator, value = token.partition("=")
            options[key] = value if separator else (argv[index + 1] if index + 1 < len(argv) else "")
    for key in ("--task-name", "--run-name", "--experiment-name", "--job-name"):
        if options.get(key):
            return options[key], "argument"
    for token in argv[1:]:
        match = re.search(r"(?:^|[/=])([Ee]\d{3}(?:[-_][A-Za-z0-9_.+\-]+)?)(?:/([Tt]\d{3}))?", token)
        if match:
            return match[1][0].upper() + match[1][1:] + ("/" + match[2].upper() if match[2] else ""), "path"
    if options.get("--dataset"):
        keys = ("--dataset", "--unit", "--scheduler", "--fusion")
        return " / ".join(options[key] for key in keys if options.get(key)), "arguments"
    if "-m" in argv and argv.index("-m") + 1 < len(argv):
        return argv[argv.index("-m") + 1], "module"
    for token in argv[1:]:
        if token.endswith(".py"):
            return os.path.basename(token), "script"
    if "tensorboard_data_server" in " ".join(argv):
        return "TensorBoard data server", "executable"
    for token in argv[1:]:
        if token and not token.startswith("-"):
            return os.path.basename(token), "argument"
    return "Python <stdin> (name unavailable)", "unknown"


def metadata_expired(cached, start, comm, now, on_gpu):
    return (cached is None or cached["start"] != start or cached.get("comm") != comm
            or now - cached.get("metadata_at", 0) >= 15 or (on_gpu and not cached["relevant"]))


class Collector:
    def __init__(self):
        self.hz = os.sysconf("SC_CLK_TCK")
        self.page_size = os.sysconf("SC_PAGE_SIZE")
        self.cpu_previous = self.cpu_ticks()
        self.process_cache = {}
        self.owner_cache = {}
        self.gpu_apps = []
        self.gpu_apps_at = 0.0
        self.disks = []
        self.disks_at = 0.0

    @staticmethod
    def cpu_ticks():
        values = [int(item) for item in read_text("/proc/stat").splitlines()[0].split()[1:9]]
        return sum(values), values[3] + values[4]

    def gpu_query(self, category, fields):
        completed = subprocess.run(
            ["nvidia-smi", "--query-" + category + "=" + fields, "--format=csv,noheader,nounits"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=3,
        )
        if completed.returncode:
            raise RuntimeError("nvidia-smi: " + completed.stderr.strip()[:120])
        return list(csv.reader(io.StringIO(completed.stdout), skipinitialspace=True))

    def processes(self, now, uptime):
        gpu_memory = {}
        for app in self.gpu_apps:
            gpu_memory[app["pid"]] = gpu_memory.get(app["pid"], 0) + (app["memory_mib"] or 0)
        result, seen = [], set()
        for name in os.listdir("/proc"):
            if not name.isdigit():
                continue
            pid = int(name)
            if pid == os.getpid():
                continue
            path = "/proc/" + name
            try:
                stat_line = read_text(path + "/stat", 4096)
                fields = stat_line.rpartition(") ")[2].split()
                comm = stat_line.partition("(")[2].rpartition(") ")[0]
                start = int(fields[19])
                ticks = int(fields[11]) + int(fields[12])
                rss = max(0, int(fields[21])) * self.page_size
                seen.add(pid)
                cached = self.process_cache.get(pid)
                if metadata_expired(cached, start, comm, now, pid in gpu_memory):
                    previous = cached if cached is not None and cached["start"] == start else None
                    with open(path + "/cmdline", "rb") as handle:
                        argv = [part.decode("utf-8", "replace") for part in handle.read(16384).split(b"\0") if part]
                    executable = os.path.basename(argv[0]) if argv else ""
                    relevant = bool(re.fullmatch(r"python(?:\d+(?:\.\d+)*)?|torchrun", executable))
                    relevant = relevant or "tensorboard_data_server" in " ".join(argv) or pid in gpu_memory
                    uid = os.stat(path).st_uid if relevant else None
                    if relevant and uid not in self.owner_cache:
                        try:
                            self.owner_cache[uid] = pwd.getpwuid(uid).pw_name
                        except KeyError:
                            self.owner_cache[uid] = str(uid)
                    label, source = task_label(argv) if relevant else ("", "")
                    command = " ".join(argv)
                    cached = dict(start=start, comm=comm, metadata_at=now, relevant=relevant, owner=self.owner_cache.get(uid, "?"),
                                  task=label, source=source, command=command[:4000],
                                  ticks=previous["ticks"] if previous else ticks, at=previous["at"] if previous else now,
                                  service=bool(re.search(r"tensorboard|watch_experiment|networkd-dispatcher|unattended|update-manager|715login|/conda run", command, re.I)))
                    self.process_cache[pid] = cached
                if not cached["relevant"]:
                    continue
                elapsed = now - cached["at"]
                cpu = max(0.0, (ticks - cached["ticks"]) / self.hz / elapsed * 100) if elapsed > 0.05 else None
                cached.update(ticks=ticks, at=now)
                result.append(dict(pid=pid, owner=cached["owner"], task=cached["task"], source=cached["source"],
                                   command=cached["command"], cpu=cpu, rss=rss, start=start,
                                   age=max(0, uptime - start / self.hz), service=cached["service"],
                                   gpu_mib=gpu_memory.get(pid, 0)))
            except (OSError, ValueError, IndexError):
                continue
        self.process_cache = {pid: item for pid, item in self.process_cache.items() if pid in seen}
        known = {item["pid"] for item in result}
        for pid, memory in gpu_memory.items():
            if pid not in known:
                result.append(dict(pid=pid, owner="?", task="process metadata unavailable", source="unknown",
                                   command="", cpu=None, rss=0, start=0, age=0, service=False, gpu_mib=memory))
        return sorted(result, key=lambda item: (-item["gpu_mib"], -(item["cpu"] or 0), item["pid"]))

    def snapshot(self):
        started = time.monotonic()
        errors = []
        total, idle = self.cpu_ticks()
        previous_total, previous_idle = self.cpu_previous
        cpu = 100 * (1 - (idle - previous_idle) / (total - previous_total)) if total > previous_total else None
        self.cpu_previous = total, idle
        memory = {}
        for line in read_text("/proc/meminfo").splitlines():
            key, value = line.split(":", 1)
            memory[key] = int(value.split()[0]) * 1024
        uptime = float(read_text("/proc/uptime").split()[0])
        gpus = []
        try:
            rows = self.gpu_query("gpu", "index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw")
            for row in rows:
                if len(row) == 8:
                    gpus.append(dict(index=row[0], uuid=row[1], name=row[2], util=number(row[3]),
                                     used_mib=number(row[4]), total_mib=number(row[5]), temperature=number(row[6]), power=number(row[7])))
        except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
            errors.append(str(error)[:160])
        if started - self.gpu_apps_at >= 6:
            try:
                rows = self.gpu_query("compute-apps", "gpu_uuid,pid,used_memory")
                self.gpu_apps = [dict(uuid=row[0], pid=int(row[1]), memory_mib=number(row[2])) for row in rows if len(row) == 3]
                self.gpu_apps_at = started
            except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
                self.gpu_apps = []
                errors.append(str(error)[:160])
        if started - self.disks_at >= 15:
            self.disks = []
            devices = set()
            for path in ("/", "/home"):
                try:
                    device = os.stat(path).st_dev
                    if device in devices:
                        continue
                    devices.add(device)
                    disk = os.statvfs(path)
                    total_bytes = disk.f_blocks * disk.f_frsize
                    used_bytes = (disk.f_blocks - disk.f_bfree) * disk.f_frsize
                    free_bytes = disk.f_bavail * disk.f_frsize
                    self.disks.append(dict(path=path, total=total_bytes, used=used_bytes, free=free_bytes,
                                           percent=100 * used_bytes / max(1, used_bytes + free_bytes)))
                except OSError:
                    continue
            self.disks_at = started
        processes = self.processes(time.monotonic(), uptime)
        usage = resource.getrusage(resource.RUSAGE_SELF)
        children = resource.getrusage(resource.RUSAGE_CHILDREN)
        return dict(hostname=socket.gethostname().split(".")[0], time=time.time(), cpu=cpu,
                    cores=os.cpu_count(), load=read_text("/proc/loadavg").split()[:3], uptime=uptime,
                    memory=dict(total=memory["MemTotal"], used=memory["MemTotal"] - memory.get("MemAvailable", memory["MemFree"]),
                                available=memory.get("MemAvailable", memory["MemFree"])),
                    swap=dict(total=memory["SwapTotal"], used=memory["SwapTotal"] - memory["SwapFree"]),
                    disks=self.disks, gpus=gpus, processes=processes, errors=errors,
                    collector=dict(pid=os.getpid(), cost_ms=(time.monotonic() - started) * 1000,
                                   peak_rss_kib=usage.ru_maxrss,
                                   cpu_seconds=usage.ru_utime + usage.ru_stime + children.ru_utime + children.ru_stime))


def main():
    collector = Collector()
    time.sleep(0.15)
    while True:
        started = time.monotonic()
        print(json.dumps(collector.snapshot(), ensure_ascii=True, separators=(",", ":")), flush=True)
        if "--once" in sys.argv:
            return
        time.sleep(max(0.1, 3 - (time.monotonic() - started)))


if __name__ == "__main__":
    try:
        main()
    except (BrokenPipeError, KeyboardInterrupt):
        pass
