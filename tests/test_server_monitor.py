import copy
import json
import sys
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from backend.server_monitor import HostWorker, ServerMonitor, configuration, normalize_snapshot, ssh_command


SAMPLE = {
    "hostname": "compute-a", "time": 1234, "cpu": 30.5, "cores": 32, "uptime": 90000,
    "load": ["1.1", "2.2", "3.3"], "errors": [],
    "memory": {"total": 128 * 1024**3, "used": 48 * 1024**3, "available": 80 * 1024**3},
    "swap": {"total": 0, "used": 0},
    "disks": [{"path": "/", "total": 1024**4, "used": 900 * 1024**3, "free": 124 * 1024**3, "percent": 88}],
    "gpus": [{"index": "0", "name": "NVIDIA Example GPU", "util": 82, "used_mib": 12000,
              "total_mib": 24000, "temperature": 55, "power": 220},
             {"index": "1", "name": "NVIDIA Example GPU", "util": None, "used_mib": 2000,
              "total_mib": 24000, "temperature": None, "power": None}],
    "processes": [{"pid": 100, "owner": "researcher", "task": "Training example", "command": "python train.py --seed 1",
                   "cpu": 180.2, "rss": 5 * 1024**3, "gpu_mib": 12000, "age": 7000, "start": 1000, "service": False}],
}


def wait_for(predicate, timeout=3):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        if predicate():
            return
        time.sleep(.02)
    raise AssertionError("condition timed out")


def source(tail=""):
    return ("import json,time,sys\nsample=" + repr(SAMPLE) + "\n" + tail).encode()


STREAM = source("while True:\n sample['time']=time.time()\n print(json.dumps(sample),flush=True)\n time.sleep(.05)\n")


