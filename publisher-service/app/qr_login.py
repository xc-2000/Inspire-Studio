from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import re
import sys
import time
import uuid
from urllib.parse import urlsplit, parse_qs
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

Platform = Literal["douyin", "xiaohongshu", "wechat_channels", "toutiao"]

LOGIN_URLS: dict[Platform, str] = {
    "douyin": "https://creator.douyin.com/",
    "xiaohongshu": "https://creator.xiaohongshu.com/login",
    "wechat_channels": "https://channels.weixin.qq.com/login.html",
    "toutiao": "https://mp.toutiao.com/",
}

PLATFORM_NAMES: dict[Platform, str] = {
    "douyin": "抖音",
    "xiaohongshu": "小红书",
    "wechat_channels": "微信视频号",
    "toutiao": "今日头条",
}

CHROMIUM_EXECUTABLE = os.getenv("PUBLISHER_CHROMIUM_EXECUTABLE", "/usr/bin/chromium")
CHROMIUM_HEADLESS = os.getenv("PUBLISHER_CHROMIUM_HEADLESS", "true").strip().lower() not in {"0", "false", "no", "off"}
LOGIN_TIMEOUT_SECONDS = int(os.getenv("PUBLISHER_LOGIN_TIMEOUT_SECONDS", "300"))
MAX_ACTIVE_SESSIONS = int(os.getenv("PUBLISHER_MAX_LOGIN_SESSIONS", "8"))
ROOT = Path(__file__).resolve().parents[1]
XHS_ROOT = ROOT / "vendor" / "xhs-upload"
WECHAT_ROOT = ROOT / "vendor" / "wechat-channels-upload"
WECHAT_COOKIE_NAMES = {
    "sessionid", "wxuin", "wwrtx.ref", "wwrtx.refid", "wwrtx.sid", "wwrtx.vid",
    "wwrtx.vst", "wxpluginkey", "FinderHelperIframeSessionId",
}

# Uvicorn 已为这个 logger 配置 INFO 输出；应用模块自己的 logger 默认会被 WARNING
# 过滤，导致扫码现场无法诊断。
logger = logging.getLogger("uvicorn.error")

SCANNED_TEXT_HINTS = (
    "已扫码", "扫码成功", "扫描成功", "确认登录", "登录确认", "待确认",
    "请在手机上确认", "请在手机端确认", "手机上确认", "手机端确认", "授权登录",
)
WECHAT_SCANNED_TEXT_HINTS = ("已扫码", "扫码成功", "扫描成功")
WECHAT_QR_SELECTOR = (
    "img.js_qrcode_img, img[src*='/connect/qrcode/'], img[alt*='二维码'], "
    "img[src*='qrcode'], img[src*='qr_code'], "
    "[class*='qrcode'] img, [class*='qr-code'] img, [class*='qrCode'] img, "
    "[class*='qrcode'] canvas, [class*='qr-code'] canvas, [class*='qrCode'] canvas"
)
EXPIRED_TEXT_HINTS = (
    "二维码已失效", "二维码失效", "二维码已过期", "二维码过期", "扫码已过期",
)
STATUS_TEXT_WORDS = ("扫码", "扫描", "二维码", "登录", "确认", "授权", "过期", "失效")


