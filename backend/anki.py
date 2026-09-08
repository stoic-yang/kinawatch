"""On-demand, read-only AnkiConnect snapshots for the vocabulary page."""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import time
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from zoneinfo import ZoneInfo

from .paths import default_data_dir

READ_ACTIONS = frozenset({"version", "getActiveProfile", "deckNamesAndIds", "findCards", "cardsInfo", "getReviewsOfCards"})
MAX_RESPONSE = 32 * 1024 * 1024
MAX_CARDS = 20000
MAX_REVIEWS = 500000
FIELDS = {
    "term": ("英语单词", "单词", "Word", "Expression", "Front"),
    "phonetic": ("英美音标", "音标", "Phonetic", "Pronunciation"),
    "definition": ("中文释义", "释义", "Meaning", "Definition", "Back"),
    "example": ("英语例句", "例句", "Example", "Sentence"),
    "translation": ("中文例句", "例句翻译", "Translation"),
}


class AnkiUnavailable(RuntimeError):
    pass


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise AnkiUnavailable("AnkiConnect 不支持重定向。")


class AnkiClient:
    def __init__(self, config: dict):
        self.url = str(config.get("server_url", "http://127.0.0.1:8765")).rstrip("/")
        parsed = urlsplit(self.url)
        if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
                or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path):
            raise ValueError("anki.server_url 必须是本机 HTTP 地址。")
        self.key = config.get("api_key")
        self.timeout = 5
        self.opener = build_opener(ProxyHandler({}), _NoRedirect())

    def call(self, action: str, **params):
        if action not in READ_ACTIONS:
            raise ValueError("Only read-only Anki actions are allowed")
        payload = {"action": action, "version": 6, "params": params}
        if self.key:
            payload["key"] = self.key
        request = Request(self.url, json.dumps(payload).encode(), {"Content-Type": "application/json"})
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                raw = response.read(MAX_RESPONSE + 1)
            if len(raw) > MAX_RESPONSE:
                raise AnkiUnavailable("Anki 数据过大，请在本机配置中缩小词库范围。")
            data = json.loads(raw)
            if not isinstance(data, dict) or "result" not in data or "error" not in data:
                raise AnkiUnavailable("连接的服务不是 AnkiConnect。")
            if data["error"]:
                # Do not expose arbitrary plugin errors, credentials or local paths.
                raise AnkiUnavailable("AnkiConnect 读取失败，请确认已打开牌组并检查插件设置。")
            return data["result"]
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            raise AnkiUnavailable("未连接到 Anki，请打开电脑端 Anki 后重试。") from exc
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise AnkiUnavailable("AnkiConnect 返回了无法识别的数据。") from exc


class _PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.suppressed = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}:
            self.suppressed += 1
        elif tag in {"br", "div", "p", "li"} and not self.suppressed:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in {"script", "style"}:
            self.suppressed = max(0, self.suppressed - 1)
        elif tag in {"div", "p", "li"} and not self.suppressed:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.suppressed:
            self.parts.append(data)


def plain_text(value: str) -> str:
    parser = _PlainText()
    parser.feed(re.sub(r"\[sound:[^\]]*\]", "", value))
    return "\n".join(line for raw in "".join(parser.parts).splitlines()
                     if (line := " ".join(raw.split()))).strip()


def _field(fields: dict, names) -> str:
    lookup = {key.casefold(): value for key, value in fields.items()}
    for name in names:
        value = lookup.get(name.casefold(), {})
        if isinstance(value, dict) and isinstance(value.get("value"), str):
            text = plain_text(value["value"])
            if text:
                return text
    return ""


def build_snapshot(profile: str, decks: dict, cards: list[dict], histories: dict,
                   timezone_name: str, field_map: dict, now: datetime) -> dict:
    """Notes are vocabulary entries; cards and answer events remain separate."""
    zone = ZoneInfo(timezone_name)
    words: dict[int, dict] = {}
    card_lookup = {}
    skipped = set()
    for card in cards:
        note_id, card_id = int(card["note"]), int(card["cardId"])
        content = {key: _field(card["fields"], [field_map[key]] if key in field_map else names)
                   for key, names in FIELDS.items()}
        if not content["term"]:
            skipped.add(note_id)
            continue
        word = words.setdefault(note_id, {"id": note_id, **content, "cards": []})
        queue, kind = int(card["queue"]), int(card["type"])
        state = "suspended" if queue == -1 else "buried" if queue < 0 else "new" if kind == 0 else "learning" if kind in {1, 3} else "review"
        word["cards"].append({"id": card_id, "deck": card["deckName"], "state": state})
        card_lookup[card_id] = (note_id, card["deckName"])
    reviews = {}
    for raw_id, history in histories.items():
        card_id = int(raw_id)
        if card_id not in card_lookup:
            continue
        note_id, deck = card_lookup[card_id]
        for row in history:
            # Manual scheduling/reset entries are not answers.
            if row["ease"] not in {1, 2, 3, 4} or row["type"] not in {0, 1, 2, 3}:
                continue
            timestamp = datetime.fromtimestamp(int(row["id"]) / 1000, zone)
            if timestamp > now.astimezone(zone):
                raise ValueError("Anki 复习记录包含未来时间。")
            reviews[int(row["id"])] = {"id": int(row["id"]), "card_id": card_id, "note_id": note_id,
                "deck": deck, "date": timestamp.date().isoformat(), "time": timestamp.isoformat(),
                "rating": row["ease"], "kind": row["type"], "answer_ms": max(0, int(row["time"])),
                "interval": int(row["ivl"])}
    return {"version": 1, "profile": profile, "timezone": timezone_name,
            "fetched_at": now.astimezone(zone).isoformat(),
            "decks": [{"id": value, "name": key} for key, value in decks.items()],
            "words": sorted(words.values(), key=lambda word: (word["term"].casefold(), word["id"])),
            "reviews": sorted(reviews.values(), key=lambda row: row["id"]),
            "skipped_notes": len(skipped - words.keys())}


