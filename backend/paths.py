from __future__ import annotations

import os
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
EXAMPLE_CONFIG_PATH = PROJECT_ROOT / "config" / "kinawatch.example.json"
LOCAL_CONFIG_PATH = PROJECT_ROOT / "config" / "kinawatch.local.json"
LEGACY_LOCAL_CONFIG_PATH = PROJECT_ROOT / "config" / "dashboard.local.json"
CONFIG_ENV_VAR = "KINAWATCH_CONFIG"
LEGACY_CONFIG_ENV_VAR = "KINA_DASHBOARD_CONFIG"


def expanded_path(raw_value: str) -> Path:
    return Path(raw_value).expanduser().resolve(strict=False)


def default_config_path() -> Path:
    configured = os.environ.get(CONFIG_ENV_VAR) or os.environ.get(
        LEGACY_CONFIG_ENV_VAR
    )
    if configured:
        return expanded_path(configured)
    if LOCAL_CONFIG_PATH.is_file():
        return LOCAL_CONFIG_PATH
    if LEGACY_LOCAL_CONFIG_PATH.is_file():
        return LEGACY_LOCAL_CONFIG_PATH
    return EXAMPLE_CONFIG_PATH
