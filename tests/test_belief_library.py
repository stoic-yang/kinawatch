from __future__ import annotations

import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from backend.beliefs import BeliefLibrary, legacy_entries
from backend.journal_repository import JournalRepository
from backend.server import DashboardApplication, DashboardRequestHandler, IdleHTTPServer
from backend.workflow_writer import WorkflowWriteConflict, WorkflowWriteDisabled, WorkflowWriteValidation
from test_journal_document import fixture_settings


FIRST = "b-" + "1" * 32
SECOND = "b-" + "2" * 32
SOURCE = '\ufeff---\r\ntags: [合成, 测试]\r\naliases: ["保持原文"]\r\n---\r\n\r\n# 合成原则\r\n\r\n> 只用测试文件。\r\n'


class BeliefLibraryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.settings = fixture_settings(self.root)
        self.settings.raw['activitywatch'] = {'timezone': 'Asia/Shanghai', 'categories_file': str(Path(__file__).resolve().parents[1] / 'config/categories.example.json')}
        self.repository = JournalRepository(self.settings)
        self.library = BeliefLibrary(self.repository)

    def save(self, identifier=FIRST, source=SOURCE, expected=None):
        return self.library.save({'namespace': self.library.namespace, 'id': identifier, 'markdown': source, 'expected_fingerprint': expected})

    def manage(self, action, **fields):
        before = self.library.read()
        return self.library.manage({'namespace': self.library.namespace, 'action': action, 'expected_revision': before['revision'], **fields})

    def test_read_is_side_effect_free_and_raw_markdown_survives_restart(self):
        self.assertEqual(self.library.read()['records'], [])
        self.assertFalse(self.library.root.exists())
        saved = self.save()['records'][0]
        self.assertEqual(saved['markdown'], SOURCE)
        self.assertEqual((self.library.root / saved['path']).read_bytes(), SOURCE.encode())
        self.assertEqual(BeliefLibrary(self.repository).read()['records'][0]['markdown'], SOURCE)
        self.assertFalse((self.library.root / 'Daily').exists())
        with self.assertRaises(WorkflowWriteConflict):
            self.save()
        revised = self.save(source=SOURCE + '\r\n下一步。', expected=saved['fingerprint'])
        self.assertTrue(revised['records'][0]['markdown'].endswith('下一步。'))

    def test_legacy_copy_on_explicit_save_keeps_original_bytes_and_stable_management(self):
        note = self.repository.locate_beliefs().note
        note.parent.mkdir(parents=True)
        original = '\ufeff---\r\ntags: [合成]\r\n---\r\n# 原稿\r\n\r\n## 1. 原则甲\r\n正文甲。\r\n```md\r\n## 不是信念\r\n```\r\n\r\n## 2. 原则乙\r\n正文乙。'.encode()
        note.write_bytes(original)
        before = self.library.read()
        self.assertEqual(len(before['records']), 2)
        self.assertFalse(self.library.directory.exists())
        first = before['records'][0]
        self.assertIn('# 原则甲\r\n', first['markdown'])
        self.manage('like', id=first['id'], value=True, day=before['today'])
        self.manage('order', order=[row['id'] for row in before['records']])
        saved = self.save(first['id'], '# 修改后的原则\n\n#测试', first['fingerprint'])
        self.assertEqual(len(saved['records']), 2)
        row = next(item for item in saved['records'] if item['id'] == first['id'])
        self.assertFalse(row['legacy']); self.assertEqual(row['like_count'], 1)
        self.assertEqual(saved['order'][0], first['id'])
        self.assertEqual(note.read_bytes(), original)
        self.assertEqual(len(list(self.library.directory.glob('*.md'))), 1)

    def test_daily_like_is_idempotent_and_cancellation_keeps_prior_days(self):
        self.save()
        with patch('backend.beliefs.datetime') as clock:
            clock.now.return_value = datetime.fromisoformat('2026-09-10T23:59:59+08:00')
            clock.strptime = datetime.strptime
            first = self.manage('like', id=FIRST, value=True, day='2026-09-10')
            self.assertEqual(first['records'][0]['like_count'], 1)
            repeated = self.manage('like', id=FIRST, value=True, day='2026-09-10')
            self.assertEqual(repeated['records'][0]['like_count'], 1)
            clock.now.return_value = datetime.fromisoformat('2026-09-11T00:00:00+08:00')
            self.assertFalse(self.library.read()['records'][0]['liked_today'])
            with self.assertRaises(WorkflowWriteConflict):
                self.manage('like', id=FIRST, value=True, day='2026-09-10')
            self.manage('like', id=FIRST, value=True, day='2026-09-11')
            undone = self.manage('like', id=FIRST, value=False, day='2026-09-11')
            self.assertEqual(undone['records'][0]['liked_days'], ['2026-09-10'])

    def test_edit_preserves_creation_time_and_default_manual_order(self):
        first = self.save()['records'][0]
        before = self.save(SECOND, '# 新增的合成原则')
        after = self.save(FIRST, '# 修订合成原则', first['fingerprint'])
        self.assertEqual(after['order'], before['order'])
        revised = next(item for item in after['records'] if item['id'] == FIRST)
        self.assertEqual(revised['created_at'], first['created_at'])

    def test_external_edits_and_concurrent_mutations_reject_stale_versions(self):
        first = self.save()['records'][0]
        (self.library.root / first['path']).write_text('# 外部修改')
        with self.assertRaises(WorkflowWriteConflict):
            self.save(source='# 不覆盖', expected=first['fingerprint'])
        before = self.library.read()
        payload = {'namespace': before['namespace'], 'action': 'like', 'id': FIRST, 'value': True, 'day': before['today'], 'expected_revision': before['revision']}
        def attempt(_):
            try: return BeliefLibrary(self.repository).manage(payload)
            except WorkflowWriteConflict: return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(attempt, range(2)))
        self.assertEqual(sum(result is not None for result in results), 1)
        self.assertEqual(self.library.read()['records'][0]['like_count'], 1)

    def test_order_pin_and_invalid_request_never_lose_records(self):
        self.save(); self.save(SECOND, '# 另一个原则')
        self.manage('order', order=[FIRST, SECOND])
        self.manage('pin', id=SECOND, value=True)
        after = BeliefLibrary(self.repository).read()
        self.assertEqual(after['order'], [FIRST, SECOND])
        self.assertTrue(next(item for item in after['records'] if item['id'] == SECOND)['pinned'])
        for order in [[FIRST], [FIRST, FIRST], [FIRST, 'unknown']]:
            with self.assertRaises(WorkflowWriteValidation): self.manage('order', order=order)
        self.assertEqual(self.library.read()['order'], [FIRST, SECOND])
        for payload in [{'id': '../outside'}, {'namespace': 'wrong', 'id': FIRST, 'markdown': '# 不写入', 'expected_fingerprint': after['records'][0]['fingerprint']}]:
            with self.assertRaises((WorkflowWriteValidation, WorkflowWriteConflict)): self.library.save(payload)

    def test_readonly_gate_and_symlink_confinement(self):
        self.settings.raw['journal_write_enabled'] = False
        with self.assertRaises(WorkflowWriteDisabled): self.save()
        self.assertFalse(self.library.directory.exists())
        self.settings.raw['journal_write_enabled'] = True
        self.library.directory.parent.mkdir(parents=True)
        outside = self.root / 'outside'; outside.mkdir()
        self.library.directory.symlink_to(outside)
        for call in [self.library.read, self.save]:
            with self.assertRaises(WorkflowWriteValidation): call()
        self.assertEqual(list(outside.iterdir()), [])

    def test_corrupt_metadata_is_not_silently_reset(self):
        self.save(); self.library.metadata.write_text('{broken')
        with self.assertRaises(WorkflowWriteValidation): self.library.read()
        self.assertEqual(self.library.metadata.read_text(), '{broken')

    def test_http_contract_and_cross_origin_rejection(self):
        app = DashboardApplication(self.settings, aggregator=SimpleNamespace(), activitywatch=object(), activity_editor=object())
        server = IdleHTTPServer(('127.0.0.1', 0), DashboardRequestHandler, app, idle_timeout_seconds=0)
        thread = threading.Thread(target=server.serve_forever); thread.start()
        try:
            base = 'http://127.0.0.1:' + str(server.server_address[1])
            with urlopen(base + '/api/beliefs') as response: snapshot = json.load(response)
            payload = {'namespace': snapshot['namespace'], 'id': FIRST, 'markdown': SOURCE, 'expected_fingerprint': None}
            request = Request(base + '/api/beliefs/document', data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'}, method='PUT')
            with urlopen(request) as response: saved = json.load(response)
            self.assertEqual(saved['records'][0]['markdown'], SOURCE)
            with self.assertRaises(HTTPError) as caught: urlopen(request)
            self.assertEqual(caught.exception.code, 409)
            caught.exception.close()
            request.add_header('Origin', 'https://example.com')
            with self.assertRaises(HTTPError) as caught: urlopen(request)
            self.assertEqual(caught.exception.code, 403)
            caught.exception.close()
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)
