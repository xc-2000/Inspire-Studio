"""腾讯云 COS v5 签名 + 上传（q-sign-algorithm=sha1）。

签名逻辑与 cos-js-sdk-v5 的 util.getAuth 逐字节一致，已用 5 组真实请求交叉验证：
单次 PUT、?uploads 列举未完成分片、?uploads 初始化分片、分片 PUT、完成分片 POST。

小红书上传用的临时密钥来自 permit 接口（/api/media/v1/upload/creator/permit）返回的
uploadTempPermits[i]：secretId / secretKey / token / startTime / expireTime /
uploadAddr / bucket / region / fileIds。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator, Mapping

import requests

__all__ = [
    "SIGNED_HEADER_WHITELIST",
    "cam_safe_url_encode",
    "CosCredentials",
    "build_authorization",
    "CosUploadResult",
    "CosUploadError",
    "CosUploader",
]

SIGNED_HEADER_WHITELIST = frozenset(
    {
        "cache-control", "content-disposition", "content-encoding", "content-length",
        "content-md5", "expect", "expires", "host", "if-match", "if-modified-since",
        "if-none-match", "if-unmodified-since", "origin", "range", "transfer-encoding",
        "pic-operations",
    }
)

DEFAULT_SLICE_SIZE = 3145728
IMAGE_SINGLE_SLICE_SIZE = 5242880


def cam_safe_url_encode(value: Any) -> str:
    """COS 专用 URL 编码：encodeURIComponent 之后再转义 5 个字符。"""
    text = urllib.parse.quote(str(value), safe="-_.~")
    return (
        text.replace("!", "%21").replace("'", "%27").replace("(", "%28")
        .replace(")", "%29").replace("*", "%2A")
    )


def _is_signed_header(name: str) -> bool:
    lowered = name.lower()
    return "x-cos-" in lowered or "x-ci-" in lowered or lowered in SIGNED_HEADER_WHITELIST


def _signable_headers(headers: Mapping[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in headers.items():
        if not _is_signed_header(key) or value is None:
            continue
        if isinstance(value, (list, tuple)):
            value = ",".join(str(v) for v in value)
        out[key] = str(value)
    return out


def _sorted_keys(obj: Mapping[str, Any], lower_case: bool) -> list[str]:
    keys = [cam_safe_url_encode(k).lower() if lower_case else k for k in obj]
    keys.sort(key=str.lower)
    return keys


def _obj2str(obj: Mapping[str, Any], lower_case_key: bool = False) -> str:
    parts = []
    for key in _sorted_keys(obj, False):
        value = "" if obj[key] is None else str(obj[key])
        enc_key = cam_safe_url_encode(key).lower() if lower_case_key else cam_safe_url_encode(key)
        parts.append(enc_key + "=" + cam_safe_url_encode(value))
    return "&".join(parts)


def _to_seconds(value: Any, fallback_ms: int | None = None) -> int:
    if value is None:
        return int(time.time()) if fallback_ms is None else int(fallback_ms) // 1000
    ivalue = int(value)
    return ivalue // 1000 if ivalue > 10**11 else ivalue


@dataclass
class CosCredentials:
    """permit.uploadTempPermits[i] 的归一化视图。"""

    secret_id: str
    secret_key: str
    token: str
    start_time: int
    expire_time: int
    upload_addr: str
    scheme: str = "https"
    bucket: str = ""
    region: str = ""
    file_ids: list[str] = field(default_factory=list)
    cdn_domain: str = ""
    cloud_type: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_permit(cls, permit: Mapping[str, Any], request_ts_ms: int | None = None) -> "CosCredentials":
        upload_addr = str(permit.get("uploadAddr") or "")
        scheme = "https"
        if upload_addr.startswith("http://"):
            scheme = "http"
        elif upload_addr.startswith("https://"):
            scheme = "https"
        return cls(
            secret_id=permit.get("secretId") or "null",
            secret_key=permit.get("secretKey") or "null",
            token=permit.get("token") or "",
            start_time=_to_seconds(permit.get("startTime"), request_ts_ms),
            expire_time=_to_seconds(permit.get("expireTime"), request_ts_ms),
            upload_addr=upload_addr,
            scheme=scheme,
            bucket=permit.get("bucket") or "",
            region=permit.get("region") or "",
            file_ids=list(permit.get("fileIds") or []),
            cdn_domain=permit.get("cdnDomain") or "",
            cloud_type=permit.get("cloudType") or "",
            raw=dict(permit),
        )

    @property
    def key_time(self) -> str:
        return f"{self.start_time};{self.expire_time}"

    def host(self) -> str:
        addr = self.upload_addr or ""
        if addr.startswith("http://") or addr.startswith("https://"):
            addr = urllib.parse.urlparse(addr).netloc
        return addr


def build_authorization(
    credentials: CosCredentials,
    method: str,
    key: str,
    headers: Mapping[str, Any] | None = None,
    query: Mapping[str, Any] | None = None,
) -> tuple[str, str, dict[str, str]]:
    """计算 COS 请求的 Authorization，返回 (authorization, format_string, 签名头)。"""
    pathname = key if key.startswith("/") else "/" + key
    signable = _signable_headers(headers or {})
    query = dict(query or {})

    header_list = ";".join(_sorted_keys(signable, True)).lower()
    param_list = ";".join(_sorted_keys(query, True)).lower()

    key_time = credentials.key_time
    sign_key = hmac.new(
        credentials.secret_key.encode(), key_time.encode(), hashlib.sha1
    ).hexdigest()
    format_string = "\n".join(
        [method.lower(), pathname, _obj2str(query, True), _obj2str(signable, True), ""]
    )
    string_to_sign = "\n".join(
        ["sha1", key_time, hashlib.sha1(format_string.encode()).hexdigest(), ""]
    )
    signature = hmac.new(
        sign_key.encode(), string_to_sign.encode(), hashlib.sha1
    ).hexdigest()

    authorization = (
        "q-sign-algorithm=sha1"
        f"&q-ak={credentials.secret_id}"
        f"&q-sign-time={key_time}"
        f"&q-key-time={key_time}"
        f"&q-header-list={header_list}"
        f"&q-url-param-list={param_list}"
        f"&q-signature={signature}"
    )
    return authorization, format_string, signable


def camelize_ros_header(name: str) -> str:
    """x-ros-video-id -> videoId，对应站点 e.split("x-ros-")[1].replace(/-\w/g, ...)。"""
    lowered = name.lower()
    suffix = lowered.split("x-ros-", 1)[1] if "x-ros-" in lowered else lowered
    parts = suffix.split("-")
    return (parts[0] if parts else "") + "".join(p.capitalize() for p in parts[1:])


@dataclass
class CosUploadResult:
    file_id: str
    key: str
    size: int
    bucket: str = ""
    region: str = ""
    etag: str = ""
    slice_size: int = DEFAULT_SLICE_SIZE
    is_slice: bool = False
    upload_addr: str = ""
    cdn_domain: str = ""
    url: str = ""
    preview_url: str = ""
    static_url: str = ""
    tracer_id: str = ""
    #: 视频上传时由 COS 响应头 ``x-ros-video-id`` 返回，是转码查询真正要用的 id
    #: （``postgw/videoid`` 接口实测返回空 data，站点本身也用响应头）
    video_id: str = ""
    ros_headers: dict[str, str] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)


class CosUploadError(RuntimeError):
    def __init__(self, message: str, status: int = 0, body: str = ""):
        super().__init__(message)
        self.status = status
        self.body = body


class CosUploader:
    """把本地内容按 permit 授权上传到小红书 ROS(COS)。

    - size <= slice_size：单次 PUT /{Key}
    - 否则：分片上传（初始化 -> 逐片 PUT -> CompleteMultipartUpload）
    """

    def __init__(
        self,
        credentials: CosCredentials,
        session: requests.Session | None = None,
        slice_size: int = DEFAULT_SLICE_SIZE,
        async_limit: int = 5,
        timeout: int = 180,
        on_progress: Callable[[int, int], None] | None = None,
    ):
        if not credentials.host():
            raise ValueError("permit 里没有 uploadAddr，无法上传")
        self.credentials = credentials
        self.session = session or requests.Session()
        self.slice_size = max(1, int(slice_size or DEFAULT_SLICE_SIZE))
        self.async_limit = max(1, int(async_limit or 5))
        self.timeout = timeout
        self.on_progress = on_progress
        self._app_id = "1251524319" if credentials.bucket == "unknown" else ""

    # ---------- 基础请求 ----------

    def _base_headers(self, extra: Mapping[str, Any] | None = None) -> dict[str, str]:
        headers: dict[str, Any] = {
            "host": self.credentials.host(),
            "x-cos-security-token": self.credentials.token,
        }
        if extra:
            headers.update(extra)
        return {k: str(v) for k, v in headers.items()}

    def _url(self, key: str, query: Mapping[str, Any] | None = None) -> str:
        url = f"{self.credentials.scheme}://{self.credentials.host()}/{key.lstrip('/')}"
        if query:
            pairs = []
            for k, v in query.items():
                if v is None or v == "":
                    pairs.append(cam_safe_url_encode(k))
                else:
                    pairs.append(cam_safe_url_encode(k) + "=" + cam_safe_url_encode(v))
            if pairs:
                url += "?" + "&".join(pairs)
        return url

    def _request(
        self,
        method: str,
        key: str,
        headers: Mapping[str, Any],
        query: Mapping[str, Any] | None = None,
        data: bytes | None = None,
    ) -> requests.Response:
        authorization, _, _ = build_authorization(
            self.credentials, method, key, headers, query
        )
        send_headers = {k: v for k, v in headers.items() if k.lower() != "host"}
        send_headers["Authorization"] = authorization
        if self._app_id:
            send_headers["x-cos-appid"] = self._app_id
        response = self.session.request(
            method,
            self._url(key, query),
            headers=send_headers,
            data=data,
            timeout=self.timeout,
            allow_redirects=False,
        )
        if response.status_code >= 400:
            raise CosUploadError(
                f"COS {method} {key} 失败：HTTP {response.status_code}",
                response.status_code,
                response.text[:1000],
            )
        return response

    # ---------- 单次上传 ----------

    def put_object(self, key: str, body: bytes, content_type: str = "") -> requests.Response:
        headers = self._base_headers(
            {
                "cache-control": "",
                "content-type": content_type or "",
                "content-length": str(len(body)),
            }
        )
        return self._request("PUT", key, headers, data=body)

    # ---------- 分片上传 ----------

    def list_incomplete(self, key: str) -> requests.Response:
        return self._request(
            "GET", "/", self._base_headers(), {"uploads": "", "prefix": key}
        )

    def create_multipart(self, key: str) -> requests.Response:
        return self._request(
            "POST", key, self._base_headers({"content-length": "0"}), {"uploads": ""}
        )

    @staticmethod
    def parse_upload_id(xml_text: str) -> str:
        match = re.search(r"<UploadId>(.*?)</UploadId>", xml_text, re.S)
        if not match:
            raise CosUploadError("初始化分片响应里没有 UploadId", 0, xml_text[:500])
        return match.group(1).strip()

    def upload_part(self, key: str, upload_id: str, part_number: int, body: bytes) -> str:
        headers = self._base_headers({"content-length": str(len(body))})
        response = self._request(
            "PUT",
            key,
            headers,
            {"partNumber": str(part_number), "uploadId": upload_id},
            data=body,
        )
        return response.headers.get("ETag") or response.headers.get("etag") or ""

    def complete_multipart(
        self, key: str, upload_id: str, parts: list[tuple[int, str]]
    ) -> requests.Response:
        xml = (
            "<CompleteMultipartUpload>"
            + "".join(
                f"<Part><PartNumber>{n}</PartNumber><ETag>{e}</ETag></Part>"
                for n, e in parts
            )
            + "</CompleteMultipartUpload>"
        ).encode()
        headers = self._base_headers(
            {
                "content-md5": base64.b64encode(hashlib.md5(xml).digest()).decode(),
                "content-type": "application/xml",
                "content-length": str(len(xml)),
            }
        )
        return self._request("POST", key, headers, {"uploadId": upload_id}, data=xml)

    def abort_multipart(self, key: str, upload_id: str) -> None:
        try:
            self._request("DELETE", key, self._base_headers(), {"uploadId": upload_id})
        except Exception:  # noqa: BLE001 - 清理失败不影响主流程
            pass

    # ---------- 统一入口 ----------

    def upload(
        self,
        body: bytes,
        key: str | None = None,
        content_type: str = "",
        slice_size: int | None = None,
    ) -> CosUploadResult:
        key = key or (self.credentials.file_ids[0] if self.credentials.file_ids else None)
        if not key:
            raise ValueError("permit 里没有 fileIds，必须显式传 key")
        chunk = int(slice_size or self.slice_size)
        if len(body) <= chunk:
            return self._result(key, body, chunk, False, self.put_object(key, body, content_type))
        return self._multipart(key, body, chunk)

    def _multipart(self, key: str, body: bytes, chunk: int) -> CosUploadResult:
        try:
            self.list_incomplete(key)
        except CosUploadError:
            pass
        upload_id = self.parse_upload_id(self.create_multipart(key).text)
        parts: list[tuple[int, str]] = []
        done = 0
        try:
            for index, offset in enumerate(range(0, len(body), chunk), start=1):
                piece = body[offset : offset + chunk]
                parts.append((index, self.upload_part(key, upload_id, index, piece)))
                done += len(piece)
                if self.on_progress:
                    self.on_progress(done, len(body))
            response = self.complete_multipart(key, upload_id, parts)
        except Exception:
            self.abort_multipart(key, upload_id)
            raise
        return self._result(key, body, chunk, True, response)

    def _result(
        self, key: str, body: bytes, chunk: int, is_slice: bool, response: requests.Response
    ) -> CosUploadResult:
        ros_headers: dict[str, str] = {}
        tracer_id = ""
        for name, value in response.headers.items():
            lowered = name.lower()
            if lowered.startswith("x-ros-"):
                ros_headers[camelize_ros_header(lowered)] = value
            elif lowered == "x-tracer":
                tracer_id = value

        result = CosUploadResult(
            file_id=key,
            key=key,
            size=len(body),
            bucket=self.credentials.bucket,
            region=self.credentials.region,
            etag=response.headers.get("ETag") or response.headers.get("etag") or "",
            slice_size=chunk,
            is_slice=is_slice,
            upload_addr=self.credentials.upload_addr,
            cdn_domain=self.credentials.cdn_domain,
            tracer_id=tracer_id,
            video_id=ros_headers.get("videoId", ""),
            ros_headers=ros_headers,
            raw={"status": response.status_code, "headers": dict(response.headers)},
        )
        if self.credentials.cdn_domain:
            url = f"{self.credentials.cdn_domain}/{key}"
            result.url = result.preview_url = result.static_url = url
        return result
