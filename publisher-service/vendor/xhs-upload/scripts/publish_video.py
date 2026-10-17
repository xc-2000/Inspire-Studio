#!/usr/bin/env python
"""发布视频笔记。

用法::

    # 自动用服务端首帧做封面
    python scripts/publish_video.py --cookies cookies.json \
        --video a.mp4 --title "标题" --desc "正文"

    # 指定封面 + 强制转码
    python scripts/publish_video.py --cookies cookies.json \
        --video a.mp4 --cover c.jpg --title "标题" --transcode

    # 只打印 payload 结构
    python scripts/publish_video.py --video a.mp4 --title t --dry-run
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
    build_cover,
    build_video_info,
    to_post_note_payload,
)
from xhs.publish import _video_dimensions  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="小红书视频发布")
    parser.add_argument("--cookies", default=str(ROOT / "cookies.json"))
    parser.add_argument("--video", required=True)
    parser.add_argument("--cover", default=None, help="封面图片路径；默认用服务端首帧")
    parser.add_argument("--title", required=True)
    parser.add_argument("--desc", default="")
    parser.add_argument("--topic", action="append", default=[])
    parser.add_argument("--transcode", action="store_true", help="需要转码（scene=preview_video）")
    parser.add_argument("--private", action="store_true")
    parser.add_argument("--no-wait", action="store_true", help="不等待转码/首帧")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    video = Path(args.video)
    if not video.exists():
        print(f"视频不存在：{video}")
        return 2

    width, height, duration_ms = _video_dimensions(video)

    if args.dry_run:
        cover = build_cover("<coverFileId>", width=width or 1080, height=height or 1920, source="upload")
        video_info = build_video_info(
            file_id="<videoFileId>",
            cover=cover,
            width=width,
            height=height,
            duration_ms=duration_ms,
        )
        common = build_common(
            note_type="video",
            title=args.title,
            desc=args.desc,
            privacy_type=1 if args.private else 0,
            capa_context=build_capa_context(),
        )
        print(json.dumps(to_post_note_payload(common, video_info=video_info), ensure_ascii=False, indent=2))
        print(f"\n[dimensions] {width}x{height}, duration={duration_ms}ms")
        return 0

    client = XhsClient(cookie_path=args.cookies)
    login = Login(client)
    if not login.verify():
        print("会话无效或缺失。先跑 python scripts/login.py")
        return 2

    topics = []
    for name in args.topic:
        try:
            found = client.search_topic(name)
        except ApiError as exc:
            print(f"[warn] 搜索话题 {name} 失败：{exc}")
            continue
        if found:
            topics.append({"id": found[0].get("id"), "name": found[0].get("name") or name, "type": "topic"})
            print(f"[topic] {name} -> id={found[0].get('id')}")

    publisher = Publisher(client, verbose=args.verbose or True)
    try:
        result = publisher.publish_video(
            video=video,
            title=args.title,
            desc=args.desc,
            cover=args.cover,
            need_transcode=args.transcode,
            topics=topics,
            privacy_type=1 if args.private else 0,
            wait_for_transcode=not args.no_wait,
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
