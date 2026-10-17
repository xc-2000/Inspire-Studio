#!/usr/bin/env python
"""校验 cookie 登录态，并顺便确认上传许可可用。

用法::

    python scripts/login_check.py [--cookies cookies.json]
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

from xhs import CREATOR, CREATOR_REFERER, EDITH, ApiError, XhsClient, Login  # noqa: E402


def show(title: str, ok: bool, detail: str = "") -> None:
    print(f"{'[ok]  ' if ok else '[fail]'} {title}" + (f"  {detail}" if detail else ""))


def main() -> int:
    parser = argparse.ArgumentParser(description="校验小红书登录态")
    parser.add_argument("--cookies", default=str(ROOT / "cookies.json"))
    args = parser.parse_args()

    client = XhsClient(cookie_path=args.cookies)
    keys = sorted(client.cookies.values)
    print(f"cookie 文件: {args.cookies}")
    print(f"cookie 字段: {', '.join(keys)}")
    # 创作平台登录不发 web_session（那是主站 www 的会话），缺它不影响发布
    print("web_session: " + ("有" if client.cookies.web_session else "缺失（正常，发布不需要）"))


    failed = False

    # 1) creator 登录态
    login = Login(client)
    ok = login.verify()
    show("creator 登录态有效（galaxy_creator_session_id）", ok)
    failed |= not ok

    # 2) edith 鉴权：带 Origin 才通（缺 Origin 会 401 code=-100）
    try:
        raw = client.request(
            "GET", EDITH + "/api/sns/v1/creator/red_skill/web/list_mountable_skills",
            params={"skill_keyword": "", "size": 1}, referer=CREATOR_REFERER, raw=True,
        )
        ok = raw.status_code == 200
        show("edith 鉴权可用（cookie + Origin）", ok, f"HTTP {raw.status_code} {raw.text[:80]}")
        failed |= not ok
    except Exception as exc:  # noqa: BLE001
        show("edith 鉴权可用（cookie + Origin）", False, repr(exc))
        failed = True

    # 3) 上传许可
    try:
        permit = client.get_upload_permit(scene="image", file_count=1)
        permits = permit.get("uploadTempPermits") or []
        if permits:
            p = sorted(permits, key=lambda x: x.get("qos", 0), reverse=True)[0]
            show(
                "上传许可可用",
                True,
                f"qos={p.get('qos')} bucket={p.get('bucket')} "
                f"addr={p.get('uploadAddr')} region={p.get('region')}",
            )
            print()
            print("uploadLimitPolicy:")
            print("  " + json.dumps(permit.get("uploadLimitPolicy"), ensure_ascii=False))
        else:
            show("上传许可可用", False, json.dumps(permit, ensure_ascii=False)[:200])
            failed = True
    except ApiError as exc:
        show("上传许可可用", False, f"HTTP {exc.status} {exc.body}")
        failed = True

    print()
    print("登录态与上传链路可用。" if not failed else "有检查项失败，见上。")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
