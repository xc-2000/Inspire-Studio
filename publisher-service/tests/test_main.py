from __future__ import annotations

import asyncio
import base64
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from PIL import Image

from app.main import PublishRequest, parse_cookie_header, publish, publish_command, redact_output, write_credentials
from app.qr_login import LoginSession, QrLoginManager


class PublisherServiceTest(unittest.TestCase):
    def test_cookie_header_is_normalized_for_xiaohongshu(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "cookies.json"
            write_credentials("xiaohongshu", "a1=first; web_session=secret", target)
            self.assertEqual({"a1": "first", "web_session": "secret"}, json.loads(target.read_text("utf-8")))

    def test_wechat_document_keeps_account_metadata(self) -> None:
        document = {"cookies": {"sessionid": "secret"}, "finder_username": "finder-id", "fingerprint": "device"}
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "cookies.json"
            write_credentials("wechat_channels", json.dumps(document), target)
            self.assertEqual(document, json.loads(target.read_text("utf-8")))

    def test_douyin_dry_run_never_invokes_platform_uploader(self) -> None:
        request = PublishRequest(
            platform="douyin",
            credentials="sessionid=secret-value",
            media_type="video",
            title="演示",
            media_urls=["https://cdn.example.com/video.mp4"],
            publish_mode="dry_run",
        )
        result = asyncio.run(publish(request))
        self.assertTrue(result["dryRun"])
        self.assertIn("未调用平台接口", result["message"])

    def test_wechat_publish_requires_explicit_yes(self) -> None:
        request = PublishRequest(
            platform="wechat_channels",
            credentials='{"sessionid":"secret-value"}',
            media_type="video",
            description="说明",
            media_urls=["https://cdn.example.com/video.mp4"],
            cover_url="https://cdn.example.com/cover.jpg",
            publish_mode="publish",
        )
        command, _ = publish_command(request, Path("cookie.json"), [Path("video.mp4")], Path("cover.jpg"))
        self.assertIn("--publish", command)
        self.assertIn("--yes", command)

    def test_sensitive_output_is_redacted(self) -> None:
        value = redact_output("sessionid=abc123 web_session: xyz token=hello")
        self.assertNotIn("abc123", value)
        self.assertNotIn("xyz", value)
        self.assertNotIn("hello", value)

    def test_invalid_cookie_header_is_rejected(self) -> None:
        with self.assertRaises(Exception):
            parse_cookie_header("missing separators")

    def test_qr_renderer_keeps_square_dimensions(self) -> None:
        manager = QrLoginManager()
        data_uri = manager._render_qr("xhsdiscover://login/example")
        image = Image.open(io.BytesIO(base64.b64decode(data_uri.split(",", 1)[1])))
        self.assertEqual((360, 360), image.size)

    def test_login_detection_uses_platform_session_cookie(self) -> None:
        manager = QrLoginManager()
        self.assertTrue(manager._logged_in("douyin", [{"name": "sessionid", "domain": ".douyin.com"}]))
        self.assertTrue(manager._logged_in("douyin", [
            {"name": "sid_guard", "domain": ".douyin.com"},
            {"name": "uid_tt", "domain": ".douyin.com"},
        ]))
        self.assertTrue(manager._logged_in("xiaohongshu", [{"name": "web_session", "domain": ".xiaohongshu.com"}]))
        self.assertTrue(manager._logged_in("xiaohongshu", [
            {"name": "access-token-creator.xiaohongshu.com", "domain": ".xiaohongshu.com"},
            {"name": "customer-sso-sid", "domain": "creator.xiaohongshu.com"},
        ]))
        self.assertTrue(manager._logged_in("wechat_channels", [{"name": "sessionid", "domain": ".weixin.qq.com"}]))
        self.assertFalse(manager._logged_in("douyin", [{"name": "passport_csrf_token", "domain": ".douyin.com"}]))
        self.assertFalse(manager._logged_in("douyin", [{"name": "sid_guard", "domain": ".douyin.com"}]))
        self.assertFalse(manager._logged_in("xiaohongshu", [
            {"name": "a1", "domain": ".xiaohongshu.com"},
            {"name": "webId", "domain": ".xiaohongshu.com"},
        ]))
        self.assertFalse(manager._logged_in("xiaohongshu", [
            {"name": "access-token-creator.xiaohongshu.com", "domain": ".xiaohongshu.com"},
        ]))

    def test_scan_state_recognizes_current_platform_wording(self) -> None:
        manager = QrLoginManager()
        session = LoginSession("scan-state", "douyin", 0, 9999999999, qr_was_visible=True)
        self.assertTrue(manager._looks_scanned(session, "扫码成功，请在手机端确认", True))
        self.assertTrue(manager._looks_scanned(session, "", False))
        self.assertFalse(manager._looks_scanned(session, "等待扫码", True))

    def test_login_response_summary_redacts_session_material(self) -> None:
        manager = QrLoginManager()
        summary = manager._safe_login_response_summary({
            "message": "success",
            "data": {"error_code": 0, "redirect_url": "https://example.test/?ticket=secret", "token": "secret"},
        })
        self.assertEqual("success", summary["message"])
        self.assertEqual(0, summary["data"]["error_code"])
        self.assertEqual("<str>", summary["data"]["redirect_url"])
        self.assertEqual("<str>", summary["data"]["token"])

    def test_netscape_export_keeps_http_only_cookie(self) -> None:
        manager = QrLoginManager()
        exported = manager._netscape_cookies([{
            "domain": ".douyin.com", "path": "/", "secure": True, "expires": 1800000000,
            "name": "sessionid", "value": "secret", "httpOnly": True,
        }])
        self.assertIn("#HttpOnly_.douyin.com", exported)
        self.assertIn("\tsessionid\tsecret", exported)


class DouyinQrResponseTest(unittest.IsolatedAsyncioTestCase):
    async def test_verification_pointer_uses_the_same_browser_session(self) -> None:
        manager = QrLoginManager()
        mouse = SimpleNamespace(move=AsyncMock(), down=AsyncMock(), up=AsyncMock())
        session = LoginSession("interactive", "douyin", 0, 9999999999, status="verification")
        session.page = SimpleNamespace(mouse=mouse, bring_to_front=AsyncMock(), viewport_size={"width": 1100, "height": 760})
        manager._sessions[session.id] = session
        await manager.verification_action(session.id, {"kind": "pointer", "x": 0.1, "y": 0.2, "endX": 0.5, "endY": 0.2})
        self.assertEqual((110.0, 152.0), mouse.move.await_args_list[0].args)
        self.assertEqual((550.0, 152.0), mouse.move.await_args_list[1].args)
        mouse.down.assert_awaited_once()
        mouse.up.assert_awaited_once()
        with self.assertRaises(ValueError):
            await manager.verification_action(session.id, {"kind": "pointer", "x": -1, "y": 0, "endX": 0, "endY": 0})
        session.status = "confirmed"
        with self.assertRaises(ValueError):
            await manager.verification_action(session.id, {"kind": "text", "text": "test"})

    async def test_verification_click_is_not_dispatched_as_a_drag(self) -> None:
        manager = QrLoginManager()
        mouse = SimpleNamespace(click=AsyncMock(), down=AsyncMock())
        session = LoginSession("click", "douyin", 0, 9999999999, status="verification")
        session.page = SimpleNamespace(mouse=mouse, bring_to_front=AsyncMock(), viewport_size={"width": 800, "height": 600})
        manager._sessions[session.id] = session
        await manager.verification_action(session.id, {"kind": "pointer", "x": .5, "y": .5, "endX": .501, "endY": .501})
        mouse.click.assert_awaited_once_with(400.8, 300.6, delay=80)
        mouse.down.assert_not_awaited()

    async def test_verification_can_finish_and_return_login_credentials(self) -> None:
        manager = QrLoginManager()
        session = LoginSession("finish", "douyin", 0, 9999999999, status="verification")
        session.context = SimpleNamespace(cookies=AsyncMock(return_value=[{"name": "sessionid", "domain": ".douyin.com", "value": "test"}]), close=AsyncMock())
        session.page = SimpleNamespace(wait_for_timeout=AsyncMock())
        manager._sessions[session.id] = session
        result = await manager.status(session.id)
        self.assertEqual("confirmed", result["status"])
        self.assertIn("sessionid", result["credentials"])
        self.assertIsNone(session.context)

    async def test_verification_survives_repeated_status_polls(self) -> None:
        manager = QrLoginManager()
        session = LoginSession("verify", "douyin", 0, 9999999999,
                               status="verification", message="请完成安全验证")
        session.context = SimpleNamespace(close=AsyncMock(), cookies=AsyncMock(return_value=[]))
        session.page = SimpleNamespace(locator=lambda _: SimpleNamespace(inner_text=AsyncMock(return_value="已扫码")), screenshot=AsyncMock(return_value=b"official-page"))
        manager._qr_visible = AsyncMock(return_value=False)
        manager._log_diagnostic = lambda *args: None
        manager._sessions[session.id] = session
        for _ in range(3):
            result = await manager.status(session.id)
            self.assertEqual("verification", result["status"])
            self.assertIn("官方页面", result["message"])
            self.assertTrue(result["qrCodeDataUrl"])
            self.assertNotIn("credentials", result)
        session.context.close.assert_not_awaited()

    async def test_verification_arriving_during_dom_poll_is_not_overwritten(self) -> None:
        manager = QrLoginManager()
        session = LoginSession("race", "douyin", 0, 9999999999)
        session.context = SimpleNamespace(cookies=AsyncMock(return_value=[]), close=AsyncMock())

        async def read_body(**_kwargs):
            session.status = "verification"
            session.message = "请完成安全验证"
            session.qr_code_data_url = ""
            return "已扫码，请在手机上确认登录"

        session.page = SimpleNamespace(locator=lambda _: SimpleNamespace(inner_text=read_body), screenshot=AsyncMock(return_value=b"official-page"))
        manager._qr_visible = AsyncMock(return_value=False)
        manager._sessions[session.id] = session
        result = await manager.status(session.id)
        self.assertEqual("verification", result["status"])
        self.assertIn("官方页面", result["message"])
        session.context.close.assert_not_awaited()

    async def test_platform_verification_response_requests_app_verification(self) -> None:
        class FakeResponse:
            url = "https://creator.douyin.com/passport/web/check_qrconnect/"
            status = 200

            async def json(self):
                return {
                    "message": "error",
                    "data": {
                        "error_code": 2046,
                        "schema": "snssdk1128://verify/example",
                        "token": "secret",
                    },
                }

        manager = QrLoginManager()
        session = SimpleNamespace(
            id="session-id",
            status="waiting",
            message="等待扫码",
            qr_code_data_url="data:image/png;base64,official",
            native={},
        )
        await manager._observe_douyin_login_response(session, FakeResponse())
        self.assertEqual("verification", session.status)
        self.assertIn("官方验证页面", session.message)
        self.assertEqual("", session.qr_code_data_url)
        self.assertNotIn("douyinVerificationRequired", session.native)


class XiaohongshuQrStatusTest(unittest.IsolatedAsyncioTestCase):
    def _session(self, protocol_status: str, cookies: dict[str, str] | None = None):
        class FakeLogin:
            def query_status(self, _qr):
                return protocol_status

            def on_login_success(self, _qr):
                return None

        return SimpleNamespace(
            id="session-id",
            platform="xiaohongshu",
            status="waiting",
            message="等待扫码",
            qr_code_data_url="data:image/png;base64,test",
            credentials="",
            expires_at=9999999999,
            last_diagnostic="",
            native={
                "login": FakeLogin(),
                "qr": object(),
                "client": SimpleNamespace(cookies=SimpleNamespace(values=dict(cookies or {}))),
            },
        )

    async def test_success_word_without_login_cookie_keeps_waiting(self) -> None:
        manager = QrLoginManager()
        session = self._session("success")
        response = await manager._xhs_status(session)
        self.assertEqual("waiting", response["status"])
        self.assertTrue(response["qrCodeDataUrl"])
        self.assertNotIn("成功", response["message"])

    async def test_confirmed_without_login_cookie_is_not_completed(self) -> None:
        manager = QrLoginManager()
        session = self._session("confirmed", {"a1": "anonymous"})
        response = await manager._xhs_status(session)
        self.assertEqual("scanned", response["status"])
        self.assertTrue(response["qrCodeDataUrl"])
        self.assertEqual("", session.credentials)

    async def test_confirmed_with_login_cookie_returns_credentials(self) -> None:
        manager = QrLoginManager()
        session = self._session("confirmed", {"a1": "anonymous", "web_session": "secret"})
        response = await manager._xhs_status(session)
        self.assertEqual("confirmed", response["status"])
        self.assertIsNone(response["qrCodeDataUrl"])
        self.assertEqual("secret", json.loads(response["credentials"])["web_session"])


if __name__ == "__main__":
    unittest.main()
