"""高层发布接口：图文 / 视频 / 音频。

把 ``uploader`` + ``payload`` + ``client`` 串成一次完整发布：

图文
    1. 逐张取许可（``scene=image``）并上传
    2. 组装 ``imageInfo.images[]``
    3. ``POST /web_api/sns/v2/note``，``common.type="normal"``

视频
    1. 取许可（``scene=video`` 或 ``scene=preview_video``）并上传
    2. ``POST /videoid?fileKey=<fileId>&bizName=217`` 取 videoId
    3. 轮询 ``query_transcode``（``level=14``）等首帧/转码
    4. 封面：显式上传（``scene=image``）或复用首帧 ``firstFrameFileId``
    5. 组装 ``videoInfo`` 后 ``POST /web_api/sns/v2/note``，``common.type="video"``
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from .client import XhsClient
from .payload import (
    COVER_SOURCE_RECOMMEND,
    COVER_SOURCE_UPLOAD,
    build_capa_context,
    build_common,
    build_cover,
    build_image_entry,
    build_chapters,
    build_image_info,
    build_segments,
    build_video_info,
)
from .uploader import BIZ_NAME, Uploader, UploadError, guess_mime_type

__all__ = ["PublishResult", "Publisher", "NoteType"]

NOTE_TYPE_VIDEO = "video"
NOTE_TYPE_NORMAL = "normal"

#: 隐私：对齐站点 ``privacyInfo``，公开为 ``type=0``
PRIVACY_PUBLIC = 0
PRIVACY_PRIVATE = 1
PRIVACY_PARTIAL_INVISIBLE = 2
PRIVACY_PARTIAL_VISIBLE = 3


def _image_dimensions(path: Path) -> tuple[int, int]:
    try:
        from PIL import Image  # 可选依赖

        with Image.open(path) as image:
            return int(image.width), int(image.height)
    except Exception:  # noqa: BLE001 - 拿不到就发 0，服务端会自己解析
        return 0, 0


def _video_dimensions(path: Path) -> tuple[int, int, int]:
    """返回 ``(width, height, duration_ms)``；依赖 ffprobe，取不到则全 0。"""
    import json
    import shutil
    import subprocess

    if not shutil.which("ffprobe"):
        return 0, 0, 0
    try:
        out = subprocess.run(
            [
                "ffprobe", "-v", "quiet", "-print_format", "json",
                "-show_streams", "-show_format", str(path),
            ],
            capture_output=True,
            check=True,
            timeout=60,
        ).stdout
        meta = json.loads(out)
    except Exception:  # noqa: BLE001
        return 0, 0, 0

    width = height = 0
    duration_ms = 0
    for stream in meta.get("streams", []):
        if stream.get("codec_type") == "video" and not width:
            width = int(stream.get("width") or 0)
            height = int(stream.get("height") or 0)
    duration = (meta.get("format") or {}).get("duration")
    if duration:
        duration_ms = int(float(duration) * 1000)
    return width, height, duration_ms


@dataclass
class PublishResult:
    ok: bool
    raw: dict[str, Any] = field(default_factory=dict)
    note_id: str = ""
    video_id: str = ""
    detail: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_response(cls, data: Mapping[str, Any]) -> "PublishResult":
        payload = dict(data or {})
        inner = payload.get("data") or {}
        return cls(
            ok=bool(payload.get("success")) or payload.get("code") in (0, None),
            raw=payload,
            note_id=str(inner.get("note_id") or inner.get("id") or ""),
            video_id=str(inner.get("video_id") or ""),
            detail=dict(inner),
        )


class Publisher:
    def __init__(
        self,
        client: XhsClient,
        uploader: Uploader | None = None,
        verbose: bool = False,
        on_progress: Callable[[int, int], None] | None = None,
    ):
        self.client = client
        self.uploader = uploader or Uploader(
            client, biz_name=BIZ_NAME, on_progress=on_progress, verbose=verbose
        )
        self.verbose = verbose

    def _log(self, message: str) -> None:
        if self.verbose:
            print(f"[publish] {message}", flush=True)

    # ------------------------------------------------------------------
    # 图文
    # ------------------------------------------------------------------

    def publish_images(
        self,
        images: Sequence[str | Path],
        title: str,
        desc: str = "",
        topics: Sequence[Mapping[str, Any]] | None = None,
        ats: Sequence[Mapping[str, Any]] | None = None,
        privacy_type: int = PRIVACY_PUBLIC,
        user_ids: Sequence[str] | None = None,
        post_time_ms: int | None = None,
    ) -> PublishResult:
        if not images:
            raise UploadError("请上传图片")

        entries: list[dict[str, Any]] = []
        for index, path in enumerate(images):
            file = Path(path)
            upload = self.uploader.upload_image(file, scene="image")
            width, height = _image_dimensions(file)
            entry = build_image_entry(
                file_id=upload.file_id,
                width=width,
                height=height,
                mime_type=guess_mime_type(file, "image/png"),
                index=index,
                size_bytes=file.stat().st_size,
            )
            entries.append(entry)
            self._log(f"图片 {index + 1}/{len(images)} 上传完成 fileId={upload.file_id}")

        common = build_common(
            note_type=NOTE_TYPE_NORMAL,
            title=title,
            desc=desc,
            topics=topics,
            ats=ats,
            privacy_type=privacy_type,
            user_ids=user_ids,
            post_time_ms=post_time_ms,
            capa_context=build_capa_context(),
        )
        data = self.client.post_note(common, image_info=build_image_info(entries))
        return PublishResult.from_response(data)

    # ------------------------------------------------------------------
    # 视频
    # ------------------------------------------------------------------

    def publish_video(
        self,
        video: str | Path,
        title: str,
        desc: str = "",
        cover: str | Path | None = None,
        need_transcode: bool = False,
        topics: Sequence[Mapping[str, Any]] | None = None,
        ats: Sequence[Mapping[str, Any]] | None = None,
        privacy_type: int = PRIVACY_PUBLIC,
        user_ids: Sequence[str] | None = None,
        post_time_ms: int | None = None,
        video_meta: Mapping[str, Any] | str | None = None,
        audio_meta: Mapping[str, Any] | str | None = None,
        chapters: Sequence[Mapping[str, Any]] | None = None,
        summary: str = "",
        wait_for_transcode: bool = True,
        transcode_timeout: float = 900,
    ) -> PublishResult:
        video_path = Path(video)
        scene = "preview_video" if need_transcode else "video"

        upload = self.uploader.upload_video(video_path, scene=scene)
        self._log(f"视频上传完成 fileId={upload.file_id}")

        # COS 响应头 x-ros-video-id 就是服务端已生成的 videoId，优先用它；
        # 拿不到时才回落到 postgw/videoid 接口（该接口在未上传完成时会返回空 data）。
        video_id = upload.video_id or self.uploader.make_video_id(upload.file_id)
        self._log(f"videoId={video_id}")

        transcode = None
        if wait_for_transcode:
            transcode = self.uploader.wait_for_transcode(
                video_id,
                need_transcode=need_transcode,
                query_cover=True,
                on_tick=lambda r: self._log(
                    f"转码轮询 hasFirstFrame={r.get('hasFirstFrame')} "
                    f"progress={(r.get('transProgressInfo') or {}).get('progress')}"
                ),
                timeout=transcode_timeout,
            )
            self._log(
                f"转码完成 firstFrame={transcode.first_frame_file_id} "
                f"transcodeVideo={transcode.transcode_video_file_id}"
            )

        width, height, duration_ms = _video_dimensions(video_path)

        # 封面：显式上传 > 首帧
        cover_info: dict[str, Any] | None = None
        cover_source = COVER_SOURCE_UPLOAD
        cover_file_id = ""
        if cover is not None:
            cover_upload = self.uploader.upload_image(Path(cover), scene="image")
            cover_file_id = cover_upload.file_id
            cover_w, cover_h = _image_dimensions(Path(cover))
            cover_source = COVER_SOURCE_UPLOAD
        elif transcode and transcode.first_frame_file_id:
            cover_file_id = transcode.first_frame_file_id
            cover_w, cover_h = width, height
            cover_source = "default"
        else:
            cover_w = cover_h = 0

        if cover_file_id:
            cover_info = build_cover(
                fileid=cover_file_id,
                width=cover_w,
                height=cover_h,
                source=cover_source,
            )

        video_info = build_video_info(
            file_id=upload.file_id,
            cover=cover_info,
            width=width,
            height=height,
            duration_ms=duration_ms,
            video_meta=video_meta,
            audio_meta=audio_meta,
            segments=build_segments(duration_ms, video_meta, audio_meta) if video_meta or audio_meta else None,
            chapters=build_chapters(chapters) if chapters else None,
            summary=summary,
        )

        common = build_common(
            note_type=NOTE_TYPE_VIDEO,
            title=title,
            desc=desc,
            topics=topics,
            ats=ats,
            privacy_type=privacy_type,
            user_ids=user_ids,
            post_time_ms=post_time_ms,
            capa_context=build_capa_context(),
        )
        data = self.client.post_note(common, video_info=video_info)
        result = PublishResult.from_response(data)
        result.video_id = video_id
        return result


class NoteType:
    """站点枚举简写（``{0: "video", 1: "normal"}``）。"""

    VIDEO = NOTE_TYPE_VIDEO
    NORMAL = NOTE_TYPE_NORMAL


_ = (time, COVER_SOURCE_RECOMMEND)
