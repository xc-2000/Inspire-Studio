"""签名层：薄封装内置的 xhshow（vendored，MIT）。

小红书 web/creator 接口需要 `x-s` / `x-s-common` / `x-t` / `x-b3-traceid` /
`x-xray-traceid` 等头。xhshow 生成的头名是小写，直接透传给 requests 即可。
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Literal

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from _vendor_xhshow import SessionManager, Xhshow  # noqa: E402

__all__ = ["Signer", "generate_a1", "generate_web_id"]

SignFormat = Literal["xys", "xyw"]


class Signer:
    """把 xhshow 的签名器包成"给一次请求签名"的接口。"""

    def __init__(self, xsec_appid: str = "ugc", sign_format: SignFormat = "xys"):
        self._client = Xhshow()
        self._session = SessionManager()
        self.xsec_appid = xsec_appid
        self.sign_format = sign_format

    def headers(
        self,
        method: str,
        uri: str,
        cookie_dict: dict[str, Any],
        params: dict[str, Any] | None = None,
        payload: dict[str, Any] | None = None,
        xsec_appid: str | None = None,
        sign_format: SignFormat | None = None,
        x_rap: bool = False,
        user_id: str | None = None,
    ) -> dict[str, str]:
        headers = self._client.sign_headers(
            method.upper(),
            uri,
            cookie_dict,
            xsec_appid=xsec_appid or self.xsec_appid,
            params=params if method.upper() == "GET" else None,
            payload=payload if method.upper() == "POST" else None,
            session=self._session,
            sign_format=sign_format or self.sign_format,
            x_rap=x_rap,
            user_id=user_id,
        )
        return {str(k): str(v) for k, v in headers.items()}

    def x_s_common(self, cookie_dict: dict[str, Any]) -> str:
        return self._client.sign_xs_common(cookie_dict)


def generate_a1() -> str:
    return Xhshow.generate_a1()


def generate_web_id(a1: str) -> str:
    return Xhshow.generate_web_id(a1)
