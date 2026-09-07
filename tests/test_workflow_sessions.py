import copy
import unittest
from datetime import datetime, timedelta

from backend.workflow_sessions import build_workflow_snapshot


def block(start, end, seconds=60, title="Synthetic"):
    return {"kind": "screen", "start": start, "end": end,
            "duration_seconds": seconds, "title": title}


class WorkflowSessionTests(unittest.TestCase):
    def test_fifteen_minute_boundary_crosses_midnight_without_counting_gaps(self):
        timeline = [block("2026-09-06T23:35:00+08:00", "2026-09-06T23:45:00+08:00", 600),
                    block("2026-09-07T00:00:00+08:00", "2026-09-07T00:05:00+08:00", 300),
                    block("2026-09-07T00:21:00+08:00", "2026-09-07T00:36:00+08:00", 900)]
        snapshot = build_workflow_snapshot(timeline, "2026-09-07T01:00:00+08:00")
        self.assertEqual(len(snapshot["sessions"]), 2)
        self.assertEqual(snapshot["sessions"][0]["active_seconds"], 900)
        self.assertEqual(snapshot["sessions"][1]["start"], timeline[-1]["start"])

    def test_workflow_identity_survives_extension_but_snapshot_tracks_evidence(self):
        timeline = [block("2026-09-06T09:00:00+08:00", "2026-09-06T09:15:00+08:00", 900)]
        first = build_workflow_snapshot(timeline, "2026-09-06T09:15:00+08:00")
        timeline.append(block("2026-09-06T09:15:00+08:00", "2026-09-06T09:16:00+08:00"))
        second = build_workflow_snapshot(timeline, "2026-09-06T09:16:00+08:00")
        self.assertEqual(first["sessions"][0]["id"], second["sessions"][0]["id"])
        self.assertNotEqual(first["id"], second["id"])
        timeline[-1]["title"] = "Corrected observation"
        third = build_workflow_snapshot(timeline, second["cutoff"])
        self.assertNotEqual(second["id"], third["id"])

    def test_minimum_uses_active_seconds_and_preserves_source_timeline(self):
        start = datetime.fromisoformat("2026-09-06T09:00:00+08:00")
        # All spans are 20 minutes, including the one-minute activity fragment.
        timeline = [block((start + timedelta(hours=i)).isoformat(),
                          (start + timedelta(hours=i, minutes=20)).isoformat(), seconds)
                    for i, seconds in enumerate([60, 899.999, 900, 900.001])]
        original = copy.deepcopy(timeline)
        snapshot = build_workflow_snapshot(timeline, "2026-09-06T13:00:00+08:00")
        self.assertEqual(snapshot["min_active_seconds"], 900)
        self.assertEqual([s["active_seconds"] for s in snapshot["sessions"]], [900, 900.001])
        self.assertEqual(timeline, original)

    def test_short_blocks_qualify_together_and_running_workflow_appears_at_minimum(self):
        timeline = [block("2026-09-06T09:00:00+08:00", "2026-09-06T09:08:00+08:00", 480),
                    block("2026-09-06T09:13:00+08:00", "2026-09-06T09:19:59+08:00", 419)]
        first = build_workflow_snapshot(timeline, timeline[-1]["end"])
        self.assertEqual(first["sessions"], [])
        timeline.append(block("2026-09-06T09:19:59+08:00", "2026-09-06T09:20:00+08:00", 1))
        second = build_workflow_snapshot(timeline, timeline[-1]["end"])
        self.assertEqual(len(second["sessions"]), 1)
        self.assertEqual(second["sessions"][0]["start"], timeline[0]["start"])
        self.assertEqual(second["sessions"][0]["active_seconds"], 900)
        self.assertNotEqual(first["id"], second["id"])
