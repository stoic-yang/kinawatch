"""Read Apple Biome using the separately installed, pinned aw-import-screentime.

No ActivityWatch client, title lookup, watcher, or upstream state writer is used.
Run with the reader's Python environment; JSON is written only to stdout.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aw_import_screentime.__main__ import iter_app_in_focus_events, stitch_intervals


def read_biome(root: Path) -> dict:
    db = root / "sync/sync.db"
    with sqlite3.connect(db.as_uri() + "?mode=ro", uri=True, timeout=3) as connection:
        connection.execute("PRAGMA query_only=ON")
        connection.row_factory = sqlite3.Row
        peers = connection.execute("SELECT * FROM DevicePeer WHERE me = 0 AND platform != 3").fetchall()
    devices = []
    for peer in peers:
        device_id = peer["device_identifier"]
        directory = root / "streams/restricted/App.InFocus/remote" / device_id
        files = sorted(p for p in directory.iterdir() if p.is_file()) if directory.is_dir() else []
        if sum(p.stat().st_size for p in files) > 128 * 1024 * 1024:
            raise ValueError("屏幕活动文件超出单设备读取上限。")
        raw = {}
        for path in files:
            for event in iter_app_in_focus_events(path):
                raw[event.SerializeToString()] = event
                if len(raw) > 1_000_000:
                    raise ValueError("屏幕活动记录过多。")
        ordered = sorted(raw.values(), key=lambda event: event.cf_absolute_time)
        events = []
        rejected = 0
        now = datetime.now(timezone.utc)
        for event in stitch_intervals(ordered, tzinfo=timezone.utc):
            seconds = event.duration.total_seconds()
            end = event.timestamp + event.duration
            # A missing close event can stitch days together. Keep that gap unknown.
            if not 0 < seconds <= 12 * 3600 or end > now + timedelta(minutes=5):
                rejected += 1
                continue
            identity = f"{device_id}|{event.timestamp.isoformat()}|{end.isoformat()}|{event.data['app']}"
            events.append({"id": hashlib.sha256(identity.encode()).hexdigest()[:24],
                           "timestamp": event.timestamp.isoformat(), "end": end.isoformat(),
                           "duration_seconds": seconds, "bundle_id": event.data["app"]})
        devices.append({"id": device_id, "name": peer["name"] or "", "platform": peer["platform"],
                        "last_sync": peer["last_sync_date"], "files": len(files),
                        "rejected_intervals": rejected, "events": events})
    return {"version": 1, "devices": devices}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.home() / "Library/Biome")
    arguments = parser.parse_args()
    print(json.dumps(read_biome(arguments.root.resolve()), ensure_ascii=False, separators=(",", ":")))
