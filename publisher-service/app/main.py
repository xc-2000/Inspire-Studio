from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field, field_validator

from app.qr_login import qr_login_manager
from app.account_check import check_wechat_account
from app import toutiao

Platform = Literal["douyin", "xiaohongshu", "wechat_channels", "toutiao"]
MediaType = Literal["video", "images"]
PublishMode = Literal["dry_run", "draft", "publish"]

ROOT = Path(__file__).resolve().parents[1]
XHS_ROOT = ROOT / "vendor" / "xhs-upload"
WECHAT_ROOT = ROOT / "vendor" / "wechat-channels-upload"
DOUYIN_BIN = os.getenv("DOUYIN_UPLOADER_BIN", "douyin-uploader")
INTERNAL_TOKEN = os.getenv("PUBLISHER_INTERNAL_TOKEN", "")
MAX_DOWNLOAD_BYTES = int(os.getenv("PUBLISHER_MAX_DOWNLOAD_BYTES", str(4 * 1024 * 1024 * 1024)))
COMMAND_TIMEOUT = int(os.getenv("PUBLISHER_COMMAND_TIMEOUT_SECONDS", "7200"))


class AccountCheckRequest(BaseModel):
    platform: Platform
    credentials: str = Field(min_length=1, max_length=2_000_000)


class QrLoginStartRequest(BaseModel):
    platform: Platform


class PublishRequest(AccountCheckRequest):
    media_type: MediaType
    title: str = Field(default="", max_length=200)
    description: str = Field(default="", max_length=5000)
    media_urls: list[str] = Field(min_length=1, max_length=20)
    cover_url: str | None = None
    topics: list[str] = Field(default_factory=list, max_length=20)
    publish_mode: PublishMode = "dry_run"
    visibility: Literal["public", "private", "fans"] = "public"
    allow_download: bool = False
    transcode: bool = False

    @field_validator("media_urls")
    @classmethod
    def validate_media_urls(cls, values: list[str]) -> list[str]:
        for value in values:
            parsed = urlparse(value)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                raise ValueError("素材地址必须是可访问的 HTTP(S) URL")
        return values


async def require_internal_token(x_internal_token: str = Header(default="")) -> None:
    if not INTERNAL_TOKEN or x_internal_token != INTERNAL_TOKEN:
        raise HTTPException(status_code=401, detail="内部服务凭据无效")


@asynccontextmanager
async def lifespan(_: FastAPI):
    if not INTERNAL_TOKEN:
        raise RuntimeError("PUBLISHER_INTERNAL_TOKEN 未配置")
    try:
        yield
    finally:
        await qr_login_manager.close_all()


app = FastAPI(title="Inspire Studio Publisher", version="1.0.0", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, object]:
    return {"status": "ok", "platforms": ["douyin", "xiaohongshu", "wechat_channels", "toutiao"]}


@app.post("/accounts/check", dependencies=[Depends(require_internal_token)])
async def check_account(request: AccountCheckRequest) -> dict[str, object]:
    if request.platform == "toutiao":
        try:
            return await asyncio.to_thread(toutiao.check_account, request.credentials)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=toutiao.safe_error(exc)) from None
    with tempfile.TemporaryDirectory(prefix="publisher-account-") as directory:
        cookie_path = Path(directory) / "credentials.txt"
        write_credentials(request.platform, request.credentials, cookie_path)
        if request.platform == "wechat_channels":
            return await asyncio.to_thread(check_wechat_account, cookie_path)
        command, cwd = account_check_command(request.platform, cookie_path)
        result = await run_command(command, cwd)
        return {"ok": True, "message": account_success_message(request.platform), "details": result}


@app.post("/accounts/qr/start", dependencies=[Depends(require_internal_token)])
async def start_qr_login(request: QrLoginStartRequest) -> dict[str, object]:
    try:
        return await qr_login_manager.start(request.platform)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"生成登录二维码失败：{str(exc)[:500]}") from None


@app.get("/accounts/qr/{session_id}", dependencies=[Depends(require_internal_token)])
async def qr_login_status(session_id: str) -> dict[str, object]:
    try:
        return await qr_login_manager.status(session_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc).strip("'")) from None


@app.delete("/accounts/qr/{session_id}", dependencies=[Depends(require_internal_token)])
async def cancel_qr_login(session_id: str) -> dict[str, object]:
    await qr_login_manager.cancel(session_id)
    return {"ok": True}


@app.post("/accounts/qr/{session_id}/action", dependencies=[Depends(require_internal_token)])
async def qr_verification_action(session_id: str, action: dict) -> dict[str, bool]:
    try:
        await qr_login_manager.verification_action(session_id, action)
        return {"ok": True}
    except KeyError:
        raise HTTPException(status_code=404, detail="扫码会话不存在或已过期") from None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)[:200]) from None
    except TypeError:
        raise HTTPException(status_code=400, detail="当前验证操作无效，请刷新登录状态") from None


