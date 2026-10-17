"""登录：扫码登录（协议）+ 已有会话导入。

协议（``project-publish-components.*.js`` 的 ``nK`` / ``n$`` / ``nU``，
请求参数 camelCase -> snake_case 由 axios 拦截器完成，所以发出的是 snake_case）：

1. ``POST {edith}/api/sns/web/v1/login/qrcode/create``
   body ``{"qrType": 1[, "service": ..., "oldQrId": ...]}``
   -> ``{"qr_id","code","url","multi_flag"}``（response 也是 snake_case）
2. ``POST {edith}/api/qrcode/userinfo``
   body ``{"qrId": ..., "code": ...}`` -> ``{"codeStatus": n}``
3. ``GET {edith}/api/sns/web/v1/login/qrcode/status``
   query ``qr_id=...&code=...`` -> ``{"code_status": n}``

``code_status`` 语义（已联网验证 0 = 待扫码）:

===== ==================================
0     待扫码
1     已扫码，等待手机确认
2     登录成功（响应 Set-Cookie 带 web_session）
3     二维码过期
===== ==================================

三个接口都是匿名可用的；但 ``qrcode/create`` 有风控，被判定风险时返回
HTTP 461 / ``code=300012 "IP存在风险"`` —— 换网络重试，或直接
:meth:`Login.import_cookies` 导入浏览器里已有的会话。
"""


from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

from .client import CREATOR_REFERER, EDITH, ENDPOINTS, XhsClient

__all__ = [
    "QRCODE_USERINFO",
    "CODE_STATUS",
    "QrCode",
    "Login",
    "SessionExpired",
]

QRCODE_USERINFO = f"{EDITH}/api/qrcode/userinfo"

#: 二维码创建：请求用 camelCase（服务端接受），响应是 snake_case
QRCODE_CREATE_BODY_KEY = "qrType"

#: code_status -> 语义（站点 UI 映射 nq = {0: 2, 1: 3, 2: 1, 3: 4}）
CODE_STATUS = {
    0: "waiting",  # 待扫码（UI 2 = 展示二维码）
    1: "scanned",  # 已扫码，等待手机确认（UI 3）
    2: "confirmed",  # 登录成功（UI 1）
    3: "expired",  # 二维码过期（UI 4）
}

#: code_status -> 站点 UI 状态
UI_STATUS_MAP = {0: 2, 1: 3, 2: 1, 3: 4}

COOKIE_KEYS_OF_INTEREST = (
    "web_session",
    "webId",
    "a1",
    "gid",
    "customerClientId",
    "customerClientIdV2",
    "xsecappid",
    "webBuild",
    "websectiga",
    "sec_poison_id",
    "acw_tc",
    "ets",
    "loadts",
)


class SessionExpired(RuntimeError):
    pass


@dataclass
class QrCode:
    qr_id: str
    url: str = ""
    code: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    def to_data_uri(self, scale: int = 6) -> str:
        """把二维码内容渲染成 ``data:image/png;base64,...``（需要 ``qrcode`` 包）。"""
        try:
            import base64
            import io

            import qrcode  # type: ignore
        except ImportError as exc:  # pragma: no cover - 可选依赖
            raise RuntimeError("渲染二维码需要 `pip install qrcode[pil]`") from exc

        image = qrcode.make(self.url)
        if scale > 1:
            image = image.resize((image.width * scale, image.height * scale))
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()

    def save_png(self, path: str | Path, scale: int = 6) -> Path:
        data_uri = self.to_data_uri(scale)
        raw = data_uri.split(",", 1)[1]
        import base64

        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base64.b64decode(raw))
        return target


