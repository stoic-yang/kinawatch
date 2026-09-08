from __future__ import annotations

import copy
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from backend.anki import AnkiClient, AnkiStore, AnkiUnavailable, READ_ACTIONS, build_snapshot, plain_text


def fixture():
    cards = [
        {"cardId": 1, "note": 10, "deckName": "English", "queue": 2, "type": 2,
         "fields": {"英语单词": {"value": "<b>apple</b>"}, "中文释义": {"value": "苹果"}}},
        {"cardId": 2, "note": 10, "deckName": "English::Reverse", "queue": 1, "type": 1,
         "fields": {"英语单词": {"value": "apple"}, "中文释义": {"value": "苹果"}}},
        {"cardId": 3, "note": 20, "deckName": "English", "queue": 0, "type": 0,
         "fields": {"Word": {"value": "pear"}, "Back": {"value": "梨"}}},
    ]
    def review(stamp, rating=3, kind=0):
        return {"id": int(datetime.fromisoformat(stamp).timestamp() * 1000), "ease": rating,
                "time": 2500, "ivl": -60, "type": kind}
    histories = {"1": [review("2026-05-17T15:59:00+00:00", 1), review("2026-05-17T16:01:00+00:00")],
                 "2": [review("2026-05-18T02:00:00+00:00", 4), review("2026-05-18T03:00:00+00:00", 0, 4)], "3": []}
    return cards, histories


class FakeClient:
    def __init__(self):
        self.cards, self.histories = fixture()
        self.calls = []
        self.fail = False
        self.switch_profile = False
        self.profile_calls = 0

    def call(self, action, **params):
        self.calls.append(action)
        if self.fail:
            raise AnkiUnavailable("Anki offline")
        if action == "version": return 6
        if action == "getActiveProfile":
            self.profile_calls += 1
            return "Other" if self.switch_profile and self.profile_calls % 2 == 0 else "Fixture"
        if action == "deckNamesAndIds": return {"English": 1, "English::Reverse": 2}
        if action == "findCards": return [card["cardId"] for card in self.cards]
        if action == "cardsInfo": return copy.deepcopy(self.cards)
        if action == "getReviewsOfCards": return copy.deepcopy(self.histories)
        raise AssertionError(action)


