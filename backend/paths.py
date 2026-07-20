from __future__ import annotations

import os
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
EXAMPLE_CONFIG_PATH = PROJECT_ROOT / "config" / "kinawatch.example.json"
LOCAL_CONFIG_PATH = PROJECT_ROOT / "config" / "kinawatch.local.json"
LEGACY_LOCAL_CONFIG_PATH = PROJECT_ROOT / "config" / "dashboard.local.json"
CONFIG_ENV_VAR = "KINAWATCH_CONFIG"
LEGACY_CONFIG_ENV_VAR = "KINA_DASHBOARD_CONFIG"
DATA_DIR_ENV_VAR = "KINAWATCH_DATA_DIR"


def expanded_path(raw_value: str) -> Path:
    return Path(raw_value).expanduser().resolve(strict=False)


def default_data_dir() -> Path:
    """Return the platform-appropriate root for KinaWatch-owned user data."""
    configured = os.environ.get(DATA_DIR_ENV_VAR, "").strip()
    if configured:
        return expanded_path(configured)

    if os.name == "nt":
        local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
        base = (
            Path(local_app_data)
            if local_app_data
            else Path.home() / "AppData" / "Local"
        )
        return (base / "KinaWatch").resolve(strict=False)

    if sys.platform == "darwin":
        return (Path.home() / "Library" / "Application Support" / "KinaWatch").resolve(
            strict=False
        )

    xdg_data_home = os.environ.get("XDG_DATA_HOME", "").strip()
    base = (
        Path(xdg_data_home).expanduser()
        if xdg_data_home
        else Path.home() / ".local" / "share"
    )
    return (base / "kinawatch").resolve(strict=False)


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
