"""Toutiao adapter using the MIT-licensed xc-2000 publishing protocols."""
from __future__ import annotations

import html
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

VENDOR_ROOT = Path(__file__).resolve().parents[1] / "vendor" / "toutiao-auto-publisher"
if str(VENDOR_ROOT) not in sys.path:
    sys.path.insert(0, str(VENDOR_ROOT))

from toutiao_login import QRLoginManager
from toutiao_protocol import LoginRequired, PublisherError, ToutiaoProtocolClient, parse_cookie_header
from toutiao_video import ToutiaoVideoClient


def config() -> dict[str, Any]:
    return {"toutiao": {
        "base_url": "https://mp.toutiao.com", "aid": 1231,
        "protocol_log_dir": "", "chrome_protocol_enabled": True,
        "chrome_executable": os.getenv("PUBLISHER_CHROMIUM_EXECUTABLE", "/usr/bin/chromium"),
        "chrome_profile_root": "./chrome-profiles",
    }}


def safe_error(error: Exception) -> str:
    if isinstance(error, LoginRequired):
        return "头条登录已过期，请重新扫码登录"
    text = str(error).strip()
    text = re.sub(r"https?://[^\s]+", "[平台地址]", text)
    text = re.sub(r'(?i)(cookie|sessionid|sessionid_ss|sid_guard|token|authorization|ttwid|passport_csrf_token)([\s\x22\x27:=]+)[^\s;,}]+', r"\1=***", text)
    return text[:300] if isinstance(error, PublisherError) and text else "头条平台连接失败，请稍后重试"


def credentials(raw: str) -> dict[str, str]:
    try:
        document = json.loads(raw)
    except json.JSONDecodeError:
        document = parse_cookie_header(raw)
    if isinstance(document, dict):
        document = document.get("cookies", document)
    if isinstance(document, list):
        document = {item["name"]: item.get("value", "") for item in document if isinstance(item, dict)
                    and item.get("name") and (str(item.get("domain", "")).lstrip(".") == "toutiao.com"
                    or str(item.get("domain", "")).endswith(".toutiao.com"))}
    if not isinstance(document, dict) or not document or any(not isinstance(value, str) for value in document.values()):
        raise PublisherError("头条登录凭据格式无效，请重新扫码")
    return dict(document)


class ToutiaoLogin:
    def __init__(self) -> None:
        self.manager = QRLoginManager(config(), self)
        self.login_id = ""

    def save_account(self, profile: dict, cookies: dict[str, str]) -> dict:
        if not cookies:
            raise PublisherError("扫码已确认，但没有获取到有效登录凭据")
        return {"credentials": json.dumps({"cookies": cookies}, ensure_ascii=False)}

    def start(self) -> dict:
        result = self.manager.start()
        self.login_id = result["login_id"]
        return self._map(result)

    def poll(self) -> dict:
        return self._map(self.manager.poll(self.login_id))

    def _map(self, result: dict) -> dict:
        status = {"new": "waiting", "scanned": "scanned", "confirmed": "confirmed", "expired": "expired"}.get(result.get("status"), "failed")
        mapped = {"status": status, "qrcode": result.get("qrcode"),
                  "credentials": result.get("account", {}).get("credentials", ""),
                  "message": {"waiting": "请用今日头条 App 扫码登录", "scanned": "已扫码，请在今日头条 App 确认",
                              "confirmed": "今日头条扫码登录成功", "expired": "二维码已过期，请重新获取",
                              "failed": "头条未确认登录，请重新扫码" }[status]}
        attempt = self.manager.attempts.get(self.login_id)
        if attempt:
            mapped["expiresAt"] = attempt.expires_at
        return mapped

    def close(self) -> None:
        if self.login_id:
            self.manager._drop(self.login_id)


def check_account(raw: str) -> dict[str, object]:
    try:
        with tempfile.TemporaryDirectory(prefix="publisher-toutiao-check-") as folder:
            with ToutiaoProtocolClient(config(), Path(folder), cookie_override=credentials(raw)) as client:
                client.get_account_profile()
        return {"ok": True, "status": "valid", "message": "今日头条登录态可用"}
    except LoginRequired:
        return {"ok": False, "status": "invalid", "message": "头条登录已过期，请重新扫码登录"}
    except Exception as exc:
        raise PublisherError(safe_error(exc)) from None


@dataclass
class Article:
    title: str
    summary: str
    body_html: str
    tags: list[str]
    topic: str = ""


def publish_media(request: Any, media: list[Path], cover: Path | None, directory: Path) -> dict[str, object]:
    """One final submission only. Never retry a publish after an ambiguous response."""
    cookies = credentials(request.credentials)
    article = Article(request.title.strip(), request.description.strip()[:200], "", request.topics)
    if request.media_type == "video":
        probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                "stream=width,height", "-of", "json", str(media[0])],
                               capture_output=True, text=True, timeout=30, check=True)
        streams = json.loads(probe.stdout).get("streams", [])
        if not streams:
            raise PublisherError("素材中没有可发布的视频画面")
        landscape = int(streams[0].get("width", 0)) >= int(streams[0].get("height", 0))
        with ToutiaoVideoClient(config(), directory, cookie_override=cookies) as client:
            result = client.publish(article, media[0], request.publish_mode, landscape=landscape)
        return {"ok": True, "itemId": result.get("item_id", ""), "videoId": result.get("vid", "")}
    with ToutiaoProtocolClient(config(), directory, cookie_override=cookies) as client:
        client.check_session()
        uploaded = [client.upload_image(path) for path in media]
        paragraphs = ["<p>" + html.escape(line) + "</p>" for line in request.description.splitlines() if line.strip()]
        pictures = ['<p><img src="' + html.escape(image["url"], quote=True) + '"></p>' for image in uploaded]
        tags = "<p>" + html.escape(" ".join("#" + tag.lstrip("#") for tag in request.topics)) + "</p>" if request.topics else ""
        article.body_html = "".join(paragraphs + pictures) + tags
        result = client.publish(article, request.publish_mode, cover or media[0])
        return {"ok": True, "itemId": result.get("pgc_id", "")}