class ServerMonitorTests(unittest.TestCase):
    def test_http_endpoint_is_same_origin_read_only_and_takes_no_commands(self):
        from urllib.error import HTTPError
        from urllib.request import Request, urlopen
        from backend.server import DashboardRequestHandler, IdleHTTPServer
        from test_server import StubApplication

        app = StubApplication()
        app.servers = lambda: {"enabled": False, "hosts": []}
        server = IdleHTTPServer(("127.0.0.1", 0), DashboardRequestHandler, app, idle_timeout_seconds=.1)
        thread = threading.Thread(target=server.serve_until_idle)
        thread.start()
        endpoint = f"http://127.0.0.1:{server.server_port}/api/servers?host=arbitrary&command=anything"
        try:
            with urlopen(endpoint, timeout=2) as response:
                self.assertEqual(json.load(response)["hosts"], [])
                self.assertEqual(response.headers["Cache-Control"], "no-store")
            for request in (Request(endpoint, headers={"Origin": "https://example.test"}),
                            Request(endpoint, headers={"Sec-Fetch-Site": "cross-site"})):
                with self.assertRaises(HTTPError) as caught:
                    urlopen(request, timeout=2)
                self.assertEqual(caught.exception.code, 403)
                caught.exception.close()
            with self.assertRaises(HTTPError) as caught:
                urlopen(Request(endpoint, data=b"{}", method="PUT"), timeout=2)
            self.assertEqual(caught.exception.code, 404)
            caught.exception.close()
        finally:
            thread.join(timeout=1); server.server_close(); thread.join(timeout=1)

    def test_configuration_rejects_http_control_and_shell_syntax(self):
        self.assertEqual(configuration({}), (False, [], ""))
        self.assertEqual(configuration({"enabled": True, "hosts": ["compute-a"]}), (True, ["compute-a"], ""))
        for raw in [[], {"enabled": "false"}, {"enabled": True, "hosts": []},
                    {"enabled": True, "hosts": ["-Fconfig"]}, {"enabled": True, "hosts": ["host;command"]},
                    {"enabled": True, "hosts": ["a", "a"]}, {"enabled": True, "hosts": ["a"], "jump_host": "a,b"}]:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                configuration(raw)

    def test_direct_route_disables_inherited_proxy_and_keeps_auth_noninteractive(self):
        command = ssh_command("compute-a", "")
        for option in ("ProxyJump=none", "ProxyCommand=none", "BatchMode=yes", "StrictHostKeyChecking=yes", "ForwardAgent=no"):
            self.assertIn(option, command)
        self.assertNotIn("-J", command)
        self.assertEqual(command[-4:], ["compute-a", "/usr/bin/python3", "-u", "-"])
        command = ssh_command("compute-a", "gateway")
        self.assertEqual(command[command.index("-J") + 1], "gateway")

    def test_private_per_host_python_path_is_validated_and_used_by_worker(self):
        raw = {"enabled": True, "hosts": ["a", "b"], "python_paths": {"b": "/opt/conda/bin/python"}}
        configuration(raw)
        with patch("backend.server_monitor.HostWorker.start"):
            monitor = ServerMonitor(raw)
            monitor.read()
            self.assertEqual(monitor.workers["a"].python_path, "/usr/bin/python3")
            self.assertEqual(monitor.workers["b"].python_path, "/opt/conda/bin/python")
        command = ssh_command("b", "", "/opt/conda/bin/python")
        self.assertEqual(command[-4:], ["b", "/opt/conda/bin/python", "-u", "-"])
        for paths in ([], {"other": "/usr/bin/python3"}, {"a": "python3"}, {"a": "/tmp/a b"},
                      {"a": "/tmp/python;touch"}, {"a": "/tmp/$(command)"}, {"a": None}):
            with self.subTest(paths=paths), self.assertRaises(ValueError):
                configuration({**raw, "python_paths": paths})

    def test_normalization_retains_all_gpus_nulls_units_and_plain_text(self):
        raw = copy.deepcopy(SAMPLE)
        raw["hostname"] = "\x1b[31mhost\x00"
        raw["unexpected"] = "private metadata"
        data = normalize_snapshot(raw)
        self.assertEqual(data["hostname"], "host ")
        self.assertNotIn("unexpected", data)
        self.assertEqual(len(data["gpus"]), 2)
        self.assertIsNone(data["gpus"][1]["util"])
        self.assertEqual(data["processes"][0]["cpu"], 180.2)
        self.assertEqual(data["memory"]["total"], 128 * 1024**3)

    def test_malformed_and_unbounded_remote_data_is_rejected(self):
        for key, value in [("time", None), ("cpu", float("nan")), ("memory", []), ("gpus", [{}] * 65),
                           ("processes", [{}] * 4097), ("swap", {"total": -1}), ("errors", "error")]:
            raw = copy.deepcopy(SAMPLE); raw[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                normalize_snapshot(raw)

    def test_container_scope_survives_normalization_and_old_samples_stay_compatible(self):
        raw = copy.deepcopy(SAMPLE)
        raw.update(cpu_scope="cgroup", memory_scope="cgroup", cores=1.5)
        self.assertEqual(normalize_snapshot(raw)["cpu_scope"], "cgroup")
        self.assertEqual(normalize_snapshot(raw)["cores"], 1.5)
        self.assertEqual(normalize_snapshot(SAMPLE)["memory_scope"], "host")
        for scope in ("unknown", {}, None):
            raw["cpu_scope"] = scope
            with self.assertRaises(ValueError):
                normalize_snapshot(raw)

    def test_disabled_and_unviewed_monitors_never_start_ssh(self):
        with patch("backend.server_monitor.subprocess.Popen") as popen:
            monitor = ServerMonitor({})
            self.assertEqual(monitor.read()["hosts"], [])
            monitor.close()
            configured = ServerMonitor({"enabled": True, "hosts": ["a"]})
            configured.close()
            popen.assert_not_called()

    def worker(self, data):
        worker = HostWorker("fixture", "", data)
        command = patch("backend.server_monitor.ssh_command", return_value=[sys.executable, "-u", "-"])
        command.start()
        self.addCleanup(command.stop)
        self.addCleanup(lambda: (worker.stop_event.set(), worker.join(timeout=3)))
        worker.start()
        return worker

    def test_stream_handles_partial_and_multiple_records_and_fresh_samples(self):
        data = source("record=json.dumps(sample)+'\\n'\nsys.stdout.write(record[:10]);sys.stdout.flush()\ntime.sleep(.03)\nsys.stdout.write(record[10:]);sample['time']+=1\nprint(json.dumps(sample),flush=True)\ntime.sleep(10)\n")
        worker = self.worker(data)
        wait_for(lambda: worker.read()["samples"] == 2)
        result = worker.read()
        self.assertEqual(result["status"], "online")
        self.assertEqual(result["data"]["hostname"], "compute-a")
        self.assertLess(result["age_seconds"], 1)

    def test_duplicate_sample_rejected_and_last_good_data_labeled_offline(self):
        worker = self.worker(source("print(json.dumps(sample),flush=True)\nprint(json.dumps(sample),flush=True)\ntime.sleep(10)"))
        wait_for(lambda: bool(worker.read()["error"]))
        result = worker.read()
        self.assertIn("旧样本", result["error"])
        self.assertEqual(result["status"], "offline")
        self.assertIsNotNone(result["data"])

    def test_ssh_error_retained_without_turning_missing_metrics_into_zero(self):
        worker = self.worker(b"import sys\nprint('Connection refused',file=sys.stderr)\n")
        wait_for(lambda: bool(worker.read()["error"]))
        result = worker.read()
        self.assertEqual(result["status"], "offline")
        self.assertIn("Connection refused", result["error"])
        self.assertIsNone(result["data"])

    def test_stalled_stream_times_out(self):
        with patch("backend.server_monitor.STARTUP_SECONDS", .15):
            worker = self.worker(b"import time\ntime.sleep(10)\n")
            wait_for(lambda: bool(worker.read()["error"]))
            self.assertIn("超时", worker.read()["error"])

    def test_oversized_complete_record_rejected(self):
        with patch("backend.server_monitor.MAX_RECORD_BYTES", 100):
            worker = self.worker(b"print('x'*101,flush=True)\n")
            wait_for(lambda: bool(worker.read()["error"]))
            self.assertIn("大小限制", worker.read()["error"])

    def test_concurrent_viewers_share_streams_and_lease_expiry_releases_them(self):
        with patch("backend.server_monitor.ssh_command", return_value=[sys.executable, "-u", "-"]), \
                patch("backend.server_monitor.Path.read_bytes", return_value=STREAM), \
                patch("backend.server_monitor.LEASE_SECONDS", .4):
            monitor = ServerMonitor({"enabled": True, "hosts": ["a", "b"]})
            self.addCleanup(monitor.close)
            with ThreadPoolExecutor(max_workers=5) as pool:
                list(pool.map(lambda _: monitor.read(), range(10)))
            workers = list(monitor.workers.values())
            wait_for(lambda: all(worker.read()["samples"] >= 2 for worker in workers))
            self.assertEqual(len(workers), 2)
            monitor.read()
            self.assertEqual(list(monitor.workers.values()), workers)
            wait_for(lambda: all(not worker.is_alive() for worker in workers))
            self.assertTrue(all(worker.read()["status"] == "stale" for worker in workers))
            monitor.read()
            self.assertTrue(all(monitor.workers[worker.alias] is not worker for worker in workers))
            monitor.close()
            self.assertTrue(all(not worker.is_alive() for worker in monitor.workers.values()))
            monitor.read()
            self.assertTrue(all(not worker.is_alive() for worker in monitor.workers.values()))


if __name__ == "__main__":
    unittest.main()
