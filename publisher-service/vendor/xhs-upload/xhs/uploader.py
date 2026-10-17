"""上传编排：许可获取 -> COS 上传 -> 组装 imageInfo / videoInfo 素材。

对应站点 ``index.0b7d72c0.js`` 里的 uploader 抽象（``getPermit`` / ``post``）：

- 许可：``GET {creator}/api/media/v1/upload/creator/permit``
  （``bizName="spectrum"``，``scene`` ∈ ``image`` / ``video`` / ``preview_video`` / ``audio`` / ``preview_audio``）
- 许可选择：``uploadTempPermits`` 按 ``qos`` 降序取第一个
- 尺寸策略（模块 ``35530``）：<=10MB -> 2MiB、10~20MB -> 3MiB、20~100MB -> 3MiB、
  >1000MB -> 3MiB；单图上传站点显式用 5MiB，多图批量用 3MiB（``FileParallelLimit`` 默认 2）
- 视频上传后：``GET .../postgw/videoid?fileKey=...&bizName=217`` 拿 ``videoId``，
  再轮询 ``query_transcode``（``level=14``）等首帧/转码完成
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

from .client import AUDIO_TRANSCODE_LEVEL, VIDEO_TRANSCODE_LEVEL, XhsClient
from .cos import (
    DEFAULT_SLICE_SIZE,
    IMAGE_SINGLE_SLICE_SIZE,
    CosCredentials,
    CosUploadResult,
    CosUploader,
)

__all__ = [
    "UploadError",
    "TranscodeResult",
    "slice_policy",
    "select_permit",
    "validate_against_limit_policy",
    "Uploader",
    "guess_mime_type",
]

#: 站点 ``bizName``：creator 侧所有发布素材都用 ``spectrum``
BIZ_NAME = "spectrum"

MIME_BY_SUFFIX = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".heic": "image/heic",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
}

#: 转码轮询默认值（``e7`` 的入参）
FIRST_REQUEST_TIME_S = 3
POLL_INTERVAL_S = 3
MAX_UNCHANGED_QUERY_TIMES = 10
MAX_HTTP_FAIL_TIMES = 3
#: 站点 token 请求重试 5 次、间隔 1s（模块 9712 ``requestToken``）
TOKEN_ATTEMPTS = 5
TOKEN_RETRY_INTERVAL_S = 1.0


class UploadError(RuntimeError):
    pass


def guess_mime_type(path: str | Path, fallback: str = "application/octet-stream") -> str:
    suffix = Path(path).suffix.lower()
    return MIME_BY_SUFFIX.get(suffix, fallback)


def slice_policy(size_bytes: int, network: str = "UNKNOWN") -> tuple[int, int]:
    """返回 ``(sliceSize, asyncLimit)``，等价的站点实现见模块 ``35530`` 的 ``l``。"""
    mb = size_bytes / 1024 / 1024
    if mb <= 0:
        return DEFAULT_SLICE_SIZE, 5
    if mb <= 10:
        return 2097152, 5
    if mb <= 20:
        return (4194304 if network == "EXCELLENT" else DEFAULT_SLICE_SIZE), 5
    if mb <= 100:
        return (5242880 if network == "EXCELLENT" else DEFAULT_SLICE_SIZE), 5
    if mb > 1000 and network in ("GOOD", "EXCELLENT"):
        return 5242880, 5
    return DEFAULT_SLICE_SIZE, 5


def select_permit(permits: Sequence[Mapping[str, Any]]) -> Mapping[str, Any]:
    """站点按 ``qos`` 降序取第一个（``permits.sort((a,b) => b.qos - a.qos)[0]``）。"""
    if not permits:
        raise UploadError("token 获取失败：uploadTempPermits 为空")
    return sorted(permits, key=lambda item: item.get("qos", 0), reverse=True)[0]


def validate_against_limit_policy(
    policy: Mapping[str, Any] | None, mime_type: str, size_bytes: int
) -> None:
    """复刻站点的 ``uploadLimitPolicy`` 校验与报错文案。"""
    if not policy:
        return
    file_types = policy.get("fileTypes") or []
    if file_types:
        allowed = [ext for group in file_types for ext in str(group).split("/")]
        if not any(mime_type.endswith(ext) for ext in allowed):
            raise UploadError(
                f"文件类型 {mime_type} 不在可上传的文件类型 {', '.join(file_types)} 中。"
            )
    max_size = policy.get("maxSize")
    if max_size is not None and size_bytes > max_size:
        raise UploadError(
            f"文件尺寸（{size_bytes / 1048576} mb）超过最大尺寸（{max_size / 1048576} mb）。"
        )


@dataclass
class TranscodeResult:
    video_id: str
    has_first_frame: bool = False
    first_frame_file_id: str = ""
    has_transcode_video: bool = False
    transcode_video_file_id: str = ""
    progress: str = ""
    raw: dict[str, Any] | None = None


class Uploader:
    """把文件传到小红书 ROS(COS)，并返回可直接进 payload 的结构。"""

    def __init__(
        self,
        client: XhsClient,
        biz_name: str = BIZ_NAME,
        network: str = "UNKNOWN",
        on_progress: Callable[[int, int], None] | None = None,
        verbose: bool = False,
    ):
        self.client = client
        self.biz_name = biz_name
        self.network = network
        self.on_progress = on_progress
        self.verbose = verbose

    def _log(self, message: str) -> None:
        if self.verbose:
            print(f"[uploader] {message}", flush=True)

    # ---------- 许可 ----------

    def request_permit(
        self,
        scene: str,
        file_count: int = 1,
        file_format: str | None = None,
        persistent_ops: str | None = None,
        persistent_notify_url: str | None = None,
    ) -> tuple[CosCredentials, Mapping[str, Any]]:
        # 站点 ``requestToken`` 对空 permit 会重试 5 次、每次间隔 1s
        last: Mapping[str, Any] = {}
        for attempt in range(TOKEN_ATTEMPTS):
            data = self.client.get_upload_permit(
                biz_name=self.biz_name,
                scene=scene,
                file_count=file_count,
                file_format=file_format,
                persistent_ops=persistent_ops,
                persistent_notify_url=persistent_notify_url,
            )
            last = data or {}
            permits = last.get("uploadTempPermits") or []
            if permits:
                permit = select_permit(permits)
                return (
                    CosCredentials.from_permit(permit, request_ts_ms=int(time.time() * 1000)),
                    permit,
                )
            if attempt < TOKEN_ATTEMPTS - 1:
                time.sleep(TOKEN_RETRY_INTERVAL_S)
        raise UploadError(
            f"token 获取失败：uploadTempPermits 为空（scene={scene}）"
            f" 响应={json.dumps(last, ensure_ascii=False)[:300]}"
        )

    # ---------- 图片 ----------

    def upload_image(
        self,
        path: str | Path,
        scene: str = "image",
        slice_size: int = IMAGE_SINGLE_SLICE_SIZE,
    ) -> CosUploadResult:
        """上传单张图片（站点单图用 ``SliceSize: 5242880``）。"""
        file = Path(path)
        body = file.read_bytes()
        mime = guess_mime_type(file, "image/png")
        credentials, permit = self.request_permit(
            scene, file_count=1, file_format=file.suffix.lstrip(".")
        )
        validate_against_limit_policy(permit.get("uploadLimitPolicy"), mime, len(body))
        self._log(f"图片许可 scene={scene} bucket={credentials.bucket} addr={credentials.upload_addr}")
        uploader = CosUploader(
            credentials,
            session=self.client.session,
            slice_size=slice_size,
            on_progress=self.on_progress,
        )
        return uploader.upload(body, content_type=mime)

    def upload_video(
        self,
        path: str | Path,
        scene: str = "video",
        slice_size: int | None = None,
        async_limit: int | None = None,
    ) -> CosUploadResult:
        """上传视频（``scene="video"`` 不转码 / ``scene="preview_video"`` 转码）。"""
        file = Path(path)
        body = file.read_bytes()
        mime = guess_mime_type(file, "video/mp4")
        policy_slice, policy_limit = slice_policy(len(body), self.network)
        chunk = slice_size or policy_slice
        limit = async_limit or policy_limit
        credentials, permit = self.request_permit(
            scene, file_count=1, file_format=file.suffix.lstrip(".")
        )
        validate_against_limit_policy(permit.get("uploadLimitPolicy"), mime, len(body))
        self._log(
            f"视频许可 scene={scene} bucket={credentials.bucket} "
            f"addr={credentials.upload_addr} slice={chunk} limit={limit}"
        )
        uploader = CosUploader(
            credentials,
            session=self.client.session,
            slice_size=chunk,
            async_limit=limit,
            on_progress=self.on_progress,
        )
        return uploader.upload(body, content_type=mime)

    # ---------- 视频 id / 转码 ----------

    def make_video_id(self, file_key: str, biz_name: str = "217") -> str:
        video_id = self.client.make_video_id(file_key, biz_name)
        if video_id == -1:
            raise UploadError(f"服务端生成 videoId 失败（fileKey={file_key}）")
        return str(video_id)

    def wait_for_transcode(
        self,
        video_id: str,
        need_transcode: bool = False,
        query_cover: bool = True,
        level: str = VIDEO_TRANSCODE_LEVEL,
        resource_type: int = 0,
        interval: float = POLL_INTERVAL_S,
        timeout: float = 900,
        on_tick: Callable[[dict[str, Any]], None] | None = None,
    ) -> TranscodeResult:
        """轮询 ``query_transcode``，直到首帧与转码都就绪。

        站点成功条件：``((level && hasTranscodeVideo) || !level) &&
        ((queryCover && hasFirstFrame) || !queryCover)``；
        另外 ``maxUnchangedQueryTimes``（默认 10）次无变化视为失败。
        """
        deadline = time.time() + timeout
        last_progress = ""
        unchanged = 0
        http_fails = 0
        first_request = True
        result: dict[str, Any] = {}

        while True:
            if time.time() > deadline:
                raise UploadError("转码超时，请刷新重试")
            sleep_for = interval * (FIRST_REQUEST_TIME_S if first_request else 1)
            time.sleep(sleep_for)
            first_request = False

            try:
                result = self.client.query_transcode(
                    video_id, need_transcode, level=level, resource_type=resource_type
                )
                http_fails = 0
            except Exception as exc:  # noqa: BLE001 - 与站点一致：连续失败 N 次才放弃
                http_fails += 1
                self._log(f"query_transcode 失败（{http_fails}/{MAX_HTTP_FAIL_TIMES}）：{exc}")
                if http_fails > MAX_HTTP_FAIL_TIMES:
                    raise UploadError("转码失败，请刷新重试") from exc
                continue

            if on_tick:
                on_tick(result)

            has_first_frame = bool(result.get("hasFirstFrame"))
            if has_first_frame:
                unchanged = 0
            else:
                unchanged += 1

            progress = str((result.get("transProgressInfo") or {}).get("progress") or "")
            if need_transcode:
                # 进度长时间不动也视为失败（站点 track queryProgressFailed）
                if progress and progress == last_progress:
                    unchanged += 1
                last_progress = progress
                if unchanged >= result.get("maxUnchangedQueryTimes", MAX_UNCHANGED_QUERY_TIMES):
                    raise UploadError("转码进度未变化，请刷新重试")
                if progress == "100%":
                    break
            else:
                if unchanged >= result.get("maxUnchangedQueryTimes", MAX_UNCHANGED_QUERY_TIMES):
                    raise UploadError("转码进度未变化，请刷新重试")
                if not query_cover or has_first_frame:
                    break

        return TranscodeResult(
            video_id=str(video_id),
            has_first_frame=bool(result.get("hasFirstFrame")),
            first_frame_file_id=str(result.get("firstFrameFileId") or ""),
            has_transcode_video=bool(result.get("hasTranscodeVideo")),
            transcode_video_file_id=str(result.get("transcodeVideoFileId") or ""),
            progress=str((result.get("transProgressInfo") or {}).get("progress") or ""),
            raw=dict(result),
        )

    # ---------- 便捷方法 ----------

    def upload_images(
        self,
        paths: Iterable[str | Path],
        scene: str = "image",
    ) -> list[CosUploadResult]:
        """批量上传图片（站点多图批量 ``SliceSize: 3145728``）。"""
        results: list[CosUploadResult] = []
        for path in paths:
            results.append(self.upload_image(path, scene=scene, slice_size=DEFAULT_SLICE_SIZE))
        return results
