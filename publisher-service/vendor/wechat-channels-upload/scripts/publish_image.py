#!/usr/bin/env python
"""发布图文（**默认只存草稿**）。

用法::

    # 存草稿（默认）
    python scripts/publish_image.py --cookies cookies.json \
        --images a.jpg b.jpg --title "标题" --desc "正文 #话题#"

    # 真的发出去（需要显式 --publish）
    python scripts/publish_image.py --cookies cookies.json \
        --images a.jpg --title t --desc d --publish

    # 只验证请求体结构，不发任何请求
    python scripts/publish_image.py --images a.jpg --title t --desc d --dry-run

    # 覆盖已有草稿
    python scripts/publish_image.py --cookies cookies.json \
        --images a.jpg --title t --desc d --object-id draft-xxx

为什么默认不发：视频号没有面向个人的公开发布 API，短时间高频发布有会话风控风险
（``douyin-uploader`` 的实测是 ~40 秒内 5 次发布触发 403 + 会话被踢）。
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
from wechat_channels.errors import ChannelsError  # noqa: E402
from wechat_channels.media import MediaError  # noqa: E402
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
    parser = argparse.ArgumentParser(description="视频号图文（默认存草稿）")
    parser.add_argument("--cookies", default=str(ROOT / "cookies.json"))
    parser.add_argument("--images", nargs="+", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--desc", default="")
    parser.add_argument("--topic", action="append", default=[], help="话题名，可重复")
    parser.add_argument("--mention", action="append", default=[], help="@ 的昵称，可重复")
    parser.add_argument("--mp-title", default="", help="公众号文章标题（<=30 字）")
    parser.add_argument("--ext-link", default="", help="扩展链接（公众号文章 URL）")
    parser.add_argument("--ext-link-title", default="")
    parser.add_argument("--collection-id", default="", help="合集 id")
    parser.add_argument("--collection-name", default="")
    parser.add_argument("--effective-time", type=int, default=0, help="定时发表（unix 秒）")
    parser.add_argument("--original", action="store_true", help="标记原创")
    parser.add_argument("--object-id", default=None, help="覆盖已有草稿")
    parser.add_argument("--client-id", default="", help="复用同一个 clientid（排查用）")
    parser.add_argument("--publish", action="store_true", help="真的发布（默认只存草稿）")
    parser.add_argument(
        "--yes",
        action="store_true",
        help="与 --publish 连用，跳过交互确认（对外发布不可撤销）",
    )
    parser.add_argument("--preview", action="store_true", help="只生成预览票据")
    parser.add_argument("--dry-run", action="store_true", help="不发请求，只打印请求体")
    parser.add_argument("--no-variants", action="store_true", help="图片不生成三分变体")
    parser.add_argument("--throttle", type=float, default=30.0, help="写请求最小间隔秒数")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    if args.publish and not args.dry_run and not args.preview and not args.yes:
        # 对外发布不可撤销（只能事后删除），默认要求一次显式确认
        print(f"即将**真的发布**到视频号：{len(args.images)} 张图")
        print(f"  标题: {args.title or '(空)'}")
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
        result = publisher.publish_images(
            args.images,
            title=args.title,
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
            variants=not args.no_variants,
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
        print("这是 dry-run，没有任何请求发出。去掉 --dry-run 才会真的上传。")
        return 0

    print(json.dumps(result.raw, ensure_ascii=False, indent=2)[:2000])
    if result.ok:
        if result.action == "draft":
            print()
            print(f"草稿已保存，objectId = {result.object_id}")
            print("去 https://channels.weixin.qq.com/platform/post/list 查看/继续编辑")
        elif result.action == "publish":
            # post_create 的响应里没有 objectId（只有 errCode/baseResp），
            # 新帖 id 要去 post_list 查，所以这里不要假装有 id。
            print()
            print("已发表。errCode=0 即成功；新帖 id 请用 post_list 查询。")
            print("列表页: https://channels.weixin.qq.com/platform/post/list")
        else:
            print()
            print("预览票据已生成（未落库）")
        return 0
    print()
    print(f"[fail] errCode={result.err_code} {result.err_msg}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
