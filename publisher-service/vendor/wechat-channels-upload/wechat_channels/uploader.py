"""CDN 上传：DFS 分片协议（现代）+ ``snsuploadbig``（老版）。

站点按 ``authData`` 响应里的 ``envInfo.uploadVersion`` 二选一：

- **truthy** → 模块 ``6ab5`` 的 ``uploadService``（本项目实现为主路径）
- falsy → 模块 ``3afc`` 的 ``snsuploadbig``（保留在 :class:`LegacySnsUploader`，只在
  确认账号仍走老链路时用）

两条链路都不经过网关，直连腾讯视频的 CDN 域名，凭证来自
``/helper/helper_upload_params``。

## DFS 分片流程（``docs/PROTOCOL.md`` §4.4）

::

    PUT {cdn}/applyuploaddfs                 {BlockSum, BlockPartLength[]}  -> UploadID
    PUT {cdn}/uploadpartdfs?PartNumber&UploadID&QuickUpload=<块>            -> {TransFlag, ETag, X-Errno}
    PUT {cdn}/applyuploaddfs?UploadID&PartNumberMarker  (确认分片，分页)
    POST {cdn}/completepartuploaddfs?UploadID  {TransFlag, PartInfo[]}      -> DownloadURL

小文件（``size <= 10 MiB``）走 ``PUT {cdn}/simpleuploaddfs`` + ``FormData{file}``。

三个请求头由 :meth:`DfsUploader.build_headers` 生成，其中 ``X-Arguments`` 的字段
顺序与 ``--`` 分隔都对服务端可观察，务必逐字节对齐：

::

    Authorization: <authParams.authKey>
    X-Arguments: apptype=<appType>&filetype=<authParams[cdnFileType]>&weixinnum=<uin>
                 &filekey=<encodeURIComponent(name)>&filesize=<size>&taskid=<uuid>&scene=<scene|0>
    Content-MD5: <md5 of first 5 MiB | "null">

**注意** ``Content-MD5`` 是前 5 MiB 的 md5（不是整个文件），取不到时字面量 ``null``。

## 与前端行为的已知偏差（有意为之）

- 前端把分片上传进度存进 ``localStorage``（``AssistantUploadedInfoStorageKey_<uin>``）
  做断点续传，本库不落盘 —— 每次进程内重传。见 :attr:`DfsUploader.resume_store_enabled`。
- 前端会并发 4 个分片并做 ``Quick`` → ``Normal`` → ``BackUp`` 三级降级；
  本库默认串行 + 重试，降级逻辑保留在 :meth:`DfsUploader._upload_chunks`。
- **``simpleuploaddfs`` 恒失败**（实测，见下），前端没有回退分支，本库有。

## 实测记录（2026-09，真实账号）

用真实登录态跑过完整链路，结论：

- ``applyuploaddfs`` / ``uploadpartdfs`` / ``applyuploaddfs``(confirm) /
  ``completepartuploaddfs`` 四步全部可用，单分片与 6 分片均成功，
  下载回来的文件与本地 **sha256 逐字节一致**。
- ``simpleuploaddfs``（<= 10 MiB 走它）在 ``finderassistancea`` /
  ``finderpre`` / http / https 四种组合下**一律**
  ``HTTP 404 {"X-Errno":-5103015}``。所以 :meth:`upload` 内置了自动回退：
  失败即改用分片链路，并把 :attr:`DfsUploader.single_upload_enabled` 置 ``False``。
- 分片确认接口返回的 ``PartNumber`` 是**字符串**，而本地产生的是数字，
  合并排序时必须归一成 ``int``（否则 ``TypeError``）。
- :attr:`DfsUploader.host` 取 ``envInfo.cdnHost``（本例 ``finderassistancea.video.qq.com``），
  四个端点都通；但 ``uploadpartdfs`` 另会从 ``cdnHostList`` / ``spareCdnHostList`` 随机挑。
"""

from __future__ import annotations

import hashlib
import json
import math
import mimetypes
import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

import requests

from .constants import (
    CDN_REPLACE_FROM,
    CDN_REPLACE_TO,
    CdnFileType,
    DEFAULT_CHUNK_SIZE,
    DEFAULT_CONCURRENT_LIMIT,
    DEFAULT_DFS_HOST,
    MD5_SLICE_SIZE,
    QuickChunkUploadMode,
    SINGLE_FILE_SIZE,
    UploadStrategy,
)
from .errors import LogicError, UploadError

__all__ = [
    "UploadResult",
    "DfsUploader",
    "LegacySnsUploader",
    "md5_of_head",
    "guess_upload_name",
]

ProgressCallback = Callable[[int, float], None]

#: 上传产物的文件名默认值（前端对 canvas 上传写死这两个名字）
CANVAS_JPEG_NAME = "finder_video_img.jpeg"
CANVAS_PNG_NAME = "finder_video_img.png"


