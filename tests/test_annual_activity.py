from datetime import date
import unittest

from backend.activitywatch_adapter import ActivityWatchAdapter
from backend.day_aggregator import _mac_non_entertainment_seconds
from backend.multi_device_activity import partition_devices
import test_day_aggregator as fixtures


def event(start, end, category="coding", source_type="activitywatch-rest", device="mac"):
    return {
        "timestamp": f"2026-07-15T09:{start:02d}:00+08:00",
        "wall_end_timestamp": f"2026-07-15T09:{end:02d}:00+08:00",
        "duration_seconds": (end - start) * 60,
        "category": category, "source_type": source_type, "device_id": device,
    }


class AnnualActivityTests(unittest.TestCase):
    def test_mobile_overlap_does_not_reduce_mac_and_mobile_only_time_is_excluded(self):
        mac = [event(0, 20), event(20, 30, "entertainment")]
        mobile = [event(0, 50, source_type="apple-screentime", device="phone"),
                  event(0, 40, source_type="apple-screentime", device="ipad")]
        partitioned, _, _ = partition_devices([*mac, *mobile])
        self.assertEqual(_mac_non_entertainment_seconds(mac), 1200)
        self.assertEqual(_mac_non_entertainment_seconds(partitioned), 1200)
        self.assertAlmostEqual(sum(e["duration_seconds"] for e in partitioned), 3000)

    def test_native_overlap_allocation_is_preserved(self):
        mac, _ = ActivityWatchAdapter._partition_overlaps([
            event(0, 20), event(0, 20, "entertainment")])
        self.assertEqual(_mac_non_entertainment_seconds(mac), 600)
        partitioned, _, _ = partition_devices([
            *mac, event(0, 40, source_type="apple-screentime", device="phone")])
        self.assertEqual(_mac_non_entertainment_seconds(partitioned), 600)

    def test_local_mac_and_unknown_category_are_retained_but_unknown_sources_are_not(self):
        self.assertEqual(_mac_non_entertainment_seconds([
            event(0, 10, "coursework"), event(10, 20, "uncategorized"),
            event(20, 30, "reading", "kinawatch-local"),
            event(30, 40, "entertainment", "kinawatch-local"),
            event(40, 50, source_type="unknown")]), 1800)
        self.assertEqual(_mac_non_entertainment_seconds([]), 0)
        self.assertEqual(_mac_non_entertainment_seconds([event(0, 10, "entertainment")]), 0)

    def test_day_and_cached_range_keep_offline_time_out_of_annual_metric(self):
        fixture = fixtures.DayAggregatorTests()
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        payload = fixture.aggregator.get_day(date(2026, 7, 15), "calendar")
        self.assertEqual(payload["overview"]["mac_non_entertainment_seconds"], 600)
        self.assertEqual(payload["overview"]["combined_nonoverlap_seconds"], 4200)
        cached = fixture.aggregator.get_days([date(2026, 7, 15)], "calendar")[0]
        self.assertTrue(cached["cache"]["hit"])
        self.assertEqual(cached["overview"], payload["overview"])