@app.post("/publish", dependencies=[Depends(require_internal_token)])
async def publish(request: PublishRequest) -> dict[str, object]:
    validate_platform_mode(request)
    if request.platform == "toutiao" and request.publish_mode == "dry_run":
        return {"ok": True, "dryRun": True, "message": "头条参数检查完成，未上传或发布作品"}
    if request.platform == "douyin" and request.publish_mode == "dry_run":
        return {
            "ok": True,
            "dryRun": True,
            "message": "抖音试运行已完成参数检查；为避免产生真实上传流量，未调用平台接口。",
            "mediaCount": len(request.media_urls),
        }

    with tempfile.TemporaryDirectory(prefix="publisher-task-") as directory:
        task_dir = Path(directory)
        cookie_path = task_dir / "credentials.json"
        write_credentials(request.platform, request.credentials, cookie_path)
        media_paths = await download_many(request.media_urls, task_dir / "media")
        cover_path = await download_one(request.cover_url, task_dir / "cover", "cover") if request.cover_url else None
        if request.platform == "toutiao":
            try:
                result = await asyncio.to_thread(toutiao.publish_media, request, media_paths, cover_path, task_dir)
                return {**result, "dryRun": False, "draft": request.publish_mode == "draft", "message": publish_success_message(request)}
            except Exception as exc:
                raise HTTPException(status_code=502, detail=toutiao.safe_error(exc)) from None
        command, cwd = publish_command(request, cookie_path, media_paths, cover_path)
        result = await run_command(command, cwd)
        return {
            "ok": True,
            "dryRun": request.publish_mode == "dry_run",
            "draft": request.publish_mode == "draft",
            "message": publish_success_message(request),
            "details": result,
        }


def validate_platform_mode(request: PublishRequest) -> None:
    if request.media_type == "video" and len(request.media_urls) != 1:
        raise HTTPException(status_code=422, detail="视频发布只能选择一个视频")
    if request.platform not in {"wechat_channels", "toutiao"} and request.publish_mode == "draft":
        raise HTTPException(status_code=422, detail="当前平台不支持保存草稿")
    if request.platform == "xiaohongshu" and not request.title.strip():
        raise HTTPException(status_code=422, detail="小红书发布必须填写标题")
    if request.platform == "wechat_channels" and request.media_type == "video" and not request.cover_url:
        raise HTTPException(status_code=422, detail="视频号视频必须设置封面")
    if request.platform == "toutiao":
        if not 5 <= len(request.title.strip()) <= 30:
            raise HTTPException(status_code=422, detail="头条标题需填写5至30个字")
        if request.visibility != "public":
            raise HTTPException(status_code=422, detail="头条暂只支持公开发布，未完成的内容可保存草稿")
        if len(request.topics) > 5:
            raise HTTPException(status_code=422, detail="头条最多支持5个话题")
        if request.media_type == "video" and (len(request.description) > 200 or request.cover_url):
            raise HTTPException(status_code=422, detail="头条视频简介最多200字，封面由平台自动提取")


def write_credentials(platform: Platform, raw: str, target: Path) -> None:
    value = raw.strip()
    if platform == "douyin":
        target.write_text(value, encoding="utf-8")
        return
    try:
        document = json.loads(value)
    except json.JSONDecodeError:
        document = parse_cookie_header(value)
    if not isinstance(document, (dict, list)):
        raise HTTPException(status_code=422, detail="Cookie 必须是 JSON 或 k=v; k2=v2 格式")
    if platform == "xiaohongshu" and isinstance(document, dict) and isinstance(document.get("cookies"), dict):
        document = document["cookies"]
    target.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")


