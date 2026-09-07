from __future__ import annotations

import random
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from backend.activitywatch_adapter import ActivityWatchAdapter


def event(start: float, duration: float, **fields):
    return {
        "timestamp": (datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=start)).isoformat(),
        "duration_seconds": duration,
        **fields,
    }


def reference_partition(events):
    """Independent exhaustive oracle for the interval-sharing contract."""
    intervals = [
        (datetime.fromisoformat(row["timestamp"]),
         datetime.fromisoformat(row["timestamp"]) + timedelta(seconds=row["duration_seconds"]), row)
        for row in events
    ]
    boundaries = sorted({point for start, end, _ in intervals for point in (start, end)})
    result, overlap = [], 0.0
    for start, end in zip(boundaries, boundaries[1:]):
        active = [row for left, right, row in intervals if left < end and right > start]
        if not active:
            continue
        seconds = (end - start).total_seconds()
        if len(active) > 1:
            overlap += seconds
        result.extend({
            **row, "timestamp": start.isoformat(),
            "duration_seconds": seconds / len(active),
            "wall_end_timestamp": end.isoformat(),
            "overlap_adjusted": len(active) > 1,
        } for row in active)
    return result, overlap


class ActivityCalculationTests(unittest.TestCase):
    def test_interval_partition_preserves_boundaries_duplicates_and_input_order(self):
        rows = [event(30, 15, source="last"), event(0, 10), event(10, 10),
                event(5, 30, source="nested"), event(0, 10), event(8, 0), event(9, -2)]
        self.assertEqual(ActivityWatchAdapter._partition_overlaps(rows), reference_partition(rows))
        self.assertEqual(ActivityWatchAdapter._partition_overlaps([]), ([], 0.0))

    def test_interval_partition_matches_exhaustive_overlap_accounting(self):
        randomizer = random.Random(42)
        for _ in range(50):
            rows = [event(randomizer.randrange(86400), randomizer.randrange(1, 7200), event_id=i)
                    for i in range(60)]
            randomizer.shuffle(rows)
            self.assertEqual(ActivityWatchAdapter._partition_overlaps(rows), reference_partition(rows))

    def test_repeated_context_is_classified_once_without_merging_events(self):
        rules = {"rules": [{"app_equals": ["Editor"], "category": "work"}]}
        rows = [event(i, 1, app="Editor", title="Same document", event_id=i) for i in range(100)]
        with patch.object(ActivityWatchAdapter, "_classify", wraps=ActivityWatchAdapter._classify) as classify:
            classified = ActivityWatchAdapter._classify_events(rows, rules)
        self.assertEqual(classify.call_count, 1)
        self.assertEqual([row for row, _ in classified], rows)
        aggregate = ActivityWatchAdapter._aggregate_categories(classified, rules, 20)
        self.assertEqual(aggregate["categories"][0]["event_count"], 100)
        self.assertEqual(aggregate["categories"][0]["duration_seconds"], 100)

    def test_classification_reuse_preserves_all_rule_fields_and_manual_overrides(self):
        fields = ("app", "title", "url", "project", "file", "language", "status")
        rules = {"rules": [
            {"title_equals": ["important"], "category": "priority"},
            *[{f"{field}_regex": ["^match$"], "category": field} for field in fields],
            {"title_regex": ["^0$"], "category": "zero"},
        ]}
        rows = [event(i, 1, **{field: "match"}) for i, field in enumerate(fields)]
        rows += [event(0, 1, title=value) for value in (None, "", 0, "0", False, "False", "IMPORTANT")]
        rows += [event(0, 1, title="important", manual_category="custom", manual_category_label=label)
                 for label in ("One", "Two")]
        expected = [ActivityWatchAdapter._classify(row, rules) for row in rows]
        self.assertEqual([match for _, match in ActivityWatchAdapter._classify_events(rows * 2, rules)], expected * 2)

    def test_changed_rules_are_used_on_the_next_calculation(self):
        rows = [event(0, 5, app="Editor")]
        rules = {"rules": [{"app_equals": ["Editor"], "category": "before"}]}
        self.assertEqual(ActivityWatchAdapter._classify_events(rows, rules)[0][1]["category"], "before")
        rules["rules"][0]["category"] = "after"
        self.assertEqual(ActivityWatchAdapter._classify_events(rows, rules)[0][1]["category"], "after")


if __name__ == "__main__":
    unittest.main()
