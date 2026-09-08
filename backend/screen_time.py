"""Local snapshots of mobile Screen Time; Apple's stores remain read-only."""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path

from .paths import PROJECT_ROOT, default_data_dir

SYSTEM_APPS = {"com.apple.SleepLockScreen", "com.apple.control-center", "com.apple.Spotlight", "com.apple.springboard"}
APP_NAMES = {
    "com.tencent.xin": "微信", "tv.danmaku.bilianime": "哔哩哔哩", "tv.danmaku.bilibilihd": "哔哩哔哩 HD",
    "com.xingin.discover": "小红书", "com.zhihu.ios": "知乎", "com.360buy.jdmobile": "京东",
    "com.atebits.Tweetie2": "X", "com.goodnotesapp.x": "Goodnotes", "org.zotero.ios.Zotero": "Zotero",
    "com.apple.mobilesafari": "Safari", "com.apple.Preferences": "设置", "com.apple.mobilenotes": "备忘录",
    "com.apple.mobilemail": "邮件", "com.apple.Music": "音乐", "com.apple.iBooks": "图书",
    "com.openai.chat": "ChatGPT", "com.ss.iphone.ugc.Aweme": "抖音", "com.alipay.iphoneclient": "支付宝",
    "com.netease.cloudmusic": "网易云音乐", "com.liguangming.Shadowrocket": "Shadowrocket",
    "com.icbc.iphoneclient": "工商银行", "com.cmbchina.MPBBank": "招商银行",
    "ph.telegra.Telegraph": "Telegram", "com.tencent.mqq": "QQ", "com.tencent.meeting": "腾讯会议",
    "com.tencent.ww": "企业微信", "com.apple.MobileSMS": "信息", "com.netease.mailmaster": "网易邮箱大师",
    "com.google.ios.youtube": "YouTube", "com.google.chrome.ios": "Google Chrome",
    "com.taobao.fleamarket": "闲鱼", "com.taobao.taobao4iphone": "淘宝", "com.xunmeng.pinduoduo": "拼多多",
    "cn.12306.rails12306": "铁路12306", "com.meituan.imeituan": "美团", "com.meituan.imovie": "猫眼",
    "com.baidu.map": "百度地图", "com.chinaunicom.mobilebusiness": "中国联通",
    "com.xiaomi.miwatch.pro": "小米运动健康", "com.apple.Health": "健康",
    "com.whoosh.whooshgame": "MyWhoosh",
    "com.ssreader.ChaoXingStudy": "学习通", "com.netease.uuremote": "UU远程",
    "com.apple.Passwords": "密码", "com.apple.AppStore": "App Store", "com.apple.weather": "天气",
    "com.apple.calculator": "计算器", "com.apple.camera": "相机", "com.apple.mobileslideshow": "照片",
    "com.apple.mobiletimer": "时钟", "com.apple.ClockAngel": "时钟待机界面",
    "com.apple.reminders": "提醒事项", "com.apple.mobilecal": "日历", "com.cron.calendar": "Notion Calendar",
    "com.apple.mobilephone": "电话", "com.apple.InCallService": "通话界面", "com.apple.findmy": "查找",
    "com.apple.Preview": "预览", "com.apple.BarcodeScanner": "扫码器", "com.apple.shortcuts": "快捷指令",
    "com.apple.HeadphoneProxService": "耳机连接界面", "com.apple.ScreenshotServicesService": "截屏界面",
    "com.apple.LocalAuthenticationUIService": "身份验证界面", "com.apple.AuthKitUIService": "Apple 账户验证",
    "com.apple.PassbookUIService": "钱包界面", "com.apple.PosterBoard": "壁纸界面",
    "com.apple.ContinuityCaptureShieldUI": "连续互通相机界面", "com.apple.MediaRemoteUIService": "媒体控制界面",
    "com.apple.ClipViewService": "App Clip 界面", "com.apple.purplebuddy": "设备设置助理",
    "com.apple.sidecar": "随航", "com.apple.susuiservice": "系统更新界面",
}


def timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class ScreenTimeStore:
    def __init__(self, config: dict, *, path: Path | None = None, runner=None):
        self.config = config
        self.path = path or default_data_dir() / "screen-time/snapshot.json"
        self._runner = runner or subprocess.run
        self._lock = threading.RLock()
        self._checked = float("-inf")
        self._file_signature = None
        self._snapshot = {"version": 1, "devices": []}
        self.error: str | None = None
        try:
            if self.path.is_file():
                saved = json.loads(self.path.read_text())
                if saved.get("version") != 1 or not isinstance(saved.get("devices"), list):
                    raise ValueError("unsupported snapshot")
                self._snapshot = saved
        except (OSError, ValueError, TypeError, AttributeError):
            self.error = "移动设备历史快照无法读取，将尝试从 Apple 同步记录恢复。"

    def refresh(self, *, force=False) -> None:
        with self._lock:
            now = time.monotonic()
            if not force and now - self._checked < 60:
                return
            self._checked = now
            try:
                root = Path(self.config.get("biome_root", "~/Library/Biome")).expanduser()
                inputs = [root / "sync/sync.db", root / "sync/sync.db-wal"]
                remote = root / "streams/restricted/App.InFocus/remote"
                inputs.extend(p for d in remote.iterdir() if d.is_dir() for p in d.iterdir() if p.is_file())
                signature = tuple((str(p), p.stat().st_mtime_ns, p.stat().st_size) for p in sorted(inputs) if p.exists())
                if not force and signature == self._file_signature:
                    return
                python = str(Path(self.config["reader_python"]).expanduser())
                result = self._runner([python, str(PROJECT_ROOT / "scripts/read_screentime.py"), "--root", str(root)],
                                      capture_output=True, text=True, timeout=45, check=True)
                if len(result.stdout) > 64 * 1024 * 1024:
                    raise ValueError("Screen Time output too large")
                incoming = json.loads(result.stdout)
                if incoming.get("version") != 1 or not isinstance(incoming.get("devices"), list):
                    raise ValueError("Screen Time format unsupported")
                previous = {device["id"]: device for device in self._snapshot["devices"]}
                names = self.config.get("device_names", {})
                for index, device in enumerate(incoming["devices"], 1):
                    old = previous.get(device["id"], {})
                    # A newly decoded closing transition can revise an interval.
                    # Replace the same app/start instead of retaining both ends.
                    events = {(event["timestamp"], event["bundle_id"]): event for event in old.get("events", [])}
                    events.update(((event["timestamp"], event["bundle_id"]), event) for event in device["events"])
                    device["events"] = sorted(events.values(), key=lambda event: event["timestamp"])
                    device["label"] = names.get(device["id"]) or device["name"] or f"移动设备 {index}"
                    previous[device["id"]] = device
                snapshot = {"version": 1, "devices": list(previous.values())}
                self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                temporary = None
                try:
                    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent, delete=False) as stream:
                        temporary = stream.name
                        json.dump(snapshot, stream, ensure_ascii=False, separators=(",", ":"))
                        stream.flush()
                        os.fsync(stream.fileno())
                    os.replace(temporary, self.path)
                finally:
                    if temporary and os.path.exists(temporary):
                        os.unlink(temporary)
                self._snapshot = snapshot
                self._file_signature = signature
                self.error = None
            except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
                self.error = "移动设备屏幕时间暂时无法更新；已有记录保留，请检查读取器与完全磁盘访问权限。"

    def fingerprint(self, day: date) -> str:
        self.refresh()
        # Include adjacent dates for both calendar and shifted routine days.
        low, high = (day - timedelta(days=1)).isoformat(), (day + timedelta(days=2)).isoformat()
        with self._lock:
            values = [(device["id"], device.get("label"), [e["id"] for e in device["events"]
                       if e["end"][:10] >= low and e["timestamp"][:10] <= high]) for device in self._snapshot["devices"]]
            return hashlib.sha256(json.dumps(
                [values, self.error, APP_NAMES, self.config.get("app_names", {})], sort_keys=True,
            ).encode()).hexdigest()

    def read_range(self, start: datetime, end: datetime) -> tuple[list[dict], list[dict]]:
        self.refresh()
        events, sources = [], []
        with self._lock:
            for device in self._snapshot["devices"]:
                rows = []
                label = self.config.get("device_names", {}).get(device["id"]) or device.get("label", "移动设备")
                for event in device["events"]:
                    bundle = event["bundle_id"]
                    if bundle in SYSTEM_APPS or bundle.startswith("com.apple.springboard."):
                        continue
                    a, b = max(start, timestamp(event["timestamp"])), min(end, timestamp(event["end"]))
                    if b <= a:
                        continue
                    rows.append({"timestamp": a.isoformat(), "wall_end_timestamp": b.isoformat(),
                                 "duration_seconds": (b - a).total_seconds(), "source": label,
                                 "device_id": device["id"], "source_type": "apple-screentime",
                                 "app": self.config.get("app_names", {}).get(bundle) or APP_NAMES.get(bundle, bundle),
                                 "bundle_id": bundle, "title": "", "project": "", "screen_time_id": event["id"]})
                events.extend(rows)
                all_events = device["events"]
                latest = max((e["end"] for e in all_events), default=None)
                wall_seconds, until = 0.0, start
                for row in sorted(rows, key=lambda item: item["timestamp"]):
                    a, b = timestamp(row["timestamp"]), timestamp(row["wall_end_timestamp"])
                    wall_seconds += max(0.0, (b - max(a, until)).total_seconds())
                    until = max(until, b)
                sources.append({"name": label, "label": label, "type": "apple-screentime", "ok": self.error is None,
                                "event_count": len(rows), "duration_seconds": wall_seconds,
                                "latest_event": latest, "last_sync": device.get("last_sync"),
                                "coverage": "observed" if rows else "unknown", "error": self.error})
        return events, sources

    def status(self) -> dict:
        self.refresh()
        return {"enabled": True, "error": self.error, "devices": [
            {"label": d.get("label"), "event_count": len(d["events"]),
             "latest_event": max((e["end"] for e in d["events"]), default=None)}
            for d in self._snapshot["devices"]]}
