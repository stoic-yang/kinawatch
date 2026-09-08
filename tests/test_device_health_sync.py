from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from backend.health_sync import parse_shortcuts, merge_snapshot
from backend.personal_health import PersonalHealthStore
from backend.multi_device_activity import partition_devices, MultiDeviceActivity
from backend.screen_time import ScreenTimeStore
from backend.workflow_sessions import build_workflow_snapshot


def export(steps='120\n180'):
    return {'schema': 'kinawatch.health.v1', 'exported_at': '2026-09-08T10:00:00+08:00',
            'sleep': {'start': '2026-09-06T23:00:00+08:00', 'end': '2026-09-07T07:00:00+08:00', 'value': '在床', 'source': 'Mi Fitness'},
            'steps': {'start': '2026-09-07T12:00:00+08:00\n2026-09-07T13:00:00+08:00',
                      'end': '2026-09-07T12:10:00+08:00\n2026-09-07T13:10:00+08:00', 'value': steps, 'source': 'Phone\nPhone'}}


def parse(payload):
    return parse_shortcuts(json.dumps(payload).encode(), 'Asia/Shanghai')


class HealthSyncTests(unittest.TestCase):
    def test_column_strings_and_source_rules(self):
        day = parse(export())['days'][0]
        self.assertEqual(day['date'], '2026-09-07')
        self.assertEqual(day['sleep']['minutes'], 480)
        self.assertEqual(day['sleep']['basis'], 'in_bed')
        self.assertEqual(day['steps']['count'], 300)

    def test_invalid_columns_empty_permissions_and_unknown_sleep_rejected(self):
        for mutate in (lambda p: p['steps'].update(value='10'),
                       lambda p: p.update(sleep={}, steps={}),
                       lambda p: p['sleep'].update(value='unknown'),
                       lambda p: p['sleep'].update(start='2026-09-06T23:00:00'),
                       lambda p: p['steps'].update(value='NaN\n-1')):
            payload = export(); mutate(payload)
            with self.assertRaises((ValueError, KeyError)): parse(payload)

    def test_partial_first_day_omitted(self):
        payload = export()
        payload['sleep'].update(start='2026-08-31T04:00:00+08:00', end='2026-08-31T07:00:00+08:00')
        self.assertEqual([d['date'] for d in parse(payload)['days']], ['2026-09-07'])

    def test_shortcuts_can_omit_sleep_source_but_steps_require_it(self):
        payload = export(); payload['sleep']['source'] = ''
        sleep = parse(payload)['days'][0]['sleep']
        self.assertEqual(sleep['source'], '来源未提供')
        self.assertEqual(sleep['minutes'], 480)
        payload['steps']['source'] = ''
        with self.assertRaises(ValueError): parse(payload)

    def test_incremental_merge_preserves_history_and_absent_metric(self):
        current = parse(export())
        current['days'].insert(0, {'date': '2026-08-01', 'sleep': None, 'steps': {'count': 50}})
        incoming = export('500\n100'); incoming['sleep'] = {}
        merged = merge_snapshot(current, parse(incoming))
        self.assertEqual(merged['days'][0]['date'], '2026-08-01')
        self.assertEqual(merged['days'][1]['sleep']['minutes'], 480)
        self.assertEqual(merged['days'][1]['steps']['count'], 600)
        stale = export(); stale['exported_at'] = '2026-09-08T09:00:00+08:00'
        with self.assertRaises(ValueError): merge_snapshot(current, parse(stale))

    def test_repeated_sync_is_idempotent_and_bad_update_retains_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); path = root / 'incoming.json'
            store = PersonalHealthStore('Asia/Shanghai', root / 'snapshot.json')
            self.assertEqual(store.sync_file(path)['sync']['state'], 'waiting')
            path.write_text(json.dumps(export()))
            first = store.sync_file(path)
            stamp = store.path.stat().st_mtime_ns
            self.assertEqual(first['sync']['state'], 'ready')
            path.touch()
            self.assertEqual(store.sync_file(path)['revision'], first['revision'])
            self.assertEqual(store.path.stat().st_mtime_ns, stamp)
            path.write_text('{"schema":')
            broken = store.sync_file(path)
            self.assertEqual(broken['sync']['state'], 'error')
            self.assertEqual(broken['days'], first['days'])
            self.assertEqual(store.path.stat().st_mtime_ns, stamp)


def event(device, start, end, allocated=None):
    origin = datetime(2026, 9, 7, tzinfo=timezone.utc)
    return {'device_id': device, 'timestamp': (origin + timedelta(seconds=start)).isoformat(),
            'wall_end_timestamp': (origin + timedelta(seconds=end)).isoformat(),
            'duration_seconds': end - start if allocated is None else allocated}