def md5_of_head(path: str | Path, size: int = MD5_SLICE_SIZE) -> str:
    """前 ``size`` 字节的 md5（十六进制小写）。前端超时 3s 会退化成空串。"""
    file_path = Path(path)
    limit = min(size, file_path.stat().st_size)
    digest = hashlib.md5()
    with file_path.open("rb") as handle:
        remaining = limit
        while remaining > 0:
            block = handle.read(min(1024 * 1024, remaining))
            if not block:
                break
            digest.update(block)
            remaining -= len(block)
    return digest.hexdigest()


def guess_upload_name(path: str | Path) -> str:
    """``filekey`` 用的文件名。前端直接用 ``File.name``。"""
    return Path(path).name


@dataclass
class UploadResult:
    """上传成功后的产物，与前端 ``uploadEventHandlerCb(success, resp)`` 的 ``resp.data`` 对齐。

    前端后续组装 ``media[]`` 时读的是 ``httpsUrl`` / ``fileSize``。
    """

    https_url: str
    raw: dict[str, Any] = field(default_factory=dict)
    uuid: str = ""
    file_name: str = ""
    file_size: int = 0
    cdn_file_type: str = CdnFileType.video
    md5: str = ""
    uploaded_chunks: int = 0
    strategy: int = UploadStrategy.Quick
    elapsed: float = 0.0

    @property
    def url(self) -> str:
        """别名：``media[]`` 里的字段名。"""
        return self.https_url


class _BaseUploader:
    """两条上传链路共用的：凭证解析、host 选择、``cdnFileType`` 对应的字段取值。"""

    def __init__(self, client: Any) -> None:
        self.client = client
        self.auth_params: dict[str, Any] = {}
        self.host = DEFAULT_DFS_HOST

    # ---------- 凭证 ----------

    def load_credentials(self, refresh: bool = False) -> dict[str, Any]:
        params = self.client.upload_params(refresh=refresh)
        self.auth_params = params
        return params

    def ensure_credentials(self) -> dict[str, Any]:
        if not self.auth_params:
            self.load_credentials()
        return self.auth_params

    def _log(self, message: str) -> None:
        if getattr(self, "verbose", False):
            print(f"[upload] {message}", flush=True)

    def _file_type_value(self, cdn_file_type: str) -> Any:
        """``cdn_file_type`` 是 ``"videoFileType"`` 之类的**键名**，不是数值。"""
        params = self.ensure_credentials()
        value = params.get(cdn_file_type)
        if value is None:
            raise UploadError(
                f"上传凭证里缺少 {cdn_file_type}：{sorted(params)}（helper_upload_params 响应）"
            )
        return value

    # ---------- host ----------

    def apply_env(self, env_info: Mapping[str, Any] | None) -> None:
        """按 ``authData`` 的 ``envInfo`` 设置 host。

        前端 ``index.31d9f171.js``：``N.setHost(i.envInfo.cdnHost)``，
        之后 ``uploadChunkUrl`` 再从 ``cdnHostList`` / ``spareCdnHostList`` 里随机挑。
        """
        env = dict(env_info or {})
        self.env_info = env
        cdn_host = env.get("cdnHost")
        if cdn_host:
            # 前端 setHost 是 `this.HOST = "//" + e`，可能带协议也可能不带
            if str(cdn_host).startswith("//"):
                cdn_host = "https:" + str(cdn_host)
            elif not str(cdn_host).startswith("http"):
                cdn_host = "https://" + str(cdn_host)
            self.host = str(cdn_host).rstrip("/")

    def chunk_host(self, prefer_backup: bool = False) -> str:
        """分片 PUT 的 host：``cdnHostList`` / ``spareCdnHostList`` 里随机，兜底 ``cdnHost``。

        前端写的是 ``"//" + host``（协议相对），所以这里的列表项常常只有主机名；
        本库沿用 ``self.host`` 的协议，避免在 http 调试环境里被强升成 https。
        """
        env = getattr(self, "env_info", {}) or {}
        key = "spareCdnHostList" if prefer_backup else "cdnHostList"
        candidates = [h for h in (env.get(key) or []) if h]
        if not candidates:
            return self.host
        picked = str(candidates[int(time.time() * 1000) % len(candidates)])
        scheme = "https" if self.host.startswith("https") else "http"
        if picked.startswith("//"):
            return f"{scheme}:{picked}"
        if picked.startswith("http://") or picked.startswith("https://"):
            return picked
        return f"{scheme}://{picked}"


