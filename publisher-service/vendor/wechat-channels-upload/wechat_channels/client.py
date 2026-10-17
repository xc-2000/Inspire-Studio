"""视频号助手网关客户端：cookie 会话 + 请求装饰 + 端点封装。

对应 bundle 里 ``index.31d9f171.js`` 模块 ``71948`` 的 ``Y_()`` 工厂：

1. **登录守卫** —— 无 ``sessionid`` cookie 时，业务请求一律回
   ``{"errCode":300330}``（前端是直接 ``location.href = login.html``）；
   只有 ``/notification/notification_list``、``/auth/auth_data`` 例外。
2. **每个请求体强制合并日志参数**（``_()`` 构造）：

   ==================== ==================================================
   ``timestamp``        ``Date.now()`` 字符串
   ``_log_finder_uin``  ``localStorage["finder_uin"]``
   ``_log_finder_id``   ``localStorage["finder_username"]``
   ``rawKeyBuff``       ``localStorage["finder_external_key"]``（"undefined" 归一为 ``""``）
   ``pluginSessionId``  ``localStorage["FinderHelperIframeSessionId"]``
   ``scene``            ``WN.FinderAssistant`` = 7
   ``reqScene``         ``oU()`` 当前 scene
   ==================== ==================================================

   注意是 ``Object.assign(t, n)``，即**日志参数会覆盖**调用方传入的同名字段。
3. **请求头**只加了 ``X-WECHAT-UIN``（``fakeUin``，默认 ``"0000000000"``）、
   设备指纹 ``finger-print-device-id``（可选）。
4. **查询参数中间件**（模块 ``1144``）按顺序加 ``_aid``、``_rid``、
   ``exportkey``（有 exportkey 时）、``_pageUrl``，然后才是重试包装。

没有 ``a_bogus`` 那种请求签名 —— 这一点和抖音/小红书不同，是本项目能被纯
HTTP 复刻的前提。详见 ``docs/PROTOCOL.md`` §3。
"""

from __future__ import annotations

import json
import random
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

import requests

from .constants import (
    API_BASE,
    DEFAULT_FAKE_UIN,
    ENDPOINTS,
    FINGERPRINT_HEADER,
    LOGIN_PAGE,
    NO_SESSION_REQUIRED_PATHS,
    POST_CREATE_PAGE,
    Scene,
)
from .errors import ApiError, LogicError, NetworkError, NotLoggedInError

__all__ = [
    "CookieJar",
    "ChannelsClient",
    "make_client_id",
    "make_rid",
    "make_aid",
]

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


def make_client_id() -> str:
    """``clientid``。前端用 ``uuid v4``（模块 ``eU`` / 16258 的 ``h``）。"""
    return str(uuid.uuid4())


def make_rid() -> str:
    """``_rid``：``<秒级时间戳的 16 进制>-<8 位随机 16 进制>``（模块 1144）。"""
    head = format(int(time.time()), "x")
    tail = "".join(random.choice("0123456789abcdef") for _ in range(8))
    return f"{head}-{tail}"


def make_aid() -> str:
    """``_aid``：前端优先读 ``localStorage["__ml::aid"]``，否则生成 uuid v4。"""
    return str(uuid.uuid4())


