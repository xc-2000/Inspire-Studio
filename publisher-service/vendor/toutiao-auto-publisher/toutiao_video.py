"""Toutiao video upload and publish protocol client."""

from __future__ import annotations

import datetime
import hashlib
import hmac
import json
import secrets
import time
import urllib.parse
import zlib
from pathlib import Path
from typing import Any, Callable, Mapping

from curl_cffi import requests

from chrome_protocol_bridge import ChromeProtocolBridge, ChromeProtocolError
from toutiao_protocol import LoginRequired, PublisherError
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.toutiao import Article


ProgressCallback = Callable[[str, int], None]


class ToutiaoVideoClient:
    AUTH_PATH = "/ixigua/api/upload/getAuthKey/"
    PERMISSION_PATH = "/xigua/api/upload/GetPublishAuth"
    META_PATH = "/ixigua/api/upload/GetVideoMeta"
    POSTER_PATH = "/ixigua/api/upload/GetPosterList/"
    PUBLISH_PATH = "/xigua/api/upload/PublishVideo"
    VOD_HOST = "vod.bytedanceapi.com"

    def __init__(
        self,
        config: dict[str, Any],
        config_dir: Path,
        *,
        cookie_override: Mapping[str, str] | None = None,
        headers_override: Mapping[str, str] | None = None,
    ) -> None:
        self.config = config
        self.config_dir = config_dir
        self.toutiao = config.get("toutiao", {})
        self.base_url = str(self.toutiao.get("base_url", "https://mp.toutiao.com")).rstrip("/")
        self.cookies = {str(k): str(v) for k, v in (cookie_override or {}).items()}
        self.extra_headers = {str(k): str(v) for k, v in (headers_override or {}).items()}
        self.timeout = float(self.toutiao.get("video_request_timeout_seconds", 120))
        self.session = requests.Session(impersonate=str(self.toutiao.get("impersonate", "chrome")))
        self.session.headers.update(
            {
                "Accept": "application/json, text/plain, */*",
                "Origin": self.base_url,
                "Referer": f"{self.base_url}/profile_v4/video/publish",
                "User-Agent": str(self.toutiao.get("user_agent", "Mozilla/5.0")),
                "X-Requested-With": "XMLHttpRequest",
                **self.extra_headers,
            }
        )
        for name, value in self.cookies.items():
            self.session.cookies.set(name, value, domain=".toutiao.com", path="/")

    def close(self) -> None:
        self.session.close()

    def __enter__(self) -> "ToutiaoVideoClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def publish(
        self,
        article: Article,
        video_path: Path,
        mode: str,
        *,
        landscape: bool = True,
        activity_tag: str | int = 0,
        progress: ProgressCallback | None = None,
    ) -> dict[str, Any]:
        if mode not in {"draft", "publish"}:
            raise ValueError(f"Unsupported video publish mode: {mode}")
        if not video_path.is_file():
            raise PublisherError(f"Video file does not exist: {video_path}")
        permission = self._get(self.PERMISSION_PATH)
        permission_data = permission.get("data") if isinstance(permission.get("data"), dict) else {}
        author_permission = permission_data.get("authorPermission", {})
        if permission.get("status") != 0 or author_permission.get("DisablePublish") is True:
            raise PublisherError(str(permission.get("message") or "The account cannot publish video"))

        self._progress(progress, "video-auth", 85)
        auth = self._get_upload_auth(landscape)
        raw = video_path.read_bytes()
        apply_result = self._apply_upload(auth, len(raw))
        node = self._upload_node(apply_result)
        self._progress(progress, "video-uploading", 89)
        self._upload_binary(node, raw)
        self._progress(progress, "video-processing", 92)
        committed = self._commit_upload(auth, node)
        vid = self._committed_vid(committed) or str(node.get("Vid") or "")
        if not vid:
            raise PublisherError("VOD commit succeeded without returning a vid")
        meta, poster = self._load_meta_and_poster(vid)
        self._progress(progress, "video-publishing", 96)
        payload = self.build_publish_payload(
            article, video_path.name, vid, meta, poster, mode, activity_tag
        )
        bridge = ChromeProtocolBridge(self.config, self.config_dir)
        try:
            response = bridge.post_json(
                self.PUBLISH_PATH,
                payload,
                self.cookies,
                editor_url=f"{self.base_url}/profile_v4/video/publish",
            )
        except ChromeProtocolError as exc:
            raise PublisherError(str(exc)) from exc
        data = response.get("data") if isinstance(response.get("data"), dict) else {}
        if int(response.get("status", -1)) != 0 or int(data.get("Code", -1)) != 0:
            raise PublisherError(str(data.get("Message") or response.get("message") or response))
        self._progress(progress, "completed", 100)
        return {
            "ok": True,
            "type": "video",
            "mode": mode,
            "vid": vid,
            "item_id": str(data.get("ItemId") or ""),
            "title": article.title,
            "width": int(meta.get("Width") or 0),
            "height": int(meta.get("Height") or 0),
            "duration": float(meta.get("Duration") or 0),
            "transport": "vod-http+chrome-security",
            "platform": {"status": response.get("status"), "code": data.get("Code")},
        }

    def build_publish_payload(
        self,
        article: Article,
        filename: str,
        vid: str,
        meta: Mapping[str, Any],
        poster: Mapping[str, Any],
        mode: str,
        activity_tag: str | int = 0,
    ) -> dict[str, Any]:
        width = int(meta.get("Width") or 0)
        height = int(meta.get("Height") or 0)
        duration = max(1, int(float(meta.get("Duration") or 0)))
        thumb_uri = str(poster.get("URI") or poster.get("PosterURI") or "")
        thumb_url = str(poster.get("URL") or poster.get("DownloadURL") or "")
        if not thumb_uri:
            raise PublisherError("Toutiao did not return a usable video poster")
        try:
            normalized_activity_tag = max(0, int(activity_tag))
        except (TypeError, ValueError):
            normalized_activity_tag = 0
        return {
            "ItemId": "",
            "Title": article.title[:30],
            "VideoInfo": {
                "Vid": vid,
                "VName": filename,
                "ThumbUri": thumb_uri,
                "ThumbUrl": thumb_url,
                "Duration": duration,
                "VideoWidth": width,
                "VideoHeight": height,
            },
            "Abstract": article.summary[:200],
            "ClaimOrigin": False,
            "Praise": False,
            "PublishType": 1 if mode == "publish" else 0,
            "From": "mp",
            "EnterFrom": 5,
            "IsNew": True,
            "VideoType": 3 if width >= height else 6,
            "ExternalLink": "",
            "Label": article.tags[:5],
            "CompassVideo": {
                "CompassVideoId": "",
                "CompassVideoName": "",
                "CompassVideoType": 0,
            },
            "Commodity": [],
            "CreateSource": 2,
            "HideInfo": {"HideType": 0},
            "AttrsValueMap": {},
            "ActivityTag": normalized_activity_tag,
            "ComplianceInfo": {
                "IsAIGC": True,
                "ComplianceType": 3,
            },
            "TerminalType": "01",
            "OsType": "09",
            "SoftType": "chrome",
            "DevicePlatform": "pc",
        }

    def _get_upload_auth(self, landscape: bool) -> dict[str, Any]:
        response = self._get(
            self.AUTH_PATH,
            params={
                "params": json.dumps(
                    {"type": "video", "isLandscape": landscape},
                    separators=(",", ":"),
                )
            },
        )
        data = response.get("data") if isinstance(response.get("data"), dict) else {}
        token = data.get("uploadToken") if isinstance(data.get("uploadToken"), dict) else {}
        required = ("AccessKeyId", "SecretAccessKey", "SessionToken")
        if response.get("status") != 0 or not all(token.get(key) for key in required):
            raise PublisherError(str(response.get("message") or "Video upload authorization failed"))
        return {"space_name": str(data.get("spaceName") or "pgc"), "token": token}

    def _apply_upload(self, auth: Mapping[str, Any], size: int) -> dict[str, Any]:
        query = {
            "Action": "ApplyUploadInner",
            "Version": "2020-11-19",
            "SpaceName": auth["space_name"],
            "FileType": "video",
            "IsInner": 1,
            "FileSize": size,
            "EnOID": 1,
            "s": secrets.token_hex(8),
        }
        response = self._vod_request("GET", query, b"", auth["token"])
        if self._vod_error(response):
            raise PublisherError(self._vod_error(response))
        return response

    def _upload_node(self, response: Mapping[str, Any]) -> dict[str, Any]:
        result = response.get("Result") if isinstance(response.get("Result"), dict) else {}
        inner = result.get("InnerUploadAddress") if isinstance(result.get("InnerUploadAddress"), dict) else {}
        nodes = inner.get("UploadNodes") if isinstance(inner.get("UploadNodes"), list) else []
        if not nodes or not isinstance(nodes[0], dict):
            raise PublisherError("VOD apply response does not contain an upload node")
        return nodes[0]

    def _upload_binary(self, node: Mapping[str, Any], raw: bytes) -> None:
        stores = node.get("StoreInfos") if isinstance(node.get("StoreInfos"), list) else []
        if not stores or not isinstance(stores[0], dict):
            raise PublisherError("VOD upload node does not contain storage information")
        store = stores[0]
        host = str(node.get("UploadHost") or "")
        uri = str(store.get("StoreUri") or "")
        signature = str(store.get("Auth") or "")
        if not host or not uri or not signature:
            raise PublisherError("VOD storage information is incomplete")
        headers = {
            "Authorization": signature,
            "Content-CRC32": f"{zlib.crc32(raw) & 0xFFFFFFFF:08x}",
            "X-Storage-U": "undefined",
        }
        response = requests.post(
            f"https://{host}/{uri}",
            headers=headers,
            data=raw,
            impersonate="chrome",
            timeout=self.timeout,
        )
        try:
            payload = response.json()
        except ValueError as exc:
            raise PublisherError(f"VOD binary upload returned HTTP {response.status_code}") from exc
        if response.status_code != 200 or not (payload.get("success") == 0 or payload.get("code") == 2000):
            raise PublisherError(str(payload.get("message") or payload))

    def _commit_upload(self, auth: Mapping[str, Any], node: Mapping[str, Any]) -> dict[str, Any]:
        body = json.dumps(
            {
                "SessionKey": str(node.get("SessionKey") or ""),
                "Functions": [{"name": "GetMeta"}],
            },
            separators=(",", ":"),
        ).encode()
        query = {
            "Action": "CommitUploadInner",
            "Version": "2020-11-19",
            "SpaceName": auth["space_name"],
            "app_id": int(self.toutiao.get("aid", 1231)),
        }
        response = self._vod_request("POST", query, body, auth["token"])
        if self._vod_error(response):
            raise PublisherError(self._vod_error(response))
        return response

    @staticmethod
    def _committed_vid(response: Mapping[str, Any]) -> str:
        result = response.get("Result") if isinstance(response.get("Result"), dict) else {}
        rows = result.get("Results") if isinstance(result.get("Results"), list) else []
        return str(rows[0].get("Vid") or "") if rows and isinstance(rows[0], dict) else ""

    def _load_meta_and_poster(self, vid: str) -> tuple[dict[str, Any], dict[str, Any]]:
        last_message = ""
        for attempt in range(5):
            meta_response = self._get(self.META_PATH, params={"vid": vid, "SkipDownload": "true"})
            data = meta_response.get("data") if isinstance(meta_response.get("data"), dict) else {}
            result = data.get("Result") if isinstance(data.get("Result"), dict) else {}
            meta = result.get("Meta") if isinstance(result.get("Meta"), dict) else {}
            poster_response = self._get(
                self.POSTER_PATH,
                params={"params": json.dumps({"vid": vid}, separators=(",", ":"))},
            )
            poster_data = poster_response.get("data") if isinstance(poster_response.get("data"), dict) else {}
            posters = poster_data.get("Posters") if isinstance(poster_data.get("Posters"), list) else []
            if meta and (posters or result.get("PosterURI")):
                poster = dict(posters[0]) if posters and isinstance(posters[0], dict) else {}
                poster.setdefault("PosterURI", result.get("PosterURI"))
                return dict(meta), poster
            last_message = str(poster_response.get("message") or meta_response.get("message") or "processing")
            time.sleep(1.5 * (attempt + 1))
        raise PublisherError(f"Video metadata or poster is not ready: {last_message}")

    def _vod_request(
        self,
        method: str,
        query: Mapping[str, Any],
        body: bytes,
        token: Mapping[str, Any],
    ) -> dict[str, Any]:
        query_string = "&".join(
            f"{self._quote(key)}={self._quote(value)}"
            for key, value in sorted(query.items())
            if value is not None
        )
        now = datetime.datetime.now(datetime.timezone.utc)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        date = amz_date[:8]
        payload_hash = hashlib.sha256(body).hexdigest()
        canonical_headers = {
            "host": self.VOD_HOST,
            "x-amz-date": amz_date,
            "x-amz-security-token": str(token["SessionToken"]),
        }
        if body:
            canonical_headers["x-amz-content-sha256"] = payload_hash
        signed_headers = ";".join(sorted(canonical_headers))
        header_text = "".join(
            f"{name}:{canonical_headers[name]}\n" for name in sorted(canonical_headers)
        )
        canonical_request = (
            f"{method}\n/\n{query_string}\n{header_text}\n{signed_headers}\n{payload_hash}"
        )
        scope = f"{date}/cn-north-1/vod/aws4_request"
        string_to_sign = (
            f"AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n"
            f"{hashlib.sha256(canonical_request.encode()).hexdigest()}"
        )
        signing_key = self._hmac(("AWS4" + str(token["SecretAccessKey"])).encode(), date)
        signing_key = self._hmac(signing_key, "cn-north-1")
        signing_key = self._hmac(signing_key, "vod")
        signing_key = self._hmac(signing_key, "aws4_request")
        signature = hmac.new(signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()
        headers = {
            "X-Amz-Date": amz_date,
            "x-amz-security-token": str(token["SessionToken"]),
            "Authorization": (
                "AWS4-HMAC-SHA256 "
                f"Credential={token['AccessKeyId']}/{scope}, "
                f"SignedHeaders={signed_headers}, Signature={signature}"
            ),
        }
        if body:
            headers["X-Amz-Content-Sha256"] = payload_hash
            headers["Content-Type"] = "application/json"
        response = requests.request(
            method,
            f"https://{self.VOD_HOST}/?{query_string}",
            headers=headers,
            data=body or None,
            impersonate="chrome",
            timeout=self.timeout,
        )
        try:
            payload = response.json()
        except ValueError as exc:
            raise PublisherError(f"VOD API returned HTTP {response.status_code}") from exc
        if response.status_code != 200:
            raise PublisherError(str(payload))
        return payload

    def _get(self, path: str, params: Mapping[str, Any] | None = None) -> dict[str, Any]:
        response = self.session.get(
            self.base_url + path,
            params=dict(params or {}),
            timeout=self.timeout,
            allow_redirects=False,
        )
        if response.status_code in {301, 302, 303, 307, 308}:
            raise LoginRequired("Toutiao login session has expired")
        try:
            payload = response.json()
        except ValueError as exc:
            raise PublisherError(f"Toutiao video API returned HTTP {response.status_code}") from exc
        if response.status_code != 200 or not isinstance(payload, dict):
            raise PublisherError(str(payload))
        return payload

    @staticmethod
    def _vod_error(response: Mapping[str, Any]) -> str:
        metadata = response.get("ResponseMetadata")
        if not isinstance(metadata, Mapping):
            return ""
        error = metadata.get("Error")
        if not isinstance(error, Mapping):
            return ""
        return str(error.get("Message") or error.get("Code") or "VOD request failed")

    @staticmethod
    def _hmac(key: bytes, value: str) -> bytes:
        return hmac.new(key, value.encode(), hashlib.sha256).digest()

    @staticmethod
    def _quote(value: Any) -> str:
        return urllib.parse.quote(str(value), safe="-_.~")

    @staticmethod
    def _progress(callback: ProgressCallback | None, stage: str, percent: int) -> None:
        if callback:
            callback(stage, percent)
