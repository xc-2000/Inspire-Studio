from __future__ import annotations

import sys
import unittest
from pathlib import Path


VENDOR_ROOT = Path(__file__).resolve().parents[1] / "vendor" / "xhs-upload"
if str(VENDOR_ROOT) not in sys.path:
    sys.path.insert(0, str(VENDOR_ROOT))

from xhs.login import Login, QrCode  # noqa: E402


class FakeClient:
    def __init__(self, userinfo: dict, status: dict | None = None) -> None:
        self.userinfo = userinfo
        self.status = status or {}
        self.get_calls: list[dict] = []

    def post(self, _url: str, _payload: dict, **_kwargs):
        return self.userinfo

    def get(self, _url: str, **kwargs):
        self.get_calls.append(kwargs)
        return self.status


class XiaohongshuProtocolTest(unittest.TestCase):
    def test_waiting_and_scanned_states_only_query_userinfo(self) -> None:
        for code_status, expected in ((0, "waiting"), (1, "scanned"), (3, "expired")):
            with self.subTest(code_status=code_status):
                client = FakeClient({"data": {"codeStatus": code_status}})
                result = Login(client).query_status(QrCode(qr_id="id", code="code"))
                self.assertEqual(expected, result)
                self.assertEqual([], client.get_calls)

    def test_confirmed_state_exchanges_cookie_with_country_headers(self) -> None:
        client = FakeClient(
            {
                "data": {
                    "codeStatus": 2,
                    "account_geographic_zone": "CN",
                    "account_holder_country": "CN",
                }
            },
            {"data": {"code_status": 2}},
        )
        result = Login(client).query_status(QrCode(qr_id="id", code="code"))
        self.assertEqual("confirmed", result)
        self.assertEqual(1, len(client.get_calls))
        self.assertEqual(
            {"x-rednote-datactry": "CN", "x-rednote-holderctry": "CN"},
            client.get_calls[0]["extra_headers"],
        )
        self.assertEqual({"qr_id": "id", "code": "code"}, client.get_calls[0]["params"])

    def test_nested_userinfo_response_is_supported(self) -> None:
        client = FakeClient({"data": {"data": {"codeStatus": 1}}})
        self.assertEqual("scanned", Login(client).query_status(QrCode(qr_id="id", code="code")))


if __name__ == "__main__":
    unittest.main()