@dataclass
class LoginSession:
    id: str
    platform: Platform
    created_at: float
    expires_at: float
    playwright: Any = None
    browser: Any = None
    context: Any = None
    page: Any = None
    status: str = "waiting"
    message: str = "请使用对应平台 App 扫描二维码"
    qr_code_data_url: str = ""
    credentials: str = ""
    native: dict[str, Any] = field(default_factory=dict)
    initial_url: str = ""
    qr_was_visible: bool = False
    last_qr_capture_at: float = 0.0
    last_diagnostic: str = ""
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class QrLoginManager:
    """用隔离的无头 Chromium 完成三平台扫码，并读取 HttpOnly Cookie。"""

    def __init__(self) -> None:
        self._sessions: dict[str, LoginSession] = {}
        self._manager_lock = asyncio.Lock()

    async def start(self, platform: Platform) -> dict[str, object]:
        await self._cleanup()
        async with self._manager_lock:
            active = sum(item.status in {"waiting", "scanned", "verification"} for item in self._sessions.values())
            if active >= MAX_ACTIVE_SESSIONS:
                raise RuntimeError("当前扫码登录人数较多，请稍后重试")
            now = time.time()
            session = LoginSession(
                id=str(uuid.uuid4()),
                platform=platform,
                created_at=now,
                expires_at=now + LOGIN_TIMEOUT_SECONDS,
            )
            self._sessions[session.id] = session

        try:
            await self._open_login_page(session)
            return self._response(session, include_credentials=False)
        except Exception:
            await self._close_browser(session)
            self._sessions.pop(session.id, None)
            raise

    async def status(self, session_id: str) -> dict[str, object]:
        session = self._sessions.get(session_id)
        if session is None:
            raise KeyError("扫码会话不存在或已过期")
        async with session.lock:
            if session.status in {"confirmed", "expired", "cancelled", "failed"}:
                if session.context is not None:
                    await self._close_browser(session)
                return self._response(session, include_credentials=True)
            if time.time() >= session.expires_at:
                session.status = "expired"
                session.message = "二维码已过期，请重新获取"
                await self._close_browser(session)
                return self._response(session, include_credentials=False)
            try:
                if session.platform == "toutiao":
                    from app.toutiao import safe_error
                    try:
                        result = await asyncio.to_thread(session.native["toutiao"].poll)
                        self._apply_toutiao_state(session, result)
                        if session.status in {"confirmed", "expired", "failed"}:
                            await self._close_browser(session)
                    except Exception as exc:
                        session.status = "failed"
                        session.message = safe_error(exc)
                        await self._close_browser(session)
                    return self._response(session, include_credentials=True)
                if session.platform == "xiaohongshu" and session.native:
                    return await self._xhs_status(session)
                cookies = await session.context.cookies()
                if self._logged_in(session.platform, cookies):
                    # 登录完成后页面还会继续写入 Cookie 和 localStorage，稍等并重新读取，
                    # 避免保存到一份只有部分字段的登录态。
                    await session.page.wait_for_timeout(1000)
                    cookies = await session.context.cookies()
                    session.credentials = await self._credentials(session, cookies)
                    session.status = "confirmed"
                    session.message = f"{PLATFORM_NAMES[session.platform]}扫码登录成功"
                    self._log_diagnostic(session, cookies, "", False)
                    await self._close_browser(session)
                else:
                    if session.status == "verification":
                        await self._capture_verification(session)
                        return self._response(session, include_credentials=False)
                    page_text = await self._login_page_text(session.page, session.platform)
                    qr_visible = await self._qr_visible(session.page, session.platform)
                    # 响应监听器可在上面的 await 期间收到 2046；页面仍残留
                    # “手机确认”文案时也不能覆盖已经确定的安全验证结果。
                    if session.status == "verification":
                        await self._capture_verification(session)
                        return self._response(session, include_credentials=False)
                    self._log_diagnostic(session, cookies, page_text, qr_visible)
                    if any(word in page_text for word in EXPIRED_TEXT_HINTS):
                        session.status = "expired"
                        session.message = "二维码已过期，请重新获取"
                        await self._close_browser(session)
                    elif self._looks_scanned(session, page_text, qr_visible):
                        session.status = "scanned"
                        session.message = "已扫码，请在手机上确认登录"
                    else:
                        session.status = "waiting"
                        session.message = "等待扫码"
                        # 平台网页会自动换二维码。前端展示的是提取后的图片，必须同步更新，
                        # 否则用户看到并扫描的是已经失效的旧码。
                        if qr_visible and time.time() - session.last_qr_capture_at >= 3:
                            capture_current = {
                                "douyin": self._capture_current_douyin_qr,
                                "xiaohongshu": self._capture_current_xhs_qr,
                                "wechat_channels": self._capture_current_wechat_qr,
                            }[session.platform]
                            fresh_qr = await capture_current(session.page)
                            if fresh_qr:
                                session.qr_code_data_url = fresh_qr
                                session.last_qr_capture_at = time.time()
            except Exception as exc:
                session.status = "failed"
                session.message = self._safe_error(exc)
                await self._close_browser(session)
            return self._response(session, include_credentials=True)

    async def cancel(self, session_id: str) -> None:
        session = self._sessions.get(session_id)
        if session is None:
            return
        async with session.lock:
            if session.status not in {"confirmed", "expired"}:
                session.status = "cancelled"
                session.message = "扫码登录已取消"
            await self._close_browser(session)

    async def _capture_verification(self, session: LoginSession) -> None:
        # Keep the official page and its cookies alive for the complete challenge.
        # Do not rebuild platform deep links: they can require signed app context.
        image = await session.page.screenshot(type="jpeg", quality=75, full_page=False)
        session.qr_code_data_url = "data:image/jpeg;base64," + base64.b64encode(image).decode("ascii")
        session.message = "请在下方抖音官方页面完成验证，系统会自动检测登录结果。"

    async def verification_action(self, session_id: str, action: dict[str, Any]) -> None:
        session = self._sessions.get(session_id)
        if session is None:
            raise KeyError("扫码会话不存在或已过期")
        async with session.lock:
            if session.status != "verification" or session.page is None or time.time() >= session.expires_at:
                raise ValueError("当前会话不能进行验证，请重新登录")
            kind = action.get("kind")
            if kind == "method":
                labels = {"sms": "接收短信验证码", "password": "验证登录密码", "other": "选择其他验证方式"}
                label = labels.get(action.get("method"))
                if label is None:
                    raise ValueError("不支持的验证方式")
                for frame in session.page.frames:
                    target = frame.get_by_text(label, exact=True).first
                    if await target.count() and await target.is_visible():
                        previous_text = await frame.locator("body").inner_text()
                        await target.click(timeout=3000)
                        try:
                            await frame.wait_for_function("previous => document.body.innerText !== previous", arg=previous_text, timeout=4000)
                        except Exception as exc:
                            raise ValueError("官方页面没有响应点击，请重新开启登录会话") from exc
                        return
                raise ValueError("当前官方页面没有这个验证选项，请等待画面更新")
            elif kind == "pointer":
                values = [float(action[name]) for name in ("x", "y", "endX", "endY")]
                if not all(0 <= value <= 1 for value in values):
                    raise ValueError("无效的操作位置")
                x, y, end_x, end_y = values
                await session.page.bring_to_front()
                viewport = session.page.viewport_size or {"width": 1100, "height": 760}
                width, height = viewport["width"], viewport["height"]
                if abs(x - end_x) * width < 5 and abs(y - end_y) * height < 5:
                    await session.page.mouse.click(end_x * width, end_y * height, delay=80)
                else:
                    await session.page.mouse.move(x * width, y * height)
                    await session.page.mouse.down()
                    try:
                        await session.page.mouse.move(end_x * width, end_y * height, steps=12)
                    finally:
                        await session.page.mouse.up()
            elif kind == "text":
                await session.page.keyboard.insert_text(str(action.get("text", ""))[:200])
            elif kind == "key" and action.get("text") in {"Enter", "Backspace", "Tab"}:
                await session.page.keyboard.press(action["text"])
            else:
                raise ValueError("不支持的操作")

    async def close_all(self) -> None:
        for session in list(self._sessions.values()):
            await self._close_browser(session)
        self._sessions.clear()

    async def _cleanup(self) -> None:
        now = time.time()
        for session_id, session in list(self._sessions.items()):
            if now < session.expires_at + 60:
                continue
            await self._close_browser(session)
            self._sessions.pop(session_id, None)

    async def _open_login_page(self, session: LoginSession) -> None:
        if session.platform == "toutiao":
            from app.toutiao import ToutiaoLogin, safe_error
            native = ToutiaoLogin()
            session.native["toutiao"] = native
            try:
                self._apply_toutiao_state(session, await asyncio.to_thread(native.start))
            except Exception as exc:
                raise RuntimeError(safe_error(exc)) from None
            return
        from playwright.async_api import async_playwright

        session.playwright = await async_playwright().start()
        session.browser = await session.playwright.chromium.launch(
            executable_path=CHROMIUM_EXECUTABLE,
            headless=CHROMIUM_HEADLESS,
            ignore_default_args=["--enable-automation"],
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-blink-features=AutomationControlled",
            ],
        )
        session.context = await session.browser.new_context(
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
            viewport={"width": 1100, "height": 760},
        )
        session.page = await session.context.new_page()
        if session.platform == "douyin":
            # Disallow custom-protocol navigation at the browser security layer.
            # DOM screenshots cannot expose native external-application prompts.
            await session.context.route("**/*", self._sandbox_douyin_document)
            session.page.on(
                "response",
                lambda response: asyncio.create_task(self._observe_douyin_login_response(session, response)),
            )
        await session.page.goto(LOGIN_URLS[session.platform], wait_until="domcontentloaded", timeout=45_000)
        session.initial_url = session.page.url
        await self._select_qr_login(session.page, session.platform)
        await session.page.wait_for_timeout(1800)
        session.qr_code_data_url = await self._capture_qr(session.page, session.platform)
        if not session.qr_code_data_url:
            raise RuntimeError("登录页没有生成二维码，请稍后重试")
        session.qr_was_visible = True
        session.last_qr_capture_at = time.time()

    async def _sandbox_douyin_document(self, route: Any) -> None:
        if route.request.resource_type != "document":
            await route.continue_()
            return
        response = await route.fetch()
        headers = dict(response.headers)
        sandbox = "sandbox allow-scripts allow-same-origin allow-forms allow-downloads"
        existing = headers.get("content-security-policy")
        headers["content-security-policy"] = f"{existing}, {sandbox}" if existing else sandbox
        await route.fulfill(response=response, headers=headers)

    async def _start_xhs_protocol(self, session: LoginSession) -> None:
        if str(XHS_ROOT) not in sys.path:
            sys.path.insert(0, str(XHS_ROOT))
        from xhs import Login, XhsClient

        client = XhsClient()
        login = Login(client)
        qr = await asyncio.to_thread(login.create_qrcode)
        session.native = {"client": client, "login": login, "qr": qr}
        session.qr_code_data_url = await asyncio.to_thread(self._render_qr, qr.url)
        self._log_xhs_diagnostic(session, "waiting")

    def _render_qr(self, value: str) -> str:
        import qrcode
        from PIL import Image

        image = qrcode.make(value).get_image().convert("RGB")
        image = image.resize((360, 360), Image.Resampling.NEAREST)
        buffer = io.BytesIO()
        image.save(buffer, format="PNG", optimize=True)
        return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")

    async def _xhs_status(self, session: LoginSession) -> dict[str, object]:
        login = session.native["login"]
        qr = session.native["qr"]
        try:
            status = str(await asyncio.to_thread(login.query_status, qr) or "unknown").strip().lower()
        except Exception as exc:
            # 小红书状态接口偶尔会短暂超时。保留仍可扫描的二维码并在下一轮继续查询，
            # 避免一次网络抖动把有效会话错误地显示成“二维码不可用”。
            logger.warning(
                "xhs_qr_status_retry session=%s error=%s",
                session.id[:8],
                type(exc).__name__,
            )
            session.status = "waiting"
            session.message = "小红书状态查询暂时失败，正在自动重试"
            self._log_xhs_diagnostic(session, "retrying")
            return self._response(session, include_credentials=False)

        if status == "confirmed":
            await asyncio.to_thread(login.on_login_success, qr)
            cookie_values = self._xhs_cookie_values(session)
            if cookie_values.get("web_session"):
                session.credentials = json.dumps(cookie_values, ensure_ascii=False)
                session.status = "confirmed"
                session.message = "小红书扫码登录成功"
            else:
                # 平台有时先返回“成功”，登录 Cookie 会在随后一次状态请求中写入。
                # 没拿到 web_session 前不能保存账号，也不能移除二维码。
                session.status = "scanned"
                session.message = "手机端已确认，正在同步小红书登录状态"
        elif status == "scanned":
            session.status = "scanned"
            session.message = "已扫码，请在小红书 App 中确认登录"
        elif status in {"expired", "cancelled"}:
            session.status = status
            session.message = "二维码已过期，请重新获取" if status == "expired" else "扫码登录已取消"
        elif status == "waiting":
            session.status = "waiting"
            session.message = "等待扫码"
        else:
            # 只信任协议定义的终态。诸如 success/成功 之类的平台通用文案不代表
            # 已经取得登录凭据，应继续轮询，不能显示为失败或登录完成。
            session.status = "waiting"
            session.message = "正在同步小红书扫码状态"
        self._log_xhs_diagnostic(session, status)
        return self._response(session, include_credentials=True)

    def _xhs_cookie_values(self, session: LoginSession) -> dict[str, str]:
        values = getattr(getattr(session.native.get("client"), "cookies", None), "values", {})
        if not isinstance(values, dict):
            return {}
        return {str(key): str(value) for key, value in values.items() if key and value is not None}

    def _log_xhs_diagnostic(self, session: LoginSession, protocol_status: str) -> None:
        cookie_names = sorted(self._xhs_cookie_values(session))
        diagnostic = json.dumps(
            {
                "protocolStatus": protocol_status,
                "resolvedStatus": session.status,
                "cookieNames": cookie_names,
                "hasQr": bool(session.qr_code_data_url),
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        if diagnostic == session.last_diagnostic:
            return
        session.last_diagnostic = diagnostic
        logger.info("xhs_qr_state session=%s state=%s", session.id[:8], diagnostic)

    async def _select_qr_login(self, page: Any, platform: Platform) -> None:
        if platform == "xiaohongshu":
            # 小红书当前登录页默认展示短信登录，右上角用一个无文本图片切换扫码模式。
            # 优先使用稳定的卡片结构；类名变化时再按尺寸查找 64px 切换图片。
            for selector in ("div.css-jjnw1w > img", "img[src^='data:image/png;base64']"):
                with suppress(Exception):
                    locators = page.locator(selector)
                    for index in range(min(await locators.count(), 12)):
                        locator = locators.nth(index)
                        if not await locator.is_visible():
                            continue
                        box = await locator.bounding_box()
                        if not box or not (40 <= box["width"] <= 100 and 40 <= box["height"] <= 100):
                            continue
                        await locator.click(timeout=1800)
                        await page.wait_for_timeout(700)
                        return
        for label in ("扫码登录", "二维码登录", "使用二维码登录"):
            with suppress(Exception):
                locator = page.get_by_text(label, exact=True).first
                if await locator.is_visible():
                    await locator.click(timeout=1800)
                    await page.wait_for_timeout(500)
                    return

    async def _capture_qr(self, page: Any, platform: Platform) -> str:
        if platform == "douyin":
            # 抖音二维码是 512×512 的 data URL 图片，进入动画期间可能暂时位于视口外。
            # 不能把登录页下方的 180×180 装饰 canvas 误当成二维码。
            for _ in range(16):
                current = await self._capture_current_douyin_qr(page)
                if current:
                    return current
                await page.wait_for_timeout(500)
            return ""

        if platform == "xiaohongshu":
            for _ in range(16):
                current = await self._capture_current_xhs_qr(page)
                if current:
                    return current
                await page.wait_for_timeout(500)
            return ""

        # 微信二维码位于 open.weixin.qq.com 的跨域 iframe 中，主页面只有 logo。
        # 等待真实二维码加载；整页截图不能作为已找到二维码的证据。
        for _ in range(16):
            current = await self._capture_current_wechat_qr(page)
            if current:
                return current
            await page.wait_for_timeout(500)
        return ""

    async def _find_wechat_qr(self, page: Any) -> Any | None:
        for frame in page.frames:
            with suppress(Exception):
                locators = frame.locator(WECHAT_QR_SELECTOR)
                for index in range(min(await locators.count(), 12)):
                    locator = locators.nth(index)
                    if not await locator.is_visible():
                        continue
                    box = await locator.bounding_box()
                    if not box or not (120 <= box["width"] <= 520 and 120 <= box["height"] <= 520):
                        continue
                    if not await locator.evaluate("element => element.tagName !== 'IMG' || (element.complete && element.naturalWidth > 0)"):
                        continue
                    return locator
        return None

    async def _capture_current_wechat_qr(self, page: Any) -> str:
        locator = await self._find_wechat_qr(page)
        if locator is not None:
            original = await self._wechat_qr_original(page, locator)
            if original:
                return original
            with suppress(Exception):
                data = await locator.screenshot(type="png", timeout=2500)
                return "data:image/png;base64," + base64.b64encode(data).decode("ascii")
        return ""

    async def _wechat_qr_original(self, page: Any, locator: Any) -> str:
        # 官方 iframe 把 470px 原图缩成 160px；保留原图能避免再次放大时模糊。
        # 只读取已确认可见的二维码，复用同一浏览器的请求上下文和登录会话。
        with suppress(Exception):
            from PIL import Image

            source = await locator.evaluate("element => element.currentSrc || element.src || ''")
            parts = urlsplit(source)
            if (parts.scheme != "https" or parts.hostname not in {"open.weixin.qq.com", "channels.weixin.qq.com"}
                    or parts.username or parts.password or parts.port not in {None, 443}):
                return ""
            response = await page.context.request.get(source, timeout=2500, max_redirects=0)
            try:
                mime = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                formats = {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP", "image/gif": "GIF"}
                max_bytes = 2 * 1024 * 1024
                if (not response.ok or mime not in formats
                        or int(response.headers.get("content-length", "0")) > max_bytes):
                    return ""
                data = await response.body()
                if not data or len(data) > max_bytes:
                    return ""
                with Image.open(io.BytesIO(data)) as image:
                    if image.format != formats[mime] or not all(120 <= size <= 2048 for size in image.size):
                        return ""
                    image.verify()
                return f"data:{mime};base64," + base64.b64encode(data).decode("ascii")
            finally:
                await response.dispose()
        return ""

    async def _login_page_text(self, page: Any, platform: Platform) -> str:
        text = await page.locator("body").inner_text(timeout=2500)
        if platform == "wechat_channels":
            # 扫描成功和过期提示也在 iframe 内，主页面始终只有“登录视频号助手”。
            for frame in page.frames:
                if frame == page.main_frame:
                    continue
                with suppress(Exception):
                    text += "\n" + await frame.locator("body").inner_text(timeout=1000)
        return text

    async def _capture_current_xhs_qr(self, page: Any) -> str:
        locators = page.locator("img[src^='data:image/png;base64']")
        for index in range(await locators.count()):
            locator = locators.nth(index)
            with suppress(Exception):
                dimensions = await locator.evaluate(
                    """element => {
                        const box = element.getBoundingClientRect();
                        const style = getComputedStyle(element);
                        return {
                            width: box.width,
                            height: box.height,
                            naturalWidth: element.naturalWidth,
                            naturalHeight: element.naturalHeight,
                            display: style.display,
                            visibility: style.visibility,
                            opacity: Number(style.opacity || 1)
                        };
                    }"""
                )
                if (140 <= dimensions["width"] <= 260 and 140 <= dimensions["height"] <= 260
                        and dimensions["naturalWidth"] >= 140 and dimensions["naturalHeight"] >= 140
                        and dimensions["display"] != "none" and dimensions["visibility"] != "hidden"
                        and dimensions["opacity"] > 0.2):
                    source = str(await locator.get_attribute("src") or "")
                    if source.startswith("data:image/png;base64,"):
                        return source
        return ""

    async def _capture_current_douyin_qr(self, page: Any) -> str:
        locators = page.locator("img[src^='data:image/png;base64']")
        for index in range(await locators.count()):
            locator = locators.nth(index)
            with suppress(Exception):
                dimensions = await locator.evaluate(
                    """element => {
                        const box = element.getBoundingClientRect();
                        const style = getComputedStyle(element);
                        return {
                            width: box.width,
                            height: box.height,
                            naturalWidth: element.naturalWidth,
                            naturalHeight: element.naturalHeight,
                            display: style.display,
                            visibility: style.visibility,
                            opacity: Number(style.opacity || 1)
                        };
                    }"""
                )
                if (140 <= dimensions["width"] <= 260 and 140 <= dimensions["height"] <= 260
                        and dimensions["naturalWidth"] >= 300 and dimensions["naturalHeight"] >= 300
                        and dimensions["display"] != "none" and dimensions["visibility"] != "hidden"
                        and dimensions["opacity"] > 0.2):
                    source = str(await locator.get_attribute("src") or "")
                    if source.startswith("data:image/png;base64,"):
                        return source
        return ""

    async def _qr_visible(self, page: Any, platform: Platform) -> bool:
        if platform == "wechat_channels":
            return await self._find_wechat_qr(page) is not None
        selectors = (
            "img[alt*='二维码']",
            "img[src*='qrcode']",
            "img[src*='qr_code']",
            "[class*='qrcode'] img",
            "[class*='qr-code'] img",
            "[class*='qrCode'] img",
            "[class*='qrcode'] canvas",
            "[class*='qr-code'] canvas",
            "[class*='qrCode'] canvas",
        )
        if platform == "douyin":
            selectors = ("img[src^='data:image/png;base64']", *selectors)
        elif platform == "xiaohongshu":
            selectors = ("img[src^='data:image/png;base64']", *selectors)
        for selector in selectors:
            with suppress(Exception):
                locators = page.locator(selector)
                for index in range(min(await locators.count(), 12)):
                    locator = locators.nth(index)
                    if not await locator.is_visible():
                        continue
                    box = await locator.bounding_box()
                    if box and 120 <= box["width"] <= 520 and 120 <= box["height"] <= 520:
                        return True
        return False

    def _looks_scanned(self, session: LoginSession, page_text: str, qr_visible: bool) -> bool:
        if session.platform == "wechat_channels":
            # iframe 加载/刷新或元素暂时不可见不代表扫码；“确认登录”等操作说明
            # 也不是扫码成功的证据，只信任微信显示的明确成功状态。
            return any(word in page_text for word in WECHAT_SCANNED_TEXT_HINTS)
        if any(word in page_text for word in SCANNED_TEXT_HINTS):
            return True
        # 抖音和小红书扫码后都会先收起二维码，再等待手机确认。把这个 DOM 变化作为
        # 文案识别之外的兜底，兼容平台改字或使用图标展示状态。
        if session.qr_was_visible and not qr_visible:
            return True
        return False

    async def _observe_douyin_login_response(self, session: LoginSession, response: Any) -> None:
        if "/passport/web/check_qrconnect/" not in str(response.url):
            return
        try:
            document = await response.json()
        except Exception:
            document = {}
        summary = self._safe_login_response_summary(document)
        diagnostic = json.dumps(
            {"httpStatus": response.status, "response": summary},
            ensure_ascii=False,
            sort_keys=True,
        )
        if diagnostic == session.native.get("lastDouyinResponse"):
            return
        session.native["lastDouyinResponse"] = diagnostic
        logger.info(
            "douyin_qr_response session=%s state=%s",
            session.id[:8],
            diagnostic,
        )
        data = document.get("data") if isinstance(document, dict) else None
        if session.status in {"confirmed", "expired", "cancelled", "failed", "verification"}:
            return
        if isinstance(data, dict) and data.get("error_code") == 2046:
            # Retain the official challenge only inside this short-lived session.
            # Log URL structure, never tokens or complete challenge URLs.
            session.native["douyinChallenge"] = data
            for field_name in ("url", "schema", "desc_url"):
                value = data.get(field_name)
                if isinstance(value, str) and value:
                    parts = urlsplit(value)
                    logger.info("douyin_verification_entry field=%s scheme=%s host=%s path=%s query_keys=%s",
                                field_name, parts.scheme, parts.hostname, parts.path,
                                sorted(parse_qs(parts.query)))
            session.status = "verification"
            session.message = "正在加载抖音官方验证页面"
            session.qr_code_data_url = ""
            return
        # 平台响应只用于脱敏诊断。账号验证、二维码刷新和登录跳转都交给官方
        # 创作者网页处理；服务端继续观察页面与 Cookie，避免把内部 schema
        # 重新编码成无法扫描的二维码，也避免在风控响应后停止轮询。

    def _safe_login_response_summary(self, document: Any) -> Any:
        """保留扫码状态码与字段结构，不记录 token、ticket、Cookie 或跳转地址。"""
        if isinstance(document, list):
            return [self._safe_login_response_summary(item) for item in document[:3]]
        if not isinstance(document, dict):
            return type(document).__name__
        result: dict[str, Any] = {}
        safe_text_keys = {"message", "description", "status", "status_msg"}
        sensitive_fragments = {"token", "ticket", "cookie", "redirect", "url", "verify", "avatar", "name"}
        for key, value in document.items():
            lowered = str(key).lower()
            if any(fragment in lowered for fragment in sensitive_fragments):
                result[str(key)] = f"<{type(value).__name__}>"
            elif isinstance(value, (dict, list)):
                result[str(key)] = self._safe_login_response_summary(value)
            elif isinstance(value, (int, float, bool)) or value is None:
                result[str(key)] = value
            elif lowered in safe_text_keys:
                result[str(key)] = str(value)[:160]
            else:
                result[str(key)] = f"<{type(value).__name__}>"
        return result

    def _logged_in(self, platform: Platform, cookies: list[dict[str, Any]]) -> bool:
        names = {
            str(item.get("name") or "")
            for item in cookies
            if self._cookie_domain_matches(platform, str(item.get("domain") or ""))
        }
        if platform == "douyin":
            if names & {"sessionid", "sessionid_ss"}:
                return True
            # 新版 creator 登录有时先写 sid_guard/sid_tt，随后才补 sessionid。
            # 两项同时存在时已经是完整的账号会话，单独的游客 Cookie 不会误判。
            return "sid_guard" in names and bool(names & {"sid_tt", "uid_tt", "uid_tt_ss"})
        if platform == "xiaohongshu":
            if "web_session" in names:
                return True
            # 新版小红书创作服务平台不再写入 web_session。只有访问令牌与
            # 至少一个账号或会话 Cookie 同时存在时，才视为已完成登录。
            # a1/webId 等游客 Cookie 以及孤立的访问令牌都不能触发确认。
            return (
                "access-token-creator.xiaohongshu.com" in names
                and bool(names & {
                    "customer-sso-sid",
                    "galaxy_creator_session_id",
                    "galaxy.creator.beaker.session.id",
                    "x-user-id-creator.xiaohongshu.com",
                })
            )
        return "sessionid" in names

    def _log_diagnostic(
        self,
        session: LoginSession,
        cookies: list[dict[str, Any]],
        page_text: str,
        qr_visible: bool,
    ) -> None:
        names = sorted({
            str(item.get("name") or "")
            for item in cookies
            if item.get("name") and self._cookie_domain_matches(session.platform, str(item.get("domain") or ""))
        })
        summary = self._status_text_summary(page_text)
        url = str(getattr(session.page, "url", "") or "")
        diagnostic = json.dumps(
            {"url": url, "cookieNames": names, "qrVisible": qr_visible, "statusText": summary},
            ensure_ascii=False,
            sort_keys=True,
        )
        if diagnostic == session.last_diagnostic:
            return
        session.last_diagnostic = diagnostic
        logger.info(
            "qr_login_state session=%s platform=%s state=%s",
            session.id[:8],
            session.platform,
            diagnostic,
        )

    def _status_text_summary(self, page_text: str) -> str:
        lines = []
        for raw_line in re.split(r"[\r\n]+", page_text):
            line = " ".join(raw_line.split())
            if line and any(word in line for word in STATUS_TEXT_WORDS):
                lines.append(line[:120])
            if len(lines) >= 8:
                break
        return " | ".join(lines)[:600]

    async def _credentials(self, session: LoginSession, cookies: list[dict[str, Any]]) -> str:
        matched = [item for item in cookies if self._cookie_domain_matches(session.platform, str(item.get("domain") or ""))]
        if session.platform == "douyin":
            return self._netscape_cookies(matched)
        cookie_map = {str(item.get("name")): str(item.get("value") or "") for item in matched if item.get("name")}
        if session.platform == "xiaohongshu":
            return json.dumps(cookie_map, ensure_ascii=False)

        storage = await session.page.evaluate(
            """() => ({
                finder_uin: localStorage.getItem('finder_uin') || '',
                finder_username: localStorage.getItem('finder_username') || '',
                external_key: localStorage.getItem('finder_external_key') || '',
                _finder_raw: localStorage.getItem('finder_raw') || '',
                fingerprint: localStorage.getItem('_finger_print_device_id') || ''
            })"""
        )
        cookie_map = {key: value for key, value in cookie_map.items() if key in WECHAT_COOKIE_NAMES}
        document = {"cookies": cookie_map, **{key: value for key, value in storage.items() if value}}
        if not document.get("finder_uin"):
            finder_uin = await asyncio.to_thread(
                self._wechat_finder_uin, cookie_map, str(document.get("finder_username") or "")
            )
            if finder_uin:
                document["finder_uin"] = finder_uin
        return json.dumps(document, ensure_ascii=False)

    def _wechat_finder_uin(self, cookies: dict[str, str], finder_username: str) -> str:
        try:
            if str(WECHAT_ROOT) not in sys.path:
                sys.path.insert(0, str(WECHAT_ROOT))
            from wechat_channels.client import ChannelsClient, CookieJar

            client = ChannelsClient(cookies=CookieJar(cookies), finder_username=finder_username)
            return str(client.upload_params().get("uin") or "")
        except Exception:
            return ""

    def _cookie_domain_matches(self, platform: Platform, domain: str) -> bool:
        domain = domain.lower()
        if platform == "douyin":
            return "douyin.com" in domain
        if platform == "xiaohongshu":
            return "xiaohongshu.com" in domain or "rednote.com" in domain
        return "weixin.qq.com" in domain

    def _netscape_cookies(self, cookies: list[dict[str, Any]]) -> str:
        lines = ["# Netscape HTTP Cookie File", "# 由 Inspire Studio 扫码登录自动生成"]
        for item in sorted(cookies, key=lambda value: (str(value.get("domain")), str(value.get("name")))):
            domain = str(item.get("domain") or "")
            include_subdomains = "TRUE" if domain.startswith(".") else "FALSE"
            path = str(item.get("path") or "/")
            secure = "TRUE" if item.get("secure") else "FALSE"
            expires = int(float(item.get("expires") or 0))
            prefix = "#HttpOnly_" if item.get("httpOnly") else ""
            lines.append(
                "\t".join(
                    [prefix + domain, include_subdomains, path, secure, str(expires), str(item.get("name") or ""), str(item.get("value") or "")]
                )
            )
        return "\n".join(lines) + "\n"

    async def _close_browser(self, session: LoginSession) -> None:
        native = session.native.pop("toutiao", None)
        if native is not None:
            with suppress(Exception):
                await asyncio.to_thread(native.close)
        if session.context is not None:
            with suppress(Exception):
                await session.context.close()
            session.context = None
            session.page = None
        if session.browser is not None:
            with suppress(Exception):
                await session.browser.close()
            session.browser = None
        if session.playwright is not None:
            with suppress(Exception):
                await session.playwright.stop()
            session.playwright = None

    def _apply_toutiao_state(self, session: LoginSession, result: dict) -> None:
        session.status = result["status"]
        session.message = result["message"]
        if result.get("qrcode"):
            session.qr_code_data_url = result["qrcode"]
        if result.get("expiresAt"):
            session.expires_at = float(result["expiresAt"])
        if session.status == "confirmed":
            if not result.get("credentials"):
                raise RuntimeError("扫码已确认但登录凭据为空，请重新扫码")
            session.credentials = result["credentials"]

    def _response(self, session: LoginSession, include_credentials: bool) -> dict[str, object]:
        response: dict[str, object] = {
            "sessionId": session.id,
            "platform": session.platform,
            "status": session.status,
            "message": session.message,
            "qrCodeDataUrl": session.qr_code_data_url if session.status in {"waiting", "scanned", "verification"} else None,
            "expiresAt": int(session.expires_at * 1000),
        }
        if include_credentials and session.status == "confirmed":
            response["credentials"] = session.credentials
        return response

    def _safe_error(self, error: Exception) -> str:
        text = str(error).strip() or "扫码登录失败"
        return text[:500]


qr_login_manager = QrLoginManager()