@dataclass
class CookieJar:
    """``channels.weixin.qq.com`` 的 cookie 集合，可持久化到 JSON。

    唯一必需的凭证是 ``sessionid``（在 ``channels.weixin.qq.com`` 域）。
    可选：``FinderHelperIframeSessionId``（插件 iframe 场景，对应 ``pluginSessionId``）。
    ``finder_uin`` / ``finder_username`` / ``finder_external_key`` 不是 cookie 而是
    localStorage，见 :attr:`ChannelsClient.log_params`。
    """

    values: dict[str, str] = field(default_factory=dict)
    path: Path | None = None

    # ---------- 构造 / 持久化 ----------

    @classmethod
    def load(cls, path: str | Path) -> "CookieJar":
        file = Path(path)
        if not file.exists():
            raise FileNotFoundError(
                f"cookie 文件不存在：{file}\n"
                "先用 python scripts/capture_cookies.py --wait-login 抓一份"
            )
        raw = json.loads(file.read_text(encoding="utf-8"))
        # 兼容两种格式：{"sessionid": "..."} 与 {"cookies": {...}} / 浏览器导出的 list
        if isinstance(raw, dict) and "cookies" in raw and isinstance(raw["cookies"], dict):
            raw = raw["cookies"]
        if isinstance(raw, list):  # chrome devtools / EditThisCookie 导出
            raw = {
                str(item.get("name")): str(item.get("value", ""))
                for item in raw
                if isinstance(item, dict) and item.get("name")
            }
        return cls({str(k): str(v) for k, v in raw.items()}, file)

    @classmethod
    def parse(cls, cookie_string: str) -> "CookieJar":
        """从 ``a=1; b=2`` 形式的字符串解析。"""
        values: dict[str, str] = {}
        for part in cookie_string.split(";"):
            if not part.strip() or "=" not in part:
                continue
            key, _, value = part.partition("=")
            values[key.strip()] = value.strip()
        return cls(values)

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
    def sessionid(self) -> str:
        return self.values.get("sessionid", "")

    @property
    def plugin_session_id(self) -> str:
        return self.values.get("FinderHelperIframeSessionId", "")

    @property
    def logged_in(self) -> bool:
        return bool(self.sessionid)

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


