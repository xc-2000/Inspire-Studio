"""高层发布接口：图文 / 视频 —— 默认只存草稿。

串起 ``client`` + ``uploader`` + ``media`` + ``payload``：

::

    视频:  upload_params -> PUT {cdn}/applyuploaddfs -> uploadpartdfs × N
           -> completepartuploaddfs -> media[] (含封面) -> get-finder-post-trace-key
           -> POST /post/post_draft   (默认)   或   POST /post/post_create  (--publish)

    图文:  upload_params -> 每张图 main/thumb/full 三份上传 -> media[]
           -> get-finder-post-trace-key -> post_draft / post_create

**默认动作是存草稿**。真实发布是 ``post_create``，必须显式 ``publish=True``：
视频号没有面向个人的公开发布 API，请求频率过高有会话风控风险（``douyin-uploader``
的实测记录是 ~40 秒内 5 次发布触发 403 + 会话失效），所以库层面默认保守。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from .client import ChannelsClient, make_client_id
from .constants import CdnFileType, PostMediaType, Scene
from .errors import ApiError
from .media import (
    ImageAsset,
    build_media_item,
    prepare_cover,
    prepare_image_variants,
    probe_image,
    probe_video,
    validate_media_files,
)
from .payload import (
    build_create_body,
    build_draft_body,
    build_object_desc,
    build_post_payload,
    build_preview_body,
    collect_mentions_from_text,
    collect_topics_from_text,
    validate_payload,
)
from .uploader import DfsUploader

__all__ = ["PublishResult", "Publisher", "RateLimiter"]


@dataclass
class PublishResult:
    """一次发布/存草稿的结果。"""

    action: str  #: ``"draft"`` / ``"publish"`` / ``"preview"``
    ok: bool
    raw: dict[str, Any] = field(default_factory=dict)
    err_code: int = 0
    err_msg: str = ""
    object_id: str = ""
    media: list[dict[str, Any]] = field(default_factory=list)
    payload: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)

    @property
    def post_url(self) -> str:
        return "https://channels.weixin.qq.com/platform/post/list"


class RateLimiter:
    """最小间隔节流。默认 30 秒一次「写」请求。

    参照 ``douyin-uploader/docs/protocol.md``：短时间内连续发布会导致
    HTTP 403 + 会话被踢。视频号没有公开的配额文档，这里取保守值。
    """

    def __init__(self, min_interval: float = 30.0) -> None:
        self.min_interval = min_interval
        self._last = 0.0

    def wait(self, verbose: bool = False) -> float:
        now = time.time()
        elapsed = now - self._last
        if self._last and elapsed < self.min_interval:
            delay = self.min_interval - elapsed
            if verbose:
                print(f"[throttle] 等待 {delay:.1f}s（最小间隔 {self.min_interval}s）")
            time.sleep(delay)
            now = time.time()
        self._last = now
        return now


class Publisher:
    """发布编排。

    :param client: :class:`ChannelsClient`
    :param verbose: 打印进度
    :param throttle: 写请求最小间隔（秒）；``0`` 关闭
    """

    def __init__(
        self,
        client: ChannelsClient,
        *,
        verbose: bool = False,
        throttle: float = 30.0,
        session: Any = None,
    ) -> None:
        self.client = client
        self.verbose = verbose
        self.uploader = DfsUploader(client, session=session, verbose=verbose)
        self.limiter = RateLimiter(throttle)
        self._temp_assets: list[ImageAsset] = []

    # ---------- 工具 ----------

    def _log(self, message: str) -> None:
        if self.verbose:
            print(f"[publish] {message}", flush=True)

    def _progress_printer(self, label: str) -> Callable[[int, float], None]:
        def report(percent: float, _info: Mapping[str, Any]) -> None:
            if self.verbose:
                print(f"\r[upload] {label} {percent:5.1f}%", end="", flush=True)

        return report  # type: ignore[return-value]

    def cleanup(self) -> None:
        for asset in self._temp_assets:
            asset.cleanup()
        self._temp_assets.clear()

    # ---------- 初始化 ----------

    def bootstrap(self) -> dict[str, Any]:
        """取一次账号信息（``auth_data``）+ 上传凭证，并把 ``envInfo`` 应用到 uploader。

        前端 ``getAuthData`` 之后是 ``N.setHost(i.envInfo.cdnHost)``，本项目同样处理。
        """
        auth = self.client.auth_data()
        data = auth.get("data") or {}
        env_info = data.get("envInfo") or {}
        self.uploader.apply_env(env_info)
        self._log(
            f"envInfo.uploadVersion={env_info.get('uploadVersion')!r} "
            f"cdnHost={env_info.get('cdnHost')!r} -> host={self.uploader.host}"
        )
        params = self.client.upload_params()
        self._log(f"uploadParams.uin={params.get('uin')} scene={params.get('scene')}")
        return {"auth": auth, "envInfo": env_info, "uploadParams": params}

    # ---------- 上传 ----------

    def upload_video(
        self,
        path: str | Path,
        *,
        cover: str | Path | None = None,
        progress: Callable[[int, float], None] | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """上传视频（+ 可选封面），返回 ``(media_item, meta)``。"""
        file_path = Path(path)
        meta = probe_video(file_path)
        self._log(
            f"视频 {file_path.name} {meta.width}x{meta.height} "
            f"{meta.duration:.1f}s type={meta.video_type}"
        )
        started = time.time()
        result = self.uploader.upload(
            file_path,
            cdn_file_type=CdnFileType.video,
            progress=progress or self._progress_printer(file_path.name),
        )
        upload_cost = time.time() - started
        if self.verbose:
            print()

        cover_url = ""
        if cover:
            asset = prepare_cover(cover)
            self._temp_assets.append(asset)
            cover_result = self.uploader.upload(
                asset.path,
                cdn_file_type=CdnFileType.picture,
                file_name="finder_video_img.jpeg",
            )
            cover_url = cover_result.https_url
            self._log(f"封面上传完成 {cover_url}")

        item = build_media_item(
            url=result.https_url,
            file_size=result.file_size,
            width=meta.width,
            height=meta.height,
            media_type=PostMediaType.video,
            uuid=result.uuid,
            thumb_url=cover_url,
            cover_url=cover_url,
            duration=meta.duration,
        )
        return item, dict(meta.as_dict(), uploadCost=round(upload_cost, 3))

    def upload_image(
        self,
        path: str | Path,
        *,
        variants: bool = True,
        progress: Callable[[int, float], None] | None = None,
    ) -> dict[str, Any]:
        """上传一张图片。``variants=True`` 时上传 main/thumb/full 三份（站点行为）。"""
        file_path = Path(path)
        if variants:
            assets = prepare_image_variants(file_path)
            self._temp_assets.extend(assets.values())
            main = self.uploader.upload(
                assets["main"].path,
                cdn_file_type=CdnFileType.picture,
                file_name=file_path.with_suffix(".jpeg").name,
                progress=progress,
            )
            thumb = self.uploader.upload(
                assets["thumb"].path,
                cdn_file_type=CdnFileType.thumb,
                file_name=file_path.with_suffix(".jpeg").name,
            )
            full = self.uploader.upload(
                assets["full"].path,
                cdn_file_type=CdnFileType.picture,
                file_name=file_path.with_suffix(".jpeg").name,
            )
            width, height = assets["main"].width, assets["main"].height
        else:
            main = self.uploader.upload(
                file_path,
                cdn_file_type=CdnFileType.picture,
                progress=progress,
            )
            thumb = main
            full = main
            width, height = probe_image(file_path)

        return build_media_item(
            url=main.https_url,
            file_size=main.file_size,
            width=width,
            height=height,
            media_type=PostMediaType.image,
            uuid=main.uuid,
            thumb_url=thumb.https_url,
            full_thumb_url=full.https_url,
        )

    def upload_media(
        self,
        paths: Sequence[str | Path],
        *,
        cover: str | Path | None = None,
        progress: Callable[[int, float], None] | None = None,
    ) -> tuple[list[dict[str, Any]], int]:
        """按文件类型自动分派，返回 ``(media, mediaType)``。"""
        groups = validate_media_files(paths)
        media: list[dict[str, Any]] = []
        if groups["videos"]:
            item, _meta = self.upload_video(
                groups["videos"][0], cover=cover, progress=progress
            )
            media.append(item)
            return media, PostMediaType.video
        total = len(groups["images"])
        for index, path in enumerate(groups["images"], start=1):
            self._log(f"上传图片 {index}/{total} {Path(path).name}")
            media.append(self.upload_image(path, progress=progress))
        return media, PostMediaType.image

    # ---------- 组装 + 提交 ----------

    def build_payload(
        self,
        media: Sequence[Mapping[str, Any]],
        media_type: int,
        *,
        description: str = "",
        title: str = "",
        topics: Sequence[str] | None = None,
        mentions: Sequence[str] | None = None,
        mp_title: str = "",
        ext_link: str = "",
        ext_link_title: str = "",
        location: Mapping[str, Any] | None = None,
        event: Mapping[str, Any] | None = None,
        collection_id: str = "",
        collection_name: str = "",
        original_mark: bool = False,
        video_clip_task_id: str = "",
        report: Mapping[str, Any] | None = None,
        effective_time: int | None = None,
        trace_key: str = "",
    ) -> dict[str, Any]:
        topic_list = collect_topics_from_text(description, topics)
        mention_list = collect_mentions_from_text(description, mentions)
        object_desc = build_object_desc(
            media=media,
            media_type=media_type,
            description=description,
            topics=topic_list,
            mentions=mention_list,
            title=title,
            mp_title=mp_title,
            ext_link=ext_link,
            ext_link_title=ext_link_title,
            location=location,
            event=event,
            collection_id=collection_id,
            collection_name=collection_name,
        )
        return build_post_payload(
            object_desc,
            trace_key=trace_key,
            topics=topic_list,
            original_mark=original_mark,
            video_clip_task_id=video_clip_task_id,
            report=report,
            effective_time=effective_time,
        )

    def submit(
        self,
        payload: Mapping[str, Any],
        *,
        publish: bool = False,
        object_id: str | None = None,
        client_id: str = "",
        preview: bool = False,
        fetch_trace_key: bool = True,
        dry_run: bool = False,
    ) -> PublishResult:
        """提交。

        :param publish: ``True`` 走 ``post_create``（真实发布）；默认 ``post_draft``
        :param object_id: 已有草稿 id（覆盖同一草稿时用）
        :param preview: 走 ``post_preview``（只拿票据，不落库）
        :param dry_run: 不请求，直接返回组装结果
        """
        client_id = client_id or make_client_id()
        body = dict(payload)
        warnings = validate_payload(body, for_publish=publish or preview)

        if fetch_trace_key and not dry_run:
            trace_key = self.client.get_post_trace_key(object_id)
            body = dict(body)
            body["traceInfo"] = {**(body.get("traceInfo") or {}), "traceKey": trace_key}
            self._log(f"traceKey={trace_key}")

        # 视频真实发布：新版上传链路必须先建转码任务，否则 post_create 返回 300002。
        # 草稿链路不需要（实测不带 videoClipTaskId 也能成功），preview 也应保持无副作用。
        if publish and not dry_run:
            body = self._ensure_video_clip(body)

        if dry_run:
            object_desc = body.get("objectDesc") or {}
            if publish and any(
                m.get("mediaType") == PostMediaType.video
                for m in (object_desc.get("media") or [])
            ):
                # 转码任务要真发请求才拿得到 draftId，dry-run 无法预演
                warnings = list(warnings) + [
                    "dry-run 不会创建视频转码任务：真实发布的 body 还会多出 "
                    "videoClipTaskId 与 media[].urlCdnTaskId（由 /post/post_clip_video 返回）"
                ]
            return PublishResult(
                action="preview" if preview else ("publish" if publish else "draft"),
                ok=True,
                payload=body,
                warnings=warnings,
                raw={"dryRun": True, "requestBody": self._request_body(body, client_id, publish, preview, object_id)},
            )

        self.limiter.wait(self.verbose)
        try:
            if preview:
                response = self.client.request(
                    "preview",
                    build_preview_body(body, client_id, Scene.FinderAssistant),
                )
                action = "preview"
            elif publish:
                response = self.client.request("create", build_create_body(body, client_id))
                action = "publish"
            else:
                response = self.client.request(
                    "postDraft", build_draft_body(body, client_id, object_id)
                )
                action = "draft"
        except ApiError as exc:
            return PublishResult(
                action="publish" if publish else "draft",
                ok=False,
                err_code=exc.err_code,
                err_msg=str(exc),
                payload=body,
                warnings=warnings,
            )

        data = response.get("data") or {}
        found_id = str(
            data.get("objectId") or data.get("draftId") or data.get("id") or object_id or ""
        )
        return PublishResult(
            action=action,
            ok=response.get("errCode", 0) == 0,
            raw=response,
            object_id=found_id,
            err_code=int(response.get("errCode") or 0),
            err_msg=str(response.get("errMsg") or ""),
            media=list((body.get("objectDesc") or {}).get("media") or []),
            payload=body,
            warnings=warnings,
        )

    def _ensure_video_clip(self, body: dict[str, Any]) -> dict[str, Any]:
        """为视频媒体项跑 ``post_clip_video``，回填 ``videoClipTaskId`` 与 ``urlCdnTaskId``。

        实测：``switchInfo.asyncClipPostSwitch`` 为真时（本项目账号为 ``1``），
        视频 ``post_create`` 若 ``videoClipTaskId`` / ``media[].urlCdnTaskId`` 为空，
        会返回 ``errCode 300002 "request failed"``；先建转码任务再发就成功。
        图文（``mediaType`` 非 4）不需要这一步。
        """
        object_desc = body.get("objectDesc") or {}
        media = list(object_desc.get("media") or [])
        videos = [m for m in media if m.get("mediaType") == PostMediaType.video]
        if not videos:
            return body
        # 已经带过转码任务 id 就不要重复建
        if body.get("videoClipTaskId") and all(m.get("urlCdnTaskId") for m in videos):
            return body

        trace_info = body.get("traceInfo") or {}
        for item in videos:
            clip = self.client.clip_video(
                url=str(item.get("url") or ""),
                width=int(item.get("width") or 0),
                height=int(item.get("height") or 0),
                duration=float(item.get("videoPlayLen") or 0),
                file_size=int(item.get("fileSize") or 0),
                trace_info=trace_info,
            )
            clip_id = str(clip.get("draftId") or clip.get("clipKey") or "")
            item["urlCdnTaskId"] = clip_id
            body["videoClipTaskId"] = clip_id
            self._log(f"转码任务已建 draftId={clip_id}")
        body["objectDesc"] = {**object_desc, "media": media}
        return body

    @staticmethod
    def _request_body(
        payload: Mapping[str, Any],
        client_id: str,
        publish: bool,
        preview: bool,
        object_id: str | None,
    ) -> dict[str, Any]:
        if preview:
            return build_preview_body(payload, client_id, Scene.FinderAssistant)
        if publish:
            return build_create_body(payload, client_id)
        return build_draft_body(payload, client_id, object_id)

    # ---------- 一步到位 ----------

    def publish_images(
        self,
        paths: Sequence[str | Path],
        *,
        title: str = "",
        description: str = "",
        topics: Sequence[str] | None = None,
        mentions: Sequence[str] | None = None,
        publish: bool = False,
        preview: bool = False,
        dry_run: bool = False,
        object_id: str | None = None,
        variants: bool = True,
        apply_rich_text: bool = True,
        client_id: str = "",
        fetch_trace_key: bool = True,
        **extra: Any,
    ) -> PublishResult:
        """发图文。``apply_rich_text`` 为 ``True`` 时上传前先做尺寸/数量预检。"""
        if apply_rich_text:
            # dry-run 允许文件还不存在，只做类型/数量校验
            validate_media_files(paths, check_exists=not dry_run)
        if dry_run:
            media = [self._fake_media_item(Path(p), PostMediaType.image) for p in paths]
            payload = self.build_payload(
                media, PostMediaType.image, description=description, title=title,
                topics=topics, mentions=mentions, **extra,
            )
            return self.submit(
                payload,
                publish=publish,
                preview=preview,
                dry_run=True,
                client_id=client_id,
                fetch_trace_key=fetch_trace_key,
            )

        self.bootstrap()
        try:
            groups = validate_media_files(paths)
            media = [
                self.upload_image(path, variants=variants)
                for path in groups["images"]
            ]
            payload = self.build_payload(
                media, PostMediaType.image, description=description, title=title,
                topics=topics, mentions=mentions, **extra,
            )
            return self.submit(
                payload,
                publish=publish,
                preview=preview,
                object_id=object_id,
                client_id=client_id,
                fetch_trace_key=fetch_trace_key,
            )
        finally:
            self.cleanup()

    def publish_video(
        self,
        path: str | Path,
        *,
        cover: str | Path | None = None,
        title: str = "",
        description: str = "",
        topics: Sequence[str] | None = None,
        mentions: Sequence[str] | None = None,
        publish: bool = False,
        preview: bool = False,
        dry_run: bool = False,
        object_id: str | None = None,
        media_type: int = PostMediaType.video,
        client_id: str = "",
        fetch_trace_key: bool = True,
        **extra: Any,
    ) -> PublishResult:
        """发视频。``title`` 只在图文模式用到，这里保留以便统一签名。"""
        if dry_run:
            media = [self._fake_media_item(Path(path), PostMediaType.video, cover=cover)]
            payload = self.build_payload(
                media, media_type, description=description, title=title,
                topics=topics, mentions=mentions, **extra,
            )
            return self.submit(
                payload,
                publish=publish,
                preview=preview,
                dry_run=True,
                client_id=client_id,
                fetch_trace_key=fetch_trace_key,
            )

        self.bootstrap()
        try:
            item, meta = self.upload_video(path, cover=cover)
            payload = self.build_payload(
                [item], media_type, description=description, title=title,
                topics=topics, mentions=mentions,
                report=_report_from_meta(meta, meta.get("uploadCost", 0.0)),
                **extra,
            )
            return self.submit(
                payload,
                publish=publish,
                preview=preview,
                object_id=object_id,
                client_id=client_id,
                fetch_trace_key=fetch_trace_key,
            )
        finally:
            self.cleanup()

    # ---------- dry-run 占位 ----------

    @staticmethod
    def _fake_media_item(
        path: Path, media_type: int, *, cover: str | Path | None = None
    ) -> dict[str, Any]:
        size = path.stat().st_size if path.is_file() else 0
        if media_type == PostMediaType.video:
            meta = probe_video(path)
            return build_media_item(
                url="https://finder.video.qq.com/DRYRUN",
                file_size=meta.file_size or size,
                width=meta.width,
                height=meta.height,
                media_type=media_type,
                uuid="dry-run-uuid",
                thumb_url="https://finder.video.qq.com/DRYRUN_THUMB" if cover else "",
                cover_url="https://finder.video.qq.com/DRYRUN_THUMB" if cover else "",
                duration=meta.duration,
            )
        width, height = probe_image(path) if path.is_file() else (0, 0)
        return build_media_item(
            url="https://finder.video.qq.com/DRYRUN",
            file_size=size,
            width=width,
            height=height,
            media_type=media_type,
            uuid="dry-run-uuid",
            thumb_url="https://finder.video.qq.com/DRYRUN_THUMB",
            full_thumb_url="https://finder.video.qq.com/DRYRUN_FULL",
        )


def _report_from_meta(meta: Mapping[str, Any], upload_cost: float = 0.0) -> dict[str, Any]:
    """上传完成后站点写进 ``originState.report`` 的东西。

    来源：媒体组件的 ``handleCanPostChange``（chunk-common ~528076）：

    ```js
    if (e && this.mediaList[0].isVideo) {
      const n = this.mediaList[0].extInfo;
      t = {height: n.height, width: n.width, duration: n.duration,
           fileSize: this.mediaList[0].size, uploadCost: this.mediaList[0].uploadCost};
    }
    emit(updateState, {canPost: e, report: t});
    ```

    而 ``getCreateOrPreviewParams`` 只在 ``report.fileSize`` 真值时才把 ``report``
    写进 payload —— 所以这个字段是**视频专有**的，图片模式不带。
    """
    return {
        "height": meta.get("height", 0),
        "width": meta.get("width", 0),
        "duration": meta.get("duration", 0),
        "fileSize": meta.get("fileSize", 0),
        "uploadCost": upload_cost,
    }