class MultiDeviceTests(unittest.TestCase):
    def test_short_parallel_device_does_not_shorten_workflow_end(self):
        timeline = []
        for device, start, end in [('phone', 0, 3600), ('mac', 60, 120), ('pad', 3300, 4200)]:
            row = event(device, start, end)
            timeline.append({'kind': 'screen', 'start': row['timestamp'], 'end': row['wall_end_timestamp'], 'duration_seconds': row['duration_seconds']})
        result = build_workflow_snapshot(timeline, timeline[-1]['end'])
        self.assertEqual(len(result['sessions']), 1)
        self.assertEqual(result['sessions'][0]['end'], timeline[-1]['end'])

    def test_parallel_three_devices_add_only_union_and_equal_shares(self):
        result, parallel, maximum = partition_devices([event('mac', 0, 600), event('phone', 300, 900), event('pad', 300, 600)])
        self.assertAlmostEqual(sum(e['duration_seconds'] for e in result), 900)
        self.assertEqual((parallel, maximum), (300, 3))
        self.assertAlmostEqual(sum(e['duration_seconds'] for e in result if e['device_id'] == 'mac'), 400)
        self.assertAlmostEqual(sum(e['duration_seconds'] for e in result if e['device_id'] == 'pad'), 100)

    def test_native_parallel_rows_preserve_density_without_mobile(self):
        result, parallel, maximum = partition_devices([event('mac', 0, 600, 300), event('mac', 0, 600, 300)])
        self.assertEqual([e['duration_seconds'] for e in result], [300, 300])
        self.assertEqual((parallel, maximum), (0, 1))

    def test_adjacent_intervals_have_no_overlap(self):
        result, parallel, maximum = partition_devices([event('mac', 0, 300), event('phone', 300, 600)])
        self.assertEqual(sum(e['duration_seconds'] for e in result), 600)
        self.assertEqual((parallel, maximum), (0, 1))

    def test_mac_failure_still_combines_mobile(self):
        mac = Mock()
        mac.load_day.side_effect = ConnectionError('offline')
        mac.timezone_name.return_value = 'UTC'
        mac.date_range.return_value = (datetime(2026, 9, 7, tzinfo=timezone.utc), datetime(2026, 9, 8, tzinfo=timezone.utc))
        wrapper = MultiDeviceActivity(mac, Mock())
        wrapper.combine = lambda activity: {**activity, 'mobile_loaded': True}
        value = wrapper.load_day(date(2026, 9, 7), 'calendar')
        self.assertTrue(value['mobile_loaded']); self.assertFalse(value['complete'])


class ScreenTimeTests(unittest.TestCase):
    def test_corrupt_optional_snapshot_does_not_prevent_startup(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'snapshot.json'
            path.write_text('{broken')
            store = ScreenTimeStore({}, path=path)
            self.assertEqual(store._snapshot['devices'], [])
            self.assertIsNotNone(store.error)
            self.assertEqual(path.read_text(), '{broken')

    def test_merge_refresh_failure_clipping_and_system_exclusion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'streams/restricted/App.InFocus/remote/device').mkdir(parents=True)
            incoming = {'version': 1, 'devices': [{'id': 'device', 'name': '', 'events': [
                {'id': 'e1', 'timestamp': '2026-09-07T00:00:00+00:00', 'end': '2026-09-07T01:00:00+00:00', 'bundle_id': 'com.tencent.xin'},
                {'id': 'lock', 'timestamp': '2026-09-07T01:00:00+00:00', 'end': '2026-09-07T02:00:00+00:00', 'bundle_id': 'com.apple.SleepLockScreen'}]}]}
            runner = Mock(return_value=SimpleNamespace(stdout=json.dumps(incoming)))
            store = ScreenTimeStore({'biome_root': str(root), 'reader_python': '/fixture/python', 'device_names': {'device': 'iPhone'}}, path=root / 'snapshot.json', runner=runner)
            store.refresh(force=True); store.refresh(force=True)
            self.assertEqual(len(store._snapshot['devices'][0]['events']), 2)
            rows, sources = store.read_range(datetime(2026, 9, 7, 0, 30, tzinfo=timezone.utc), datetime(2026, 9, 7, 3, tzinfo=timezone.utc))
            self.assertEqual(len(rows), 1); self.assertEqual(rows[0]['duration_seconds'], 1800)
            self.assertEqual(rows[0]['source'], 'iPhone'); self.assertEqual(rows[0]['app'], '微信')
            self.assertNotIn('event_refs', rows[0])
            runner.side_effect = subprocess.TimeoutExpired('reader', 45)
            store.refresh(force=True)
            self.assertIsNotNone(store.error)
            self.assertEqual(len(store._snapshot['devices'][0]['events']), 2)
            self.assertEqual(sources[0]['coverage'], 'observed')
