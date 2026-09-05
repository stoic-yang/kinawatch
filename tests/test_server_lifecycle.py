from __future__ import annotations

import json
import threading
import unittest
from http.client import HTTPConnection

from backend.server import DashboardRequestHandler, IdleHTTPServer


class HealthApplication:
    def health(self):
        return {"ok": True}


class ServerLifecycleTests(unittest.TestCase):
    def test_zero_timeout_serves_after_long_idle_and_shuts_down(self) -> None:
        server = IdleHTTPServer(
            ("127.0.0.1", 0),
            DashboardRequestHandler,
            HealthApplication(),
            idle_timeout_seconds=0,
        )
        server.last_request_monotonic -= 48 * 60 * 60
        thread = threading.Thread(target=server.serve_until_idle, daemon=True)
        connection = HTTPConnection(*server.server_address, timeout=2)
        thread.start()
        try:
            thread.join(timeout=0.15)
            self.assertTrue(thread.is_alive())
            connection.request("GET", "/api/health")
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertTrue(json.loads(response.read())["ok"])
        finally:
            connection.close()
            if thread.is_alive():
                server.shutdown()
            thread.join(timeout=2)
            server.server_close()
        self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    unittest.main()