class ChannelsClient:
    """网关客户端。

    :param cookies: :class:`CookieJar`；与 ``cookie_path`` 二选一
    :param finder_uin: 对应 ``localStorage["finder_uin"]``，进 ``_log_finder_uin``
    :param finder_username: 对应 ``localStorage["finder_username"]``，进 ``_log_finder_id``
    :param external_key: 对应 ``localStorage["finder_external_key"]``，进 ``rawKeyBuff``
    :param fake_uin: 进 ``X-WECHAT-UIN``；登录后站点会把它设为凭证里的 ``uin``
    :param fingerprint: 进 ``finger-print-device-id``；留空则不发该头
    :param page_url: 进查询参数 ``_pageUrl``
    """

    def __init__(
        self,
        cookies: CookieJar | None = None,
        cookie_path: str | Path | None = None,
        *,
        base_url: str = API_BASE,
        finder_uin: str = "",
        finder_username: str = "",
        external_key: str = "",
        plugin_session_id: str = "",
        fake_uin: str = DEFAULT_FAKE_UIN,
        fingerprint: str = "",
        page_url: str = POST_CREATE_PAGE,
        exportkey: str = "",
        user_agent: str = DEFAULT_UA,
        timeout: float = 30.0,
        session: requests.Session | None = None,
        endpoints: Mapping[str, str] | None = None,
    ) -> None:
        if cookies is not None:
            self.cookies = cookies
        elif cookie_path is not None:
            self.cookies = CookieJar.load(cookie_path)
        else:
            self.cookies = CookieJar()

        self.base_url = base_url.rstrip("/")
        self.endpoints: dict[str, str] = dict(ENDPOINTS)
        if endpoints:
            self.endpoints.update(endpoints)

        self.finder_uin = finder_uin or self.cookies.values.get("finder_uin", "")
        self.finder_username = finder_username
        self.external_key = external_key
        self.plugin_session_id = plugin_session_id or self.cookies.plugin_session_id
        self.fake_uin = fake_uin
        self.fingerprint = fingerprint
        self.page_url = page_url
        self.exportkey = exportkey
        self.user_agent = user_agent
        self.timeout = timeout
        self.session = session or requests.Session()
        self.aid = make_aid()

        #: ``helper_upload_params`` 的响应缓存（前端 ``uploaderStore.authParams`` 同样只取一次）
        #: 注意不要叫 ``self.upload_params`` —— 会遮蔽同名方法
        self._upload_params: dict[str, Any] | None = None

    # ---------- URL / 端点 ----------

    def url_for(self, path_or_name: str) -> str:
        """``"create"`` -> ``https://channels.weixin.qq.com/cgi-bin/.../post/post_create``。"""
        if path_or_name.startswith(("http://", "https://")):
            return path_or_name
        if path_or_name.startswith("/"):
            return f"{self.base_url}{path_or_name}"
        try:
            path = self.endpoints[path_or_name]
        except KeyError:
            raise LogicError(f"未知端点名：{path_or_name}", "endpoint") from None
        return f"{self.base_url}{path}"

    # ---------- 日志参数 ----------

    def log_params(self, scene: int | None = None) -> dict[str, Any]:
        """复刻模块 ``71948`` 的 ``_()``。"""
        params: dict[str, Any] = {
            "timestamp": str(int(time.time() * 1000)),
            "_log_finder_uin": self.finder_uin,
            "_log_finder_id": self.finder_username,
            # 前端把字符串 "undefined" 归一成空串
            "rawKeyBuff": "" if self.external_key in ("undefined", None) else self.external_key,
            "pluginSessionId": self.plugin_session_id,
            "scene": Scene.FinderAssistant,
            "reqScene": Scene.FinderAssistant,
        }
        if scene is not None:
            params["scene"] = scene
        return params

    # ---------- 底层请求 ----------

    def request(
        self,
        path_or_name: str,
        data: Mapping[str, Any] | None = None,
        *,
        scene: int | None = None,
        method: str = "POST",
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        raise_on_error: bool = True,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """发一个业务请求，返回网关原始响应 dict。

        ``raise_on_error=False`` 时 ``errCode != 0`` 不抛异常（给探测用）。
        """
        path = path_or_name if path_or_name.startswith("/") else self.endpoints.get(
            path_or_name, path_or_name
        )
        url = self.url_for(path_or_name)

        query: dict[str, Any] = dict(params or {})
        # 中间件顺序：_aid -> _rid -> exportkey -> _pageUrl
        query["_aid"] = self.aid
        query["_rid"] = make_rid()
        if self.exportkey:
            query["exportkey"] = self.exportkey
        query["_pageUrl"] = self.page_url

        body: dict[str, Any] = dict(data or {})
        body.update(self.log_params(scene))
        if scene is not None:
            body["scene"] = scene

        # 前端 helperRequest：GET 把日志参数放进 query，其余方法放进 body
        is_get = method.upper() == "GET"
        if is_get:
            query.update({key: value for key, value in body.items()})
            body = {}

        if not self.cookies.logged_in and path not in NO_SESSION_REQUIRED_PATHS:
            # 复刻登录守卫：前端是直接跳 login.html，这里显式报错
            raise NotLoggedInError(
                path,
                f"cookie 里没有 sessionid，站点会重定向到 {LOGIN_PAGE}",
            )

        request_headers = {
            "X-WECHAT-UIN": self.fake_uin or DEFAULT_FAKE_UIN,
            "User-Agent": self.user_agent,
            "Referer": self.page_url,
            "Origin": self.base_url.split("/cgi-bin")[0],
            "Accept": "application/json, text/plain, */*",
        }
        if self.fingerprint:
            request_headers[FINGERPRINT_HEADER] = self.fingerprint
        if self.cookies.values:
            request_headers["Cookie"] = self.cookies.header()
        if headers:
            request_headers.update(headers)

        try:
            response = self.session.request(
                method.upper(),
                url,
                params=query,
                json=body if not is_get else None,
                headers=request_headers,
                timeout=timeout or self.timeout,
            )
        except requests.RequestException as exc:
            raise NetworkError(f"{method.upper()} {path} 失败：{exc}") from exc

        self.cookies.merge_response_cookies(response)

        try:
            payload = response.json()
        except ValueError:
            # 未登录时网关可能直接返回 HTML 登录页
            snippet = response.text[:300].replace("\n", " ")
            raise NetworkError(
                f"{method.upper()} {path} 返回非 JSON（HTTP {response.status_code}）：{snippet}"
            ) from None

        if not isinstance(payload, dict):
            raise NetworkError(f"{method.upper()} {path} 返回了非对象 JSON：{payload!r}")

        err_code = payload.get("errCode", 0)
        if raise_on_error and err_code != 0:
            message = payload.get("message") or payload.get("errMsg") or ""
            if err_code == 300330 and not self.cookies.logged_in:
                raise NotLoggedInError(path, payload)
            raise ApiError(err_code, message, path=path, payload=payload)

        return payload

    # ---------- 端点封装（与前端 postService 一一对应）----------

    def auth_data(
        self, appid: str = "", token: str = "", *, raise_on_error: bool = True
    ) -> dict[str, Any]:
        """``/auth/auth_data``：拿账号信息 + ``envInfo``（含 CDN host、上传版本）。

        这个路径在前端的免登录白名单里（登录页也要调它），所以未登录时拿到的是
        ``errCode = 300330`` 而不是被本地拦下 —— 默认按错误处理，需要原样看响应时
        传 ``raise_on_error=False``。
        """
        return self.request(
            "authData",
            {"pluginSessionAppid": appid or None, "pluginSessionToken": token or None},
            raise_on_error=raise_on_error,
        )

    def upload_params(self, refresh: bool = False) -> dict[str, Any]:
        """``/helper/helper_upload_params``：拿上传凭证。

        前端 ``uploaderStore.getUploadParams()`` 有缓存，并且会往 ``data`` 上塞
        ``normalFile = 20310``、``fakeUin = data.uin``。
        """
        if self._upload_params is not None and not refresh:
            return self._upload_params
        response = self.request("uploadParams")
        data = response.get("data") or {}
        if not data:
            raise LogicError(
                f"helper_upload_params 未返回凭证：{json.dumps(response, ensure_ascii=False)[:300]}",
                "uploadParams",
            )
        data = dict(data)
        data.setdefault("normalFile", 20310)
        if data.get("uin"):
            self.fake_uin = str(data["uin"])
        self._upload_params = data
        return data

    def get_post_trace_key(self, object_id: str | None = None) -> str:
        """``/post/get-finder-post-trace-key``。发布前必须拿到 ``traceKey``。"""
        response = self.request("getFinderPostTraceKey", {"objectId": object_id})
        data = response.get("data") or {}
        trace_key = data.get("traceKey")
        if not trace_key:
            raise LogicError(
                f"get-finder-post-trace-key 未返回 traceKey：{json.dumps(data, ensure_ascii=False)[:300]}",
                "traceKey",
            )
        return str(trace_key)

    def post_list(self, current_page: int = 1, page_size: int = 10, **extra: Any) -> dict[str, Any]:
        payload = {"currentPage": current_page, "pageSize": page_size}
        payload.update(extra)
        return self.request("list", payload)

    def get_draft_list(self, current_page: int = 1, page_size: int = 10) -> dict[str, Any]:
        return self.request(
            "getDraftList", {"currentPage": current_page, "pageSize": page_size}
        )

    def get_draft_info(self, object_id: str) -> dict[str, Any]:
        return self.request("getDraftInfo", {"objectId": object_id})

    def create_post(self, post: Mapping[str, Any], client_id: str = "") -> dict[str, Any]:
        """``/post/post_create``。**真的发布**，用于 ``--publish``。

        body 是**扁平** payload + 小写 ``clientid``（见 ``build_create_body`` 的实测表）。
        """
        body = dict(post)
        body["clientid"] = client_id or make_client_id()
        return self.request("create", body)

    def clip_video(
        self,
        *,
        url: str,
        width: int,
        height: int,
        duration: float,
        file_size: int,
        trace_info: Mapping[str, Any] | None = None,
        target_width: int | None = None,
        target_height: int | None = None,
        scene: int = Scene.FinderAssistant,
        **extra: Any,
    ) -> dict[str, Any]:
        """``/post/post_clip_video``：视频发表前的转码/裁剪任务。

        新版上传链路（``switchInfo.asyncClipPostSwitch`` 为真）下，视频
        ``post_create`` 之前**必须**走这一步，否则 ``post_create`` 返回
        ``errCode 300002``。返回的 ``draftId`` 要同时写进 ``videoClipTaskId``
        和 ``media[].urlCdnTaskId``。

        ``cropDuration=0`` 表示不裁剪，本步只做转码准备。
        """
        payload: dict[str, Any] = {
            "url": url,
            "timeStart": 0,
            "cropDuration": 0,
            "x": 0,
            "y": 0,
            "width": int(width),
            "height": int(height),
            "clipOriginVideoInfo": {
                "width": int(width),
                "height": int(height),
                "duration": duration,
                "fileSize": int(file_size),
            },
            "traceInfo": dict(trace_info or {}),
            "type": 4,  # 前端硬编码：clipVideoRequest 里 Object.assign(..., {type: 4})
            "useAstraThumbCover": True,
            "targetWidth": int(target_width if target_width is not None else width),
            "targetHeight": int(target_height if target_height is not None else height),
        }
        payload.update(extra)
        # 日志参数（timestamp/_log_finder_uin/... 与 scene）由 request() 统一补，
        # 这里不重复加，避免覆盖调用方传入的同名字段。
        response = self.request("clipVideo", payload, scene=scene)
        data = response.get("data") or {}
        draft_id = data.get("draftId") or data.get("clipKey")
        if not draft_id:
            raise LogicError(
                "post_clip_video 未返回 draftId："
                f"{json.dumps(data, ensure_ascii=False)[:300]}",
                "clipVideo",
            )
        return data

    def post_draft(
        self, post: Mapping[str, Any], client_id: str = "", object_id: str | None = None
    ) -> dict[str, Any]:
        """``/post/post_draft``。存草稿，默认动作。"""
        post_req = dict(post)
        post_req["clientid"] = client_id or make_client_id()
        return self.request("postDraft", {"postReq": post_req, "objectId": object_id or None})

    def create_post_preview(
        self, post: Mapping[str, Any], scene: int = Scene.FinderAssistant
    ) -> dict[str, Any]:
        """``/post/post_preview``：只生成预览票据，不落库。"""
        post_req = dict(post)
        post_req["clientid"] = make_client_id()
        return self.request("preview", {"postReq": post_req, "scene": scene})

    def get_post_info(self, object_id: str) -> dict[str, Any]:
        return self.request("getPostInfo", {"objectId": object_id})

    def delete_post(self, object_id: str) -> dict[str, Any]:
        return self.request("delete", {"objectId": object_id})

    def delete_draft(self, object_id: str) -> dict[str, Any]:
        return self.request("delDraft", {"objectId": object_id})

    def parse_mp_link(self, url: str) -> dict[str, Any]:
        """``/helper/helper_parse_mp_link``：扩展链接（公众号文章）解析。"""
        return self.request("parseMpLink", {"url": url}, raise_on_error=False)

    def search_finder_account(self, keyword: str, current_page: int = 1) -> dict[str, Any]:
        return self.request(
            "searchFinderAccount", {"keyword": keyword, "currentPage": current_page}
        )

    def search_location(self, keyword: str, current_page: int = 1) -> dict[str, Any]:
        return self.request(
            "searchLocation", {"keyword": keyword, "currentPage": current_page}
        )

    # ---------- 上传（不走网关，直连 CDN）----------

    def upload(self, *args: Any, **kwargs: Any) -> Any:
        """委托给 :class:`wechat_channels.uploader.DfsUploader`（延迟导入避免循环）。

        uploader 实例**缓存在 client 上**：``DfsUploader`` 会把"``simpleuploaddfs``
        不可用"记在 ``single_upload_enabled`` 里，每次新建实例都会把这个记忆丢掉，
        导致每个小文件都白撞一次 ``404 {"X-Errno":-5103015}``。
        """
        from .uploader import DfsUploader

        uploader = getattr(self, "_uploader", None)
        if uploader is None:
            uploader = DfsUploader(self)
            self._uploader = uploader
        return uploader.upload(*args, **kwargs)