class DfsUploader(_BaseUploader):
    """模块 ``6ab5`` 的 ``uploadService``（现代 DFS 链路）。

    :param client: :class:`wechat_channels.client.ChannelsClient`
    :param chunk_size: 覆盖分片大小（前端默认 8 MiB，见 ``constants.DEFAULT_CHUNK_SIZE``）
    :param concurrent_limit: 覆盖并发数（默认 4）
    :param timeout: 单分片 PUT 超时（前端 121s）
    """

    #: 前端 ``ReplaceHost``：把 ``http://wxapp.tc.qq.com`` 换成这个
    REPLACE_HOST = CDN_REPLACE_TO

    def __init__(
        self,
        client: Any,
        *,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        concurrent_limit: int = DEFAULT_CONCURRENT_LIMIT,
        timeout: float = 121.0,
        connect_timeout: float = 30.0,
        session: requests.Session | None = None,
        verbose: bool = False,
    ) -> None:
        super().__init__(client)
        self.verbose = verbose
        self.chunk_size = chunk_size
        self.concurrent_limit = concurrent_limit
        self.timeout = timeout
        self.connect_timeout = connect_timeout
        self.session = session or getattr(client, "session", None) or requests.Session()
        self.env_info: dict[str, Any] = {}
        #: 是否记住"备份 host 可用"（前端写 localStorage ``AssistantUploadBackUpFlag``）
        self.use_backup_host = False
        #: 是否启用断点续传记录（默认关；前端用 localStorage，本库不落盘）
        self.resume_store_enabled = False
        self._resume_store: dict[str, Any] = {}
        #: 是否允许尝试 ``simpleuploaddfs``。实测该端点在真实账号上恒返
        #: ``404 {"X-Errno":-5103015}``，第一次失败后自动置 ``False`` 并改走分片。
        self.single_upload_enabled = True
        #: 失败时是否自动回退到分片链路（默认开，实测必需）
        self.single_upload_fallback = True
        #: 最近一次上传的调试信息，字段名与前端 ``uploadDebugInfo`` 一致
        self.last_debug_info: dict[str, Any] = {}

    # ---------- 请求头 ----------

    def build_headers(
        self,
        *,
        file_name: str,
        file_size: int,
        task_id: str,
        cdn_file_type: str,
        md5: str = "",
    ) -> dict[str, str]:
        params = self.ensure_credentials()
        args = (
            f"apptype={params.get('appType')}"
            f"&filetype={self._file_type_value(cdn_file_type)}"
            f"&weixinnum={params.get('uin')}"
            f"&filekey={requests.utils.quote(str(file_name), safe='')}"
            f"&filesize={file_size}"
            f"&taskid={task_id}"
            f"&scene={params.get('scene') or 0}"
        )
        return {
            "Authorization": str(params.get("authKey", "")),
            "X-Arguments": args,
            "Content-MD5": md5 or "null",
        }

    # ---------- 单请求 ----------

    def _put(
        self,
        url: str,
        *,
        data: Any = None,
        headers: Mapping[str, str] | None = None,
        timeout: float | None = None,
    ) -> requests.Response:
        merged = dict(headers or {})
        try:
            response = self.session.put(
                url,
                data=data,
                headers=merged,
                timeout=timeout or (self.connect_timeout, self.timeout),
            )
        except requests.RequestException as exc:
            raise UploadError(f"PUT {url} 失败：{exc}") from exc
        return response

    @staticmethod
    def _json(response: requests.Response, what: str) -> dict[str, Any]:
        """解析 DFS 响应。

        DFS 的 JSON body 是**扁平**的 —— 分片响应形如
        ``{"X-Errno":0,"TransFlag":"...","ETag":"..."}``，完成响应是
        ``{"DownloadURL":"..."}``（前端读的就是 ``resp.data.DownloadURL``，
        即 axios 的 ``data`` = JSON body）。这里额外兼容被包一层 ``data`` 的形态。
        """
        try:
            payload = response.json()
        except ValueError:
            raise UploadError(
                f"{what} 返回非 JSON（HTTP {response.status_code}）："
                f"{response.text[:300]}"
            ) from None
        if not isinstance(payload, dict):
            raise UploadError(f"{what} 返回了非对象 JSON：{payload!r}")
        inner = payload.get("data")
        if isinstance(inner, dict):
            merged = dict(inner)
            for key, value in payload.items():
                if key != "data":
                    merged.setdefault(key, value)
            return merged
        return payload

    #: 实测该端点的失败特征：HTTP 404 + ``{"X-Errno":-5103015}``
    UNSUPPORTED_ERRNOS = (-5103015,)

    def _is_single_upload_unsupported(self, exc: BaseException) -> bool:
        """判断错误是否表示"这个端点不需要/不支持"，而不是一次偶发失败。

        只有这种才值得永久禁用 + 回退；其它错误应当冒泡，
        否则会把凭证错误、网络问题伪装成上传成功。

        判定看 **结构化字段**（HTTP 状态码 + ``X-Errno``），不要靠 ``str(exc)``
        里搜子串 —— 消息里永远带着 ``X-Errno=`` 字面量，那样等于只在搜 ``404``，
        一个恰好含 "404" 的 500 响应就会把端点误判成不可用。

        优先级：``X-Errno`` 是服务端给出的**领域语义**（"这个端点不支持"），
        以它为准；没有 errno 时才退回用 HTTP 404 作启发式。所以 HTTP 500 +
        errno -5103015 仍算端点不可用，而 HTTP 500 + body 里恰好含 "404" 不算。
        """
        if not isinstance(exc, UploadError):
            return False
        if exc.err_no is not None:
            return exc.err_no in self.UNSUPPORTED_ERRNOS
        return exc.status_code == 404

    # ---------- 流程 ----------

    #: 走 ``simpleuploaddfs`` 的体积上限（前端 ``singleFileSize = 0xa00000``）。
    #: 实测：该端点在本账号上恒返 ``404 {"X-Errno":-5103015}``，
    #: 所以 :meth:`upload` 会在它失败时自动退回分片链路（见 ``single_upload_fallback``）。
    SINGLE_FILE_SIZE = SINGLE_FILE_SIZE

    def upload(
        self,
        path: str | Path,
        *,
        cdn_file_type: str = CdnFileType.video,
        progress: ProgressCallback | None = None,
        file_name: str | None = None,
        chunk_size: int | None = None,
        use_single_upload: bool | None = None,
    ) -> UploadResult:
        """上传一个文件，返回 :class:`UploadResult`。

        :param cdn_file_type: ``CdnFileType.video`` / ``.picture`` / ``.thumb``
        :param progress: ``(percent, debug_info) -> None``，percent 是 0~100
        :param use_single_upload: 强制走/不走 ``simpleuploaddfs``；默认按 10 MiB 阈值
        """
        file_path = Path(path)
        if not file_path.is_file():
            raise UploadError(f"文件不存在：{file_path}")

        file_size = file_path.stat().st_size
        if file_size == 0:
            raise UploadError(f"文件为空：{file_path}")
        name = file_name or guess_upload_name(file_path)
        task_id = str(uuid.uuid4())
        started = time.time()

        self.ensure_credentials()
        # 注意：Content-MD5 取前 5 MiB，不是整文件
        md5 = md5_of_head(file_path)
        headers = self.build_headers(
            file_name=name,
            file_size=file_size,
            task_id=task_id,
            cdn_file_type=cdn_file_type,
            md5=md5,
        )

        chunk_size = chunk_size or self.chunk_size
        chunk_count = max(1, math.ceil(file_size / chunk_size))
        is_big = file_size > self.SINGLE_FILE_SIZE
        if use_single_upload is None:
            use_single_upload = not is_big
            if use_single_upload and not self.single_upload_enabled:
                # 已知该端点在部分账号上恒返 404，直接走分片（见类文档）
                self._log("simpleuploaddfs 已被禁用，直接走分片链路")
                use_single_upload = False

        self.last_debug_info = {
            "cdnFileType": cdn_file_type,
            "fileSize": file_size,
            "fileName": name,
            "progress": 0,
            "strategy": UploadStrategy.Quick,
            "uploadTaskId": "",
            "uploadSpeed": 0,
            "roundTripSpeed": 0,
            "chunkCount": chunk_count,
            "chunkSize": chunk_size,
            "useBackUpHost": self.use_backup_host,
            "reuseUploadType": 0,
            "ConcurrentLimit": self.concurrent_limit,
            "isUsedQuickUpload": False,
            "sceneType": "",
        }

        if use_single_upload:
            try:
                result = self._single_upload(
                    file_path, headers, name, file_size, cdn_file_type, md5
                )
            except (UploadError, LogicError) as exc:
                if not self.single_upload_fallback:
                    raise
                # 实测（2026-09，真实账号）：``simpleuploaddfs`` 恒返
                # ``404 {"X-Errno":-5103015}``，而分片链路完全可用。
                # 前端没有这个回退分支，但服务端行为如此，照做。
                #
                # 只有"端点本身不可用"才永久禁用并回退；其它错误（网络抖动、
                # 凭证错）原样抛出，免得把真问题掩盖成"上传成功"。
                if not self._is_single_upload_unsupported(exc):
                    raise
                self._log(f"simpleuploaddfs 不可用，回退到分片链路（{exc}）")
                self.single_upload_enabled = False
                use_single_upload = False
                # last_debug_info 上面初始化时写的是 strategy=Quick，而这条支路
                # 实际走分片（result.strategy 会是 Normal）。不修正的话上报的
                # 追踪信息和真实链路自相矛盾。
                self.last_debug_info["strategy"] = UploadStrategy.Normal
            else:
                result.uuid = task_id
                result.elapsed = time.time() - started
                # 与分片链路对齐，否则 debug 里缺这个 key（前端 uploadDebugInfo
                # 本身没有它，是我们的扩展字段，两个分支都得给）
                self.last_debug_info["uploadedChunkCount"] = 1
                if progress:
                    progress(100.0, dict(self.last_debug_info, progress=100))
                return result

        upload_id = self._init_upload(headers, chunk_size, chunk_count, file_size)
        self.last_debug_info["uploadTaskId"] = upload_id
        parts, trans_flag, used_quick = self._upload_chunks(
            file_path,
            headers,
            upload_id,
            name,
            file_size,
            cdn_file_type,
            chunk_size,
            chunk_count,
            task_id,
            progress,
        )
        # 前端 handleComplete()：只要用过快传（QuickUpload=1），
        # 完成前必须先 confirmChunks 问一次服务端到底收了哪些分片，
        # 缺失的补传（reUploadMissingChunks）后再 complete。
        if used_quick:
            confirmed = self.confirm_chunks(headers, upload_id)
            by_number = {
                number: part
                for part in confirmed
                if (number := _to_int(part.get("PartNumber"))) is not None
            }
            missing = [
                index
                for index in range(chunk_count)
                if (index + 1) not in by_number
            ]
            if missing:
                self._log(f"confirm 发现缺失分片 {missing}，补传")
                repaired = self._reupload_chunks(
                    file_path, headers, upload_id, missing, chunk_size, file_size
                )
                parts = _merge_parts(parts, confirmed, repaired)
            else:
                parts = _merge_parts(parts, confirmed, [])
        self.last_debug_info["uploadedChunkCount"] = len(parts)
        # 与 result.strategy 同源：前端 uploadDebugInfo 的 strategy 是上传器自己的
        # 策略（Quick/Normal/BackUp），这里是"有没有用快传"的粗粒度近似。
        self.last_debug_info["strategy"] = (
            UploadStrategy.Quick if used_quick else UploadStrategy.Normal
        )
        data = self._complete_upload(headers, upload_id, parts, trans_flag)
        https_url = self._to_https(data)
        result = UploadResult(
            https_url=https_url,
            raw=data,
            uuid=task_id,
            file_name=name,
            file_size=file_size,
            cdn_file_type=cdn_file_type,
            md5=md5,
            uploaded_chunks=len(parts),
            strategy=UploadStrategy.Quick if used_quick else UploadStrategy.Normal,
            elapsed=time.time() - started,
        )
        if progress:
            progress(100.0, dict(self.last_debug_info, progress=100))
        return result

    def _single_upload(
        self,
        file_path: Path,
        headers: Mapping[str, str],
        name: str,
        file_size: int,
        cdn_file_type: str,
        md5: str,
    ) -> UploadResult:
        """``PUT {cdn}/simpleuploaddfs`` + ``FormData{file}``（<= 10 MiB）。"""
        url = f"{self.host}/simpleuploaddfs"
        mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
        with file_path.open("rb") as handle:
            files = {"file": (name, handle, mime)}
            try:
                response = self.session.put(
                    url,
                    files=files,
                    headers=dict(headers),
                    timeout=(self.connect_timeout, 30.0),
                )
            except requests.RequestException as exc:
                raise UploadError(f"PUT {url} 失败：{exc}") from exc
        data = self._json(response, "simpleuploaddfs")
        err_no = data.get("X-Errno")
        if not data.get("DownloadURL") and not data.get("httpsUrl"):
            # 实测该端点恒返 ``HTTP 404 {"X-Errno":-5103015}``。
            # 状态码与 errno 走结构化字段，别让判定逻辑去解析消息文本。
            raise UploadError(
                f"simpleuploaddfs 返回 HTTP {response.status_code}，"
                f"X-Errno={err_no}，body={json.dumps(data, ensure_ascii=False)[:200]}",
                status_code=response.status_code,
                err_no=err_no if isinstance(err_no, int) else None,
            )
        return UploadResult(
            https_url=self._to_https(data),
            raw=data,
            file_name=name,
            file_size=file_size,
            cdn_file_type=cdn_file_type,
            md5=md5,
            uploaded_chunks=1,
            strategy=UploadStrategy.Quick,
        )

    def _init_upload(
        self, headers: Mapping[str, str], chunk_size: int, chunk_count: int, file_size: int
    ) -> str:
        """``PUT {cdn}/applyuploaddfs``，拿 ``UploadID``。"""
        block_part_length = [
            min((index + 1) * chunk_size, file_size) for index in range(chunk_count)
        ]
        url = f"{self.host}/applyuploaddfs"
        body = json.dumps(
            {"BlockSum": chunk_count, "BlockPartLength": block_part_length},
            separators=(",", ":"),
        )
        response = self._put(url, data=body, headers={**headers, "Content-Type": "application/json"})
        data = self._json(response, "applyuploaddfs")
        upload_id = data.get("UploadID")
        if not upload_id:
            raise LogicError(
                f'Error_No_UploadId;{data.get("uuid", "")};'
                f"{json.dumps(data, ensure_ascii=False)[:300]}",
                "upload",
            )
        return str(upload_id)

    def _quick_mode(self, index: int, chunk_count: int, concurrent: int) -> bool:
        """``shouldUseQuickChunkUpload``：首块与最后 ``ConcurrentLimit`` 块不用快传。"""
        return not (index == 0 or index > chunk_count - concurrent)

    def _upload_chunks(
        self,
        file_path: Path,
        headers: Mapping[str, str],
        upload_id: str,
        name: str,
        file_size: int,
        cdn_file_type: str,
        chunk_size: int,
        chunk_count: int,
        task_id: str,
        progress: ProgressCallback | None,
    ) -> tuple[list[dict[str, Any]], str, bool]:
        """串行上传所有分片。返回 ``(PartInfo[], TransFlag, 是否用过快传)``。

        失败处理沿用前端的阶梯（略有简化）：
        ``connect timeout`` 且重试次数 <= 4 → 重试同一块；
        快传失败且是大文件 → 降到 ``Normal``；再失败 → 换备份 host 重来。
        """
        parts: dict[int, dict[str, Any]] = {}
        trans_flag = ""
        used_quick = False
        strategy = UploadStrategy.Quick
        prefer_backup = self.use_backup_host
        retries = 0
        hosts_tried_backup = False

        index = 0
        while index < chunk_count:
            offset = index * chunk_size
            end = min(offset + chunk_size, file_size)
            with file_path.open("rb") as handle:
                handle.seek(offset)
                blob = handle.read(end - offset)
            if not blob:
                raise UploadError(f"读取分片 {index} 失败（offset={offset}）")

            quick = strategy == UploadStrategy.Quick and self._quick_mode(
                index, chunk_count, self.concurrent_limit
            )
            if quick:
                used_quick = True
            url = self._chunk_url(index, upload_id, quick, prefer_backup)
            chunk_headers = {**headers, "Content-Type": "application/octet-stream"}
            started = time.time()
            try:
                response = self._put(
                    url, data=blob, headers=chunk_headers, timeout=self.timeout
                )
                inner = self._json(response, "uploadpartdfs")
                err_no = inner.get("X-Errno")
                # 前端判定：快传模式（QuickUpload=1）不校验 TransFlag/X-Errno；
                # 普通模式要求 TransFlag 真值 **且** X-Errno === 0。
                if not quick and not inner.get("TransFlag"):
                    raise UploadError(
                        f"分片 {index} 未被接受：{json.dumps(inner, ensure_ascii=False)[:200]}"
                    )
                if err_no is not None and err_no != 0:
                    raise UploadError(
                        f"分片 {index} 返回 X-Errno={err_no}："
                        f"{json.dumps(inner, ensure_ascii=False)[:200]}"
                    )
            except UploadError as exc:
                message = str(exc)
                if retries <= 4 and "connect timeout" in message:
                    retries += 1
                    continue
                if strategy == UploadStrategy.Quick and file_size > self.SINGLE_FILE_SIZE:
                    strategy = UploadStrategy.Normal
                    retries = 0
                    used_quick = True
                    continue
                if strategy == UploadStrategy.Normal and not hosts_tried_backup:
                    strategy = UploadStrategy.BackUp
                    prefer_backup = True
                    hosts_tried_backup = True
                    retries = 0
                    parts.clear()
                    used_quick = True
                    continue
                raise

            if inner.get("TransFlag"):
                trans_flag = str(inner["TransFlag"])
            etag = inner.get("ETag")
            if etag:
                parts[index] = {"PartNumber": index + 1, "ETag": etag}
            index += 1
            cost = time.time() - started
            percent = len(parts) / chunk_count * 100
            self.last_debug_info.update(
                {
                    "progress": percent,
                    "strategy": strategy,
                    "isUsedQuickUpload": used_quick,
                    "useBackUpHost": prefer_backup,
                    "roundTripSpeed": (
                        chunk_size / 1024 / cost if cost > 0 else 0
                    ),
                }
            )
            if progress:
                progress(percent, dict(self.last_debug_info))

        return (
            [parts[key] for key in sorted(parts)],
            trans_flag,
            used_quick,
        )

    def _reupload_chunks(
        self,
        file_path: Path,
        headers: Mapping[str, str],
        upload_id: str,
        indexes: Sequence[int],
        chunk_size: int,
        file_size: int,
    ) -> list[dict[str, Any]]:
        """``reUploadMissingChunks``：补传 confirm 报缺失的分片（不带快传参数）。"""
        repaired: list[dict[str, Any]] = []
        for index in indexes:
            offset = index * chunk_size
            end = min(offset + chunk_size, file_size)
            with file_path.open("rb") as handle:
                handle.seek(offset)
                blob = handle.read(end - offset)
            url = self._chunk_url(index, upload_id, False, self.use_backup_host)
            response = self._put(
                url,
                data=blob,
                headers={**headers, "Content-Type": "application/octet-stream"},
                timeout=self.timeout,
            )
            inner = self._json(response, "uploadpartdfs")
            if inner.get("X-Errno") not in (None, 0):
                raise UploadError(
                    f"补传分片 {index} 失败：X-Errno={inner.get('X-Errno')} "
                    f"{json.dumps(inner, ensure_ascii=False)[:200]}"
                )
            repaired.append(
                {"PartNumber": index + 1, "ETag": inner.get("ETag") or ""}
            )
        return repaired

    def _chunk_url(
        self, index: int, upload_id: str, quick: bool, prefer_backup: bool
    ) -> str:
        host = self.chunk_host(prefer_backup)
        mode = QuickChunkUploadMode.Quick if quick else QuickChunkUploadMode.Normal
        return (
            f"{host}/uploadpartdfs?PartNumber={index + 1}"
            f"&UploadID={upload_id}&QuickUpload={mode}"
        )

    def confirm_chunks(
        self, headers: Mapping[str, str], upload_id: str
    ) -> list[dict[str, Any]]:
        """``PUT {cdn}/applyuploaddfs?UploadID&PartNumberMarker``，分页返回已收分片。"""
        marker: Any = "1"
        collected: list[dict[str, Any]] = []
        while True:
            url = (
                f"{self.host}/applyuploaddfs?UploadID={upload_id}"
                f"&PartNumberMarker={marker}"
            )
            response = self._put(
                url,
                data=json.dumps({}, separators=(",", ":")),
                headers={**headers, "Content-Type": "application/json"},
            )
            payload = self._json(response, "confirmChunks")
            result = payload.get("ListPartsResult")
            if not result:
                raise LogicError(
                    f"confirm upload fail: {json.dumps(payload, ensure_ascii=False)[:200]}",
                    "upload",
                )
            collected.extend(result.get("Part") or [])
            if result.get("IsTruncated") != "true":
                break
            marker = result.get("NextPartNumberMarker")
        # 前端按 PartNumber 去重，保留首个。
        # key 归一成 int：服务端返回的是字符串 "1"，不归一的话 "1" 与 1 会被
        # 当成两个不同的分片，去重失效（现在 _merge_parts 兜住了，但不能依赖它）。
        seen: set[int] = set()
        unique: list[dict[str, Any]] = []
        for part in collected:
            key = _to_int(part.get("PartNumber"))
            if key is None or key in seen:
                continue
            seen.add(key)
            unique.append({**part, "PartNumber": key})
        return unique

    def _complete_upload(
        self,
        headers: Mapping[str, str],
        upload_id: str,
        parts: Sequence[Mapping[str, Any]],
        trans_flag: str,
    ) -> dict[str, Any]:
        """``POST {cdn}/completepartuploaddfs``，拿 ``DownloadURL``。"""
        url = f"{self.host}/completepartuploaddfs?UploadID={upload_id}"
        body = json.dumps(
            {
                "TransFlag": trans_flag,
                # key 用 _to_int 归一：直接比较 "1" 与 1 会抛 TypeError
                "PartInfo": sorted(
                    (dict(part) for part in parts),
                    key=lambda p: _to_int(p.get("PartNumber")) or 0,
                ),
            },
            separators=(",", ":"),
        )
        response = self.session.post(
            url,
            data=body,
            headers={**headers, "Content-Type": "application/json"},
            timeout=(self.connect_timeout, self.timeout),
        )
        data = self._json(response, "completepartuploaddfs")
        if not data.get("DownloadURL") and not data.get("httpsUrl"):
            raise UploadError(
                f"completepartuploaddfs 未返回 DownloadURL："
                f"{json.dumps(data, ensure_ascii=False)[:300]}"
            )
        return data

    @classmethod
    def _to_https(cls, data: Mapping[str, Any]) -> str:
        """前端：``httpsUrl = DownloadURL.replace("http://wxapp.tc.qq.com", ReplaceHost)``。"""
        url = str(data.get("DownloadURL") or data.get("httpsUrl") or "")
        if not url:
            raise UploadError(f"上传响应里没有 URL：{sorted(data)}")
        return url.replace(CDN_REPLACE_FROM, cls.REPLACE_HOST)


