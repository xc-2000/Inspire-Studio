"""素材预处理与 ``media[]`` 组装。

对应站点 ``n5`` 组件（chunk-common ~471100）与 ``iy`` 的 ``updatePostDesc`` 事件：

- 视频：只上传原片，尺寸/时长由 ``ffprobe`` 取值；
  ``duration > videoMaxDuration(61s)`` → ``videoType = mega``，否则 ``normal``。
- 图片（图文模式）：前端把每张图画到 canvas 后**上传三份**：

  ========== ======================== ==============================
  用途        尺寸                      质量
  ========== ======================== ==============================
  ``url``     ``a3b6.l`` 2048×2048     0.9  （原始，JPEG）
  ``thumbUrl`` ``a3b6.p`` 1080×1080    0.7
  ``full*``   ``a3b6.n`` 3240×3240     0.8  （长图/高清，JPEG）
  ========== ======================== ==============================

  三份都是 JPEG（``toBlob("image/jpeg", quality)``），文件名固定
  ``finder_video_img.jpeg``。注意：canvas 会**丢掉 alpha 通道**，PNG 透明区变黑。

- 封面：``a3b6.m`` 1080×1080 q0.7，同样走图片上传。

Python 侧没有 canvas，这里用 Pillow 复刻「等比缩放到不超过 maxW×maxH 的框内」，
对应前端 ``m.b`` 的实现（``if m > maxWidth or v > maxHeight`` 时按长边缩放）。
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

from .constants import (
    IMAGE_FULL_MAX,
    IMAGE_MAIN,
    IMAGE_THUMB,
    IMG_MAX_COUNT,
    VIDEO_COVER,
    VIDEO_MAX_DURATION,
    CardShowStyle,
    PostMediaType,
    VideoType,
)

__all__ = [
    "MediaError",
    "ImageAsset",
    "VideoMeta",
    "probe_image",
    "probe_video",
    "prepare_image_variants",
    "prepare_cover",
    "build_media_item",
    "validate_media_files",
]

#: 上传时前端写死的文件名（``uploadImgByCanvas`` / ``compressAndUpload``）
CANVAS_JPEG_NAME = "finder_video_img.jpeg"
CANVAS_PNG_NAME = "finder_video_img.png"

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".heic"}
VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".mkv", ".avi", ".flv", ".wmv", ".webm"}

#: ``contentTips`` 里的原话
IMAGE_SIZE_LIMIT_TEXT = "单张不超过20MB"
VIDEO_SIZE_LIMIT_TEXT = "大小不超过4GB"
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_VIDEO_BYTES = 1024 * 4 * 1048576

#: 图片档位 -> ``a3b6`` 里的常量（``l`` / ``p`` / ``n`` 与 ``m`` 同值）
PRESETS: dict[str, dict[str, float]] = {
    "main": IMAGE_MAIN,       # a3b6.l  2048x2048 q0.9  -> media[].url
    "thumb": IMAGE_THUMB,     # a3b6.p  1080x1080 q0.7  -> media[].thumbUrl
    "full": IMAGE_FULL_MAX,   # a3b6.n  3240x3240 q0.8  -> media[].fullThumbUrl
    "cover": VIDEO_COVER,     # a3b6.m  1080x1080 q0.7  -> 视频封面 / 图片封面
}


class MediaError(Exception):
    """素材不符合站点限制。"""


@dataclass
class VideoMeta:
    width: int = 0
    height: int = 0
    duration: float = 0.0  #: 秒
    file_size: int = 0
    path: Path | None = None

    @property
    def is_landscape(self) -> bool:
        return self.width > self.height

    @property
    def video_type(self) -> int:
        """``n5`` 的 ``videoType``：超过 61s 归为 ``mega``。"""
        return VideoType.mega if self.duration > VIDEO_MAX_DURATION else VideoType.normal

    def as_dict(self) -> dict[str, Any]:
        return {
            "width": self.width,
            "height": self.height,
            "duration": self.duration,
            "fileSize": self.file_size,
        }


@dataclass
class ImageAsset:
    """一份图片变体（Pillow 缩放后的临时文件）。"""

    path: Path
    width: int
    height: int
    role: str = "main"
    _tempdir: tempfile.TemporaryDirectory | None = field(default=None, repr=False)

    def cleanup(self) -> None:
        if self._tempdir is not None:
            self._tempdir.cleanup()
            self._tempdir = None


# --------------------------------------------------------------------------
# 探测
# --------------------------------------------------------------------------


def probe_image(path: str | Path) -> tuple[int, int]:
    """``(width, height)``。拿不到就返回 ``(0, 0)``。"""
    try:
        from PIL import Image  # 可选依赖
    except ImportError:
        return 0, 0
    try:
        with Image.open(path) as image:
            return int(image.width), int(image.height)
    except Exception:  # noqa: BLE001
        return 0, 0


def probe_video(path: str | Path) -> VideoMeta:
    """用 ``ffprobe`` 取视频元信息；没装或文件不存在时只回 0 / 文件大小。

    文件不存在也不抛异常 —— ``--dry-run`` 允许对着还不存在的路径预览请求体。
    """
    file_path = Path(path)
    meta = VideoMeta(path=file_path, file_size=0)
    if not file_path.is_file():
        return meta
    meta.file_size = file_path.stat().st_size
    if not shutil.which("ffprobe"):
        return meta
    try:
        output = subprocess.run(
            [
                "ffprobe",
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_streams",
                "-show_format",
                str(file_path),
            ],
            capture_output=True,
            check=True,
            timeout=120,
        ).stdout
        parsed = json.loads(output)
    except Exception:  # noqa: BLE001
        return meta

    for stream in parsed.get("streams", []):
        if stream.get("codec_type") == "video" and not meta.width:
            meta.width = int(stream.get("width") or 0)
            meta.height = int(stream.get("height") or 0)
    duration = (parsed.get("format") or {}).get("duration")
    if duration:
        meta.duration = float(duration)
    return meta


# --------------------------------------------------------------------------
# 图片缩放（复刻 canvas fit 逻辑）
# --------------------------------------------------------------------------


def _fit(
    width: int, height: int, max_width: int, max_height: int
) -> tuple[int, int, float, float]:
    """前端 ``m.b``：等比缩放到 ``maxWidth×maxHeight`` 框内。

    返回 ``(canvasWidth, canvasHeight, sourceDx, sourceDy)`` —— 后两个是原始裁剪宽度，
    仅在带 ``minRatio``/``maxRatio`` 时才与原始尺寸不同；本库不做裁剪，故等于原始尺寸。
    """
    if width <= 0 or height <= 0:
        return 0, 0, 0, 0
    ratio = width / height
    frame_ratio = max_width / max_height
    target_w, target_h = width, height
    if target_w > max_width or target_h > max_height:
        if ratio >= frame_ratio:
            target_h = max_width / target_w * target_h
            target_w = max_width
        else:
            target_w = max_height / target_h * target_w
            target_h = max_height
    return int(target_w), int(target_h), width, height


def prepare_image_variants(
    path: str | Path,
    *,
    roles: Sequence[str] = ("main", "thumb", "full"),
    keep_alpha: bool = False,
) -> dict[str, ImageAsset]:
    """生成 ``main`` / ``thumb`` / ``full`` 三份 JPEG。

    前端在 ``customUpload`` 里就是这么做的；三者都上传，服务端分别用于
    正文配图、缩略图与高清原图。
    """
    try:
        from PIL import Image  # 可选依赖
    except ImportError as exc:  # pragma: no cover - 环境相关
        raise MediaError(
            "图片处理需要 Pillow：pip install Pillow（或传 use_original_images=True 跳过缩放）"
        ) from exc

    source = Path(path)
    if not source.is_file():
        raise MediaError(f"图片不存在：{source}")

    presets = PRESETS
    tempdir = tempfile.TemporaryDirectory(prefix="wxc-img-")
    assets: dict[str, ImageAsset] = {}
    try:
        with Image.open(source) as opened:
            base = opened.convert("RGBA" if keep_alpha else "RGB")
            for role in roles:
                preset = presets.get(role)
                if preset is None:
                    raise MediaError(
                        f"未知的图片档位 {role!r}，可选 {sorted(presets)}"
                    )
                target_w, target_h, _, _ = _fit(
                    base.width, base.height, preset["width"], preset["height"]
                )
                resized = (
                    base
                    if (base.width, base.height) == (target_w, target_h)
                    else base.resize((target_w, target_h), Image.LANCZOS)
                )
                if keep_alpha:
                    out = Path(tempdir.name) / f"{role}.png"
                    resized.save(out, format="PNG")
                else:
                    out = Path(tempdir.name) / f"{role}.jpeg"
                    resized.convert("RGB").save(
                        out, format="JPEG", quality=int(preset["quality"] * 100)
                    )
                assets[role] = ImageAsset(
                    path=out,
                    width=target_w,
                    height=target_h,
                    role=role,
                    _tempdir=tempdir,
                )
    except MediaError:
        tempdir.cleanup()
        raise
    except Exception as exc:  # noqa: BLE001
        tempdir.cleanup()
        raise MediaError(f"处理图片失败 {source}：{exc}") from exc
    return assets


def prepare_cover(path: str | Path) -> ImageAsset:
    """封面：``a3b6.m`` 1080×1080 q0.7（对应 ``uploadImgByCanvas``）。"""
    return prepare_image_variants(path, roles=("cover",))["cover"]


# --------------------------------------------------------------------------
# media[] 组装
# --------------------------------------------------------------------------


def build_media_item(
    *,
    url: str,
    file_size: int,
    width: int,
    height: int,
    media_type: int,
    uuid: str,
    thumb_url: str = "",
    full_thumb_url: str = "",
    cover_url: str = "",
    full_cover_url: str = "",
    duration: float = 0.0,
    card_show_style: int | None = None,
    object_id: str = "",
    url_cdn_task_id: str = "",
) -> dict[str, Any]:
    """组装 ``objectDesc.media[]`` 的一项。

    字段与前端 ``iy`` 里 ``fileList.map`` 的产物一致；横版视频会在站点侧补
    ``cardShowStyle = FinderMediaCardShowStyleCenter``，这里显式补齐以便离线复现。
    """
    is_video = media_type == PostMediaType.video
    item: dict[str, Any] = {
        "url": url,
        "fileSize": file_size,
        "thumbUrl": thumb_url,
        "fullThumbUrl": full_thumb_url or thumb_url,
        "mediaType": media_type,
        "videoPlayLen": duration if is_video else 0,
        "width": width,
        "height": height,
        "md5sum": uuid,
        "cardShowStyle": card_show_style,
    }
    if is_video and cover_url:
        item["coverUrl"] = cover_url
        item["fullCoverUrl"] = full_cover_url or cover_url
    if url_cdn_task_id:
        item["urlCdnTaskId"] = url_cdn_task_id
    if object_id:
        item["_objectId"] = object_id
    if is_video:
        if width > height:
            if not item.get("cardShowStyle"):
                item["cardShowStyle"] = CardShowStyle.Center
        else:
            item["cardShowStyle"] = None
    return item


# --------------------------------------------------------------------------
# 本地校验（对应 validBaseForm + fileList 校验）
# --------------------------------------------------------------------------


def classify_files(paths: Iterable[str | Path]) -> dict[str, list[Path]]:
    images: list[Path] = []
    videos: list[Path] = []
    unknown: list[Path] = []
    for raw in paths:
        path = Path(raw)
        suffix = path.suffix.lower()
        if suffix in IMAGE_SUFFIXES:
            images.append(path)
        elif suffix in VIDEO_SUFFIXES:
            videos.append(path)
        else:
            unknown.append(path)
    return {"images": images, "videos": videos, "unknown": unknown}


def validate_media_files(
    paths: Sequence[str | Path], *, check_exists: bool = True
) -> dict[str, list[Path]]:
    """本地预检，抛出与站点文案一致的错误。

    站点文案（模块 ``fae3`` / ``a3b6``）：

    - ``"最多上传1个视频"``
    - ``"最多上传" + imgMaxCount + "张图片"``
    - ``"不可同时选择图片和视频文件类型"``
    """
    path_list = [Path(raw) for raw in paths]
    groups = classify_files(path_list)
    if check_exists:
        absent = [str(p) for p in path_list if not p.is_file()]
        if absent:
            raise MediaError("文件不存在：" + ", ".join(absent))
    if groups["unknown"]:
        raise MediaError(
            "不识别的文件类型：" + ", ".join(str(p) for p in groups["unknown"])
        )
    if groups["videos"] and groups["images"]:
        raise MediaError("不可同时选择图片和视频文件类型")
    if len(groups["videos"]) > 1:
        raise MediaError("最多上传1个视频")
    if len(groups["images"]) > IMG_MAX_COUNT:
        raise MediaError(f"最多上传{IMG_MAX_COUNT}张图片")
    for path in groups["images"]:
        size = path.stat().st_size if path.is_file() else 0
        if size > MAX_IMAGE_BYTES:
            raise MediaError(f"{path.name} 超过单张 20MB 限制（{size / 1048576:.1f}MB）")
    for path in groups["videos"]:
        size = path.stat().st_size if path.is_file() else 0
        if size > MAX_VIDEO_BYTES:
            raise MediaError(f"{path.name} 超过 4GB 限制（{size / 1073741824:.2f}GB）")
    return groups
