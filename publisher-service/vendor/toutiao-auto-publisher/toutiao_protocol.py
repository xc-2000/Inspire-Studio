#!/usr/bin/env python3
"""Pure HTTP client for Toutiao Creator Center article publishing."""

from __future__ import annotations

import json
import mimetypes
import os
import re
import subprocess
import time
import uuid
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlencode, urljoin

from curl_cffi import CurlMime, requests

from chrome_protocol_bridge import ChromeProtocolBridge


class PublisherError(RuntimeError):
    pass


class LoginRequired(PublisherError):
    pass


class ProtocolChallenge(PublisherError):
    def __init__(self, code: int, message: str) -> None:
        self.code = code
        super().__init__(message)


CHALLENGE_MESSAGES = {
    2222: "头条要求可信浏览器校验，请更新 Cookie 或协议签名请求头后重试",
    3001: "头条要求文本验证码，请更新验证后的 Cookie 和请求头后重试",
    3002: "头条要求滑块验证码，请更新验证后的 Cookie 和请求头后重试",
    3022: "该头条号尚未完成创作者注册",
}

SENSITIVE_HEADER = re.compile(
    r"(cookie|token|ticket|csrf|authorization|signature|x-bogus|x-tt-env)",
    re.IGNORECASE,
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _coerce_activity_tag(value: str | int) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def resolve_config_path(config_dir: Path, value: str | None) -> Path | None:
    if not value:
        return None
    path = Path(value).expanduser()
    return path if path.is_absolute() else (config_dir / path).resolve()


def parse_cookie_header(value: str) -> dict[str, str]:
    value = value.strip()
    if value.lower().startswith("cookie:"):
        value = value.split(":", 1)[1].strip()
    parsed = SimpleCookie()
    try:
        parsed.load(value)
    except Exception:
        parsed = SimpleCookie()
    cookies = {name: morsel.value for name, morsel in parsed.items()}
    if cookies:
        return cookies
    for part in value.split(";"):
        name, separator, item_value = part.strip().partition("=")
        if separator and name:
            cookies[name.strip()] = item_value.strip()
    return cookies


def load_json_object(path: Path | None) -> dict[str, str]:
    if path is None or not path.is_file():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise PublisherError(f"JSON 文件必须是对象：{path}")
    return {str(key): str(value) for key, value in payload.items() if value is not None}


def credential_paths(config: dict[str, Any], config_dir: Path) -> tuple[Path | None, Path | None]:
    toutiao = config.get("toutiao", {})
    return (
        resolve_config_path(config_dir, toutiao.get("cookie_file")),
        resolve_config_path(config_dir, toutiao.get("headers_file")),
    )


def save_credentials(
    config: dict[str, Any],
    config_dir: Path,
    cookie: str,
    headers: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    cookies = parse_cookie_header(cookie)
    if not cookies:
        raise PublisherError("Cookie 内容为空或格式无效")
    cookie_path, headers_path = credential_paths(config, config_dir)
    if cookie_path is None:
        raise PublisherError("toutiao.cookie_file 未配置")
    cookie_path.parent.mkdir(parents=True, exist_ok=True)
    cookie_path.write_text(cookie.strip() + "\n", encoding="utf-8")

    clean_headers = {
        str(key).strip(): str(value).strip()
        for key, value in (headers or {}).items()
        if str(key).strip() and str(value).strip()
    }
    if headers_path is not None:
        headers_path.parent.mkdir(parents=True, exist_ok=True)
        headers_path.write_text(
            json.dumps(clean_headers, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    return {
        "cookie_count": len(cookies),
        "cookie_file": str(cookie_path),
        "headers_file": str(headers_path) if headers_path else "",
        "header_count": len(clean_headers),
    }


def credential_summary(config: dict[str, Any], config_dir: Path) -> dict[str, Any]:
    toutiao = config.get("toutiao", {})
    cookie_env = str(toutiao.get("cookie_env", "TOUTIAO_COOKIE"))
    header_env = str(toutiao.get("headers_json_env", "TOUTIAO_HEADERS_JSON"))
    cookie_path, headers_path = credential_paths(config, config_dir)
    env_cookie = os.getenv(cookie_env, "").strip()
    file_cookie = cookie_path.read_text(encoding="utf-8").strip() if cookie_path and cookie_path.is_file() else ""
    cookies = parse_cookie_header(env_cookie or file_cookie)
    file_headers = load_json_object(headers_path)
    env_headers: dict[str, str] = {}
    if os.getenv(header_env, "").strip():
        try:
            parsed = json.loads(os.environ[header_env])
            if isinstance(parsed, dict):
                env_headers = {str(k): str(v) for k, v in parsed.items()}
        except json.JSONDecodeError:
            pass
    return {
        "configured": bool(cookies),
        "source": "environment" if env_cookie else ("file" if file_cookie else "none"),
        "cookie_count": len(cookies),
        "header_count": len(file_headers | env_headers | dict(toutiao.get("headers", {}))),
        "cookie_env": cookie_env,
        "cookie_file": str(cookie_path) if cookie_path else "",
        "headers_file": str(headers_path) if headers_path else "",
    }


class ToutiaoProtocolClient:
    NEW_ARTICLE_PATH = "/mp/agw/article/new"
    PUBLISH_PATH = "/mp/agw/article/publish"
    IMAGE_PATH = "/spice/image"

    def __init__(
        self,
        config: dict[str, Any],
        config_dir: Path,
        session: Any | None = None,
        cookie_override: Mapping[str, str] | str | None = None,
        headers_override: Mapping[str, str] | None = None,
        chrome_bridge: Any | None = None,
    ) -> None:
        self.config = config
        self.config_dir = config_dir
        self.toutiao = config.get("toutiao", {})
        self.upload_config = config.get("upload", {})
        self.base_url = str(self.toutiao.get("base_url", "https://mp.toutiao.com")).rstrip("/")
        self.timeout = float(self.toutiao.get("timeout_seconds", 30))
        self.impersonate = str(self.toutiao.get("impersonate", "chrome"))
        self.aid = int(self.toutiao.get("aid", 1231))
        self.upload_source = int(self.toutiao.get("upload_source", 20020003))
        self.publish_ab = str(self.toutiao.get("mp_publish_ab_val", "0"))
        self.referer = str(
            self.toutiao.get("referer", f"{self.base_url}/profile_v4/graphic/publish")
        )
        self.log_dir = resolve_config_path(
            config_dir, self.toutiao.get("protocol_log_dir", "./artifacts/protocol")
        )
        self.cookie_override = cookie_override
        self.headers_override = dict(headers_override or {})
        self.chrome_bridge = chrome_bridge
        self.cookies, self.cookie_source = self._load_cookies()
        self.extra_headers = self._load_headers()
        self._article_defaults: dict[str, Any] = {}
        self._media_id = ""
        self.session = session or requests.Session(impersonate=self.impersonate)
        self._configure_session()

    def __enter__(self) -> "ToutiaoProtocolClient":
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        close = getattr(self.session, "close", None)
        if close:
            close()

    def _load_cookies(self) -> tuple[dict[str, str], str]:
        if self.cookie_override is not None:
            cookies = (
                parse_cookie_header(self.cookie_override)
                if isinstance(self.cookie_override, str)
                else {str(key): str(value) for key, value in self.cookie_override.items()}
            )
            return cookies, "account-store"
        cookie_env = str(self.toutiao.get("cookie_env", "TOUTIAO_COOKIE"))
        raw = os.getenv(cookie_env, "").strip()
        source = f"env:{cookie_env}"
        if not raw:
            cookie_path, _ = credential_paths(self.config, self.config_dir)
            if cookie_path and cookie_path.is_file():
                raw = cookie_path.read_text(encoding="utf-8").strip()
                source = str(cookie_path)
        return parse_cookie_header(raw), source if raw else ""

    def _load_headers(self) -> dict[str, str]:
        headers = {
            str(key): str(value)
            for key, value in dict(self.toutiao.get("headers", {})).items()
            if value is not None
        }
        _, headers_path = credential_paths(self.config, self.config_dir)
        headers.update(load_json_object(headers_path))
        env_name = str(self.toutiao.get("headers_json_env", "TOUTIAO_HEADERS_JSON"))
        raw = os.getenv(env_name, "").strip()
        if raw:
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise PublisherError(f"{env_name} 必须是 JSON 对象")
            headers.update({str(key): str(value) for key, value in payload.items()})
        headers.update(self.headers_override)
        return headers

    def _configure_session(self) -> None:
        user_agent = str(
            self.toutiao.get(
                "user_agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            )
        )
        base_headers = {
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
            "Origin": self.base_url,
            "Referer": self.referer,
            "User-Agent": user_agent,
            "X-Requested-With": "XMLHttpRequest",
        }
        base_headers.update(self.extra_headers)
        self.session.headers.update(base_headers)
        for name, value in self.cookies.items():
            self.session.cookies.set(name, value, domain=".toutiao.com", path="/")
        self._apply_csrf_headers()

    def _apply_csrf_headers(self) -> None:
        pairs = [
            ("passport_csrf_token", "x-tt-passport-csrf-token"),
            ("tt_csrf_token", "x-tt-csrf-token"),
        ]
        configured_cookie = str(self.toutiao.get("csrf_cookie", "")).strip()
        configured_header = str(self.toutiao.get("csrf_header", "")).strip()
        if configured_cookie and configured_header:
            pairs.insert(0, (configured_cookie, configured_header))
        for cookie_name, header_name in pairs:
            value = self.cookies.get(cookie_name, "")
            if value and header_name not in {key.lower(): key for key in self.session.headers}:
                self.session.headers[header_name] = value

    @property
    def configured(self) -> bool:
        return bool(self.cookies)

    def check_session(self) -> dict[str, Any]:
        if not self.configured:
            raise LoginRequired("尚未配置头条号 Cookie")
        response, payload = self._request(
            "GET",
            self.NEW_ARTICLE_PATH,
            params={"article_type": 0, "format": "json", "compat": 1, "column_no": ""},
            allow_redirects=False,
        )
        location = str(response.headers.get("location", ""))
        final_url = str(getattr(response, "url", ""))
        if response.status_code in {301, 302, 303, 307, 308} or "/auth/page/login" in (
            location + final_url
        ):
            raise LoginRequired("头条号 Cookie 已失效")
        if not isinstance(payload, dict):
            raise LoginRequired("会话检测返回了登录页或非 JSON 内容")
        code = self._code(payload)
        if code not in (None, 0) or str(payload.get("message", "")).lower() not in {
            "",
            "success",
        }:
            self._raise_payload_error(payload, login_context=True)
        data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        self._article_defaults = {
            "article_ad_type": int(data.get("article_ad_type") or 3),
            "media_id": str(data.get("media_id") or ""),
        }
        media = data.get("media") if isinstance(data.get("media"), dict) else {}
        self._media_id = str(data.get("media_id") or media.get("id") or "")
        return {
            "ok": True,
            "code": code or 0,
            "message": str(payload.get("message") or "success"),
            "cookie_count": len(self.cookies),
            "cookie_source": self.cookie_source,
            "article_type": data.get("articleType", data.get("article_type", 0)),
            "checked_at": utc_now(),
        }

    def get_account_profile(self) -> dict[str, Any]:
        if not self.configured:
            raise LoginRequired("尚未配置头条号 Cookie")
        _, payload = self._request("GET", "/mp/agw/media/user_login_status_api")
        if not isinstance(payload, dict):
            raise LoginRequired("账号资料响应不是 JSON")
        data = payload.get("data")
        if not isinstance(data, dict) or not data.get("is_login"):
            raise LoginRequired(str(payload.get("message") or "头条号 Cookie 已失效"))
        return payload

    def request_json(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        """Send an authenticated creator-platform request and validate its JSON envelope."""
        _, payload = self._request(method, path, **kwargs)
        if not isinstance(payload, dict):
            raise PublisherError(f"头条协议响应不是 JSON 对象：{path}")
        self._raise_payload_error(payload)
        return payload

    def upload_image(self, path: Path) -> dict[str, Any]:
        if not path.is_file():
            raise PublisherError(f"封面文件不存在：{path}")
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        multipart = CurlMime()
        try:
            multipart.addpart(
                name="image",
                content_type=mime,
                filename=path.name,
                local_path=path,
            )
            _, payload = self._request(
                "POST",
                self.IMAGE_PATH,
                params={
                    "upload_source": self.upload_source,
                    "aid": self.aid,
                    "device_platform": "web",
                },
                multipart=multipart,
            )
        finally:
            multipart.close()
        if not isinstance(payload, dict):
            raise PublisherError("图片上传响应不是 JSON")
        self._raise_payload_error(payload)
        data = payload.get("data")
        if not isinstance(data, dict):
            raise PublisherError("图片上传响应缺少 data")
        url = str(data.get("origin_image_url") or data.get("image_url") or "")
        uri = str(data.get("origin_image_uri") or data.get("image_uri") or "")
        if not url or not uri:
            raise PublisherError("图片上传响应缺少 origin_image_url/origin_image_uri")
        return {
            "url": url,
            "uri": uri,
            "width": int(data.get("image_width") or 0),
            "height": int(data.get("image_height") or 0),
            "mime_type": str(data.get("image_mime_type") or mime),
        }

    def build_payload(
        self,
        article: Any,
        mode: str,
        cover: Mapping[str, Any] | None = None,
        activity_tag: str | int = 0,
    ) -> dict[str, Any]:
        if mode not in {"draft", "publish"}:
            raise PublisherError(f"未知发布模式：{mode}")
        content = re.sub(
            r"<p>(?!\s*<img)(?![^>]*data-track=)",
            '<p data-track="1">',
            str(article.body_html),
        )
        plain_length = len(re.sub(r"<[^>]+>", "", content).replace("&nbsp;", " ").strip())
        search_info = {
            "searchTopOne": 0,
            "abstract": str(article.summary),
            "clue_id": "",
        }
        covers: list[dict[str, Any]] = []
        if cover:
            covers.append(
                {
                    "url": str(cover.get("url", "")),
                    "uri": str(cover.get("uri", "")),
                    "width": int(cover.get("width") or 0),
                    "height": int(cover.get("height") or 0),
                }
            )
        media_id = self._media_id or str(self._article_defaults.get("media_id") or "")
        title_id = f"{int(time.time() * 1000)}_{media_id}" if media_id else ""
        extra = {
            "content_source": 100000000402,
            "content_word_cnt": plain_length,
            "is_multi_title": 0,
            "sub_titles": [],
            "gd_ext": {
                "entrance": "",
                "from_page": "publisher_mp",
                "enter_from": "PC",
                "device_platform": "mp",
                "is_message": 0,
            },
            "tuwen_wtt_transfer_switch": "1",
        }
        payload = {
            "source": 29,
            "extra": json.dumps(extra, ensure_ascii=False, separators=(",", ":")),
            "title": str(article.title),
            "content": content,
            "title_id": title_id,
            "search_creation_info": json.dumps(search_info, ensure_ascii=False, separators=(",", ":")),
            "mp_editor_stat": "{}",
            "is_refute_rumor": 0,
            "save": 1 if mode == "publish" else 0,
            "entrance": "main" if mode == "publish" else "",
            "timer_status": 0,
            "timer_time": "",
            "article_type": 0,
            "pgc_id": "",
            "educluecard": "",
            "draft_form_data": json.dumps({"coverType": 2}, separators=(",", ":")),
            "pgc_feed_covers": json.dumps(covers, ensure_ascii=False, separators=(",", ":")),
            "article_ad_type": int(self._article_defaults.get("article_ad_type") or 3),
            "is_fans_article": 0,
            "govern_forward": 0,
            "praise": 0,
            "disable_praise": 0,
            "tree_plan_article": 0,
            "star_order_id": "",
            "star_order_name": "",
            "customer_nick_name": "",
            "activity_tag": _coerce_activity_tag(activity_tag),
            "trends_writing_tag": "",
            "claim_exclusive": 0,
        }
        if cover:
            payload["ic_uri_list"] = [str(cover.get("uri", ""))]
        return payload

    def publish(
        self,
        article: Any,
        mode: str,
        cover_path: Path | None,
        dry_run: bool = False,
        activity_tag: str | int = 0,
    ) -> dict[str, Any]:
        session = self.check_session()
        cover = None if dry_run or cover_path is None else self.upload_image(cover_path)
        payload = self.build_payload(article, mode, cover, activity_tag)
        if dry_run:
            return {
                "status": "dry-run",
                "transport": (
                    "http+chrome-security"
                    if bool(self.toutiao.get("chrome_protocol_enabled", True))
                    else "http"
                ),
                "endpoint": self.PUBLISH_PATH,
                "session": session,
                "payload": payload,
                "created_at": utc_now(),
            }
        params = {
            "source": "mp",
            "type": "article",
            "aid": self.aid,
            "mp_publish_ab_val": self.publish_ab,
        }
        form_data = {
            key: ",".join(str(item) for item in value) if isinstance(value, list) else value
            for key, value in payload.items()
        }
        body = urlencode(form_data)
        chrome_protocol_enabled = bool(self.toutiao.get("chrome_protocol_enabled", True))
        if chrome_protocol_enabled:
            bridge = self.chrome_bridge or ChromeProtocolBridge(self.config, self.config_dir)
            response_payload = bridge.publish(
                self.PUBLISH_PATH,
                params,
                body,
                self.cookies,
            )
            transport = "http+chrome-security"
        else:
            unsigned_url = (
                f"{urljoin(self.base_url + '/', self.PUBLISH_PATH.lstrip('/'))}"
                f"?{urlencode(params)}"
            )
            params["_signature"] = self._sign_publish_request(unsigned_url, body)
            _, response_payload = self._request(
                "POST",
                self.PUBLISH_PATH,
                params=params,
                data=body,
                headers={"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"},
            )
            transport = "http"
        if not isinstance(response_payload, dict):
            raise PublisherError("发布响应不是 JSON")
        self._raise_payload_error(response_payload)
        data = response_payload.get("data") if isinstance(response_payload.get("data"), dict) else {}
        pgc_id = str(data.get("pgcId") or data.get("pgc_id") or "")
        report = {
            "status": mode,
            "transport": transport,
            "title": str(article.title),
            "topic": str(article.topic),
            "pgc_id": pgc_id,
            "cover": cover,
            "response": response_payload,
            "created_at": utc_now(),
        }
        self._save_report(str(article.title), report)
        return report

    def _sign_publish_request(self, url: str, body: str) -> str:
        script = resolve_config_path(
            self.config_dir,
            self.toutiao.get("acrawler_signer", "./acrawler_signer.mjs"),
        )
        if script is None or not script.is_file():
            raise PublisherError("acrawler 签名脚本不存在")
        node_binary = str(self.toutiao.get("node_binary", "node"))
        signer_input = json.dumps(
            {
                "url": url,
                "method": "POST",
                "body": body,
                "aid": self.aid,
                "user_agent": str(self.session.headers.get("User-Agent", "")),
                "cookies": self.cookies,
            },
            ensure_ascii=False,
        )
        try:
            completed = subprocess.run(
                [node_binary, str(script)],
                input=signer_input,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=20,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise PublisherError(f"acrawler 签名执行失败：{type(exc).__name__}") from exc
        if completed.returncode != 0:
            detail = completed.stderr.strip().splitlines()[-1] if completed.stderr.strip() else "unknown error"
            raise PublisherError(f"acrawler 签名执行失败：{detail[:300]}")
        try:
            result = json.loads(completed.stdout)
            signature = str(result.get("signature") or "")
        except (AttributeError, json.JSONDecodeError, TypeError) as exc:
            raise PublisherError("acrawler 签名响应格式无效") from exc
        if not signature:
            raise PublisherError("acrawler 未返回签名")
        return signature

    def _request(self, method: str, path: str, **kwargs: Any) -> tuple[Any, Any]:
        request_id = uuid.uuid4().hex[:12]
        url = urljoin(self.base_url + "/", path.lstrip("/"))
        kwargs.setdefault("timeout", self.timeout)
        try:
            response = self.session.request(method, url, **kwargs)
        except Exception as exc:
            self._log_exchange(
                request_id,
                method,
                url,
                kwargs,
                {"network_error": f"{type(exc).__name__}: {exc}"},
            )
            raise PublisherError(f"协议请求失败：{type(exc).__name__}: {exc}") from exc
        try:
            payload: Any = response.json()
        except Exception:
            payload = None
        body_text = str(getattr(response, "text", ""))
        self._log_exchange(
            request_id,
            method,
            url,
            kwargs,
            {
                "status_code": int(response.status_code),
                "headers": self._redact_headers(dict(response.headers)),
                "json": payload,
                "text": body_text[:20_000] if payload is None else "",
            },
        )
        for header_name in ("x-ms-token", "x-tt-token", "bd-ticket-guard-client-data"):
            header_value = response.headers.get(header_name)
            if header_value:
                self.session.headers[header_name] = str(header_value)
        if int(response.status_code) >= 400:
            message = ""
            if isinstance(payload, dict):
                message = str(payload.get("message") or payload.get("reason") or "")
            raise PublisherError(f"头条协议返回 HTTP {response.status_code}：{message or body_text[:200]}")
        return response, payload

    @staticmethod
    def _code(payload: Mapping[str, Any]) -> int | None:
        value = payload.get("code")
        if value is None:
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    def _raise_payload_error(self, payload: Mapping[str, Any], login_context: bool = False) -> None:
        code = self._code(payload)
        if code in (None, 0):
            return
        message = str(payload.get("reason") or payload.get("message") or f"协议错误 {code}")
        if code in CHALLENGE_MESSAGES:
            detail = CHALLENGE_MESSAGES[code]
            if message and message not in {"error", "fail"}:
                detail = f"{detail}（{message}）"
            raise ProtocolChallenge(code, detail)
        if login_context or any(word in message.lower() for word in ("login", "登录", "未登录")):
            raise LoginRequired(f"头条号会话校验失败：{message}")
        raise PublisherError(f"头条协议错误 {code}：{message}")

    def _save_report(self, title: str, report: dict[str, Any]) -> None:
        directory = resolve_config_path(
            self.config_dir, self.upload_config.get("report_dir", "./artifacts/reports")
        )
        assert directory is not None
        directory.mkdir(parents=True, exist_ok=True)
        safe_title = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", title).strip("-")[:40] or "article"
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = directory / f"{stamp}-{safe_title}.json"
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def _log_exchange(
        self,
        request_id: str,
        method: str,
        url: str,
        kwargs: Mapping[str, Any],
        response: Mapping[str, Any],
    ) -> None:
        if self.log_dir is None:
            return
        self.log_dir.mkdir(parents=True, exist_ok=True)
        files = kwargs.get("files")
        file_summary: dict[str, Any] = {}
        if isinstance(files, Mapping):
            for name, item in files.items():
                if isinstance(item, tuple):
                    file_summary[str(name)] = {"filename": str(item[0]), "content_type": str(item[2])}
                else:
                    file_summary[str(name)] = {"uploaded": True}
        elif kwargs.get("multipart") is not None:
            file_summary["image"] = {"uploaded": True, "transport": "curl_mime"}
        event = {
            "request_id": request_id,
            "time": utc_now(),
            "request": {
                "method": method.upper(),
                "url": url,
                "params": self._redact_params(kwargs.get("params")),
                "headers": self._redact_headers(dict(self.session.headers)),
                "json": kwargs.get("json"),
                "data": kwargs.get("data"),
                "files": file_summary,
            },
            "response": response,
        }
        log_path = self.log_dir / f"{datetime.now(timezone.utc):%Y-%m-%d}.jsonl"
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")

    @staticmethod
    def _redact_headers(headers: Mapping[str, Any]) -> dict[str, str]:
        return {
            str(key): "<redacted>" if SENSITIVE_HEADER.search(str(key)) else str(value)
            for key, value in headers.items()
        }

    @staticmethod
    def _redact_params(params: Any) -> Any:
        if not isinstance(params, Mapping):
            return params
        return {
            str(key): "<redacted>" if SENSITIVE_HEADER.search(str(key)) else value
            for key, value in params.items()
        }
