"""QR protocol extracted from xc-2000/toutiao-auto-publisher (MIT)."""
from __future__ import annotations
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit
from curl_cffi import requests
from toutiao_protocol import PublisherError


@dataclass
class LoginAttempt:
    session: Any
    token: str
    qrcode: str
    created_at: float
    expires_at: float


class QRLoginManager:
    START_URL = "https://sso.toutiao.com/get_qrcode/"
    CHECK_URL = "https://sso.toutiao.com/check_qrconnect/"
    PROFILE_URL = "https://mp.toutiao.com/mp/agw/media/user_login_status_api"

    def __init__(self, config: dict[str, Any], accounts: Any) -> None:
        self.config = config
        self.accounts = accounts
        self.attempts: dict[str, LoginAttempt] = {}
        self.lock = threading.RLock()
        self.aid = int(config.get("toutiao", {}).get("aid", 1231))
        self.service = str(config.get("toutiao", {}).get("base_url", "https://mp.toutiao.com"))
        self.impersonate = str(config.get("toutiao", {}).get("impersonate", "chrome"))

    def start(self) -> dict[str, Any]:
        session = requests.Session(impersonate=self.impersonate)
        session.headers.update(
            {
                "Accept": "application/json, text/plain, */*",
                "Referer": "https://mp.toutiao.com/",
                "Origin": "https://mp.toutiao.com",
            }
        )
        try:
            response = session.get(
                self.START_URL,
                params={"aid": self.aid, "service": self.service, "need_logo": 1},
                timeout=20,
            )
            response.raise_for_status()
            payload = response.json()
            data = payload.get("data") if isinstance(payload, dict) else None
            if not isinstance(data, dict) or not data.get("token") or not data.get("qrcode"):
                message = payload.get("description") or payload.get("message") if isinstance(payload, dict) else ""
                raise PublisherError(str(message or "二维码创建失败"))
        except PublisherError:
            session.close()
            raise
        except Exception as exc:
            session.close()
            raise PublisherError(f"二维码创建失败：{exc}") from exc
        login_id = uuid.uuid4().hex
        attempt = LoginAttempt(
            session=session,
            token=str(data["token"]),
            qrcode=self._normalize_qrcode(str(data["qrcode"])),
            created_at=time.time(),
            expires_at=time.time() + 180,
        )
        with self.lock:
            self._cleanup()
            self.attempts[login_id] = attempt
        return {
            "login_id": login_id,
            "status": "new",
            "qrcode": attempt.qrcode,
            "expires_at": datetime.fromtimestamp(attempt.expires_at, timezone.utc).isoformat(),
        }

    def poll(self, login_id: str) -> dict[str, Any]:
        with self.lock:
            attempt = self.attempts.get(login_id)
        if attempt is None:
            raise KeyError(login_id)
        if time.time() > attempt.expires_at:
            self._drop(login_id)
            return {"status": "expired"}
        try:
            response = attempt.session.get(
                self.CHECK_URL,
                params={
                    "aid": self.aid,
                    "service": self.service,
                    "token": attempt.token,
                    "need_logo": 1,
                },
                timeout=20,
            )
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:
            raise PublisherError(f"登录状态获取失败：{exc}") from exc
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, dict):
            message = payload.get("description") or payload.get("message") if isinstance(payload, dict) else ""
            raise PublisherError(str(message or "登录状态获取失败"))
        raw_status = str(data.get("status", ""))
        status_map = {"1": "new", "2": "scanned", "3": "confirmed", "5": "expired"}
        status = status_map.get(raw_status, raw_status)
        if raw_status == "4" and data.get("token") and data.get("qrcode"):
            attempt.token = str(data["token"])
            attempt.qrcode = self._normalize_qrcode(str(data["qrcode"]))
            attempt.expires_at = time.time() + 180
            return {"status": "new", "qrcode": attempt.qrcode}
        if status == "confirmed":
            try:
                account = self._complete(attempt, str(data.get("redirect_url", "")))
            except PublisherError:
                raise
            except Exception as exc:
                raise PublisherError(f"登录会话保存失败：{exc}") from exc
            self._drop(login_id)
            return {"status": "confirmed", "account": account}
        if status == "expired":
            self._drop(login_id)
        return {"status": status or "error"}

    def _complete(self, attempt: LoginAttempt, redirect_url: str) -> dict[str, Any]:
        if not redirect_url:
            raise PublisherError("扫码已确认，但登录响应缺少 redirect_url")
        parsed = urlsplit(redirect_url)
        if parsed.scheme != "https" or not (parsed.hostname == "toutiao.com" or (parsed.hostname or "").endswith(".toutiao.com")):
            raise PublisherError("登录回调地址无效，请重新扫码")
        redirect_response = attempt.session.get(redirect_url, allow_redirects=True, timeout=20)
        redirect_response.raise_for_status()
        response = attempt.session.get(
            self.PROFILE_URL,
            headers={"Referer": "https://mp.toutiao.com/profile_v4/", "X-Requested-With": "XMLHttpRequest"},
            timeout=20,
        )
        response.raise_for_status()
        profile = response.json()
        data = profile.get("data") if isinstance(profile, dict) else None
        if not isinstance(data, dict) or not data.get("is_login"):
            raise PublisherError(str(profile.get("message") or "扫码确认后账号会话仍未生效"))
        cookies = {
            cookie.name: cookie.value
            for cookie in attempt.session.cookies.jar
            if str(cookie.domain).lstrip(".") == "toutiao.com" or str(cookie.domain).endswith(".toutiao.com")
        }
        return self.accounts.save_account(profile, cookies)

    @staticmethod
    def _normalize_qrcode(value: str) -> str:
        value = value.strip()
        if value.startswith("data:image/"):
            return value
        return f"data:image/png;base64,{value}"

    def _drop(self, login_id: str) -> None:
        with self.lock:
            attempt = self.attempts.pop(login_id, None)
        if attempt:
            attempt.session.close()

    def _cleanup(self) -> None:
        expired = [key for key, value in self.attempts.items() if value.expires_at < time.time()]
        for key in expired:
            attempt = self.attempts.pop(key)
            attempt.session.close()
