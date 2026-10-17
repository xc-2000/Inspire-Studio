#!/usr/bin/env python
"""检查会话是否可用，并探测上传/发布相关的接口。

用法::

    python scripts/login_check.py [--cookies cookies.json] [--json]

只做**只读**请求：``auth_data`` / ``upload_params`` / ``get-finder-post-trace-key``。
不写草稿、不发布。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

from wechat_channels.client import ChannelsClient, CookieJar  # noqa: E402
from wechat_channels.errors import ApiError, ChannelsError, NotLoggedInError  # noqa: E402


def show(title: str, ok: bool, detail: str = "") -> None:
    print(f"{'[ok]  ' if ok else '[fail]'} {title}" + (f"  {detail}" if detail else ""))


def main() -> int:
    parser = argparse.ArgumentParser(description="校验视频号助手登录态")
    parser.add_argument("--cookies", default=str(ROOT / "cookies.json"))
    parser.add_argument("--json", action="store_true", help="额外打印原始响应")
    args = parser.parse_args()

    cookie_path = Path(args.cookies)
    if not cookie_path.exists():
        print(f"[fail] 找不到 {cookie_path}，先跑 python scripts/capture_cookies.py")
        return 2

    jar = CookieJar.load(cookie_path)
    document = json.loads(cookie_path.read_text(encoding="utf-8"))
    client = ChannelsClient(
        cookies=jar,
        cookie_path=cookie_path,
        finder_uin=document.get("finder_uin", ""),
        finder_username=document.get("finder_username", ""),
        external_key=document.get("external_key", ""),
        plugin_session_id=document.get("plugin_session_id", ""),
        fingerprint=document.get("fingerprint", ""),
        fake_uin=document.get("fake_uin") or document.get("finder_uin") or "0000000000",
    )

    print(f"cookie 文件: {cookie_path}")
    print(f"cookie 字段: {', '.join(sorted(jar.values)) or '(空)'}")
    print(f"sessionid : {'有' if jar.sessionid else '缺失'}")
    print(f"finder_uin: {client.finder_uin or '(未设置，_log_finder_uin 会为空)'}")
    print(f"fingerprint: {'有' if client.fingerprint else '(未设置，不带 finger-print-device-id 头)'}")
    print()

    failed = False
    payloads: dict[str, object] = {}

    # 1) 账号信息
    try:
        auth = client.auth_data()
        data = auth.get("data") or {}
        finder = data.get("finderUser") or {}
        env = data.get("envInfo") or {}
        show(
            "auth_data 可用",
            True,
            f"finderUsername={finder.get('finderUsername')!r} "
            f"nickname={finder.get('nickname')!r}",
        )
        print(f"       envInfo.uploadVersion = {env.get('uploadVersion')!r}")
        print(f"       envInfo.cdnHost       = {env.get('cdnHost')!r}")
        if not env.get("uploadVersion"):
            print("       [warn] 该账号走的是**老上传链路**（snsuploadbig），不保证本库可用")
        payloads["auth_data"] = auth
    except NotLoggedInError as exc:
        show("auth_data 可用", False, f"{exc} —— 会话已失效，重新扫码")
        failed = True
    except ApiError as exc:
        show("auth_data 可用", False, str(exc))
        failed = True
    except ChannelsError as exc:
        show("auth_data 可用", False, repr(exc))
        failed = True

    # 2) 上传凭证
    try:
        params = client.upload_params()
        show(
            "helper_upload_params 可用",
            True,
            f"uin={params.get('uin')} appType={params.get('appType')} scene={params.get('scene')}",
        )
        print(
            "       凭证字段: "
            + ", ".join(
                sorted(k for k in params if k.endswith("FileType") or k in ("authKey", "scene"))
            )
        )
        payloads["upload_params"] = params
    except ChannelsError as exc:
        show("helper_upload_params 可用", False, str(exc))
        failed = True

    # 3) traceKey（发布链路的第一步）
    try:
        trace_key = client.get_post_trace_key(None)
        show("get-finder-post-trace-key 可用", bool(trace_key), f"traceKey={trace_key!r}")
        failed |= not trace_key
        payloads["traceKey"] = trace_key
    except ChannelsError as exc:
        show("get-finder-post-trace-key 可用", False, str(exc))
        failed = True

    # 4) 草稿列表（只读）
    try:
        drafts = client.get_draft_list()
        total = (drafts.get("data") or {}).get("totalCount")
        show("get_draft_list 可用", True, f"totalCount={total}")
        payloads["draftList"] = drafts
    except ChannelsError as exc:
        show("get_draft_list 可用", False, str(exc))
        failed = True

    if args.json:
        print()
        print(json.dumps(payloads, ensure_ascii=False, indent=2)[:4000])

    print()
    print("会话与上传链路可用。" if not failed else "有检查项失败，见上。")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
