"""wechat-channels-upload —— 视频号助手（channels.weixin.qq.com）协议上传。

纯 HTTP，不依赖浏览器自动化。协议从 ``finder-helper-web`` 前端 bundle 反推，
证据与推导过程见 ``docs/PROTOCOL.md`` 与 ``_recon/``。

快速上手::

    from wechat_channels import ChannelsClient, Publisher

    client = ChannelsClient(cookie_path="cookies.json", finder_uin="...", finder_username="...")
    pub = Publisher(client, verbose=True)
    result = pub.publish_video("demo.mp4", description="hello #测试", publish=False)  # 存草稿

**默认只存草稿**（``/post/post_draft``）。真实发布要显式 ``publish=True``。
"""

from __future__ import annotations

from .client import ChannelsClient, CookieJar, make_client_id
from .constants import (
    API_BASE,
    ORIGIN,
    POST_CREATE_PAGE,
    CardShowStyle,
    CdnFileType,
    ErrCode,
    PostMediaType,
    Scene,
    VideoType,
    Visibility,
)
from .errors import (
    ApiError,
    ChannelsError,
    LogicError,
    NetworkError,
    NotLoggedInError,
    UploadError,
)
from .media import (
    ImageAsset,
    MediaError,
    build_media_item,
    probe_image,
    probe_video,
    prepare_cover,
    prepare_image_variants,
    validate_media_files,
)
from .payload import (
    build_create_body,
    build_draft_body,
    build_object_desc,
    build_post_payload,
    build_preview_body,
    default_object_desc,
    default_temp_post,
    validate_payload,
)
from .publish import Publisher, PublishResult, RateLimiter
from .richtext import (
    build_finder_topic_info,
    build_rich_text_json,
    char_len,
    desc_to_delta,
    json_safe_clone,
    merge_ops,
    split_desc,
    split_header,
)
from .uploader import DfsUploader, LegacySnsUploader, UploadResult, md5_of_head

__version__ = "0.1.0"

__all__ = [
    "__version__",
    # client
    "ChannelsClient",
    "CookieJar",
    "make_client_id",
    # constants
    "API_BASE",
    "ORIGIN",
    "POST_CREATE_PAGE",
    "CardShowStyle",
    "CdnFileType",
    "ErrCode",
    "PostMediaType",
    "Scene",
    "VideoType",
    "Visibility",
    # errors
    "ApiError",
    "ChannelsError",
    "LogicError",
    "NetworkError",
    "NotLoggedInError",
    "UploadError",
    # media
    "ImageAsset",
    "MediaError",
    "build_media_item",
    "probe_image",
    "probe_video",
    "prepare_cover",
    "prepare_image_variants",
    "validate_media_files",
    # payload
    "build_create_body",
    "build_draft_body",
    "build_object_desc",
    "build_post_payload",
    "build_preview_body",
    "default_object_desc",
    "default_temp_post",
    "validate_payload",
    # publish
    "Publisher",
    "PublishResult",
    "RateLimiter",
    # richtext
    "build_finder_topic_info",
    "build_rich_text_json",
    "char_len",
    "desc_to_delta",
    "json_safe_clone",
    "merge_ops",
    "split_desc",
    "split_header",
    # uploader
    "DfsUploader",
    "LegacySnsUploader",
    "UploadResult",
    "md5_of_head",
]
