"""Build a bounded candidate snapshot from frozen Computer History/AW evidence.

This command writes only the requested candidate file. Installation is separate.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from datetime import timedelta
from pathlib import Path

from backend.local_activity import timestamp

MAX_HOLD_SECONDS = 120


def merge_intervals(intervals):
    result = []
    for start, end in sorted(intervals):
        if end <= start:
            continue
        if result and start <= result[-1][1]:
            result[-1] = result[-1][0], max(end, result[-1][1])
        else:
            result.append((start, end))
    return result


def reconstruct(history, afk, chrome, start, end):
    active = merge_intervals([
        (max(start, timestamp(e["timestamp"])),
         min(end, timestamp(e["timestamp"]) + timedelta(seconds=e["duration"])))
        for e in afk if e.get("data", {}).get("status") == "not-afk"
    ])
    # Multiple observations in one second resolve to the last observed state.
    states = {}
    for e in sorted(history, key=lambda e: (timestamp(e["timestamp"]), e.get("id", 0))):
        states[timestamp(e["timestamp"])] = e
    observations = sorted(states.items())
    tabs = [(timestamp(e["timestamp"]), timestamp(e["timestamp"]) + timedelta(seconds=e["duration"]), e)
            for e in chrome if e.get("duration", 0) > 0]
    parts = []
    for i, (clock, event) in enumerate(observations):
        app = event.get("app", {}).get("name", "")
        if not app or event["kind"].startswith("session.") or app == "loginwindow":
            continue
        next_clock = observations[i + 1][0] if i + 1 < len(observations) else end
        left, right = max(start, clock), min(end, next_clock, clock + timedelta(seconds=MAX_HOLD_SECONDS))
        if right <= left:
            continue
        window = event.get("window") or {}
        data = {"app": app, "title": window.get("title") or app, "url": window.get("url") or ""}
        # Browser evidence enriches only observed foreground Chrome, and only
        # when the observed URL agrees. Never infer Chrome from an open tab.
        if app == "Google Chrome" and data["url"]:
            matches = [e for a, b, e in tabs if a <= left < b
                       and e.get("data", {}).get("url") == data["url"]]
            if matches and matches[-1]["data"].get("title"):
                data["title"] = matches[-1]["data"]["title"]
        for a, b in active:
            s, t = max(left, a), min(right, b)
            if t > s:
                parts.append({"start": s, "end": t, "data": data,
                              "evidence": [f'{event["timestamp"]}/{event.get("id")}']})
    merged = []
    for part in parts:
        if merged and merged[-1]["end"] == part["start"] and merged[-1]["data"] == part["data"]:
            merged[-1]["end"] = part["end"]
            merged[-1]["evidence"].extend(part["evidence"])
        else:
            merged.append(part)
    result, evidence = [], {}
    for part in merged:
        seconds = (part["end"] - part["start"]).total_seconds()
        if seconds < 1:
            continue
        body = {"timestamp": part["start"].isoformat(), "duration": seconds, "data": part["data"]}
        identity = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()[:24]
        result.append({"id": identity, **body})
        evidence[identity] = part["evidence"]
    by_app = Counter()
    for event in result:
        by_app[event["data"]["app"]] += event["duration"]
    active_seconds = sum((b - a).total_seconds() for a, b in active)
    recovered_seconds = sum(e["duration"] for e in result)
    return {"version": 1, "events": result}, {
        "start": start.isoformat(), "end": end.isoformat(), "max_hold_seconds": MAX_HOLD_SECONDS,
        "active_seconds": active_seconds, "recovered_seconds": recovered_seconds,
        "unassigned_active_seconds": active_seconds - recovered_seconds,
        "events": len(result), "by_app_seconds": dict(by_app.most_common()), "evidence": evidence,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot-dir", type=Path, required=True)
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    start, end = timestamp(args.start), timestamp(args.end)
    if end <= start or end - start > timedelta(days=1):
        parser.error("Choose a positive interval of at most one day.")
    load = lambda name: json.loads((args.snapshot_dir / name).read_text())
    payload, report = reconstruct(load("computer-history.json"), load("afk.json"), load("chrome.json"), start, end)
    report_path = args.output.with_suffix(".report.json")
    if args.output.exists() or report_path.exists():
        parser.error("Candidate output already exists; choose a new path.")
    for path, value in [(args.output, payload), (report_path, report)]:
        with path.open("x", encoding="utf-8") as handle:
            path.chmod(0o600)
            json.dump(value, handle, ensure_ascii=False, indent=2)
    print(json.dumps({k: v for k, v in report.items() if k != "evidence"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
