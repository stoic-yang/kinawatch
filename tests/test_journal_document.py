from __future__ import annotations

import json
import socket
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import Mock, patch

from backend.config import DashboardSettings
from backend.journal_repository import JournalRepository
from backend.server import (
    MAX_DOCUMENT_BODY_BYTES,
    DashboardApplication,
    DashboardRequestHandler,
    IdleHTTPServer,
)
from backend.workflow_writer import (
    WorkflowWriteConflict,
    WorkflowWriteValidation,
    WorkflowWriter,
)


DAY = "2026-09-02"


def fixture_settings(root: Path, provider: str = "local", enabled: bool = True) -> DashboardSettings:
    journal = {
        "provider": provider,
        "daily_notes_dir": "Daily",
        # Full-document creation must not silently insert the legacy template.
        "daily_note_template": ["## 旧模板", "不要插入正文"],
    }
    if provider == "local":
        journal["storage_dir"] = str(root / "managed")
    else:
        journal["vault"] = str(root / "vault")
        journal["vault_name"] = "Fixture notes"
    return DashboardSettings(
        config_path=root / "kinawatch.json",
        raw={
            "host": "127.0.0.1",
            "cache_dir": str(root / "cache"),
            "journal_write_enabled": enabled,
            "journal": journal,
        },
    )


class JournalDocumentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repository = JournalRepository(fixture_settings(self.root))
        self.writer = WorkflowWriter(self.repository)
        self.location = self.repository.locate(date.fromisoformat(DAY))

    def seed(self, content: bytes) -> None:
        self.location.note.parent.mkdir(parents=True, exist_ok=True)
        self.location.note.write_bytes(content)

    def save(self, markdown: str, expected: dict | None = None) -> dict:
        return self.writer.upsert_document({
            "date": DAY,
            "markdown": markdown,
            "expected_fingerprint": expected or self.writer.read_document(DAY)["journal_fingerprint"],
        })

    def test_read_missing_does_not_create_and_first_save_is_only_body(self) -> None:
        loaded = self.writer.read_document(DAY)
        self.assertFalse(loaded["exists"])
        self.assertFalse(loaded["has_frontmatter"])
        self.assertEqual(loaded["markdown"], "")
        self.assertEqual(loaded["path"], f"Daily/{DAY}.md")
        self.assertEqual(loaded["provider"], "local")
        self.assertEqual(loaded["open_url"], "")
        self.assertFalse(self.location.vault.exists())

        body = "  # 自己写的标题\n\n第一段。\n\n"
        saved = self.save(body, loaded["journal_fingerprint"])
        self.assertTrue(saved["created"])
        self.assertTrue(saved["changed"])
        self.assertEqual(saved["markdown"], body)
        self.assertEqual(self.location.note.read_bytes(), body.encode())
        self.assertEqual(self.writer.read_document(DAY)["markdown"], body)

    def test_future_notes_round_trip_for_both_providers_without_touching_other_dates(self) -> None:
        for provider in ("local", "obsidian"):
            repository = JournalRepository(fixture_settings(self.root / provider, provider))
            writer = WorkflowWriter(repository)
            today = date.today()
            current_note = repository.locate(today).note
            current_note.parent.mkdir(parents=True)
            current_note.write_bytes(b"Keep today's note unchanged.\n")
            for offset in (1, 40, 400):
                target = today + timedelta(days=offset)
                with self.subTest(provider=provider, date=target):
                    loaded = writer.read_document(target.isoformat())
                    note = repository.locate(target).note
                    self.assertFalse(note.exists())
                    body = f"# 提前计划 {target}\n\n- [ ] 准备阅读材料\n"
                    payload = {
                        "date": target.isoformat(),
                        "markdown": body,
                        "expected_fingerprint": loaded["journal_fingerprint"],
                    }
                    saved = writer.upsert_document(payload)
                    self.assertTrue(saved["created"])
                    self.assertEqual(note.read_text(), body)
                    self.assertEqual(writer.read_document(target.isoformat())["markdown"], body)
                    with self.assertRaises(WorkflowWriteConflict):
                        writer.upsert_document({**payload, "markdown": "stale draft"})
                    self.assertEqual(note.read_text(), body)
                    self.assertEqual(current_note.read_bytes(), b"Keep today's note unchanged.\n")

    def test_frontmatter_and_all_unknown_body_round_trip_without_normalizing(self) -> None:
        prefix = (
            b"\xef\xbb\xbf---\r\n"
            b"title: '2026-09-02'  # keep this comment\r\n"
            b"tags:\r\n  - review\r\ncustom: {nested: true}\r\n---\r\n"
        )
        body = (
            "\r\n# 日记原文\r\n\r\n未知段落含 [[链接]]。  \r\n"
            "> [!note]- 工作流\r\n> - **09:00-10:00**：自己写的说明。\r\n\r\n"
            "> [!note]- 复盘\r\n> **自由记录**\r\n> 从前的正文。\r\n"
            "- [x] 完成复盘\r\n\r\n## Kina 建议\r\n已有文字也属于正文。\r\n"
        )
        original = prefix + body.encode()
        self.seed(original)
        loaded = self.writer.read_document(DAY)
        self.assertTrue(loaded["has_frontmatter"])
        self.assertEqual(loaded["markdown"], body)
        unchanged = self.save(body, loaded["journal_fingerprint"])
        self.assertFalse(unchanged["changed"])
        self.assertEqual(unchanged["journal_fingerprint"], loaded["journal_fingerprint"])
        self.assertEqual(self.location.note.read_bytes(), original)

        edited = body.replace("未知段落", "现在可编辑的段落") + "\r\n末段  "
        saved = self.save(edited, unchanged["journal_fingerprint"])
        self.assertFalse(saved["created"])
        self.assertTrue(saved["changed"])
        self.assertEqual(self.location.note.read_bytes(), prefix + edited.encode())
        self.assertEqual(self.writer.read_document(DAY)["markdown"], edited)

    def test_body_may_exceed_8000_characters_and_keep_leading_trailing_whitespace(self) -> None:
        body = "\n" + "长文 [[引用]] 🙂\n" * 3000 + "\n  "
        self.assertGreater(len(body), 8000)
        saved = self.save(body)
        self.assertEqual(saved["markdown"], body)
        self.assertEqual(self.location.note.read_bytes(), body.encode())

    def test_clear_body_preserves_properties_and_allows_empty_file_creation(self) -> None:
        prefix = b"---\ntitle: fixture\n---\n"
        self.seed(prefix + "旧正文".encode())
        cleared = self.save("")
        self.assertEqual(cleared["markdown"], "")
        self.assertTrue(cleared["exists"])
        self.assertEqual(self.location.note.read_bytes(), prefix)

        other_day = "2026-09-03"
        before = self.writer.read_document(other_day)
        empty = self.writer.upsert_document({
            "date": other_day, "markdown": "",
            "expected_fingerprint": before["journal_fingerprint"],
        })
        self.assertTrue(empty["created"])
        other = self.repository.locate(date.fromisoformat(other_day)).note
        self.assertEqual(other.read_bytes(), b"")
        self.assertTrue(self.writer.read_document(other_day)["exists"])

    def test_new_yaml_looking_body_gets_boundary_without_hiding_user_text(self) -> None:
        body = "---\ntitle: this is user text\n---\n正文\n"
        saved = self.save(body)
        self.assertEqual(saved["markdown"], body)
        self.assertTrue(saved["has_frontmatter"])
        self.assertEqual(self.location.note.read_bytes(), b"---\n---\n" + body.encode())
        self.assertEqual(self.writer.read_document(DAY)["markdown"], body)
        unchanged = self.save(body, saved["journal_fingerprint"])
        self.assertFalse(unchanged["changed"])

    def test_ordinary_horizontal_rules_do_not_create_a_yaml_envelope(self) -> None:
        for body in (
            "---\n普通段落\n---\n\n结尾\n",
            "---\n## 标题\n---\n",
            "---\nhttps://example.test/\n---\n",
            "---\n未闭合的分隔线\n",
        ):
            with self.subTest(body=body):
                self.seed(body.encode())
                loaded = self.writer.read_document(DAY)
                self.assertFalse(loaded["has_frontmatter"])
                self.assertEqual(loaded["markdown"], body)
                saved = self.save(body, loaded["journal_fingerprint"])
                self.assertFalse(saved["changed"])
                self.assertEqual(self.location.note.read_bytes(), body.encode())

    def test_existing_frontmatter_is_only_split_once(self) -> None:
        prefix = b"---\nprivate: keep\n---\n"
        body = "---\ntitle: editable YAML example\n---\n\n"
        self.seed(prefix + b"old")
        self.save(body)
        self.assertEqual(self.location.note.read_bytes(), prefix + body.encode())
        self.assertEqual(self.writer.read_document(DAY)["markdown"], body)

    def test_properties_only_eof_and_bom_keep_body_boundary(self) -> None:
        for prefix in (
            b"---\ntitle: fixture\n---",
            b"\xef\xbb\xbf---\r\nname: fixture\r\n...",
        ):
            with self.subTest(prefix=prefix):
                self.seed(prefix)
                self.assertEqual(self.writer.read_document(DAY)["markdown"], "")
                self.save("added")
                self.assertEqual(self.location.note.read_bytes(), prefix + b"\nadded")
                self.assertEqual(self.writer.read_document(DAY)["markdown"], "added")
        self.seed(b"\xef\xbb\xbfplain")
        self.save("new")
        self.assertEqual(self.location.note.read_bytes(), b"\xef\xbb\xbfnew")

    def test_obsidian_keeps_fixed_existing_suffixed_note_and_open_url(self) -> None:
        repository = JournalRepository(fixture_settings(self.root, "obsidian"))
        writer = WorkflowWriter(repository)
        before = writer.read_document(DAY)
        self.assertFalse(before["exists"])
        self.assertFalse((self.root / "vault").exists())
        directory = self.root / "vault" / "Daily"
        directory.mkdir(parents=True)
        note = directory / f"{DAY} 周三.md"
        note.write_text("原文", encoding="utf-8")
        loaded = writer.read_document(DAY)
        self.assertEqual(loaded["path"], f"Daily/{DAY} 周三.md")
        self.assertEqual(loaded["provider"], "obsidian")
        self.assertTrue(loaded["open_url"].startswith("obsidian://open?"))
        saved = writer.upsert_document({
            "date": DAY, "markdown": "改过的原文",
            "expected_fingerprint": loaded["journal_fingerprint"],
        })
        self.assertEqual(saved["open_url"], loaded["open_url"])
        self.assertEqual(note.read_text(encoding="utf-8"), "改过的原文")
        self.assertFalse((directory / f"{DAY}.md").exists())
        missing_day = "2026-09-03"
        missing = writer.read_document(missing_day)
        created = writer.upsert_document({
            "date": missing_day, "markdown": "新日记",
            "expected_fingerprint": missing["journal_fingerprint"],
        })
        self.assertTrue(created["created"])
        self.assertEqual((directory / f"{missing_day}.md").read_text(encoding="utf-8"), "新日记")

    def test_stale_versions_and_wrong_date_cannot_replace_notes(self) -> None:
        self.seed(b"first")
        loaded = self.writer.read_document(DAY)
        self.seed(b"external editor changed the entire file")
        with self.assertRaises(WorkflowWriteConflict):
            self.save("stale", loaded["journal_fingerprint"])
        self.assertEqual(self.location.note.read_bytes(), b"external editor changed the entire file")
        with self.assertRaises(WorkflowWriteConflict):
            self.writer.upsert_document({
                "date": "2026-09-03", "markdown": "wrong day",
                "expected_fingerprint": loaded["journal_fingerprint"],
            })
        self.assertFalse(self.repository.locate(date(2026, 9, 3)).note.exists())

    def test_concurrent_edits_accept_only_one_shared_version(self) -> None:
        self.seed(b"first")
        expected = self.writer.read_document(DAY)["journal_fingerprint"]
        barrier = threading.Barrier(2)

        def attempt(body: str) -> str:
            barrier.wait(timeout=3)
            try:
                self.save(body, expected)
                return body
            except WorkflowWriteConflict:
                return "conflict"

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(attempt, ["writer one", "writer two"]))
        self.assertEqual(results.count("conflict"), 1)
        self.assertEqual(self.location.note.read_text(), next(r for r in results if r != "conflict"))

    def test_external_change_during_atomic_write_is_rejected_and_temp_removed(self) -> None:
        self.seed(b"first")
        expected = self.writer.read_document(DAY)["journal_fingerprint"]
        original_atomic = self.writer._atomic_write

        def externally_changed(path, content, fingerprint):
            path.write_bytes(b"external change before atomic replacement")
            return original_atomic(path, content, fingerprint)

        with patch.object(self.writer, "_atomic_write", side_effect=externally_changed):
            with self.assertRaises(WorkflowWriteConflict):
                self.save("must not replace external content", expected)
        self.assertEqual(self.location.note.read_bytes(), b"external change before atomic replacement")
        self.assertEqual(list(self.location.note.parent.glob("*.tmp")), [])

    def test_snapshot_retries_external_edit_instead_of_pairing_old_body_with_new_version(self) -> None:
        self.seed(b"old")
        read_bytes = Path.read_bytes
        edited = False

        def race(path):
            nonlocal edited
            content = read_bytes(path)
            if path == self.location.note and not edited:
                edited = True
                path.write_bytes(b"new external body")
            return content

        with patch.object(Path, "read_bytes", race):
            loaded = self.writer.read_document(DAY)
        self.assertEqual(loaded["markdown"], "new external body")
        self.assertEqual(loaded["journal_fingerprint"], self.repository.locate(date.fromisoformat(DAY)).fingerprint.to_dict())

    def test_validation_and_symbolic_links_cannot_redirect_date_identity(self) -> None:
        for value in (None, "", "20260902", "2026-99-02", "../2026-09-02", 20260902):
            with self.subTest(date=value), self.assertRaises(WorkflowWriteValidation):
                self.writer.read_document(value)
        before = self.writer.read_document(DAY)
        valid = {"date": DAY, "markdown": "text", "expected_fingerprint": before["journal_fingerprint"]}
        for payload in (
            {**valid, "path": "other.md"},
            {**valid, "markdown": None},
            {**valid, "markdown": "\ud800"},
            {"date": DAY, "markdown": "missing fingerprint"},
        ):
            with self.subTest(payload=payload), self.assertRaises(WorkflowWriteValidation):
                self.writer.upsert_document(payload)
        self.assertFalse(self.location.vault.exists())

        outside = self.root / "outside.md"
        outside.write_bytes(b"keep")
        self.location.note.parent.mkdir(parents=True)
        self.location.note.symlink_to(outside)
        with self.assertRaises(WorkflowWriteValidation):
            self.writer.read_document(DAY)
        with self.assertRaises(WorkflowWriteValidation):
            self.writer.upsert_document(valid)
        self.assertEqual(outside.read_bytes(), b"keep")


class JournalDocumentEndpointTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.settings = fixture_settings(self.root)
        self.cache = SimpleNamespace(invalidate=Mock())
        self.application = DashboardApplication(
            self.settings,
            aggregator=SimpleNamespace(cache=self.cache),
            activitywatch=object(),
            activity_editor=object(),
        )
        self.server = IdleHTTPServer(
            ("127.0.0.1", 0), DashboardRequestHandler, self.application,
            idle_timeout_seconds=0,
        )
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.addCleanup(self.stop_server)
        host, port = self.server.server_address
        self.base = f"http://{host}:{port}"
        self.endpoint = self.base + "/api/journal/document"

    def stop_server(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def get_document(self, day: str = DAY) -> dict:
        with urlopen(self.endpoint + f"?date={day}", timeout=3) as response:
            return json.load(response)

    def put(self, body: dict, endpoint: str | None = None) -> dict:
        request = Request(
            endpoint or self.endpoint,
            data=json.dumps(body, ensure_ascii=False).encode(),
            headers={"Content-Type": "application/json"},
            method="PUT",
        )
        with urlopen(request, timeout=3) as response:
            return json.load(response)

    def test_real_endpoint_long_document_conflict_and_day_cache_invalidation(self) -> None:
        loaded = self.get_document()
        self.assertTrue(loaded["write_enabled"])
        self.assertFalse((self.root / "managed").exists())
        body = "原文及未知内容\n" * 20000
        self.assertGreater(len(body.encode()), 256 * 1024)
        payload = {"date": DAY, "markdown": body, "expected_fingerprint": loaded["journal_fingerprint"]}
        saved = self.put(payload)
        self.assertTrue(saved["created"])
        self.assertTrue(saved["write_enabled"])
        self.assertEqual(saved["markdown"], body)
        self.assertEqual(self.get_document()["markdown"], body)
        self.cache.invalidate.assert_called_once_with(date.fromisoformat(DAY))
        with self.assertRaises(HTTPError) as conflict:
            self.put(payload)
        self.assertEqual(conflict.exception.code, 409)
        conflict.exception.close()
        no_change = self.put({**payload, "expected_fingerprint": saved["journal_fingerprint"]})
        self.assertFalse(no_change["changed"])
        self.cache.invalidate.assert_called_once()

    def test_read_is_available_while_write_gate_is_disabled(self) -> None:
        self.settings.raw["journal_write_enabled"] = False
        loaded = self.get_document()
        self.assertFalse(loaded["write_enabled"])
        with self.assertRaises(HTTPError) as disabled:
            self.put({"date": DAY, "markdown": "text", "expected_fingerprint": loaded["journal_fingerprint"]})
        self.assertEqual(disabled.exception.code, 403)
        disabled.exception.close()
        self.assertFalse((self.root / "managed").exists())

    def test_invalid_date_and_body_return_400(self) -> None:
        for query in ("", "?date=20260902", "?date=2026-02-30"):
            with self.subTest(query=query), self.assertRaises(HTTPError) as error:
                urlopen(self.endpoint + query, timeout=3)
            self.assertEqual(error.exception.code, 400)
            error.exception.close()
        loaded = self.get_document()
        with self.assertRaises(HTTPError) as error:
            self.put({"date": DAY, "markdown": {}, "expected_fingerprint": loaded["journal_fingerprint"]})
        self.assertEqual(error.exception.code, 400)
        error.exception.close()

    def test_document_transport_cap_and_other_endpoint_cap_stay_separate(self) -> None:
        host, port = self.server.server_address
        for path, length in (
            ("/api/journal/document", MAX_DOCUMENT_BODY_BYTES + 1),
            ("/api/journal/review", 256 * 1024 + 1),
        ):
            with self.subTest(path=path), socket.create_connection((host, port), timeout=3) as connection:
                # The handler rejects the header before trying to read 16 MiB.
                request = (
                    f"PUT {path} HTTP/1.1\r\nHost: {host}:{port}\r\n"
                    f"Content-Type: application/json\r\nContent-Length: {length}\r\n"
                    "Connection: close\r\n\r\n"
                )
                connection.sendall(request.encode())
                response = connection.recv(4096)
                self.assertIn(b" 400 ", response.split(b"\r\n", 1)[0])
        self.assertFalse((self.root / "managed").exists())


if __name__ == "__main__":
    unittest.main()
