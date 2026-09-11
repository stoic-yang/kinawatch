"""Canonical Mac workflows shared by the UI and external generators."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

WORKFLOW_GAP_SECONDS = 15 * 60
MIN_WORKFLOW_ACTIVE_SECONDS = 15 * 60


def build_workflow_snapshot(timeline: list[dict[str, Any]], cutoff: str) -> dict[str, Any]:
    blocks = [{**block, "duration_seconds": block.get("device_duration_seconds", block["duration_seconds"])}
              for block in timeline if block["kind"] == "screen"
              and block.get("source_type", "activitywatch-rest") in {"activitywatch-rest", "kinawatch-local"}]
    sessions: list[dict[str, Any]] = []
    for block in blocks:
        start = datetime.fromisoformat(block["start"].replace("Z", "+00:00"))
        end = datetime.fromisoformat(block["end"].replace("Z", "+00:00"))
        previous_end = datetime.fromisoformat(sessions[-1]["end"]) if sessions else None
        if previous_end is None or (start - previous_end).total_seconds() > WORKFLOW_GAP_SECONDS:
            # Extending a running workflow does not change its identity.
            identity = "mac:" + start.astimezone(timezone.utc).isoformat()
            sessions.append({
                "id": hashlib.sha256(identity.encode()).hexdigest()[:16],
                "start": start.isoformat(), "end": end.isoformat(),
                "active_seconds": 0.0,
            })
        sessions[-1]["end"] = max(end, datetime.fromisoformat(sessions[-1]["end"])).isoformat()
        sessions[-1]["active_seconds"] += block["duration_seconds"]
    # Apply the minimum after grouping: several short blocks can form a full
    # workflow, but idle gaps never count toward its active duration.
    sessions = [session for session in sessions
                if session["active_seconds"] >= MIN_WORKFLOW_ACTIVE_SECONDS]
    evidence = {"source": "mac", "timeline": blocks, "gap_seconds": WORKFLOW_GAP_SECONDS,
                "min_active_seconds": MIN_WORKFLOW_ACTIVE_SECONDS}
    digest = hashlib.sha256(json.dumps(evidence, sort_keys=True).encode()).hexdigest()
    return {"version": 1, "source": "mac", "id": digest, "cutoff": cutoff,
            "min_active_seconds": MIN_WORKFLOW_ACTIVE_SECONDS, "sessions": sessions}