def parse_cookie_header(raw: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for item in re.split(r"[;\n]+", raw):
        if "=" not in item:
            continue
        key, value = item.strip().split("=", 1)
        if key:
            result[key] = value
    if not result:
        raise HTTPException(status_code=422, detail="没有识别到 Cookie 字段")
    return result


def account_check_command(platform: Platform, cookie_path: Path) -> tuple[list[str], Path | None]:
    if platform == "douyin":
        return [DOUYIN_BIN, "login-check", "--cookie", str(cookie_path)], None
    root = XHS_ROOT if platform == "xiaohongshu" else WECHAT_ROOT
    command = ["python", str(root / "scripts" / "login_check.py"), "--cookies", str(cookie_path)]
    return command, root


def publish_command(request: PublishRequest, cookie_path: Path, media_paths: list[Path], cover_path: Path | None) -> tuple[list[str], Path | None]:
    if request.platform == "douyin":
        command = [DOUYIN_BIN, "publish-video" if request.media_type == "video" else "publish-images", "--cookie", str(cookie_path)]
        command += ["--file", str(media_paths[0]) if request.media_type == "video" else ",".join(map(str, media_paths))]
        command += ["--text", with_topics(request.description, request.topics), "--visibility", request.visibility]
        if request.media_type == "video":
            command += ["--title", request.title]
            if request.allow_download:
                command.append("--allow-download")
        return command, None

    root = XHS_ROOT if request.platform == "xiaohongshu" else WECHAT_ROOT
    script = root / "scripts" / ("publish_video.py" if request.media_type == "video" else "publish_image.py")
    command = ["python", str(script), "--cookies", str(cookie_path)]
    if request.media_type == "video":
        command += ["--video", str(media_paths[0])]
        if cover_path:
            command += ["--cover", str(cover_path)]
    else:
        command += ["--images", *map(str, media_paths)]
    command += ["--desc", request.description]
    if request.media_type == "images" or request.platform == "xiaohongshu":
        command += ["--title", request.title]
    for topic in request.topics:
        command += ["--topic", topic]
    if request.visibility == "private" and request.platform == "xiaohongshu":
        command.append("--private")
    if request.transcode and request.platform == "xiaohongshu" and request.media_type == "video":
        command.append("--transcode")
    if request.publish_mode == "dry_run":
        command.append("--dry-run")
    if request.publish_mode == "publish" and request.platform == "wechat_channels":
        command += ["--publish", "--yes"]
    return command, root


async def download_many(urls: list[str], directory: Path) -> list[Path]:
    directory.mkdir(parents=True, exist_ok=True)
    result: list[Path] = []
    async with httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(30, read=900)) as client:
        for index, url in enumerate(urls):
            result.append(await stream_download(client, url, directory / f"media-{index + 1}{url_suffix(url)}"))
    return result


async def download_one(url: str, directory: Path, name: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(30, read=900)) as client:
        return await stream_download(client, url, directory / f"{name}{url_suffix(url)}")


async def stream_download(client: httpx.AsyncClient, url: str, target: Path) -> Path:
    total = 0
    async with client.stream("GET", url) as response:
        response.raise_for_status()
        declared = int(response.headers.get("content-length", "0") or "0")
        if declared > MAX_DOWNLOAD_BYTES:
            raise HTTPException(status_code=422, detail="素材文件超过发布服务大小限制")
        with target.open("wb") as handle:
            async for chunk in response.aiter_bytes(1024 * 1024):
                total += len(chunk)
                if total > MAX_DOWNLOAD_BYTES:
                    raise HTTPException(status_code=422, detail="素材文件超过发布服务大小限制")
                handle.write(chunk)
    if total == 0:
        raise HTTPException(status_code=422, detail="素材文件为空")
    return target


def url_suffix(url: str) -> str:
    suffix = Path(urlparse(url).path).suffix.lower()
    return suffix if re.fullmatch(r"\.[a-z0-9]{1,8}", suffix) else ".bin"


async def run_command(command: list[str], cwd: Path | None) -> str:
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=str(cwd) if cwd else None,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        output, _ = await asyncio.wait_for(process.communicate(), timeout=COMMAND_TIMEOUT)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise HTTPException(status_code=504, detail="平台处理超时") from None
    text = output.decode("utf-8", errors="replace").strip()
    safe_text = redact_output(text)
    if process.returncode != 0:
        raise HTTPException(status_code=502, detail=publish_error_message(safe_text))
    return safe_text[-6000:]


def publish_error_message(value: str) -> str:
    if "HTTP 403" in value and "aweme/create" in value:
        return "视频已上传，但抖音拒绝创建作品（HTTP 403）。请在抖音创作者中心检查账号状态与平台提示，稍后再发布。"
    match = re.search(r'status_msg="([^"\n]+)"', value)
    if match:
        return "平台拒绝发布：" + match.group(1)[:200]
    errors = [line for line in value.splitlines() if line.startswith(("错误:", "错误：", "Error:", "ERROR"))]
    return errors[-1][:500] if errors else "平台执行失败，请检查账号登录状态及素材是否符合平台要求。"


def redact_output(value: str) -> str:
    value = re.sub(r"(?i)(sessionid|sid_guard|web_session|a1|ttwid|token)(\s*[=:]\s*)[^\s;,]+", r"\1\2***", value)
    value = re.sub(r"/tmp/publisher-[^\s]+", "<temporary-file>", value)
    return value


def with_topics(description: str, topics: list[str]) -> str:
    suffix = " ".join(f"#{topic.lstrip('#')}" for topic in topics if topic.strip())
    return " ".join(part for part in [description.strip(), suffix] if part)


def account_success_message(platform: Platform) -> str:
    return {"douyin": "抖音登录态可用", "xiaohongshu": "小红书登录态可用", "wechat_channels": "视频号登录态可用", "toutiao": "头条登录态可用"}[platform]


def publish_success_message(request: PublishRequest) -> str:
    action = {"dry_run": "试运行完成", "draft": "草稿已保存", "publish": "发布请求已完成"}[request.publish_mode]
    platform = {"douyin": "抖音", "xiaohongshu": "小红书", "wechat_channels": "微信视频号", "toutiao": "今日头条"}[request.platform]
    return f"{platform}{action}"
