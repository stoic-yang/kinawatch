"""Mobile identities must not inherit unrelated names, sources or cached matches."""
import json
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path

from backend.activitywatch_adapter import ActivityWatchAdapter
from backend.screen_time import ScreenTimeStore


class MobileClassificationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rules = json.loads((Path(__file__).parents[1] / 'config/categories.example.json').read_text())

    def test_identity_survives_localization_and_cannot_match_other_sources(self):
        events = [
            {'app': 'Custom name', 'title': '', 'bundle_id': 'tv.danmaku.bilianime', 'source_type': 'apple-screentime'},
            {'app': 'Custom name', 'title': '', 'bundle_id': 'com.tencent.mqq', 'source_type': 'apple-screentime'},
            {'app': 'Custom name', 'title': '', 'bundle_id': 'tv.danmaku.bilianime', 'source_type': 'activitywatch-rest'},
            {'app': 'Custom name', 'title': '', 'bundle_id': 'unknown.app', 'source_type': 'apple-screentime'},
        ]
        expected = ['video', 'communication', None, None]
        matches = ActivityWatchAdapter._classify_events(events, self.rules)
        self.assertEqual([m['category'] if m else None for _, m in matches], expected)
        events[0]['manual_category'] = 'coursework'
        matches = ActivityWatchAdapter._classify_events(events, self.rules)
        self.assertEqual(matches[0][1]['category'], 'coursework')

    def test_no_inferred_subject_for_video_notes_or_remote_apps(self):
        for bundle, category in [
            ('tv.danmaku.bilibilihd', 'video'), ('com.google.ios.youtube', 'video'),
            ('com.xingin.discover', 'social'), ('com.goodnotesapp.x', 'writing'),
            ('org.zotero.ios.Zotero', 'research'), ('com.netease.uuremote', 'remote'),
            ('com.ssreader.ChaoXingStudy', 'coursework'), ('com.360buy.jdmobile', 'life'),
            ('com.apple.Preferences', 'system'), ('com.apple.InCallService', 'communication'),
        ]:
            with self.subTest(bundle=bundle):
                event = {'bundle_id': bundle, 'source_type': 'apple-screentime', 'title': ''}
                self.assertEqual(ActivityWatchAdapter._classify(event, self.rules)['category'], category)

    def test_app_fallback_does_not_override_future_explicit_content(self):
        rules = {'categories': {'coursework': {'label': '课程'}}, 'rules': [
            *self.rules['rules'], {'category': 'coursework', 'title_contains': ['Example course']},
        ]}
        event = {'bundle_id': 'tv.danmaku.bilianime', 'source_type': 'apple-screentime', 'title': 'Example course'}
        self.assertEqual(ActivityWatchAdapter._classify(event, rules)['category'], 'coursework')

    def test_name_override_invalidates_cached_days_without_modifying_capture(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'snapshot.json'
            data = {'version': 1, 'devices': [{'id': 'phone', 'label': 'iPhone', 'events': [
                {'id': 'one', 'bundle_id': 'com.tencent.mqq', 'timestamp': '2026-09-07T00:00:00+00:00', 'end': '2026-09-07T00:01:00+00:00'},
            ]}]}
            path.write_text(json.dumps(data))
            before = path.read_bytes()
            store = ScreenTimeStore({}, path=path)
            store.refresh = lambda **kwargs: None
            first = store.fingerprint(date(2026, 9, 7))
            store.config['app_names'] = {'com.tencent.mqq': 'Custom name'}
            self.assertNotEqual(first, store.fingerprint(date(2026, 9, 7)))
            events, _ = store.read_range(datetime(2026, 9, 7, tzinfo=timezone.utc), datetime(2026, 9, 8, tzinfo=timezone.utc))
            self.assertEqual(events[0]['app'], 'Custom name')
            self.assertEqual(events[0]['bundle_id'], 'com.tencent.mqq')
            self.assertEqual(path.read_bytes(), before)
