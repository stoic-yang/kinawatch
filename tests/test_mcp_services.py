import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from backend import mcp_runtime as runtime
from backend.mcp_services import MCPServiceCenter, MCPServiceError
from backend.server import DashboardRequestHandler, IdleHTTPServer


class MCPServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.workspace = self.base / "workspaces" / "project"
        self.workspace.mkdir(parents=True)
        self.config = {"enabled": True, "store_dir": str(self.base / "state"), "folder_roots": [str(self.base / "workspaces")],
                       "runtime_python": sys.executable, "cloudflared": sys.executable}
        self.center = MCPServiceCenter(self.config)
        self.center.dependency_cache = {"ready": True, "error": "", "version": "fixture"}

    def create_profile(self):
        with patch.object(self.center, "action", return_value={"ok": True}):
            result = self.center.create({"name": "Example project", "workspace": str(self.workspace)})
        return result["id"], self.center.root / "services" / result["id"]

    def test_disabled_and_status_reads_do_not_create_state_or_start_processes(self):
        disabled = MCPServiceCenter({**self.config, "enabled": False})
        with patch("backend.mcp_services.subprocess.Popen") as popen:
            self.assertFalse(disabled.read()["enabled"])
            self.assertEqual(self.center.read()["services"], [])
            self.assertFalse(self.center.root.exists())
            popen.assert_not_called()
        with self.assertRaises(PermissionError):
            disabled.browse()

    def test_picker_lists_directories_without_reading_files_or_following_escapes(self):
        (self.workspace / "notes").mkdir()
        (self.workspace / ".hidden").mkdir()
        (self.workspace / "private.txt").write_text("not returned")
        (self.workspace / "escape").symlink_to(self.base)
        listing = self.center.browse(str(self.workspace))
        self.assertEqual([p["name"] for p in listing["folders"]], ["notes"])
        self.assertNotIn("not returned", json.dumps(listing))
        self.assertTrue(listing["selectable"])
        for raw in (str(self.base), str(self.workspace / "escape"), str(self.workspace / "private.txt"), "bad\x00path"):
            with self.subTest(raw=raw), self.assertRaises(MCPServiceError):
                self.center.folder(raw, select=True)

    def test_service_credential_storage_and_ancestors_cannot_be_exposed(self):
        center = MCPServiceCenter({**self.config, "folder_roots": [str(self.base)]})
        center.root.mkdir()
        for path in (center.root, self.base):
            with self.assertRaises(MCPServiceError):
                center.folder(str(path), select=True)
        self.assertFalse(center.browse(str(self.base))["selectable"])

    def test_create_is_explicit_private_unique_and_does_not_copy_workspace(self):
        (self.workspace / "original.md").write_text("unchanged")
        key, directory = self.create_profile()
        config = runtime.read_json(directory / "config.json")
        self.assertEqual(config["workspace"], str(self.workspace))
        self.assertEqual(config["workspace_identity"], [self.workspace.stat().st_dev, self.workspace.stat().st_ino])
        self.assertGreater(len(config["oauth_password"]), 24)
        self.assertEqual(len(bytes.fromhex(config["token_secret"])), 32)
        self.assertEqual((directory / "config.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual(list(self.workspace.iterdir()), [self.workspace / "original.md"])
        with patch.object(self.center, "action", return_value={"ok": True}):
            same = self.center.create({"name": "Another label", "workspace": str(self.workspace)})
        self.assertTrue(same["existing"])
        self.assertEqual(same["id"], key)
        self.assertEqual(len(self.center.profiles()), 1)

    def test_credentials_require_explicit_action_and_logs_are_redacted(self):
        key, directory = self.create_profile()
        password = self.center.password({"id": key})["password"]
        config = runtime.read_json(directory / "config.json")
        snapshot = self.center.read()
        self.assertNotIn(password, json.dumps(snapshot))
        self.assertNotIn(config["token_secret"], json.dumps(snapshot))
        (directory / "server.log").write_text(password + "\n" + config["token_secret"])
        self.assertNotIn(password, self.center.logs(key)["text"])
        self.assertNotIn(config["token_secret"], self.center.logs(key)["text"])
        for key in ("../config", "a" * 32 + "/../", "legacy-unknown"):
            with self.assertRaises(MCPServiceError):
                self.center.password({"id": key})

    def test_workspace_replacement_and_symlink_retargeting_reject_restart(self):
        _, directory = self.create_profile()
        config = runtime.read_json(directory / "config.json")
        runtime.workspace_unchanged(config)
        self.workspace.rename(self.workspace.with_name("old"))
        self.workspace.mkdir()
        with self.assertRaises(ValueError):
            runtime.workspace_unchanged(config)

    def test_client_cannot_supply_binary_environment_or_shell_commands(self):
        for body in ({"name": "project", "workspace": str(self.workspace), "runtime_python": "/evil"},
                     {"name": "bad\nname", "workspace": str(self.workspace)}):
            with self.assertRaises(MCPServiceError):
                self.center.create(body)
        with self.assertRaises(MCPServiceError):
            self.center.action({"id": "a" * 32, "action": "run-shell"})

    def test_restart_of_manager_adopts_metadata_without_auto_start(self):
        key, directory = self.create_profile()
        runtime.write_json(directory / "state.json", {"server": {"pid": 42, "fingerprint": "owned"}, "tunnel": {"pid": 43, "fingerprint": "owned"},
                                                     "url": "https://fixture-mcp.trycloudflare.com/mcp", "busy": False})
        other = MCPServiceCenter(self.config)
        with patch.object(runtime, "alive", return_value=True), patch.object(runtime, "metadata", return_value=True), patch("subprocess.Popen") as popen:
            snapshot = other.snapshot(key)
            self.assertEqual(snapshot["status"], "running")
            self.assertEqual(snapshot["url"], "https://fixture-mcp.trycloudflare.com/mcp")
            popen.assert_not_called()

    def test_interrupted_operation_becomes_retryable_and_hides_old_url(self):
        key, directory = self.create_profile()
        runtime.write_json(directory / "state.json", {"busy": True, "operation": "start", "started_at": 1,
                                                     "controller": {"pid": 42, "fingerprint": "gone"}, "url": "https://old.trycloudflare.com/mcp"})
        with patch.object(runtime, "alive", return_value=False):
            snapshot = self.center.snapshot(key)
        self.assertFalse(snapshot["busy"])
        self.assertEqual(snapshot["status"], "error")
        self.assertIsNone(snapshot["url"])

    def test_legacy_service_read_preserves_settings_and_url(self):
        legacy = self.base / "legacy"; legacy.mkdir(); (legacy / "logs").mkdir()
        runtime.write_json(legacy / "settings.json", {"workspace": str(self.workspace), "port": 19001, "oauth_password": "legacy-password", "token_secret": "secret"})
        (legacy / "logs/tunnel.stderr.log").write_text("https://existing-mcp.trycloudflare.com\n" + "later diagnostics\n" * 3000)
        before = (legacy / "settings.json").read_bytes()
        center = MCPServiceCenter({**self.config, "legacy_services": [{"id": "old", "name": "Existing", "directory": str(legacy)}]})
        with patch.object(center, "_legacy_running", return_value=True), patch.object(runtime, "metadata", return_value=True):
            snapshot = center.snapshot("legacy-old")
            self.assertEqual(snapshot["url"], "https://existing-mcp.trycloudflare.com/mcp")
            self.assertEqual(snapshot["status"], "running")
            self.assertNotIn("legacy-password", json.dumps(snapshot))
        self.assertEqual((legacy / "settings.json").read_bytes(), before)

    def test_process_identity_prevents_pid_reuse_kill(self):
        with patch.object(runtime, "process_identity", return_value="different"), patch.object(os, "killpg") as kill:
            runtime.stop({"pid": 12345, "fingerprint": "original"})
            kill.assert_not_called()

    def test_lifecycle_can_stop_its_own_detached_process(self):
        directory = self.base / "process"; directory.mkdir()
        identity = runtime.launch([sys.executable, "-c", "import time;time.sleep(30)"], directory, "fixture")
        try:
            self.assertTrue(runtime.alive(identity))
            runtime.stop(identity)
            self.assertFalse(runtime.alive(identity))
        finally:
            runtime.stop(identity)

    def test_runtime_environment_is_oauth_only_and_drops_provider_keys(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "private", "PYTHONPATH": "/untrusted", "CODING_TOOLS_MCP_AUTH_MODE": "none"}):
            env = runtime.runtime_environment({"runtime_python": sys.executable, "oauth_password": "password", "token_secret": "secret"}, self.base)
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertNotIn("PYTHONPATH", env)
        self.assertEqual(env["CODING_TOOLS_MCP_AUTH_MODE"], "oauth")
        self.assertEqual(env["CODING_TOOLS_MCP_TELEMETRY"], "off")

    def test_failed_listener_closes_its_tunnel_and_clears_public_url(self):
        _, directory = self.create_profile()
        pair = {"server": {"pid": 10001, "fingerprint": "server"}, "tunnel": {"pid": 10002, "fingerprint": "tunnel"}}
        runtime.write_json(directory / "state.json", {**pair, "busy": False, "url": "https://fixture.trycloudflare.com/mcp"})
        with patch.object(runtime, "alive", side_effect=lambda value: value == pair["tunnel"]), patch.object(runtime, "stop") as stop:
            runtime.guard_pair(directory)
        state = runtime.read_json(directory / "state.json")
        self.assertIsNone(state["url"])
        self.assertNotIn("server", state)
        self.assertNotIn("tunnel", state)
        self.assertIn("退出", state["error"])
        stop.assert_any_call(pair["tunnel"])

    def test_http_rejects_cross_site_and_form_actions_before_file_or_process_access(self):
        from test_server import StubApplication
        app = StubApplication(); app.mcp_services = self.center
        server = IdleHTTPServer(("127.0.0.1", 0), DashboardRequestHandler, app, idle_timeout_seconds=.2)
        thread = threading.Thread(target=server.serve_until_idle); thread.start()
        base = f"http://127.0.0.1:{server.server_port}/api/mcp/"
        try:
            with urlopen(base + "services") as response:
                self.assertEqual(json.load(response)["services"], [])
            for headers, expected in [({"Content-Type": "application/json"}, 403),
                                      ({"Content-Type": "application/json", "X-KinaWatch-MCP": "1", "Origin": "https://evil.test"}, 403),
                                      ({"Content-Type": "text/plain", "X-KinaWatch-MCP": "1"}, 400)]:
                with self.assertRaises(HTTPError) as caught:
                    urlopen(Request(base + "services", data=b"{}", headers=headers), timeout=2)
                self.assertEqual(caught.exception.code, expected); caught.exception.close()
            self.assertFalse(self.center.root.exists())
        finally:
            thread.join(timeout=1); server.server_close(); thread.join(timeout=1)


if __name__ == "__main__":
    unittest.main()
