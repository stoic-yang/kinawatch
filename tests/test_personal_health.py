from __future__ import annotations

import io
import json
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from xml.sax.saxutils import quoteattr

from backend.personal_health import HealthImportConflict, PersonalHealthStore, parse_export
from backend.server import DashboardRequestHandler, IdleHTTPServer


def record(kind, start, end, value, source="Mi Fitness", **extra):
    attrs = dict(type=kind, sourceName=source, startDate=start + " +0800", endDate=end + " +0800", value=value, **extra)
    return "<Record " + " ".join(f"{k}={quoteattr(str(v))}" for k, v in attrs.items()) + "/>"


def sleep(start, end, value="InBed", source="Mi Fitness"):
    return record("HKCategoryTypeIdentifierSleepAnalysis", start, end, "HKCategoryValueSleepAnalysis" + value, source)


def steps(start, end, count, source="Phone"):
    return record("HKQuantityTypeIdentifierStepCount", start, end, count, source, unit="count")


def archive(records, exported="2026-09-07 11:30:00 +0800"):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("apple_health_export/export.xml", f'<HealthData><ExportDate value="{exported}"/>{records}</HealthData>')
        z.writestr("apple_health_export/export_cda.xml", "alternate representation must not count twice")
    return output.getvalue()


class PersonalHealthTests(unittest.TestCase):
    def test_sleep_union_nap_and_wake_date(self):
        raw = sleep("2026-09-01 22:00:00", "2026-09-02 06:00:00")
        raw += sleep("2026-09-01 23:00:00", "2026-09-02 05:00:00")
        raw += sleep("2026-09-02 13:00:00", "2026-09-02 14:00:00")
        data = parse_export(archive(raw), "Asia/Shanghai")
        self.assertEqual(len(data["days"]), 1)
        day = data["days"][0]
        self.assertEqual(day["date"], "2026-09-02")
        self.assertEqual(day["sleep"]["minutes"], 540)
        self.assertEqual(day["sleep"]["main_minutes"], 480)
        self.assertEqual(day["sleep"]["basis"], "in_bed")
        self.assertEqual(len(day["sleep"]["sessions"]), 2)
        self.assertIsNone(day["steps"])

    def test_sleep_stages_across_midnight_do_not_double_count_in_bed(self):
        raw = sleep("2026-09-01 22:00:00", "2026-09-02 07:00:00")
        raw += sleep("2026-09-01 22:00:00", "2026-09-01 23:00:00", "AsleepDeep")
        raw += sleep("2026-09-01 23:00:00", "2026-09-02 00:00:00", "AsleepCore")
        raw += sleep("2026-09-02 00:20:00", "2026-09-02 06:00:00", "AsleepREM")
        result = parse_export(archive(raw), "Asia/Shanghai")["days"]
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["date"], "2026-09-02")
        self.assertEqual(result[0]["sleep"]["basis"], "asleep")
        self.assertEqual(result[0]["sleep"]["minutes"], 460)

    def test_steps_take_hourly_max_and_use_phone_when_band_absent(self):
        raw = steps("2026-09-01 10:00:00", "2026-09-01 11:00:00", 100)
        raw += steps("2026-09-01 10:00:00", "2026-09-01 11:00:00", 80, "Band")
        raw += steps("2026-09-01 11:00:00", "2026-09-01 12:00:00", 50)
        raw += steps("2026-09-01 12:00:00", "2026-09-01 13:00:00", 70, "Band")
        result = parse_export(archive(raw + raw), "Asia/Shanghai")["days"][0]
        self.assertEqual(result["steps"]["count"], 220)
        self.assertEqual(result["steps"]["sources"], {"Phone": 150, "Band": 150})
        self.assertIsNone(result["sleep"])

    def test_steps_split_midnight_and_invalid_values_are_not_summed(self):
        raw = steps("2026-09-01 23:30:00", "2026-09-02 00:30:00", 120)
        raw += steps("2026-09-02 01:00:00", "2026-09-02 02:00:00", "nan")
        result = parse_export(archive(raw), "Asia/Shanghai")
        self.assertEqual([d["steps"]["count"] for d in result["days"]], [60, 60])
        self.assertEqual(result["record_counts"]["skipped"], 1)

    def test_wearable_sleep_priority_and_other_metrics_not_retained(self):
        raw = sleep("2026-09-01 22:00:00", "2026-09-02 06:00:00")
        raw += sleep("2026-09-01 20:00:00", "2026-09-02 10:00:00", source="Phone")
        raw += record("HKQuantityTypeIdentifierHeartRate", "2026-09-02 10:00:00", "2026-09-02 11:00:00", 80)
        result = parse_export(archive(raw), "Asia/Shanghai")
        self.assertEqual(result["days"][0]["sleep"]["minutes"], 480)
        self.assertNotIn("HeartRate", json.dumps(result))

    def test_read_no_create_conflicts_and_failed_import_preserve_snapshot(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "health" / "snapshot.json"
            store = PersonalHealthStore("Asia/Shanghai", path)
            self.assertFalse(store.read()["available"])
            self.assertFalse(path.parent.exists())
            raw = archive(sleep("2026-09-01 22:00:00", "2026-09-02 06:00:00"))
            saved = store.import_archive(raw, "empty")
            original = path.read_bytes()
            with self.assertRaises(HealthImportConflict): store.import_archive(raw, "empty")
            with self.assertRaises(ValueError): store.import_archive(b"invalid zip", saved["revision"])
            old = archive(sleep("2026-09-01 22:00:00", "2026-09-02 06:00:00"), "2026-09-06 11:30:00 +0800")
            with self.assertRaises(ValueError): store.import_archive(old, saved["revision"])
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(store.import_archive(raw, saved["revision"])["days"], saved["days"])

    def test_rejects_wrong_xml_root_and_empty_export(self):
        with self.assertRaises(ValueError): parse_export(archive(""), "Asia/Shanghai")
        payload = io.BytesIO()
        with zipfile.ZipFile(payload, "w") as z: z.writestr("export.xml", "<Other/>")
        with self.assertRaises(ValueError): parse_export(payload.getvalue(), "Asia/Shanghai")


class HealthHTTPTests(unittest.TestCase):
    def test_import_authority_revision_and_read_endpoint(self):
        with tempfile.TemporaryDirectory() as root:
            store = PersonalHealthStore("Asia/Shanghai", Path(root) / "snapshot.json")
            app = SimpleNamespace(personal_health=store)
            server = IdleHTTPServer(("127.0.0.1", 0), DashboardRequestHandler, app, 60)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                with urlopen(base + "/api/personal-health") as response: self.assertFalse(json.load(response)["available"])
                data = archive(sleep("2026-09-01 22:00:00", "2026-09-02 06:00:00"))
                headers = {"Content-Type": "application/zip", "If-Match": "empty"}
                bad = Request(base + "/api/personal-health/import", data=data, headers={**headers, "Origin": "https://example.com"}, method="POST")
                with self.assertRaises(HTTPError) as error: urlopen(bad)
                self.assertEqual(error.exception.code, 403)
                error.exception.close()
                self.assertFalse(store.read()["available"])
                request = Request(base + "/api/personal-health/import", data=data, headers=headers, method="POST")
                with urlopen(request) as response: result = json.load(response)
                self.assertTrue(result["available"])
                with self.assertRaises(HTTPError) as error: urlopen(request)
                self.assertEqual(error.exception.code, 409)
                error.exception.close()
                with urlopen(base + "/api/personal-health") as response: self.assertEqual(json.load(response)["revision"], result["revision"])
            finally:
                server.shutdown(); server.server_close(); thread.join()