def _merge_parts(*groups: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """按 ``PartNumber`` 合并多组分片信息并升序返回（前端 ``finishUpload`` 也排序）。

    ⚠️ ``PartNumber`` 一定要归一成 ``int``：本地产生的分片是数字，而
    ``applyuploaddfs`` 确认接口返回的是**字符串**（``"1"``）。两者混在一起
    ``sorted()`` 会抛 ``TypeError: '<' not supported between 'str' and 'int'``。
    这是实测踩到的坑（mock 服务端返回数字，所以离线测试覆盖不到）。
    """
    merged: dict[int, dict[str, Any]] = {}
    for group in groups:
        for part in group or []:
            number = _to_int(part.get("PartNumber"))
            if number:
                merged[number] = {**part, "PartNumber": number}
    return [merged[key] for key in sorted(merged)]


def _to_int(value: Any) -> int | None:
    """``PartNumber`` 这类字段可能是 ``int`` 也可能是 ``str``，统一归一。

    返回 ``None`` 表示"不是个有效编号"，而不是 ``0`` —— 免得把坏数据当成 0 号分片。
    """
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


class LegacySnsUploader(_BaseUploader):
    """模块 ``3afc`` 的 ``snsuploadbig``（老链路）。

    仅当 ``envInfo.uploadVersion`` 为空时站点才用它。保留实现是为了能在老账号上
    对照验证 —— 默认不要走这条。

    要点：``POST //{host}/snsuploadbig``，multipart 字段顺序固定：
    ``ver, seq, weixinnum, apptype, filetype, authkey, hasthumb, filekey,
    totalsize, fileuuid, rangestart, rangeend, blockmd5, filedata, forcetranscode``。
    ``chunkSize = 512 KiB``，每 3 个分片一批。
    """

    REPLACE_HOST = CDN_REPLACE_TO
    #: 老链路默认 host（不带协议，前端是 ``"finder.video.qq.com"``）
    DEFAULT_HOST = "finder.video.qq.com"
    CHUNK_SIZE = 524288
    SINGLE_PACK_LIMIT = 3

    def __init__(
        self,
        client: Any,
        *,
        chunk_size: int = CHUNK_SIZE,
        timeout: float = 30.0,
        session: requests.Session | None = None,
    ) -> None:
        super().__init__(client)
        self.host = self.DEFAULT_HOST
        self.chunk_size = chunk_size
        self.timeout = timeout
        self.session = session or getattr(client, "session", None) or requests.Session()

    @property
    def url(self) -> str:
        return f"https://{self.host}/snsuploadbig"

    def upload(
        self,
        path: str | Path,
        *,
        cdn_file_type: str = CdnFileType.picture,
        progress: ProgressCallback | None = None,
        file_name: str | None = None,
    ) -> UploadResult:
        file_path = Path(path)
        if not file_path.is_file():
            raise UploadError(f"文件不存在：{file_path}")
        self.ensure_credentials()
        name = file_name or guess_upload_name(file_path)
        file_size = file_path.stat().st_size
        task_id = str(uuid.uuid4())
        chunk_count = max(1, math.ceil(file_size / self.chunk_size))
        started = time.time()
        last: dict[str, Any] = {}

        for index in range(chunk_count):
            offset = index * self.chunk_size
            end = min(offset + self.chunk_size, file_size)
            with file_path.open("rb") as handle:
                handle.seek(offset)
                blob = handle.read(end - offset)
            md5 = hashlib.md5(blob).hexdigest()
            last = self._upload_chunk(
                blob, file_path, name, file_size, task_id, offset, end - 1, md5, cdn_file_type
            )
            if progress:
                progress((index + 1) / chunk_count * 100, {"chunkIndex": index})

        url = str(last.get("fileurl") or last.get("httpsUrl") or "")
        if not url:
            raise UploadError(f"snsuploadbig 响应里没有 fileurl：{sorted(last)}")
        return UploadResult(
            https_url=url.replace(CDN_REPLACE_FROM, self.REPLACE_HOST),
            raw=last,
            uuid=task_id,
            file_name=name,
            file_size=file_size,
            cdn_file_type=cdn_file_type,
            uploaded_chunks=chunk_count,
            elapsed=time.time() - started,
        )

    def _upload_chunk(
        self,
        blob: bytes,
        file_path: Path,
        name: str,
        file_size: int,
        task_id: str,
        chunk_start: int,
        chunk_end: int,
        md5: str,
        cdn_file_type: str,
    ) -> dict[str, Any]:
        params = self.ensure_credentials()
        fields = [
            ("ver", "1"),
            ("seq", f"{time.time()}{os.urandom(1).hex()}"),
            ("weixinnum", str(params.get("uin"))),
            ("apptype", str(params.get("appType"))),
            ("filetype", str(self._file_type_value(cdn_file_type))),
            ("authkey", str(params.get("authKey"))),
            ("hasthumb", "0"),
            ("filekey", name),
            ("totalsize", str(file_size)),
            ("fileuuid", task_id),
            ("rangestart", str(chunk_start)),
            ("rangeend", str(chunk_end)),
            ("blockmd5", md5),
            ("filedata", ("blob", blob, "application/octet-stream")),
            ("forcetranscode", "0"),
        ]
        try:
            response = self.session.post(
                self.url, files=fields, timeout=(10.0, self.timeout)
            )
        except requests.RequestException as exc:
            raise UploadError(f"POST {self.url} 失败：{exc}") from exc
        try:
            payload = response.json()
        except ValueError:
            raise UploadError(
                f"snsuploadbig 返回非 JSON（HTTP {response.status_code}）："
                f"{response.text[:300]}"
            ) from None
        retcode = payload.get("retcode")
        if retcode:
            raise UploadError(
                f"snsuploadbig retcode={retcode} serverip={payload.get('serverip')} "
                f"range={chunk_start}-{chunk_end}"
            )
        if payload.get("uploadfinish") and payload.get("fileurl"):
            payload["httpsUrl"] = str(payload["fileurl"]).replace(
                CDN_REPLACE_FROM, self.REPLACE_HOST
            )
        return payload
