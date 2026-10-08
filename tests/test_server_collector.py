import unittest
from unittest.mock import patch

from backend.server_collector import SystemResources, cgroup_v2_paths


MEMORY = {"MemTotal": 1024**4, "MemAvailable": 800 * 1024**3,
          "MemFree": 100 * 1024**3, "SwapTotal": 16 * 1024**3, "SwapFree": 8 * 1024**3}


class ContainerResourceTests(unittest.TestCase):
    def reader(self, files):
        return patch("backend.server_collector.cgroup_value", side_effect=lambda path, name: files.get((path, name)))

    def resources(self, paths=("/cg",)):
        with patch("backend.server_collector.cgroup_v2_paths", return_value=list(paths)):
            return SystemResources()

    def test_dual_gpu_instance_uses_shared_32_cpu_160_gib_limits_and_usage(self):
        files = {("/cg", "cpu.max"): "3200000 100000", ("/cg", "cpuset.cpus.effective"): "0-191",
                 ("/cg", "cpu.stat"): "usage_usec 1000000\nuser_usec 900000\nsystem_usec 100000",
                 ("/cg", "memory.max"): str(160 * 1024**3),
                 ("/cg", "memory.current"): str(120 * 1024**3),
                 ("/cg", "memory.swap.max"): "0", ("/cg", "memory.swap.current"): "0"}
        resources = self.resources()
        with self.reader(files), patch("backend.server_collector.os.cpu_count", return_value=192):
            first = resources.sample(MEMORY, 99, 100)
            self.assertIsNone(first["cpu"])
            files[("/cg", "cpu.stat")] = "usage_usec 49000000"
            sample = resources.sample(MEMORY, 99, 103)
        self.assertEqual(sample["cores"], 32)
        self.assertEqual(sample["cpu"], 50)
        self.assertEqual(sample["cpu_scope"], "cgroup")
        self.assertEqual(sample["memory_scope"], "cgroup")
        self.assertEqual(sample["memory"], {"total": 160 * 1024**3, "used": 120 * 1024**3, "available": 40 * 1024**3})
        self.assertEqual(sample["swap"], {"total": 0, "used": 0})

    def test_ordinary_unbounded_host_preserves_existing_proc_measurements(self):
        resources = self.resources()
        files = {("/cg", "cpu.max"): "max 100000", ("/cg", "memory.max"): "max",
                 ("/cg", "cpuset.cpus.effective"): "0-63"}
        with self.reader(files), patch("backend.server_collector.os.cpu_count", return_value=64):
            sample = resources.sample(MEMORY, 37.5, 100)
        self.assertEqual((sample["cpu"], sample["cores"], sample["cpu_scope"], sample["memory_scope"]),
                         (37.5, 64, "host", "host"))
        self.assertEqual(sample["memory"]["total"], 1024**4)
        self.assertEqual(sample["memory"]["used"], 224 * 1024**3)
        self.assertEqual(sample["swap"]["used"], 8 * 1024**3)

    def test_missing_scoped_counters_and_reset_never_become_host_usage_or_zero(self):
        resources = self.resources()
        files = {("/cg", "cpu.max"): "150000 100000", ("/cg", "memory.max"): str(160 * 1024**3)}
        with self.reader(files), patch("backend.server_collector.os.cpu_count", return_value=192):
            sample = resources.sample(MEMORY, 99, 100)
            self.assertEqual(sample["cores"], 1.5)
            self.assertIsNone(sample["cpu"])
            self.assertIsNone(sample["memory"]["used"])
            self.assertIsNone(sample["memory"]["available"])
            self.assertEqual(sample["swap"], {"total": None, "used": None})
            files[("/cg", "cpu.stat")] = "usage_usec 5000000"
            self.assertIsNone(resources.sample(MEMORY, 99, 103)["cpu"])
            files[("/cg", "cpu.stat")] = "usage_usec 1000"
            self.assertIsNone(resources.sample(MEMORY, 99, 106)["cpu"])
            files[("/cg", "cpu.max")] = "100000 100000"
            self.assertIsNone(resources.sample(MEMORY, 99, 109)["cpu"])

    def test_visible_parent_limit_and_effective_cpuset_are_respected(self):
        resources = self.resources(("/cg/child", "/cg"))
        files = {("/cg/child", "cpu.max"): "max 100000", ("/cg", "cpu.max"): "3200000 100000",
                 ("/cg/child", "cpuset.cpus.effective"): "0-7,16-23",
                 ("/cg/child", "memory.max"): "max", ("/cg", "memory.max"): str(160 * 1024**3),
                 ("/cg", "memory.current"): str(120 * 1024**3)}
        with self.reader(files), patch("backend.server_collector.os.cpu_count", return_value=192):
            sample = resources.sample(MEMORY, 99, 100)
        self.assertEqual(sample["cores"], 16)
        self.assertEqual(sample["memory"]["used"], 120 * 1024**3)

    def test_cgroup_namespace_and_nested_mount_mapping(self):
        for membership, mount, expected in [
            ("0::/\n", "1 0 0:29 / /sys/fs/cgroup ro - cgroup2 cgroup rw", ["/sys/fs/cgroup"]),
            ("0::/group/child\n", "1 0 0:29 /group /sys/fs/cgroup ro - cgroup2 cgroup rw",
             ["/sys/fs/cgroup/child", "/sys/fs/cgroup"]),
            ("2:memory:/group\n", "1 0 0:29 / /sys/fs/cgroup ro - cgroup cgroup rw", []),
        ]:
            with self.subTest(membership=membership), patch("backend.server_collector.read_text", side_effect=[membership, mount]):
                self.assertEqual(cgroup_v2_paths(), expected)
