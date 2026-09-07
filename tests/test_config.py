from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.config import load_json, load_settings
from backend.paths import CONFIG_ENV_VAR, DATA_DIR_ENV_VAR, EXAMPLE_CONFIG_PATH


class DashboardConfigTests(unittest.TestCase):
    def test_public_example_is_local_only_and_read_only(self) -> None:
        raw = load_json(EXAMPLE_CONFIG_PATH)

        self.assertEqual(raw["version"], 2)
        self.assertEqual(raw["host"], "127.0.0.1")
        self.assertFalse(raw["journal_write_enabled"])
        self.assertFalse(raw["activity_edit_enabled"])
        self.assertNotIn("upstream", raw)
        self.assertNotIn("/Users/", json.dumps(raw))
        self.assertEqual(raw["journal"]["provider"], "local")
        self.assertNotIn("vault", raw["journal"])
        self.assertEqual(raw["journal_schema_version"], 3)
        self.assertEqual(raw["day_schema_version"], 12)

        settings = load_settings(EXAMPLE_CONFIG_PATH)
        self.assertEqual(
            settings.activitywatch["categories_file"],
            EXAMPLE_CONFIG_PATH.parent / "categories.example.json",
        )
        self.assertEqual(settings.activitywatch["server_url"], "http://127.0.0.1:5600")
        self.assertEqual(settings.journal_schema_version, 3)
        self.assertEqual(settings.day_schema_version, 12)
        self.assertFalse(settings.activitywatch["media_activity"]["enabled"])
        self.assertEqual(
            settings.activitywatch["media_activity"]["rules"][0][
                "title_contains"
            ],
            ["Audio playing"],
        )
        self.assertFalse(settings.activity_edit_enabled)
        self.assertEqual(
            settings.activity_edit_store_path.name,
            "activity-edits.json",
        )
        self.assertEqual(settings.weekly_reviews_dir, "Review/Weekly")
        self.assertEqual(settings.monthly_reviews_dir, "Review/Monthly")

    def test_local_journal_uses_managed_data_dir_without_obsidian(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            managed_root = Path(temporary) / "managed-data"
            with patch.dict(
                os.environ,
                {DATA_DIR_ENV_VAR: str(managed_root)},
            ):
                settings = load_settings(EXAMPLE_CONFIG_PATH)
                journal = settings.journal

        self.assertEqual(journal["provider"], "local")
        self.assertEqual(
            journal["storage_dir"],
            (managed_root / "journal").resolve(),
        )
        self.assertEqual(journal["vault"], (managed_root / "journal").resolve())
        self.assertEqual(journal["vault_name"], "")

    def test_direct_obsidian_config_without_provider_remains_compatible(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = root / "kinawatch.json"
            config_path.write_text(
                json.dumps(
                    {
                        "host": "127.0.0.1",
                        "cache_dir": str(root / "cache"),
                        "journal": {
                            "vault": str(root / "vault"),
                            "vault_name": "Notes",
                        },
                    }
                ),
                encoding="utf-8",
            )

            journal = load_settings(config_path).journal

        self.assertEqual(journal["provider"], "obsidian")
        self.assertEqual(journal["storage_dir"], (root / "vault").resolve())
        self.assertEqual(journal["vault_name"], "Notes")

    def test_unknown_journal_provider_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = root / "kinawatch.json"
            config_path.write_text(
                json.dumps(
                    {
                        "host": "127.0.0.1",
                        "cache_dir": str(root / "cache"),
                        "journal": {"provider": "cloud"},
                    }
                ),
                encoding="utf-8",
            )

            settings = load_settings(config_path)
            with self.assertRaisesRegex(ValueError, "journal.provider"):
                _ = settings.journal

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

    def test_v1_upstream_config_is_normalized_without_importing_kina(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            activity_path = root / "activitywatch.json"
            categories_path = root / "categories.json"
            obsidian_path = root / "obsidian.json"
            review_path = root / "daily_review.json"
            activity_path.write_text(
                json.dumps(
                    {
                        "timezone": "UTC",
                        "default_bucket": "window",
                        "bucket_aliases": {
                            "window": "window-test",
                            "afk": "afk-test",
                        },
                    }
                ),
                encoding="utf-8",
            )
            categories_path.write_text(
                json.dumps({"categories": {}, "rules": []}),
                encoding="utf-8",
            )
            obsidian_path.write_text(
                json.dumps({"default_vault": str(root / "vault")}),
                encoding="utf-8",
            )
            review_path.write_text(
                json.dumps(
                    {
                        "vault_name": "Vault",
                        "daily_notes_dir": "Daily",
                        "daily_note_date_format": "%Y-%m-%d",
                    }
                ),
                encoding="utf-8",
            )
            config_path = root / "dashboard.json"
            config_path.write_text(
                json.dumps(
                    {
                        "host": "127.0.0.1",
                        "cache_dir": str(root / "cache"),
                        "upstream": {
                            "kina_scripts_dir": str(root / "missing-scripts"),
                            "activitywatch_config": str(activity_path),
                            "activitywatch_categories": str(categories_path),
                            "obsidian_config": str(obsidian_path),
                            "daily_review_config": str(review_path),
                        },
                    }
                ),
                encoding="utf-8",
            )

            settings = load_settings(config_path)

            self.assertEqual(
                settings.activitywatch["window_bucket_id"], "window-test"
            )
            self.assertEqual(settings.activitywatch["afk_bucket_id"], "afk-test")
            self.assertEqual(settings.journal["vault_name"], "Vault")
            self.assertNotIn("kina_scripts_dir", settings.activitywatch)
            self.assertEqual(len(settings.input_fingerprint()), 64)

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
