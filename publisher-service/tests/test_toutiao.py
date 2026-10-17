import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException
from app import toutiao
from app.main import PublishRequest, publish, validate_platform_mode
from app.qr_login import QrLoginManager


def request(**kwargs):
    return PublishRequest(platform="toutiao", credentials='{"cookies":{"sessionid":"private-test-session"}}',
                          media_type=kwargs.pop("media_type", "video"), title=kwargs.pop("title", "雨夜中的纸飞机"),
                          media_urls=["https://example.invalid/video.mp4"], publish_mode=kwargs.pop("publish_mode", "draft"), **kwargs)


class ToutiaoPublishingTest(unittest.TestCase):
    def test_invalid_parameters_rejected_before_downloading_or_posting(self):
        for changes in [{"title": "短"}, {"title": "字" * 31}, {"visibility": "private"},
                        {"topics": ["t"] * 6}, {"description": "字" * 201}, {"cover_url": "https://example.invalid/cover.jpg"}]:
            with self.subTest(changes=changes), patch("app.main.download_many", new_callable=AsyncMock) as download:
                with self.assertRaises(HTTPException):
                    asyncio.run(publish(request(**changes)))
                download.assert_not_called()
        validate_platform_mode(request())
        validate_platform_mode(request(media_type="images", description="字" * 500))

    def test_dry_run_cannot_upload_or_publish(self):
        with patch("app.main.download_many", new_callable=AsyncMock) as download:
            result = asyncio.run(publish(request(publish_mode="dry_run")))
            self.assertTrue(result["dryRun"])
            download.assert_not_called()

    def test_image_article_includes_every_image_escapes_body_and_uses_draft_mode(self):
        client = MagicMock()
        client.upload_image.side_effect = [{"url": "https://example.invalid/1.jpg"}, {"url": "https://example.invalid/2.jpg"}]
        client.publish.return_value = {"pgc_id": "draft-123"}
        with tempfile.TemporaryDirectory() as folder, patch("app.toutiao.ToutiaoProtocolClient") as factory:
            factory.return_value.__enter__.return_value = client
            files = [Path(folder) / "1.jpg", Path(folder) / "2.jpg"]
            result = toutiao.publish_media(request(media_type="images", description="<script>alert(1)</script>", topics=["风景"]), files, None, Path(folder))
        article, mode, cover = client.publish.call_args.args
        self.assertEqual(mode, "draft")
        self.assertEqual(cover, files[0])
        self.assertIn("&lt;script&gt;", article.body_html)
        self.assertNotIn("<script>", article.body_html)
        self.assertIn("1.jpg", article.body_html)
        self.assertIn("2.jpg", article.body_html)
        self.assertEqual(result["itemId"], "draft-123")
        self.assertNotIn("private-test-session", str(result))
        client.publish.assert_called_once()

    def test_video_uses_actual_orientation_and_never_retries_final_publication(self):
        client = MagicMock()
        client.publish.side_effect = toutiao.PublisherError("response lost")
        with tempfile.TemporaryDirectory() as folder, patch("app.toutiao.ToutiaoVideoClient") as factory, patch("app.toutiao.subprocess.run") as probe:
            factory.return_value.__enter__.return_value = client
            probe.return_value.stdout = '{"streams":[{"width":720,"height":1280}]}'
            with self.assertRaises(toutiao.PublisherError):
                toutiao.publish_media(request(publish_mode="publish"), [Path(folder)/"video.mp4"], None, Path(folder))
        client.publish.assert_called_once()
        self.assertFalse(client.publish.call_args.kwargs["landscape"])
        self.assertEqual(client.publish.call_args.args[2], "publish")

    def test_expired_account_is_invalid_and_credentials_do_not_leak(self):
        with patch("app.toutiao.ToutiaoProtocolClient") as factory:
            factory.return_value.__enter__.return_value.get_account_profile.side_effect = toutiao.LoginRequired("expired")
            result = toutiao.check_account('{"sessionid":"private"}')
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "invalid")
        self.assertEqual(toutiao.credentials('sessionid=private'), {"sessionid": "private"})
        self.assertEqual(toutiao.credentials('[{"domain":".toutiao.com","name":"sessionid","value":"private"},{"domain":"eviltoutiao.com","name":"other","value":"wrong"}]'), {"sessionid": "private"})
        self.assertNotIn("private", toutiao.safe_error(toutiao.PublisherError("token=private https://sso.toutiao.com/a?token=private")))


class ToutiaoQrTest(unittest.IsolatedAsyncioTestCase):
    async def test_wait_scan_refresh_confirm_and_repeated_poll(self):
        native = MagicMock()
        native.start.return_value = {"status": "waiting", "message": "扫码", "qrcode": "data:image/png;base64,first", "expiresAt": time.time()+180}
        native.poll.side_effect = [
            {"status": "scanned", "message": "确认"},
            {"status": "waiting", "message": "扫码", "qrcode": "data:image/png;base64,second", "expiresAt": time.time()+180},
            {"status": "confirmed", "message": "成功", "credentials": '{"cookies":{"sessionid":"private"}}'},
        ]
        manager = QrLoginManager()
        with patch("app.toutiao.ToutiaoLogin", return_value=native):
            started = await manager.start("toutiao")
            self.assertNotIn("credentials", started)
            sid = started["sessionId"]
            self.assertEqual((await manager.status(sid))["status"], "scanned")
            self.assertTrue((await manager.status(sid))["qrCodeDataUrl"].endswith("second"))
            confirmed = await manager.status(sid)
            self.assertEqual(confirmed["status"], "confirmed")
            self.assertTrue(confirmed["credentials"])
            self.assertIsNone(confirmed["qrCodeDataUrl"])
            self.assertEqual(await manager.status(sid), confirmed)
            native.close.assert_called_once()
            self.assertEqual(native.poll.call_count, 3)

    async def test_cancel_releases_http_session_without_browser(self):
        native = MagicMock()
        native.start.return_value = {"status": "waiting", "message": "扫码", "qrcode": "data:image/png;base64,first"}
        manager = QrLoginManager()
        with patch("app.toutiao.ToutiaoLogin", return_value=native):
            started = await manager.start("toutiao")
            await manager.cancel(started["sessionId"])
            self.assertEqual((await manager.status(started["sessionId"]))["status"], "cancelled")
            native.close.assert_called_once()
            native.poll.assert_not_called()
