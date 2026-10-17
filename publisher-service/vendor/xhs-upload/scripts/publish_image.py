#!/usr/bin/env python
"""发布图文笔记。

用法::

    python scripts/publish_image.py --cookies cookies.json \
        --images a.jpg b.jpg --title "标题" --desc "正文 #话题"

    # 加话题与 @用户（会自动搜索取 id）
    python scripts/publish_image.py --cookies cookies.json \
        --images a.jpg --title "标题" --desc "正文" --topic 咖啡 --topic 手冲

    # 仅组装 payload 不真正发布（验证字段结构）
    python scripts/publish_image.py --images a.jpg --title t --dry-run
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

from xhs import ApiError, Login, Publisher, UploadError, XhsClient  # noqa: E402
from xhs.payload import (  # noqa: E402
    build_capa_context,
    build_common,
    build_image_entry,
    build_image_info,
    to_post_note_payload,
)


def resolve_topics(client: XhsClient, names: list[str]) -> list[dict]:
    topics = []
    for name in names:
        try:
            found = client.search_topic(name)
        except ApiError as exc:
            print(f"[warn] 搜索话题 {name} 失败：{exc}")
            continue
        if not found:
            print(f"[warn] 未找到话题：{name}")
            continue
        best = found[0]
        topics.append(
            {
                "id": best.get("id"),
                "name": best.get("name") or name,
                "type": "topic",
                "link": best.get("link") or "",
            }
        )
        print(f"[topic] {name} -> id={best.get('id')} name={best.get('name')}")
    return topics


def main() -> int:
    parser = argparse.ArgumentParser(description="小红书图文发布")
    parser.add_argument("--cookies", default=str(ROOT / "cookies.json"))
    parser.add_argument("--images", nargs="+", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--desc", default="")
    parser.add_argument("--topic", action="append", default=[], help="话题名，可重复")
    parser.add_argument("--private", action="store_true", help="仅自己可见")
    parser.add_argument("--dry-run", action="store_true", help="只打印 payload，不发布")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    if args.dry_run:
        # 不上传，只验证字段结构
        entries = [
            build_image_entry(
                file_id="<fileId>",
                width=1080,
                height=1440,
                mime_type="image/jpeg",
                index=index,
                size_bytes=Path(p).stat().st_size if Path(p).exists() else 0,
            )
            for index, p in enumerate(args.images)
        ]
        common = build_common(
            note_type="normal",
            title=args.title,
            desc=args.desc,
            privacy_type=1 if args.private else 0,
            capa_context=build_capa_context(),
        )
        payload = to_post_note_payload(common, image_info=build_image_info(entries))
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    client = XhsClient(cookie_path=args.cookies)
    login = Login(client)
    if not login.verify():
        print("会话无效或缺失。先跑 python scripts/login.py")
        return 2

    topics = resolve_topics(client, args.topic) if args.topic else []
    publisher = Publisher(client, verbose=args.verbose or True)
    try:
        result = publisher.publish_images(
            images=args.images,
            title=args.title,
            desc=args.desc,
            topics=topics,
            privacy_type=1 if args.private else 0,
        )
    except (ApiError, UploadError) as exc:
        print(f"发布失败：{exc}")
        return 1

    print(json.dumps(result.raw, ensure_ascii=False, indent=2))
    if result.note_id:
        print(f"笔记已发布：https://www.xiaohongshu.com/explore/{result.note_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
