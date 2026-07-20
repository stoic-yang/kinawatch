from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.config import load_json, load_settings
from backend.paths import CONFIG_ENV_VAR, EXAMPLE_CONFIG_PATH


class DashboardConfigTests(unittest.TestCase):
    def test_public_example_is_local_only_and_read_only(self) -> None:
        raw = load_json(EXAMPLE_CONFIG_PATH)

        self.assertEqual(raw["host"], "127.0.0.1")
        self.assertFalse(raw["journal_write_enabled"])
        self.assertNotIn("/Users/", json.dumps(raw))

    def test_environment_variable_selects_an_external_config(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "dashboard.json"
            path.write_text(
                json.dumps(
                    {
                        "host": "localhost",
                        "cache_dir": str(Path(temporary) / "cache"),
                        "upstream": {},
                    }
                ),
                encoding="utf-8",
            )

            with patch.dict(os.environ, {CONFIG_ENV_VAR: str(path)}):
                settings = load_settings()

        self.assertEqual(settings.config_path, path.resolve())
        self.assertEqual(settings.host, "localhost")

    def test_non_local_bind_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "dashboard.json"
            path.write_text(
                json.dumps(
                    {
                        "host": "0.0.0.0",
                        "cache_dir": str(Path(temporary) / "cache"),
                        "upstream": {},
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "local-only"):
                load_settings(path)


if __name__ == "__main__":
    unittest.main()
