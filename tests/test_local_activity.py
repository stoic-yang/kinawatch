from __future__ import annotations

import copy
import json
import tempfile
import unittest
from dataclasses import replace
from datetime import date, timedelta
from pathlib import Path

from backend.activity_edits import ActivityEditStore
from backend.activitywatch_adapter import ActivityWatchAdapter
from backend.config import load_settings
from backend.local_activity import LOCAL_BUCKET, LocalActivityStore, timestamp
from backend.paths import EXAMPLE_CONFIG_PATH
from backend.workflow_sessions import build_workflow_snapshot
from scripts.reconstruct_local_activity import reconstruct


def event(identity, start, duration, app="Code"):
    return {"id": identity, "timestamp": start, "duration": duration,
            "data": {"app": app, "title": "Synthetic", "url": ""}}


class Client:
    def __init__(self):
        self.calls = []

    def info(self):
        return {"hostname": "synthetic"}

    def buckets(self):
        return {"window": {"type": "currentwindow", "hostname": "synthetic"},
                "afk": {"type": "afkstatus", "hostname": "synthetic"}}

    def events(self, bucket_id, start, end):
        self.calls.append(bucket_id)
        if bucket_id == "window":
            return [event("captured", "2026-09-11T10:01:00Z", 60)]
        if bucket_id == "afk":
            return [{"timestamp": "2026-09-11T10:00:00Z", "duration": 180,
                     "data": {"status": "not-afk"}}]
        raise AssertionError("Local records must never be queried through ActivityWatch")


class LocalActivityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "local.json"
        base = load_settings(EXAMPLE_CONFIG_PATH)
        self.settings = replace(base, raw={**base.raw, "local_activity_file": str(self.path),
            "activitywatch": {**base.raw["activitywatch"], "timezone": "UTC"}})
        self.events = [event("local", "2026-09-11T10:00:00Z", 300)]
        self.write(self.events)
        self.store = LocalActivityStore(self.settings)
        self.client = Client()
        self.adapter = ActivityWatchAdapter(self.settings, self.client,
            edit_store=ActivityEditStore(self.settings, Path(self.directory.name) / "edits.json"))

    def write(self, events):
        self.path.write_text(json.dumps({"version": 1, "events": events}))

    def test_capture_precedence_afk_filter_batch_parity_and_inspection(self):
        before = self.path.read_bytes()
        day = date(2026, 9, 11)
        single = self.adapter.load_day(day, "calendar")
        self.assertEqual(single, self.adapter.load_days([day], "calendar")[day])
        self.assertEqual(single["total_duration_seconds"], 180)
        local = [e for e in single["events"] if e.get("source_type") == "kinawatch-local"]
        self.assertEqual(sum(e["duration_seconds"] for e in local), 120)
        self.assertEqual(sum(s["duration_seconds"] for s in single["sources"]), 180)
        self.assertEqual(single["sources"][0]["observed_duration_seconds"], 60)
        self.assertEqual(single["sources"][1]["observed_duration_seconds"], 240)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(set(self.client.calls), {"window", "afk"})
        inspected = self.adapter.inspect_events(day, "calendar", LOCAL_BUCKET, ["local"])
        row = inspected["events"][0]
        self.assertTrue(row["editable"])
        self.assertEqual(row["effective"]["app"], "Code")
        self.assertEqual(self.adapter.inspect_events(day + timedelta(days=1), "calendar", LOCAL_BUCKET, ["local"])["events"], [])

    def test_invalid_snapshot_preserves_captured_activity_and_reports_error(self):
        valid = self.adapter.correction_fingerprint(date(2026, 9, 11))
        self.path.write_text('{"version": 1, "events": [')
        self.assertNotEqual(valid, self.adapter.correction_fingerprint(date(2026, 9, 11)))
        result = self.adapter.load_day(date(2026, 9, 11), "calendar")
        self.assertEqual(result["total_duration_seconds"], 60)
        self.assertFalse(result["complete"])
        self.assertTrue(result["issues"])

    def test_fingerprint_covers_routine_early_hours_and_only_relevant_days(self):
        previous = self.store.fingerprint(date(2026, 9, 10))
        changed = self.store.fingerprint(date(2026, 9, 11))
        self.events[0]["data"]["title"] = "Changed"
        self.write(self.events)
        self.assertEqual(previous, self.store.fingerprint(date(2026, 9, 10)))
        self.assertNotEqual(changed, self.store.fingerprint(date(2026, 9, 11)))
        self.write([event("early", "2026-09-12T02:00:00Z", 60)])
        self.assertTrue(self.store.fingerprint(date(2026, 9, 11)))
        self.assertTrue(self.store.fingerprint(date(2026, 9, 12)))

    def test_rejects_duplicate_overlap_nonfinite_naive_and_future_events(self):
        invalid = [self.events * 2,
                   [self.events[0], event("overlap", "2026-09-11T10:00:01Z", 60)],
                   [event("nan", "2026-09-11T10:00:00Z", float("nan"))],
                   [event("naive", "2026-09-11T10:00:00", 60)],
                   [event("future", "2099-01-01T10:00:00Z", 60)]]
        for events in invalid:
            with self.subTest(events=events):
                self.write(events)
                with self.assertRaises(ValueError):
                    self.store.read()

    def test_local_correction_uses_original_fingerprint_and_preserves_snapshot(self):
        day = date(2026, 9, 11)
        inspected = self.adapter.inspect_events(day, "calendar", LOCAL_BUCKET, ["local"])["events"][0]
        before = self.path.read_bytes()
        self.adapter.activity_edits.upsert(day=day, bucket_id=LOCAL_BUCKET, event_id="local",
            source_fingerprint=inspected["source_fingerprint"], patch={"app": "Edited"},
            expected_revision=self.adapter.activity_edits.revision_token())
        local = [e for e in self.adapter.load_day(day, "calendar")["events"] if e.get("source_type") == "kinawatch-local"]
        self.assertTrue(all(e["app"] == "Edited" for e in local))
        self.assertEqual(self.path.read_bytes(), before)
        self.events[0]["data"]["title"] = "Source changed"
        self.write(self.events)
        result = self.adapter.load_day(day, "calendar")
        self.assertTrue(result["issues"])
        self.assertTrue(all(e["app"] == "Code" for e in result["events"]))

    def test_local_mac_events_form_workflows_without_mobile_contribution(self):
        local = {"kind": "screen", "start": "2026-09-11T10:00:00+00:00",
                 "end": "2026-09-11T10:20:00+00:00", "duration_seconds": 600,
                 "device_duration_seconds": 1200, "source_type": "kinawatch-local"}
        phone = {**local, "source_type": "apple-screentime"}
        result = build_workflow_snapshot([local, phone], local["end"])
        self.assertEqual(result["sessions"][0]["active_seconds"], 1200)


class ReconstructionTests(unittest.TestCase):
    def test_caps_unknown_gaps_respects_session_stop_and_afk_and_does_not_infer_chrome(self):
        start, end = timestamp("2026-09-11T10:00:00Z"), timestamp("2026-09-11T10:10:00Z")
        def observation(seconds, kind="window.changed", app="Code"):
            return {"id": seconds, "timestamp": (start + timedelta(seconds=seconds)).isoformat(),
                    "kind": kind, **({"app": {"name": app}, "window": {"title": "Synthetic"}} if app else {})}
        history = [observation(0), observation(300), observation(330, "session.ended", None),
                   observation(500, "session.started", None), observation(520)]
        afk = [{"timestamp": start.isoformat(), "duration": 60, "data": {"status": "not-afk"}},
               {"timestamp": (start + timedelta(seconds=300)).isoformat(), "duration": 300,
                "data": {"status": "not-afk"}}]
        chrome = [event("chrome", start.isoformat(), 600, "Chrome")]
        before = copy.deepcopy((history, afk, chrome))
        result, report = reconstruct(history, afk, chrome, start, end)
        self.assertEqual([e["duration"] for e in result["events"]], [60, 30, 80])
        self.assertTrue(all(e["data"]["app"] == "Code" for e in result["events"]))
        self.assertEqual(report["recovered_seconds"], 170)
        self.assertEqual(before, (history, afk, chrome))
        self.assertEqual(result, reconstruct(history, afk, chrome, start, end)[0])