class Login:
    """扫码登录 + 会话导入。"""

    def __init__(self, client: XhsClient):
        self.client = client

    # ------------------------------------------------------------------
    # 扫码登录
    # ------------------------------------------------------------------

    def create_qrcode(self, service: str = "", old_qr_id: str | None = None) -> QrCode:
        """创建登录二维码；返回 ``qr_id`` / ``url``（``url`` 是 ``xhsdiscover://`` 深链）。"""
        body: dict[str, Any] = {QRCODE_CREATE_BODY_KEY: 1}
        if service:
            body["service"] = service
        if old_qr_id:
            body["oldQrId"] = old_qr_id
        data = self.client.post(
            ENDPOINTS["QRCODE_CREATE"],
            body,
            referer=CREATOR_REFERER,
        )
        payload = data.get("data") if isinstance(data.get("data"), dict) else data
        qr_id = payload.get("qr_id") or payload.get("qrId") or ""
        url = payload.get("url") or ""
        if not qr_id or not url:
            raise RuntimeError(
                f"创建二维码失败：{json.dumps(data, ensure_ascii=False)[:300]}"
            )
        return QrCode(
            qr_id=str(qr_id),
            url=str(url),
            code=str(payload.get("code") or ""),
            raw=dict(payload),
        )

    def query_userinfo(self, qr: QrCode) -> dict[str, Any]:
        """``POST /api/qrcode/userinfo``：扫码后能拿到头像等账号信息。"""
        data = self.client.post(
            QRCODE_USERINFO,
            {"qrId": qr.qr_id, "code": qr.code},
            referer=CREATOR_REFERER,
        )
        payload = self._status_payload(data)
        return dict(payload or {})

    def query_status(self, qr: QrCode) -> str:
        """按创作中心当前网页顺序查询二维码状态。

        网页每轮先 POST ``/api/qrcode/userinfo``。只有 ``codeStatus=2`` 时，
        才带上账号地域响应头 GET ``/login/qrcode/status`` 完成登录 Cookie 交换。
        直接持续请求 GET 接口会在手机确认后返回“登录异常”。
        """
        userinfo = self.query_userinfo(qr)
        status = userinfo.get("code_status")
        if status is None:
            status = userinfo.get("codeStatus")
        if status is None:
            return "unknown"
        status_code = int(status)
        if status_code != 2:
            return CODE_STATUS.get(status_code, "unknown")

        extra_headers: dict[str, str] = {}
        data_country = userinfo.get("accountGeographicZone") or userinfo.get("account_geographic_zone")
        holder_country = userinfo.get("accountHolderCountry") or userinfo.get("account_holder_country")
        if data_country:
            extra_headers["x-rednote-datactry"] = str(data_country)
        if holder_country:
            extra_headers["x-rednote-holderctry"] = str(holder_country)
        data = self.client.get(
            ENDPOINTS["QRCODE_STATUS"],
            params={"qr_id": qr.qr_id, "code": qr.code},
            referer=CREATOR_REFERER,
            extra_headers=extra_headers,
        )
        payload = self._status_payload(data)
        final_status = payload.get("code_status")
        if final_status is None:
            final_status = payload.get("codeStatus")
        return CODE_STATUS.get(int(final_status if final_status is not None else status_code), "unknown")

    @staticmethod
    def _status_payload(data: Any) -> dict[str, Any]:
        """兼容直返、data 和 data.data 三种扫码响应形状。"""
        if not isinstance(data, dict):
            return {}
        candidates = [data, data.get("data")]
        nested = data.get("data")
        if isinstance(nested, dict):
            candidates.append(nested.get("data"))
        for candidate in candidates:
            if isinstance(candidate, dict) and (
                candidate.get("codeStatus") is not None or candidate.get("code_status") is not None
            ):
                return candidate
        if isinstance(nested, dict):
            nested_data = nested.get("data")
            return nested_data if isinstance(nested_data, dict) else nested
        return data

    def wait_for_login(
        self,
        qr: QrCode,
        interval: float = 1.0,
        timeout: float = 300,
        on_status: Callable[[str], None] | None = None,
    ) -> Any:
        """轮询到登录成功（或超时/过期）。

        成功后 ``self.client.cookies`` 里会带上 ``web_session``；
        调用方负责 ``cookies.save(path)``。
        """
        deadline = time.time() + timeout
        last = ""
        while time.time() < deadline:
            status = self.query_status(qr)
            if status != last and on_status:
                on_status(status)
            last = status
            if status == "confirmed":
                # 登录成功时响应会 Set-Cookie web_session
                self.on_login_success(qr)
                return self.client.creator_user_info()
            if status in ("expired", "cancelled"):
                raise SessionExpired(f"二维码已失效（{status}），请重新获取")
            time.sleep(interval)
        raise TimeoutError("等待扫码确认超时")

    def on_login_success(self, qr: QrCode) -> None:
        """登录成功后的收尾：补一次 userinfo（失败不影响主流程）。"""
        from .client import ApiError

        try:
            info = self.query_userinfo(qr)
        except ApiError:
            return
        if not info:
            return
        for key in ("userId", "user_id", "web_session", "customerClientId"):
            value = info.get(key)
            if value:
                self.client.cookies.update({key: value})

    def qr_login(
        self,
        interval: float = 1.0,
        timeout: float = 300,
        on_status: Callable[[str], None] | None = None,
        qr_png: str | Path | None = None,
        on_qr: Callable[[QrCode], None] | None = None,
    ) -> Any:
        """一站式扫码登录。

        :param qr_png: 若给定路径，会把二维码保存成 PNG（需要 ``qrcode`` 包）
        :param on_qr: 拿到二维码后的回调（例如打印 ``qr.url`` 让用户用 App 扫）
        """
        qr = self.create_qrcode()
        if on_qr:
            on_qr(qr)
        if qr_png:
            try:
                qr.save_png(qr_png)
            except RuntimeError as exc:
                print(f"[login] 保存二维码失败：{exc}", flush=True)
        return self.wait_for_login(qr, interval=interval, timeout=timeout, on_status=on_status)

    # ------------------------------------------------------------------
    # 会话导入
    # ------------------------------------------------------------------

    def import_cookies(
        self,
        cookies: Mapping[str, Any] | str | Path,
        verify: bool = True,
    ) -> bool:
        """导入已有 cookie（dict / ``k=v; k=v`` 字符串 / JSON 文件路径）。"""
        values: dict[str, str] = {}
        if isinstance(cookies, Mapping):
            values = {str(k): str(v) for k, v in cookies.items()}
        elif isinstance(cookies, Path) or (
            isinstance(cookies, str) and Path(cookies).exists()
        ):
            raw = json.loads(Path(cookies).read_text(encoding="utf-8"))
            if isinstance(raw, dict) and "cookies" in raw:
                raw = raw["cookies"]
            if isinstance(raw, list):  # Playwright/CDP 风格 [{name, value}, ...]
                values = {str(item["name"]): str(item["value"]) for item in raw}
            else:
                values = {str(k): str(v) for k, v in raw.items()}
        else:
            values = self.parse_cookie_header(str(cookies))

        if not values:
            raise ValueError("没有解析出任何 cookie")
        self.client.cookies.update(values)
        if verify:
            return self.verify()
        return True

    @staticmethod
    def parse_cookie_header(header: str) -> dict[str, str]:
        """解析 ``a1=..; web_session=..`` 形式（也接受换行分隔）。"""
        values: dict[str, str] = {}
        for chunk in re.split(r"[;\n]", header):
            chunk = chunk.strip()
            if not chunk or "=" not in chunk:
                continue
            key, value = chunk.split("=", 1)
            values[key.strip()] = value.strip()
        return values

    def verify(self) -> bool:
        """用一个需要登录的接口验证会话是否有效。"""
        from .client import ApiError

        try:
            info = self.client.creator_user_info()
        except ApiError:
            return False
        data = info.get("data") if isinstance(info, dict) else None
        if isinstance(data, dict):
            user_id = data.get("userId") or data.get("user_id")
            if user_id:
                self.client.cookies.update({"user_id": str(user_id)})
        return bool(data)

    # ------------------------------------------------------------------
    # 从浏览器读取（可选）
    # ------------------------------------------------------------------

    @staticmethod
    def cookies_from_playwright(storage_state_path: str | Path) -> dict[str, str]:
        """从 Playwright ``storage_state.json`` 里取出 xiaohongshu 域下的 cookie。"""
        state = json.loads(Path(storage_state_path).read_text(encoding="utf-8"))
        out: dict[str, str] = {}
        for cookie in state.get("cookies", []):
            domain = str(cookie.get("domain") or "")
            if "xiaohongshu.com" in domain or "rednote.com" in domain:
                out[str(cookie["name"])] = str(cookie["value"])
        return out
