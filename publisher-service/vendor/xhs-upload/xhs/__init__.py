"""xhs-upload：小红书（创作服务平台）协议发布库。

不依赖浏览器自动化，纯 HTTP 协议完成：

1. 取上传许可（``/api/media/v1/upload/creator/permit``）
2. 上传素材到小红书 ROS(COS)（腾讯云 COS v5 签名，单次 PUT / 分片上传）
3. （视频）生成 videoId 并轮询转码
4. ``POST /web_api/sns/v2/note`` 发布图文 / 视频 / 音频

快速开始::

    from xhs import XhsClient, Publisher, Login

    client = XhsClient(cookie_path="cookies.json")
    login = Login(client)
    login.qr_login(on_qr=lambda qr: print(qr.url))   # 或用 login.import_cookies(...)
    client.cookies.save("cookies.json")

    publisher = Publisher(client, verbose=True)
    result = publisher.publish_images(["/path/a.jpg"], title="标题", desc="正文")
    print(result.note_id)
"""

from __future__ import annotations

from .client import (
    CREATOR,
    CREATOR_ORIGIN,
    CREATOR_REFERER,
    EDITH,
    ENDPOINTS,
    WWW,
    ApiError,
    CookieJar,
    XhsClient,
)
from .cos import (
    DEFAULT_SLICE_SIZE,
    IMAGE_SINGLE_SLICE_SIZE,
    CosCredentials,
    CosUploadError,
    CosUploadResult,
    CosUploader,
    build_authorization,
    cam_safe_url_encode,
)
from .login import CODE_STATUS, Login, QrCode, SessionExpired
from .payload import (
    HASH_TAG_TYPE,
    HASH_TAG_TYPES,
    NOTE_TYPE,
    build_common,
    build_cover,
    build_image_entry,
    build_hash_tag,
    build_image_info,
    build_video_info,
    to_post_note_payload,
    to_snake_case,
)
from .publish import NoteType, Publisher, PublishResult
from .uploader import Uploader, UploadError, TranscodeResult, guess_mime_type, slice_policy

__version__ = "0.1.0"

__all__ = [
    "__version__",
    # client
    "XhsClient",
    "CookieJar",
    "ApiError",
    "EDITH",
    "WWW",
    "CREATOR",
    "CREATOR_REFERER",
    "CREATOR_ORIGIN",
    "ENDPOINTS",
    # cos
    "CosCredentials",
    "CosUploader",
    "CosUploadResult",
    "CosUploadError",
    "build_authorization",
    "cam_safe_url_encode",
    "DEFAULT_SLICE_SIZE",
    "IMAGE_SINGLE_SLICE_SIZE",
    # uploader
    "Uploader",
    "UploadError",
    "TranscodeResult",
    "slice_policy",
    "guess_mime_type",
    # payload
    "NOTE_TYPE",
    "HASH_TAG_TYPE",
    "HASH_TAG_TYPES",
    "build_hash_tag",
    "to_snake_case",
    "to_post_note_payload",
    "build_common",
    "build_cover",
    "build_image_entry",
    "build_image_info",
    "build_video_info",
    # publish
    "Publisher",
    "PublishResult",
    "NoteType",
    # login
    "Login",
    "QrCode",
    "SessionExpired",
    "CODE_STATUS",
]
