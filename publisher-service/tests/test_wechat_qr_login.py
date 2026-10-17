from __future__ import annotations

import base64
import io
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from PIL import Image

from app.qr_login import LoginSession, QrLoginManager


def qr_element(*, visible: bool = True, loaded: bool = True) -> SimpleNamespace:
    return SimpleNamespace(
        is_visible=AsyncMock(return_value=visible),
        bounding_box=AsyncMock(return_value={"width": 160, "height": 160}),
        evaluate=AsyncMock(return_value=loaded),
        screenshot=AsyncMock(return_value=b"iframe-qr"),
    )


def login_frame(text: str = "", elements: tuple = ()) -> SimpleNamespace:
    body = SimpleNamespace(inner_text=AsyncMock(return_value=text))
    images = SimpleNamespace(count=AsyncMock(return_value=len(elements)), nth=lambda index: elements[index])
    return SimpleNamespace(locator=lambda selector: body if selector == "body" else images)


def login_page(frame: SimpleNamespace) -> SimpleNamespace:
    main = login_frame("登录视频号助手")
    return SimpleNamespace(
        frames=[main, frame], main_frame=main, locator=main.locator,
        url="https://channels.weixin.qq.com/login.html",
        wait_for_timeout=AsyncMock(), screenshot=AsyncMock(),
    )


def original_qr_image(size: tuple[int, int] = (470, 470), *, format: str = "PNG") -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, "white").save(buffer, format=format)
    return buffer.getvalue()


def original_qr_page(
    source: str = "https://open.weixin.qq.com/connect/qrcode/test-token",
    *,
    data: bytes | None = None,
    mime: str = "image/png",
    content_length: int | None = None,
    ok: bool = True,
) -> tuple[SimpleNamespace, SimpleNamespace, SimpleNamespace]:
    element = qr_element()
    element.evaluate.side_effect = lambda script: source if "currentSrc" in script else True
    headers = {"content-type": mime}
    if content_length is not None:
        headers["content-length"] = str(content_length)
    response = SimpleNamespace(
        ok=ok,
        headers=headers,
        body=AsyncMock(return_value=original_qr_image() if data is None else data),
        dispose=AsyncMock(),
    )
    page = login_page(login_frame(elements=(element,)))
    page.context = SimpleNamespace(request=SimpleNamespace(get=AsyncMock(return_value=response)))
    return page, element, response