class AnkiStore:
    def __init__(self, config: dict, timezone_name: str, *, client=None, root: Path | None = None):
        self.client = client or AnkiClient(config)
        self.timezone = timezone_name
        self.query = str(config.get("query", ""))
        self.field_map = config.get("fields", {})
        if not isinstance(self.field_map, dict) or any(key not in FIELDS or not isinstance(value, str) for key, value in self.field_map.items()):
            raise ValueError("anki.fields 必须将单词字段映射到 Anki 模板中的字段名。")
        identity = json.dumps([config.get("server_url", "http://127.0.0.1:8765"), self.query, self.field_map, timezone_name], sort_keys=True)
        token = hashlib.sha256(identity.encode()).hexdigest()[:16]
        self.path = (root or default_data_dir()) / "anki" / f"snapshot-{token}.json"
        self.lock = threading.Lock()
        self.snapshot: dict | None = None
        self.last_attempt = 0.0
        self.error: str | None = None

    def _read_saved(self):
        if self.snapshot is not None or not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if (isinstance(data, dict) and data.get("version") == 1 and data.get("timezone") == self.timezone
                    and isinstance(data.get("words"), list) and isinstance(data.get("reviews"), list)):
                self.snapshot = data
        except (OSError, ValueError, TypeError):
            pass

    def _save(self, snapshot):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix=".anki-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as file:
                json.dump(snapshot, file, ensure_ascii=False, separators=(",", ":"))
                file.flush()
                os.fsync(file.fileno())
            os.replace(name, self.path)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def _fetch(self):
        if self.client.call("version") < 6:
            raise AnkiUnavailable("请更新 AnkiConnect 插件后重试。")
        profile = self.client.call("getActiveProfile")
        decks = self.client.call("deckNamesAndIds")
        ids = self.client.call("findCards", query=self.query)
        if len(ids) > MAX_CARDS:
            raise AnkiUnavailable("词库超过 20,000 张卡片，请通过 anki.query 选择英语牌组。")
        cards, histories = [], {}
        review_count = 0
        for offset in range(0, len(ids), 200):
            chunk = ids[offset:offset + 200]
            batch = self.client.call("cardsInfo", cards=chunk)
            if len(batch) != len(chunk) or any(not card for card in batch):
                raise AnkiUnavailable("读取期间词库发生变化，请重新读取。")
            cards.extend(batch)
            history = self.client.call("getReviewsOfCards", cards=chunk)
            review_count += sum(len(rows) for rows in history.values())
            if review_count > MAX_REVIEWS:
                raise AnkiUnavailable("复习记录过多，请缩小 anki.query 范围。")
            histories.update(history)
        if self.client.call("getActiveProfile") != profile:
            raise AnkiUnavailable("读取期间切换了 Anki 账户，请重新读取。")
        return build_snapshot(profile, decks, cards, histories, self.timezone, self.field_map, datetime.now(timezone.utc))

    def read(self, refresh=False):
        with self.lock:
            self._read_saved()
            elapsed = time.monotonic() - self.last_attempt
            if self.last_attempt == 0 or elapsed >= 60 or (refresh and elapsed >= 1):
                try:
                    snapshot = self._fetch()
                    self._save(snapshot)
                    self.snapshot = snapshot
                    self.error = None
                except (AnkiUnavailable, ValueError, TypeError, KeyError, OSError) as exc:
                    self.error = str(exc) if isinstance(exc, AnkiUnavailable) else "Anki 数据读取未完成，已保留上次结果，请重试。"
                self.last_attempt = time.monotonic()
            return {"available": self.snapshot is not None, "status": "cached" if self.error and self.snapshot is not None else "unavailable" if self.error else "ready",
                    "error": self.error, "snapshot": self.snapshot}
