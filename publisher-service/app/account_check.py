"""Read-only login checks with explicit authentication and transport outcomes."""
from __future__ import annotations

import json
import sys
from pathlib import Path

WECHAT_ROOT = Path(__file__).resolve().parents[1] / "vendor" / "wechat-channels-upload"
if str(WECHAT_ROOT) not in sys.path:
    sys.path.insert(0, str(WECHAT_ROOT))

from wechat_channels.client import ChannelsClient, CookieJar
from wechat_channels.errors import ApiError, ChannelsError, NetworkError, is_login_expired


def check_wechat_account(cookie_path: Path) -> dict[str, object]:
    document = json.loads(cookie_path.read_text(encoding="utf-8"))
    metadata = document if isinstance(document, dict) else {}
    cookies = CookieJar.load(cookie_path)
    if not cookies.sessionid:
        return _result("invalid", "视频号登录凭据不完整，请重新扫码登录。")

    client = ChannelsClient(
        cookies=cookies,
        cookie_path=cookie_path,
        **{key: str(metadata.get(key) or "") for key in (
            "finder_uin", "finder_username", "external_key", "plugin_session_id", "fingerprint",
        )},
        fake_uin=str(metadata.get("fake_uin") or metadata.get("finder_uin") or "0000000000"),
        timeout=15,
    )
    try:
        # Upload and draft permissions are independent of authentication.
        response = client.auth_data()
        data = response.get("data") or {}
        finder = data.get("finderUser") if isinstance(data, dict) else None
        if not isinstance(finder, dict) or not finder:
            return _result("error", "视频号未返回账号信息，暂时无法确认登录状态，请稍后重试。")
        return _result("valid", "视频号登录态可用")
    except ApiError as exc:
        if is_login_expired(exc.err_code):
            reason = "账号已在其他设备登录" if exc.err_code == 300334 else "视频号登录已过期"
            return _result("invalid", f"{reason}，请重新扫码登录（{exc.err_code}）。")
        return _result("error", f"视频号暂时无法检查登录状态（{exc.err_code}），请稍后重试。")
    except NetworkError:
        return _result("error", "连接视频号失败，暂时无法确认登录状态，请稍后重试。")
    except ChannelsError:
        return _result("error", "视频号登录检查未完成，请稍后重试。")
    finally:
        client.session.close()


def _result(status: str, message: str) -> dict[str, object]:
    return {"ok": status == "valid", "status": status, "message": message}