class WechatQrLoginTest(unittest.IsolatedAsyncioTestCase):
    async def test_preserves_official_original_image_at_470_pixels(self) -> None:
        cases = (
            ("https://open.weixin.qq.com/connect/qrcode/test-token", "PNG", "image/png"),
            ("https://open.weixin.qq.com/connect/qrcode/test-token", "JPEG", "image/jpeg"),
            ("https://channels.weixin.qq.com/qrcode/test-token", "PNG", "image/png"),
            ("https://open.weixin.qq.com:443/connect/qrcode/test-token", "JPEG", "image/jpeg"),
        )
        for source, format, mime in cases:
            with self.subTest(source=source, mime=mime):
                original = original_qr_image(format=format)
                page, element, response = original_qr_page(source, data=original, mime=mime)

                result = await QrLoginManager()._capture_qr(page, "wechat_channels")

                self.assertEqual(f"data:{mime};base64," + base64.b64encode(original).decode(), result)
                with Image.open(io.BytesIO(base64.b64decode(result.split(",", 1)[1]))) as image:
                    self.assertEqual((470, 470), image.size)
                page.context.request.get.assert_awaited_once_with(source, timeout=2500, max_redirects=0)
                response.dispose.assert_awaited_once()
                element.screenshot.assert_not_awaited()
                page.screenshot.assert_not_awaited()

    async def test_untrusted_image_source_falls_back_without_request(self) -> None:
        sources = (
            "http://open.weixin.qq.com/connect/qrcode/test-token",
            "https://open.weixin.qq.com.example.com/qrcode/test-token",
            "https://example.com/qrcode/test-token",
            "https://user:password@open.weixin.qq.com/qrcode/test-token",
            "https://open.weixin.qq.com:8443/qrcode/test-token",
            "https://open.weixin.qq.com:invalid/qrcode/test-token",
            "data:image/png;base64,aW52YWxpZA==",
            "/connect/qrcode/test-token",
        )
        for source in sources:
            with self.subTest(source=source):
                page, element, response = original_qr_page(source)

                result = await QrLoginManager()._capture_qr(page, "wechat_channels")

                self.assertEqual("data:image/png;base64," + base64.b64encode(b"iframe-qr").decode(), result)
                page.context.request.get.assert_not_awaited()
                response.dispose.assert_not_awaited()
                element.screenshot.assert_awaited_once()
                page.screenshot.assert_not_awaited()

    async def test_invalid_original_response_falls_back_and_is_disposed(self) -> None:
        cases = (
            ("html", {"mime": "text/html", "data": b"<html>expired</html>"}),
            ("oversize_header", {"content_length": 2 * 1024 * 1024 + 1}),
            ("oversize_body", {"data": b"x" * (2 * 1024 * 1024 + 1)}),
            ("corrupt_image", {"data": b"not an image"}),
            ("empty_image", {"data": b""}),
            ("failed_status", {"ok": False}),
            ("wrong_image_type", {"mime": "image/jpeg"}),
            ("too_small", {"data": original_qr_image((119, 470))}),
            ("too_large", {"data": original_qr_image((470, 2049))}),
        )
        for name, kwargs in cases:
            with self.subTest(response=name):
                page, element, response = original_qr_page(**kwargs)

                result = await QrLoginManager()._capture_qr(page, "wechat_channels")

                self.assertEqual("data:image/png;base64," + base64.b64encode(b"iframe-qr").decode(), result)
                page.context.request.get.assert_awaited_once()
                response.dispose.assert_awaited_once()
                element.screenshot.assert_awaited_once()
                page.screenshot.assert_not_awaited()

    async def test_original_request_failure_falls_back_to_element_screenshot(self) -> None:
        page, element, response = original_qr_page()
        page.context.request.get.side_effect = TimeoutError("original image request timed out")

        result = await QrLoginManager()._capture_qr(page, "wechat_channels")

        self.assertEqual("data:image/png;base64," + base64.b64encode(b"iframe-qr").decode(), result)
        page.context.request.get.assert_awaited_once()
        response.dispose.assert_not_awaited()
        element.screenshot.assert_awaited_once()
        page.screenshot.assert_not_awaited()

    async def test_captures_visible_qr_inside_login_iframe(self) -> None:
        hidden, visible = qr_element(visible=False), qr_element()
        page = login_page(login_frame(elements=(hidden, visible)))
        manager = QrLoginManager()

        result = await manager._capture_qr(page, "wechat_channels")

        self.assertEqual("data:image/png;base64," + base64.b64encode(b"iframe-qr").decode(), result)
        self.assertTrue(await manager._qr_visible(page, "wechat_channels"))
        hidden.screenshot.assert_not_awaited()
        visible.screenshot.assert_awaited_once()
        page.screenshot.assert_not_awaited()

    async def test_waits_for_iframe_image_to_load(self) -> None:
        element = qr_element()
        element.evaluate.side_effect = [False, True]
        page = login_page(login_frame(elements=(element,)))

        self.assertTrue(await QrLoginManager()._capture_qr(page, "wechat_channels"))

        page.wait_for_timeout.assert_awaited_once_with(500)
        element.screenshot.assert_awaited_once()

    async def test_missing_qr_does_not_return_login_page_as_a_qr(self) -> None:
        page = login_page(login_frame())
        manager = QrLoginManager()

        self.assertEqual("", await manager._capture_qr(page, "wechat_channels"))
        self.assertFalse(await manager._qr_visible(page, "wechat_channels"))
        page.screenshot.assert_not_awaited()

    async def test_unscanned_iframe_stays_waiting_and_refreshes_qr(self) -> None:
        manager = QrLoginManager()
        page = login_page(login_frame("使用微信扫一扫登录，扫码后请在手机上确认登录", (qr_element(),)))
        session = self.session(page)
        manager._sessions[session.id] = session

        result = await manager.status(session.id)

        self.assertEqual("waiting", result["status"])
        self.assertTrue(result["qrCodeDataUrl"].startswith("data:image/png;base64,"))
        self.assertNotEqual("previous-qr", result["qrCodeDataUrl"])
        session.context.close.assert_not_awaited()

    async def test_missing_iframe_qr_is_not_evidence_of_a_scan(self) -> None:
        manager = QrLoginManager()
        session = self.session(login_page(login_frame()))
        manager._sessions[session.id] = session

        result = await manager.status(session.id)

        self.assertEqual("waiting", result["status"])
        self.assertEqual("previous-qr", result["qrCodeDataUrl"])
        session.context.close.assert_not_awaited()

    async def test_scan_success_text_inside_iframe_updates_status_and_keeps_qr(self) -> None:
        manager = QrLoginManager()
        session = self.session(login_page(login_frame("扫描成功\n在微信中轻触允许即可登录")))
        manager._sessions[session.id] = session

        result = await manager.status(session.id)

        self.assertEqual("scanned", result["status"])
        self.assertEqual("previous-qr", result["qrCodeDataUrl"])
        session.context.close.assert_not_awaited()

    async def test_expiration_text_inside_iframe_is_observed(self) -> None:
        manager = QrLoginManager()
        session = self.session(login_page(login_frame("二维码已过期")))
        context = session.context
        manager._sessions[session.id] = session

        result = await manager.status(session.id)

        self.assertEqual("expired", result["status"])
        self.assertIsNone(result["qrCodeDataUrl"])
        context.close.assert_awaited_once()

    def test_generic_login_instructions_do_not_indicate_a_scan(self) -> None:
        manager = QrLoginManager()
        session = self.session(login_page(login_frame()))
        for text in ("确认登录", "授权登录", "请在手机上确认登录", "登录视频号助手"):
            for visible in (True, False):
                with self.subTest(text=text, visible=visible):
                    self.assertFalse(manager._looks_scanned(session, text, visible))

    @staticmethod
    def session(page: SimpleNamespace) -> LoginSession:
        return LoginSession(
            "wechat-test", "wechat_channels", 0, 9999999999,
            page=page, context=SimpleNamespace(cookies=AsyncMock(return_value=[]), close=AsyncMock()),
            qr_was_visible=True, qr_code_data_url="previous-qr",
        )


if __name__ == "__main__":
    unittest.main()
