from __future__ import annotations

import copy
import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from backend.server import DashboardRequestHandler, IdleHTTPServer
from backend.timetable import MAX_BYTES, read_timetable, validate_timetable


def fixture():
    return {"version": 1, "term": "Example term", "school": "Example school",
            "timezone": "Asia/Shanghai", "week1_monday": "2026-09-14", "weeks": 16,
            "slots": [{"id": "am", "label": "1–2节", "start": "08:00", "end": "09:40"}],
            "courses": [{"id": "example", "name": "Example course", "teacher": "Teacher",
                         "room": "Room A", "slot": "am", "weekday": 3,
                         "weeks": [1, 3, 5], "weeks_label": "1–5周（单）"}],
            "exceptions": [{"date": "2026-10-10", "follows": "2026-10-07", "label": "Makeup"}]}


class TimetableTests(unittest.TestCase):
    def test_normalization_retains_rules_without_mutation_or_extra_private_fields(self):
        raw = fixture()
        raw["student_id"] = "do-not-expose"
        before = copy.deepcopy(raw)
        result = validate_timetable(raw)
        self.assertEqual(raw, before)
        self.assertNotIn("student_id", result)
        self.assertEqual(result["courses"][0]["weeks"], [1, 3, 5])
        self.assertEqual(result["exceptions"][0]["follows"], "2026-10-07")

    def test_rejects_dates_weeks_times_references_and_duplicates(self):
        for change in [
            lambda x: x.update(week1_monday="2026-09-15"),
            lambda x: x.update(timezone="Not/AZone"),
            lambda x: x["courses"][0].update(weeks=[0]),
            lambda x: x["courses"][0].update(weeks=[17]),
            lambda x: x["courses"][0].update(weeks=[True]),
            lambda x: x["courses"][0].update(slot="missing"),
            lambda x: x["slots"][0].update(start="24:01"),
            lambda x: x["slots"][0].update(end="07:00"),
            lambda x: x["courses"].append(copy.deepcopy(x["courses"][0])),
            lambda x: x["exceptions"].append(copy.deepcopy(x["exceptions"][0])),
            lambda x: x["exceptions"][0].update(follows="2027-06-01"),
            lambda x: x.update(sources=[{"title": "Unsafe", "url": "javascript:alert(1)"}]),
        ]:
            raw = fixture()
            change(raw)
            with self.subTest(raw=raw), self.assertRaises((ValueError, KeyError)):
                validate_timetable(raw)

    def test_reads_never_create_or_modify_files_and_invalid_files_are_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "missing" / "timetable.json"
            self.assertEqual(read_timetable(path)["status"], "empty")
            self.assertFalse(path.parent.exists())
            path = Path(directory) / "timetable.json"
            for content in [b"{", b"[]", b"x" * (MAX_BYTES + 1), json.dumps(fixture()).encode()]:
                path.write_bytes(content)
                status = read_timetable(path)["status"]
                self.assertEqual(status, "ready" if content.startswith(b'{"version"') else "error")
                self.assertEqual(path.read_bytes(), content)

    def test_live_endpoint_uses_existing_loopback_security(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "timetable.json"
            path.write_text(json.dumps(fixture()))
            app = SimpleNamespace(timetable=lambda: read_timetable(path))
            server = IdleHTTPServer(("127.0.0.1", 0), DashboardRequestHandler, app, 0, static_root=Path(directory))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            url = f"http://127.0.0.1:{server.server_port}/api/timetable"
            try:
                with urlopen(url) as response:
                    self.assertEqual(json.load(response)["status"], "ready")
                request = Request(url, headers={"Origin": "https://example.com"})
                with self.assertRaises(HTTPError) as error:
                    urlopen(request)
                self.assertEqual(error.exception.code, 403)
                error.exception.close()
            finally:
                server.shutdown()
                thread.join(timeout=3)
                server.server_close()
