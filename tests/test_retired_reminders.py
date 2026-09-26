"""Retired task routes cannot read or mutate an existing reminders provider."""
import json
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

from backend.server import DashboardRequestHandler, IdleHTTPServer


class RetiredReminderRoutesTests(unittest.TestCase):
    def test_old_client_requests_never_reach_a_reminders_provider(self):
        reminders = SimpleNamespace(read=Mock(), action=Mock())
        application = SimpleNamespace(reminders=reminders)
        server = IdleHTTPServer(
            ("127.0.0.1", 0), DashboardRequestHandler, application,
            idle_timeout_seconds=0,
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        origin = f"http://127.0.0.1:{server.server_port}"
        opener = build_opener(ProxyHandler({}))
        requests = [Request(origin + "/api/reminders")]
        for action in ("authorize", "create", "update"):
            requests.append(Request(
                origin + "/api/reminders/action",
                data=json.dumps({"action": action}).encode(),
                headers={"Content-Type": "application/json",
                         "X-KinaWatch-Reminders": "1", "Origin": origin},
                method="POST",
            ))
        try:
            for request in requests:
                with self.subTest(method=request.get_method(), body=request.data):
                    with self.assertRaises(HTTPError) as error:
                        opener.open(request, timeout=2)
                    with error.exception as response:
                        self.assertEqual(response.code, 404)
                        self.assertEqual(json.load(response)["error"], "not found")
            reminders.read.assert_not_called()
            reminders.action.assert_not_called()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
