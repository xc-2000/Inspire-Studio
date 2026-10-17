#!/usr/bin/env python
"""发布视频（**默认只存草稿**）。

用法::

    # 存草稿（默认）
    python scripts/publish_video.py --cookies cookies.json \
        --video demo.mp4 --cover cover.jpg --desc "正文 #话题#"

    # 真的发出去
    python scripts/publish_video.py --cookies cookies.json \
        --video demo.mp4 --cover cover.jpg --desc d --publish

    # 只验证请求体结构
    python scripts/publish_video.py --video demo.mp4 --desc d --dry-run

限制（站点文案）：时长 3 秒 ~ 61 秒（超过归 mega），大小 <= 4GB，
封面建议 1080x1080 且比例在 0.857~1.778 之间。
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
from wechat_channels.constants import VIDEO_MAX_DURATION, VIDEO_MIN_DURATION  # noqa: E402
from wechat_channels.errors import ChannelsError  # noqa: E402
from wechat_channels.media import MediaError, probe_video  # noqa: E402
from wechat_channels.publish import Publisher  # noqa: E402


def build_client(cookies_path: str) -> ChannelsClient:
    path = Path(cookies_path)
    document = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    return ChannelsClient(
        cookies=CookieJar.load(path) if path.exists() else CookieJar({}),
        cookie_path=path,
        finder_uin=document.get("finder_uin", ""),
        finder_username=document.get("finder_username", ""),
        external_key=document.get("external_key", ""),
        plugin_session_id=document.get("plugin_session_id", ""),
        fingerprint=document.get("fingerprint", ""),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="视频号视频（默认存草稿）")
    parser.add_argument("--cookies", default=str(ROOT / "cookies.json"))
    parser.add_argument("--video", required=True)
    parser.add_argument("--cover", help="封面图（缺它时站点会拦「请设置视频封面」）")
    parser.add_argument("--desc", default="")
    parser.add_argument("--topic", action="append", default=[])
    parser.add_argument("--mention", action="append", default=[])
    parser.add_argument("--mp-title", default="")
    parser.add_argument("--ext-link", default="")
    parser.add_argument("--ext-link-title", default="")
    parser.add_argument("--collection-id", default="")
    parser.add_argument("--collection-name", default="")
    parser.add_argument("--effective-time", type=int, default=0, help="定时发表（unix 秒）")
    parser.add_argument("--original", action="store_true")
    parser.add_argument("--object-id", default=None)
    parser.add_argument("--client-id", default="")
    parser.add_argument("--publish", action="store_true", help="真的发布（默认只存草稿）")
    parser.add_argument(
        "--yes",
        action="store_true",
        help="与 --publish 连用，跳过交互确认（对外发布不可撤销）",
    )
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--throttle", type=float, default=30.0)
    parser.add_argument("--allow-duration-mismatch", action="store_true", help="忽略时长预检")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    meta = probe_video(args.video)
    print(
        f"[probe] {Path(args.video).name}  {meta.width}x{meta.height}  "
        f"{meta.duration:.2f}s  {meta.file_size / 1048576:.2f}MB"
    )
    if meta.width and not args.allow_duration_mismatch:
        if meta.duration and not (VIDEO_MIN_DURATION <= meta.duration <= VIDEO_MAX_DURATION):
            print(
                f"[warn] 时长 {meta.duration:.2f}s 超出站点范围 "
                f"{VIDEO_MIN_DURATION}~{VIDEO_MAX_DURATION}s（服务端多半会拒）"
            )
        if not args.cover:
            print("[warn] 没给 --cover，视频号要求必须有封面（否则「请设置视频封面」）")

    if args.publish and not args.dry_run and not args.preview and not args.yes:
        # 对外发布不可撤销（只能事后删除），默认要求一次显式确认
        print(f"即将**真的发布**到视频号：{Path(args.video).name}")
        print(f"  文案: {args.desc or '(空)'}")
        answer = input("确认发出去？输入 yes 继续: ").strip().lower()
        if answer != "yes":
            print("已取消，没有发出任何请求。")
            return 0

    client = build_client(args.cookies)
    if not args.dry_run and not client.cookies.sessionid:
        print("[fail] 缺少 sessionid，先跑 python scripts/capture_cookies.py")
        return 2

    publisher = Publisher(client, verbose=args.verbose, throttle=args.throttle)
    try:
        result = publisher.publish_video(
            args.video,
            cover=args.cover,
            description=args.desc,
            topics=args.topic or None,
            mentions=args.mention or None,
            mp_title=args.mp_title,
            ext_link=args.ext_link,
            ext_link_title=args.ext_link_title,
            collection_id=args.collection_id,
            collection_name=args.collection_name,
            original_mark=args.original,
            effective_time=args.effective_time or None,
            publish=args.publish,
            preview=args.preview,
            dry_run=args.dry_run,
            object_id=args.object_id,
            client_id=args.client_id,
        )
    except MediaError as exc:
        print(f"[fail] {exc}")
        return 2
    except ChannelsError as exc:
        print(f"[fail] {exc}")
        return 1

    for warning in result.warnings:
        print(f"[warn] {warning}")

    if args.dry_run:
        print(json.dumps(result.raw.get("requestBody"), ensure_ascii=False, indent=2))
        print()
        print("这是 dry-run，没有任何请求发出。")
        return 0

    print(json.dumps(result.raw, ensure_ascii=False, indent=2)[:2000])
    if result.ok:
        print()
        if result.action == "draft":
            print(f"草稿已保存，objectId = {result.object_id}")
        elif result.action == "publish":
            # post_create 的响应里没有 objectId（只有 errCode/baseResp），
            # 新帖 id 要去 post_list 查，所以这里不要假装有 id。
            print("已发表。errCode=0 即成功；新帖 id 请用 post_list 查询。")
            print(f"查看：https://channels.weixin.qq.com/platform/post/list")
        else:
            print("预览票据已生成（未落库）")
        return 0
    print()
    print(f"[fail] errCode={result.err_code} {result.err_msg}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