class AnkiSnapshotTests(unittest.TestCase):
    def test_sibling_cards_remain_one_entry_and_history_uses_local_midnight(self):
        cards, history = fixture()
        data = build_snapshot("Fixture", {"English": 1}, cards, history, "Asia/Shanghai", {}, datetime(2026, 6, 1, tzinfo=timezone.utc))
        self.assertEqual(len(data["words"]), 2)
        self.assertEqual(len(data["words"][0]["cards"]), 2)
        self.assertEqual([r["date"] for r in data["reviews"]], ["2026-05-17", "2026-05-18", "2026-05-18"])
        self.assertEqual(len(data["reviews"]), 3)  # excludes the manual schedule entry
        self.assertEqual(sum(r["answer_ms"] for r in data["reviews"]), 7500)

    def test_plain_text_has_no_scripts_media_or_html(self):
        self.assertEqual(plain_text('<style>body{}</style><script>bad()</script><div>A &amp; B</div><div>C<br>D</div>[sound:a.mp3]<img src="https://example.test">'), "A & B\nC\nD")

    def test_unknown_fields_are_reported_and_custom_mapping_is_supported(self):
        cards, _ = fixture()
        cards[0]["fields"] = {"Term": {"value": "tree"}}
        plain = build_snapshot("Fixture", {}, cards[:1], {}, "UTC", {}, datetime.now(timezone.utc))
        mapped = build_snapshot("Fixture", {}, cards[:1], {}, "UTC", {"term": "Term"}, datetime.now(timezone.utc))
        self.assertEqual(plain["skipped_notes"], 1)
        self.assertEqual(mapped["words"][0]["term"], "tree")

    def test_cache_survives_restart_and_connection_failure(self):
        with tempfile.TemporaryDirectory() as root:
            client = FakeClient()
            store = AnkiStore({}, "Asia/Shanghai", client=client, root=Path(root))
            self.assertFalse(store.path.exists())
            first = store.read()
            self.assertEqual(first["status"], "ready")
            saved = store.path.read_bytes()
            client.fail = True
            restarted = AnkiStore({}, "Asia/Shanghai", client=client, root=Path(root))
            stale = restarted.read()
            self.assertEqual(stale["status"], "cached")
            self.assertEqual(stale["snapshot"], first["snapshot"])
            self.assertEqual(store.path.read_bytes(), saved)
            self.assertEqual(store.path.stat().st_mode & 0o777, 0o600)
            self.assertTrue(set(client.calls).issubset(READ_ACTIONS))

    def test_failure_without_snapshot_is_unavailable_not_empty_success(self):
        with tempfile.TemporaryDirectory() as root:
            client = FakeClient(); client.fail = True
            store = AnkiStore({}, "UTC", client=client, root=Path(root))
            result = store.read()
            self.assertEqual(result["status"], "unavailable")
            self.assertFalse(result["available"])
            self.assertIsNone(result["snapshot"])
            self.assertFalse(store.path.exists())

    def test_repeated_read_uses_ttl_and_refresh_replaces_deleted_data(self):
        with tempfile.TemporaryDirectory() as root:
            client = FakeClient()
            store = AnkiStore({}, "UTC", client=client, root=Path(root))
            store.read(); count = len(client.calls)
            store.read()
            self.assertEqual(len(client.calls), count)
            client.cards = []; client.histories = {}
            store.last_attempt -= 2
            result = store.read(refresh=True)
            self.assertEqual(result["snapshot"]["words"], [])
            self.assertEqual(result["snapshot"]["reviews"], [])

    def test_profile_switch_and_failed_fetch_keep_previous_snapshot(self):
        with tempfile.TemporaryDirectory() as root:
            client = FakeClient(); store = AnkiStore({}, "UTC", client=client, root=Path(root))
            initial = store.read(); saved = store.path.read_bytes()
            client.switch_profile = True; store.last_attempt -= 2
            result = store.read(refresh=True)
            self.assertEqual(result["status"], "cached")
            self.assertEqual(result["snapshot"], initial["snapshot"])
            self.assertEqual(saved, store.path.read_bytes())

    def test_different_queries_and_timezones_do_not_share_cache(self):
        with tempfile.TemporaryDirectory() as root:
            a = AnkiStore({}, "UTC", client=FakeClient(), root=Path(root))
            b = AnkiStore({"query": "deck:Other"}, "UTC", client=FakeClient(), root=Path(root))
            c = AnkiStore({}, "Asia/Shanghai", client=FakeClient(), root=Path(root))
            self.assertEqual(len({a.path, b.path, c.path}), 3)

    def test_corrupt_cache_is_replaced_only_after_successful_read(self):
        with tempfile.TemporaryDirectory() as root:
            client = FakeClient(); store = AnkiStore({}, "UTC", client=client, root=Path(root))
            store.path.parent.mkdir(); store.path.write_text("invalid")
            client.fail = True
            self.assertFalse(store.read()["available"])
            self.assertEqual(store.path.read_text(), "invalid")
            client.fail = False; store.last_attempt -= 2
            self.assertEqual(store.read(refresh=True)["status"], "ready")

    def test_client_rejects_external_urls_and_write_actions(self):
        for url in ["https://example.com", "http://example.com", "http://127.0.0.1@evil.test", "http://127.0.0.1/?x=1", "file:///tmp/anki", "http://127.0.0.1:8765/other"]:
            with self.subTest(url=url), self.assertRaises(ValueError): AnkiClient({"server_url": url})
        client = AnkiClient({})
        with self.assertRaises(ValueError): client.call("addNote", note={})

    def test_opener_disables_proxy_and_redirect_is_rejected(self):
        from backend.anki import _NoRedirect
        with patch("backend.anki.build_opener") as opener, patch("backend.anki.ProxyHandler") as proxy:
            AnkiClient({}); proxy.assert_called_once_with({}); opener.assert_called_once()
        with self.assertRaises(AnkiUnavailable):
            _NoRedirect().redirect_request(None, None, 302, "", {}, "https://example.com")


if __name__ == "__main__": unittest.main()
