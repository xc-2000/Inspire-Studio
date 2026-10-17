"""小红书 creator 侧 HTTP 客户端：cookie 管理 + 自动签名 + 端点封装。

协议要点（从 creator 发布页前端 bundle 反推，详见 ../docs/PROTOCOL.md）：

- 域名：``edith.xiaohongshu.com``（web_api）、``creator.xiaohongshu.com``（galaxy / v5 media）
- 所有请求带 ``x-s`` / ``x-s-common`` / ``x-t`` / ``x-b3-traceid`` / ``x-xray-traceid``
- 发布类请求必须带 ``Referer: https://creator.xiaohongshu.com/``
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

import requests

from ._signing import Signer, generate_a1, generate_web_id

__all__ = [
    "EDITH",
    "WWW",
    "CREATOR",
    "ENDPOINTS",
    "CREATOR_REFERER",
    "ApiError",
    "CookieJar",
    "XhsClient",
]

EDITH = "https://edith.xiaohongshu.com"
WWW = "https://www.xiaohongshu.com"
CREATOR = "https://creator.xiaohongshu.com"

# 端点表，取自前端 bundle（project-publish-vue.*.js 模块 89775 与模块 9712）
ENDPOINTS = {
    "POST_NOTE": f"{EDITH}/web_api/sns/v2/note",
    "NOTE_INFO": f"{EDITH}/web_api/sns/capa/postgw/note/detail",
    "UPDATE_NOTE_INFO": f"{EDITH}/web_api/sns/capa/postgw/note/update",
    "TOPIC_LIST": f"{EDITH}/web_api/sns/v1/search/topic",
    "USER_LIST": f"{EDITH}/web_api/sns/v1/search/user_info",
    "RECOMMEND_COVER": f"{EDITH}/web_api/sns/capa/servicegw/cover_recommend",
    "GET_TRANSCODE_NEW": f"{EDITH}/web_api/sns/capa/postgw/query_transcode",
    "MAKE_VIDEOID": f"{EDITH}/web_api/sns/capa/postgw/videoid",
    #: 发布后回查笔记（参数是 snake_case ``note_id``）
    "NOTE_DETAIL": f"{EDITH}/web_api/sns/capa/postgw/note/detail",
    "UPLOADER_TOKEN_NEW": f"{EDITH}/api/media/v1/upload/creator/permit",
    "UPLOADER_TOKEN_NEWV2": f"{CREATOR}/api/media/v1/upload/creator/permit",
    "USER_VERIFY": f"{EDITH}/web_api/sns/v6/creator/user/verify",
    "USER_INFO": f"{CREATOR}/api/galaxy/user/my-info",
    "GET_SIGN_URL_NEW": f"{CREATOR}/web_api/sns/v5/creator/file/encryption",
    "QRCODE_CREATE": f"{EDITH}/api/sns/web/v1/login/qrcode/create",
    "QRCODE_STATUS": f"{EDITH}/api/sns/web/v1/login/qrcode/status",
    "SELFINFO": f"{EDITH}/api/sns/web/v1/user/selfinfo",
}

CREATOR_REFERER = "https://creator.xiaohongshu.com/"
#: edith 会校验 Origin，缺失时一律 401
CREATOR_ORIGIN = "https://creator.xiaohongshu.com"

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

# 视频/音频转码轮询参数（模块 9712 调用方）
VIDEO_TRANSCODE_LEVEL = "14"
AUDIO_TRANSCODE_LEVEL = "1005"
VIDEO_BIZ_NAME = "217"
AUDIO_PLAYABLE_BIZ_NAME = "10001"
AUDIO_TRANSCODE_BIZ_NAME = "10002"


class ApiError(RuntimeError):
    """业务错误：HTTP 非 2xx，或 HTTP 200 但 ``success=false`` / ``code != 0``。"""

    def __init__(self, message: str, status: int = 0, body: Any = None, code: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body
        self.code = code


@dataclass
class CookieJar:
    """小红书 cookie 集合，可持久化到 JSON 文件。

    匿名访问只需要 ``a1`` + ``webId``；登录后额外有 ``web_session``、``customerClientId`` 等。
    """

    values: dict[str, str] = field(default_factory=dict)
    path: Path | None = None

    # ---------- 构造 / 持久化 ----------

    @classmethod
    def anonymous(cls) -> "CookieJar":
        a1 = generate_a1()
        return cls(
            {
                "a1": a1,
                "webId": generate_web_id(a1),
                "webBuild": "1.29.1",
                "xsecappid": "ugc",
                "gid": f"{uuid.uuid4().hex[:8]}{int(time.time() * 1000)}",
                "ets": str(int(time.time() * 1000)),
            }
        )

    @classmethod
    def load(cls, path: str | Path) -> "CookieJar":
        file = Path(path)
        if not file.exists():
            return cls.anonymous().with_path(file)
        data = json.loads(file.read_text(encoding="utf-8"))
        return cls({str(k): str(v) for k, v in data.items()}, file)

    def with_path(self, path: str | Path) -> "CookieJar":
        self.path = Path(path)
        return self

    def save(self, path: str | Path | None = None) -> Path:
        target = Path(path) if path else self.path
        if target is None:
            raise ValueError("没有指定 cookie 保存路径")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            json.dumps(self.values, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        self.path = target
        return target

    # ---------- 取值 ----------

    @property
    def a1(self) -> str:
        return self.values.get("a1", "")

    @property
    def web_session(self) -> str:
        return self.values.get("web_session", "")

    @property
    def logged_in(self) -> bool:
        return bool(self.web_session)

    def header(self) -> str:
        return "; ".join(f"{k}={v}" for k, v in self.values.items())

    def update(self, new_values: Mapping[str, Any]) -> "CookieJar":
        for key, value in new_values.items():
            if value is not None:
                self.values[str(key)] = str(value)
        return self

    def merge_response_cookies(self, response: requests.Response) -> "CookieJar":
        for cookie in response.cookies:
            self.values[cookie.name] = cookie.value
        return self


def _camelize_keys(value: Any) -> Any:
    """把服务端 snake_case 响应递归转成 camelCase（``has_first_frame`` -> ``hasFirstFrame``）。"""
    if isinstance(value, dict):
        return {_snake_to_camel(k): _camelize_keys(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_camelize_keys(v) for v in value]
    return value


def _snake_to_camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


class XhsClient:
    """签名 + 会话一体的请求客户端。"""

    def __init__(
        self,
        cookies: CookieJar | None = None,
        cookie_path: str | Path | None = None,
        signer: Signer | None = None,
        xsec_appid: str = "ugc",
        timeout: int = 30,
        user_agent: str = DEFAULT_UA,
        endpoints: Mapping[str, str] | None = None,
    ):
        #: 端点表可覆盖，便于本地 mock 测试
        self.endpoints: dict[str, str] = dict(ENDPOINTS)
        if endpoints:
            self.endpoints.update(endpoints)
        if cookies is not None:
            self.cookies = cookies
        elif cookie_path is not None:
            self.cookies = CookieJar.load(cookie_path)
        else:
            self.cookies = CookieJar.anonymous()
        self.signer = signer or Signer(xsec_appid=xsec_appid)
        self.timeout = timeout
        self.user_agent = user_agent
        self.session = requests.Session()

    # ---------- 底层请求 ----------

    @staticmethod
    def to_uri(url: str) -> str:
        """完整 URL -> 参与签名的 path+query 里的 path 部分。"""
        if "://" not in url:
            return url
        after_host = url.split("://", 1)[1]
        return "/" + after_host.split("/", 1)[1] if "/" in after_host else "/"

    def request(
        self,
        method: str,
        url: str,
        params: Mapping[str, Any] | None = None,
        payload: Mapping[str, Any] | None = None,
        referer: str | None = None,
        extra_headers: Mapping[str, str] | None = None,
        xsec_appid: str | None = None,
        x_rap: bool = False,
        raw: bool = False,
        timeout: int | None = None,
    ) -> Any:
        """发一个已签名的请求；``raw=True`` 时直接返回 ``requests.Response``。"""
        method = method.upper()
        uri = self.to_uri(url)

        # 签名用的 query 必须与真正发出的 query 完全一致
        sign_params = None
        if method == "GET" and params:
            sign_params = {k: v for k, v in params.items() if v is not None}

        headers = self.signer.headers(
            method,
            uri,
            self.cookies.values,
            params=sign_params,
            payload=dict(payload) if (method == "POST" and payload) else None,
            xsec_appid=xsec_appid,
            x_rap=x_rap,
            user_id=self.cookies.values.get("user_id") or None,
        )
        headers["Cookie"] = self.cookies.header()
        headers["User-Agent"] = self.user_agent
        headers["Referer"] = referer or CREATOR_REFERER
        # edith 对跨站请求做 Origin 校验：缺 Origin 时即使签名与会话都正确也返回
        # 401 {"code":-100,"msg":"无登录信息"}。站点 SPA 位于 creator 域，故带上它。
        headers["Origin"] = CREATOR_ORIGIN
        headers["Accept"] = "application/json, text/plain, */*"
        if method == "POST":
            headers.setdefault("Content-Type", "application/json;charset=UTF-8")
        if extra_headers:
            headers.update(extra_headers)

        body = None
        if method == "POST":
            body = json.dumps(payload or {}, separators=(",", ":"), ensure_ascii=False)

        response = self.session.request(
            method,
            url,
            params=sign_params,
            data=body,
            headers=headers,
            timeout=timeout or self.timeout,
        )
        self.cookies.merge_response_cookies(response)

        if raw:
            return response

        try:
            data = response.json()
        except ValueError:
            raise ApiError(
                f"{method} {uri} 返回非 JSON（HTTP {response.status_code}）",
                response.status_code,
                response.text[:500],
            ) from None

        if response.status_code >= 400:
            raise ApiError(
                data.get("msg") or f"HTTP {response.status_code}",
                response.status_code,
                data,
                data.get("code"),
            )
        if isinstance(data, dict) and data.get("success") is False:
            raise ApiError(
                data.get("msg") or "接口返回 success=false",
                response.status_code,
                data,
                data.get("code"),
            )
        return data

    def get(self, url: str, params: Mapping[str, Any] | None = None, **kwargs: Any) -> Any:
        return self.request("GET", url, params=params, **kwargs)

    def post(self, url: str, payload: Mapping[str, Any] | None = None, **kwargs: Any) -> Any:
        return self.request("POST", url, payload=payload, **kwargs)

    # ---------- 会话/身份 ----------

    def self_info(self) -> Any:
        """校验签名与会话：未登录返回 ``code=-101``。"""
        return self.get(self.endpoints["SELFINFO"], referer=f"{WWW}/")

    def is_logged_in(self) -> bool:
        try:
            data = self.self_info()
        except ApiError:
            return False
        return bool((data or {}).get("data"))

    def creator_user_info(self) -> Any:
        """creator 侧用户信息；未登录返回 ``result=-100 / 登录已过期``。"""
        return self.get(self.endpoints["USER_INFO"], referer=CREATOR_REFERER)

    # ---------- 话题 / @用户 ----------

    def search_topic(self, keyword: str) -> list[dict[str, Any]]:
        data = self.post(
            self.endpoints["TOPIC_LIST"],
            {
                "keyword": keyword,
                "suggest_topic_request": {"title": "", "desc": ""},
                "page": {"page_size": 20, "page": 1},
            },
        )
        # 响应外层是 {"code":0,"data":{...,"topic_info_dtos":[...]}}
        inner = data.get("data") if isinstance(data, dict) else None
        if isinstance(inner, dict) and "topic_info_dtos" in inner:
            data = inner
        return data.get("topic_info_dtos") or []

    def search_user(self, keyword: str) -> list[dict[str, Any]]:
        data = self.post(
            self.endpoints["USER_LIST"],
            {
                "keyword": keyword,
                "search_id": str(int(time.time() * 1000)),
                "page": {"page_size": 20, "page": 1},
            },
        )
        return data.get("user_info_dtos") or []

    # ---------- 上传许可 ----------

    def get_upload_permit(
        self,
        biz_name: str = "spectrum",
        scene: str = "image",
        file_count: int = 1,
        file_format: str | None = None,
        persistent_ops: str | None = None,
        persistent_notify_url: str | None = None,
        use_v2: bool = True,
    ) -> dict[str, Any]:
        """取上传临时许可。

        **参数是 snake_case**（站点 axios 拦截器把 camelCase 转成 snake_case 后发出，
        实测 ``fileCount`` 会被服务端拒绝为 ``required param check: file_count``）。
        站点实际只发 ``biz_name/scene/file_count/version/source``，不带 ``file_format``。

        端点：``{creator}/api/media/v1/upload/creator/permit``（实测可用；
        ``galaxy.xiaohongshu.com`` 在本机网络下 TLS 握手失败）。

        返回外层已 unwrap 的 ``{"uploadTempPermits": [...], "uploadLimitPolicy": {...}}``。
        """
        params: dict[str, Any] = {
            "biz_name": biz_name,
            "scene": scene,
            "file_count": file_count,
            "version": 1,
            "source": "web",
        }
        if file_format:
            # 传 mime 会让服务端返回空许可，只有扩展名（如 "jpeg"）被接受
            params["file_format"] = file_format
        if persistent_ops:
            params["persistent_ops"] = persistent_ops
        if persistent_notify_url:
            params["persistent_notify_url"] = persistent_notify_url

        url = (
            self.endpoints["UPLOADER_TOKEN_NEWV2"] if use_v2 else self.endpoints["UPLOADER_TOKEN_NEW"]
        )
        data = self.get(url, params=params, referer=CREATOR_REFERER)
        if isinstance(data, dict):
            inner = data.get("data")
            if isinstance(inner, dict) and (
                "uploadTempPermits" in inner or "uploadLimitPolicy" in inner
            ):
                return inner
        return data

    # ---------- 视频 id / 转码 ----------

    def make_video_id(self, file_key: str, biz_name: str = VIDEO_BIZ_NAME) -> int:
        """``GET /web_api/sns/capa/postgw/videoid``；返回 ``-1`` 表示失败。"""
        data = self.get(
            self.endpoints["MAKE_VIDEOID"],
            # 线上参数是 snake_case：camelCase 会被服务端忽略并返回空 data
            params={"file_key": file_key, "biz_name": biz_name},
        )
        # 响应同样是 snake_case：{"code":0,"data":{"video_id":"138..."}}
        # get() 返回的是外层信封，video_id 在 data 里
        scope = data
        if isinstance(data, dict) and isinstance(data.get("data"), dict)                 and "video_id" not in data and "videoId" not in data:
            scope = data["data"]
        raw = None
        if isinstance(scope, dict):
            raw = scope.get("video_id") or scope.get("videoId")
        try:
            return int(raw) if raw not in (None, "", -1) else -1
        except (TypeError, ValueError):
            return -1

    def query_transcode(
        self,
        video_id: int | str,
        need_transcode: bool,
        level: str = VIDEO_TRANSCODE_LEVEL,
        resource_type: int = 0,
    ) -> dict[str, Any]:
        """``GET /web_api/sns/capa/postgw/query_transcode``。

        站点调用签名为 ``queryTranscode(videoId, needTranscode, level, resourceType=0)``，
        ``resourceType`` 默认 ``0``（传 ``1`` 实测只回默认值，不返回 ``hasFirstFrame``）。
        """
        # 实测站点发出的 query 是 snake_case（video_id/need_transcode/resource_type），
        # 写成 camelCase 时服务端会忽略它们，只回 {"max_unchanged_query_times","query_interval_ms"}。
        params = {
            "video_id": video_id,
            "need_transcode": "true" if need_transcode else "false",
            "level": level,
            "resource_type": resource_type,
        }
        data = self.get(self.endpoints["GET_TRANSCODE_NEW"], params=params)
        # 响应也是 snake_case（has_first_frame / trans_progress_info ...）；
        # 拆掉信封并归一成 camelCase，调用方只需认一套键名。
        if isinstance(data, dict) and isinstance(data.get("data"), dict):
            data = data["data"]
        return _camelize_keys(data)

    def note_detail(self, note_id: str) -> dict[str, Any]:
        """``GET /web_api/sns/capa/postgw/note/detail``；参数名是 ``note_id``。

        用于发布后回查（``data.title`` / ``data.id`` / ``data.post_time``）。
        """
        data = self.get(
            self.endpoints["NOTE_DETAIL"], params={"note_id": note_id}
        )
        if isinstance(data, dict) and isinstance(data.get("data"), dict):
            return data["data"]
        return data or {}

    def file_encryption(self, file_id: str, file_type: str = "image") -> str:
        """``GET /web_api/sns/v5/creator/file/encryption``：fileId -> fileStr。

        站点签名：``v(e) = MD5("hIJXulBFYcGRQjrz" + e + <epoch 秒按 nibble 展开>)``。
        """
        path = "/" + file_id.lstrip("/")
        ts = int(time.time() * 1000)
        seconds = ts // 1000
        nibble_key = "".join(str((seconds >> (4 * i)) & 0xF) for i in range(8))
        sign = hashlib.md5(f"hIJXulBFYcGRQjrz{path}{nibble_key}".encode()).hexdigest()
        data = self.get(
            self.endpoints["GET_SIGN_URL_NEW"],
            params={"fileId": path, "type": file_type, "ts": ts, "sign": sign},
        )
        return (data or {}).get("fileStr", "")

    # ---------- 发布 ----------

    def post_note(
        self,
        common: Mapping[str, Any],
        image_info: Mapping[str, Any] | None = None,
        video_info: Mapping[str, Any] | None = None,
    ) -> Any:
        """``POST /web_api/sns/v2/note``：payload 先转 snake_case。"""
        from .payload import to_post_note_payload

        body = to_post_note_payload(common, image_info, video_info)
        return self.post(self.endpoints["POST_NOTE"], body, referer=CREATOR_REFERER)
