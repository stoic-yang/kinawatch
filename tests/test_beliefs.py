from __future__ import annotations

import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import Mock

from backend.journal_repository import JournalRepository
from backend.server import DashboardApplication, DashboardRequestHandler, IdleHTTPServer
from backend.workflow_writer import WorkflowWriter, WorkflowWriteConflict, WorkflowWriteValidation
from tests.test_journal_document import fixture_settings


class BeliefsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.settings = fixture_settings(self.root)
        self.repository = JournalRepository(self.settings)
        self.writer = WorkflowWriter(self.repository)

    def save(self, text, version):
        return self.writer.upsert_beliefs({"markdown": text, "expected_fingerprint": version})

    def test_read_never_creates_and_save_is_independent_of_daily_or_incoming_notes(self):
        before = self.writer.read_beliefs()
        self.assertFalse(before["exists"])
        self.assertFalse((self.root / "managed").exists())
        self.assertNotIn("date", before)
        self.assertEqual(before["path"], "Review/我的人生信念.md")
        initial = "## 合成原则\n\n先记录事实。\n"
        saved = self.save(initial, before["journal_fingerprint"])
        self.assertEqual(saved["markdown"], initial)
        self.assertEqual(self.writer.read_beliefs()["markdown"], initial)
        self.assertFalse((self.root / "managed/incoming.md").exists())
        self.assertFalse((self.root / "managed/Daily").exists())
        cleared = self.save("", saved["journal_fingerprint"])
        self.assertEqual(cleared["markdown"], "")
        with self.assertRaises(WorkflowWriteConflict):
            self.save("旧版本覆盖", saved["journal_fingerprint"])
        self.assertEqual(self.writer.read_beliefs()["markdown"], "")

    def test_both_providers_preserve_properties_and_bom(self):
        for provider in ["local", "obsidian"]:
            with self.subTest(provider=provider):
                repository = JournalRepository(fixture_settings(self.root / provider, provider))
                writer = WorkflowWriter(repository)
                location = repository.locate_beliefs()
                location.note.parent.mkdir(parents=True)
                prefix = b'\xef\xbb\xbf---\r\ntags: [beliefs]\r\n---\r\n'
                location.note.write_bytes(prefix + "原有信念\r\n".encode())
                loaded = writer.read_beliefs()
                self.assertEqual(loaded["markdown"], "原有信念\r\n")
                self.assertTrue(loaded["has_frontmatter"])
                self.assertEqual(bool(loaded["open_url"]), provider == "obsidian")
                writer.upsert_beliefs({"markdown": "## 合成修订\n保持留白。\n", "expected_fingerprint": loaded["journal_fingerprint"]})
                self.assertEqual(location.note.read_bytes(), prefix + "## 合成修订\n保持留白。\n".encode())

    def test_path_payload_and_missing_markdown_are_rejected(self):
        version = self.writer.read_beliefs()["journal_fingerprint"]
        for payload in [{"expected_fingerprint": version}, {"markdown": None}, {"markdown": "a", "path": "Daily/2026-09-02.md"}, {"markdown": "a", "date": "2026-09-02"}]:
            with self.subTest(payload=payload), self.assertRaises(WorkflowWriteValidation):
                self.writer.upsert_beliefs(payload)
        self.assertFalse((self.root / "managed").exists())

    def test_config_path_and_symlink_cannot_escape_storage(self):
        for target in ["../outside.md", "/outside.md", "beliefs.txt"]:
            settings = fixture_settings(self.root)
            settings.raw["journal"]["beliefs_note_path"] = target
            with self.subTest(target=target), self.assertRaises(ValueError):
                JournalRepository(settings).locate_beliefs()
        location = self.repository.locate_beliefs()
        location.note.parent.mkdir(parents=True)
        outside = self.root / "outside.md"
        outside.write_text("不要更改")
        location.note.symlink_to(outside)
        with self.assertRaises(WorkflowWriteValidation):
            self.writer.read_beliefs()
        self.assertEqual(outside.read_text(), "不要更改")

    def test_endpoint_long_save_conflict_readonly_and_no_day_cache_invalidation(self):
        cache = SimpleNamespace(invalidate=Mock())
        application = DashboardApplication(self.settings, aggregator=SimpleNamespace(cache=cache), activitywatch=object(), activity_editor=object())
        server = IdleHTTPServer(("127.0.0.1", 0), DashboardRequestHandler, application, idle_timeout_seconds=0)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            host, port = server.server_address
            endpoint = f"http://{host}:{port}/api/journal/beliefs"
            with urlopen(endpoint) as response:
                before = json.load(response)
            self.assertTrue(before["write_enabled"])
            text = "合成测试原则，不写真实笔记。\n" * 10000
            payload = {"markdown": text, "expected_fingerprint": before["journal_fingerprint"]}
            request = Request(endpoint, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}, method="PUT")
            with urlopen(request) as response:
                saved = json.load(response)
            self.assertEqual(saved["markdown"], text)
            with self.assertRaises(HTTPError) as caught:
                urlopen(request)
            self.assertEqual(caught.exception.code, 409)
            application.settings = fixture_settings(self.root, enabled=False)
            with self.assertRaises(HTTPError) as caught:
                urlopen(request)
            self.assertEqual(caught.exception.code, 403)
            cache.invalidate.assert_not_called()
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)
