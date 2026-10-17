import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from app.account_check import check_wechat_account
from wechat_channels.errors import ApiError, NetworkError


class WechatAccountCheckTest(unittest.TestCase):
    def run_check(self, client, credentials=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cookies.json"
            path.write_text(json.dumps(credentials if credentials is not None else {
                "cookies": {"sessionid": "test-session"}, "finder_uin": "test-uin",
            }), encoding="utf-8")
            with patch("app.account_check.ChannelsClient", return_value=client):
                return check_wechat_account(path)

    def test_authentication_does_not_require_upload_or_draft_access(self):
        client = MagicMock()
        client.auth_data.return_value = {"data": {"finderUser": {"finderUsername": "test"}}}
        result = self.run_check(client)
        self.assertTrue(result["ok"])
        self.assertEqual("valid", result["status"])
        client.upload_params.assert_not_called()
        client.get_post_trace_key.assert_not_called()
        client.get_draft_list.assert_not_called()
        client.session.close.assert_called_once()

    def test_expired_and_replaced_sessions_require_scan(self):
        for code in (300330, 300333, 300334, 300349):
            with self.subTest(code=code):
                client = MagicMock()
                client.auth_data.side_effect = ApiError(code, "request failed")
                result = self.run_check(client)
                self.assertEqual("invalid", result["status"])
                self.assertFalse(result["ok"])
                self.assertIn(str(code), result["message"])
                self.assertIn("重新扫码", result["message"])

    def test_transient_errors_do_not_invalidate_credentials_or_expose_raw_errors(self):
        for error in (NetworkError("private-url-and-cookie"), ApiError(300118, "private-data")):
            with self.subTest(error=type(error).__name__):
                client = MagicMock()
                client.auth_data.side_effect = error
                result = self.run_check(client)
                self.assertEqual("error", result["status"])
                self.assertNotIn("private", result["message"])
                self.assertNotIn("重新扫码", result["message"])

    def test_missing_account_information_does_not_report_success(self):
        client = MagicMock()
        client.auth_data.return_value = {"errCode": 0, "data": {}}
        self.assertEqual("error", self.run_check(client)["status"])

    def test_missing_session_does_not_request_platform(self):
        client = MagicMock()
        self.assertEqual("invalid", self.run_check(client, {"cookies": {}})["status"])
        client.auth_data.assert_not_called()

    def test_browser_cookie_list_is_supported(self):
        client = MagicMock()
        client.auth_data.return_value = {"data": {"finderUser": {"finderUsername": "test"}}}
        result = self.run_check(client, [{"name": "sessionid", "value": "test-session"}])
        self.assertEqual("valid", result["status"])
