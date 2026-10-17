"""端点表、枚举与限额常量。

全部取自视频号助手前端 bundle（见 ``docs/PROTOCOL.md`` 的"来源"列）：

- ``404.b0af01fb.js``  —— postService / draftStore 的构造函数里内联了 456 条
  ``{name, path}`` 端点表
- ``chunk-common.7dbff146.js`` 模块 ``a3b6``（新）／``index.31d9f171.js`` 模块 ``32490``（旧）
  —— 两处各有一份常量副本，值并不完全一致（见 ``IMG_MAX_COUNT`` 注释）
- ``chunk-common.7dbff146.js`` 模块 ``c45b`` / ``f663`` —— 枚举
- ``index.31d9f171.js`` 模块 ``949`` / ``24484`` —— scene 与错误码
"""

from __future__ import annotations

# --------------------------------------------------------------------------
# 站点
# --------------------------------------------------------------------------

ORIGIN = "https://channels.weixin.qq.com"
#: 网关前缀。``RequestService`` 构造时 ``baseURL`` 缺省即此值（模块 83452 ``lG``）
API_BASE = f"{ORIGIN}/cgi-bin/mmfinderassistant-bin"

POST_CREATE_PAGE = f"{ORIGIN}/platform/post/create"
LOGIN_PAGE = f"{ORIGIN}/login.html"

#: 设备指纹头名，由 ``fingerPrintDeviceIdMiddleware`` 注入（模块 1144 / 70630）
FINGERPRINT_HEADER = "finger-print-device-id"
#: ``localStorage`` 里持久化 visitorId 的键
FINGERPRINT_STORAGE_KEY = "_finger_print_device_id"
#: ``X-WECHAT-UIN`` 取 ``userStore.fakeUin``，未登录时为 ``"0000000000"``
DEFAULT_FAKE_UIN = "0000000000"

# --------------------------------------------------------------------------
# 端点（name -> path，全部是 POST + JSON body）
# --------------------------------------------------------------------------

ENDPOINTS: dict[str, str] = {
    # ---- postService（404.b0af01fb.js）----
    "parseMpLink": "/helper/helper_parse_mp_link",
    "uploadParams": "/helper/helper_upload_params",
    "searchFinderAccount": "/helper/helper_search_finder_account",
    "searchLocation": "/helper/helper_search_location",
    "searchActivity": "/post/post_search_event",
    "searchUserPage": "/post/post_search_user_page",
    "clipVideo": "/post/post_clip_video",
    "getClipVideoResult": "/post/post_clip_video_result",
    "list": "/post/post_list",
    "mcnPostList": "/post/post_mcn_list",
    "megaList": "/post/post_mega_list",
    "create": "/post/post_create",
    "preview": "/post/post_preview",
    "postDraft": "/post/post_draft",
    "postAdDraft": "/post/post_ad_create_draft",
    "delete": "/post/post_delete",
    "getPostInfo": "/post/get_post_info",
    "delDraft": "/post/del_draft",
    "getDraftList": "/post/get_draft_list",
    "getDraftInfo": "/post/get_draft_info",
    "specialPost": "/post/post_special_create",
    "getFinderPostTraceKey": "/post/get-finder-post-trace-key",
    "getUserPrepare": "/post/post_user_prepare",
    "saveMpPostDraft": "/post/post_mp_create_draft",
    "updateVisible": "/post/post_update_visible",
    "updateCommentAuth": "/post/post_update_comment_auth",
    "updateBulletAuth": "/post/post_update_bullet_auth",
    "getVideoHdrInfo": "/helper/helper_get_video_type",
    # ---- authService（404.b0af01fb.js 模块 28706）----
    "authData": "/auth/auth_data",
    "loginCode": "/auth/auth_login_code",
    "loginStatus": "/auth/auth_login_status",
    "loginFinder": "/auth/login_finder",
    "logout": "/auth/auth_logout",
    "authWithExportkey": "/auth/auth_with_exportkey",
    "finderAssistantList": "/auth/auth_finder_list",
}

#: 网关登录守卫白名单：路径命中时即使没有 sessionid 也照常放行（模块 71948）
NO_SESSION_REQUIRED_PATHS = ("/notification/notification_list", "/auth/auth_data")

# --------------------------------------------------------------------------
# scene / 错误码
# --------------------------------------------------------------------------


class Scene:
    """模块 949 ``WN``。网关 ``helperRequest`` 会给每个 body 注入 ``scene``。"""

    Default = 0
    Ad = 2
    Mp = 3
    AdPlatform = 4
    WxAdPlatform = 5
    FinderPromote = 6
    FinderAssistant = 7
    Company = 8


class ErrCode:
    """模块 24484 ``X``（也内联在 chunk-common 偏移 ~414531）。"""

    Ok = 0
    MinNeedLogin = 300330
    MaxNeedLogin = 300350
    OtherDeviceLogin = 300334
    NoUserFound = 300021


#: 上传凭证 ``helper_upload_params`` 里 ``cdnFileType`` 的取值（模块 3afc ``a``）
class CdnFileType:
    """``X-Arguments.filetype`` 的取值 = ``helper_upload_params`` 响应里的键名。

    下面 8 个键名**全部来自实测响应**（2026-09 抓的真实账号）：

    ``authKey, uin, appType, videoFileType, pictureFileType, thumbFileType,
    musicType, scene, liveAppType, pagFileType, zipType, normalFile``

    其中发布链路用到的只有 video / picture / thumb 三类。
    """

    video = "videoFileType"
    picture = "pictureFileType"
    thumb = "thumbFileType"
    music = "musicType"
    live = "liveAppType"
    pag = "pagFileType"
    zip = "zipType"
    normal = "normalFile"


#: 同上，数值形态（模块 6ab5 ``CdnFileTypeNum``）
class CdnFileTypeNum:
    videoFileType = 0
    pictureFileType = 1
    thumbFileType = 2


class PostMediaType:
    """模块 c45b ``b``。"""

    image = 2
    video = 4


class VideoType:
    """模块 c45b ``d``。"""

    null = -1
    normal = 0
    mega = 1
    full = 2


class Visibility:
    public = 1
    follow = 2
    self = 3


class CardShowStyle:
    """模块 f663 ``b``。横版视频未指定卡片样式时站点会补 ``Center``。"""

    Tile = 1
    Center = 2


class ObjectType:
    """模块 c45b ``c``（原创声明）。"""

    default = 0
    news = 1


#: ``postFlag`` 位标记（模块 c45b ``d``）
MMFinderPostFlagAttachOriginalFlag = 1

# --------------------------------------------------------------------------
# 上传：DFS 分片参数（模块 6ab5）
# --------------------------------------------------------------------------

#: ``file.size <= singleFileSize`` 走 ``PUT /simpleuploaddfs``
SINGLE_FILE_SIZE = 0xA00000  # 10 MiB
#: ``chunkSize = 1024 * (localStorage["AssistantDebugUploadChunkSize"] || 8) * 1024``
DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024
DEFAULT_CONCURRENT_LIMIT = 4
#: 只有前 5 MiB 参与 md5（``getMd5``）
MD5_SLICE_SIZE = 5242880
#: ``uploadTaskIdExpiredTimeout``
UPLOAD_TASK_ID_EXPIRED_TIMEOUT = 858e5

#: 上传后 ``DownloadURL`` 的 host 替换（``ReplaceHost``）
CDN_REPLACE_FROM = "http://wxapp.tc.qq.com"
CDN_REPLACE_TO = "https://finder.video.qq.com"

#: 现代化 uploader 的默认 host（``uploadService.HOST``），会被 ``envInfo.cdnHost`` 覆盖
DEFAULT_DFS_HOST = "https://finderpre.video.qq.com"


class QuickChunkUploadMode:
    """``QuickUpload`` 查询参数取值（模块 6ab5 ``o``）。"""

    Confirm = 0
    Quick = 1
    Normal = 2


class UploadStrategy:
    """模块 6ab5 ``i``。失败降级阶梯 Quick -> Normal -> BackUp。"""

    Quick = 1
    Normal = 2
    Slow = 3
    BackUp = 4


class UploadEvent:
    """模块 3afc ``b`` / 6ab5 ``s``。"""

    chunkSuccess = 0
    chunkFail = 1
    fail = 2
    success = 3
    progress = 4


# --------------------------------------------------------------------------
# 限额（模块 a3b6，chunk-common 副本）
# --------------------------------------------------------------------------

#: ``descLengthLimit = j / 2``
DESC_LENGTH_LIMIT = 2000 // 2  # 1000
#: 图文标题上限（``k``），字符数按 ``charLen`` 计
TITLE_MAX_LENGTH = 22
#: ``mpTitle``（扩展链接标题）上限，组件里硬编码 ``> 60`` 报警
MP_TITLE_MAX_LENGTH = 30

#: ``a3b6.o``
CROP_RATIO_MIN = 1 / 3
CROP_RATIO_MAX = 3.0
COVER_RATIO_MIN = 0.8571428571428571  # 6/7
COVER_RATIO_MAX = 1.7777777777777777  # 16/9
IMG_MAX_COUNT = 18
VIDEO_MAX_DURATION = 61
DISPLAY_VIDEO_MAX_DURATION = 60
VIDEO_MIN_DURATION = 3

#: ``32490``（index/login bundle 里的旧副本）与之冲突的值：
#: ``imgMaxCount=9``、``videoMinDuration=2``、``videoMaxDuration=61``。
#: UI 文案 ``contentTips`` 仍写"可上传最多 9 张图片"，而 ``uploadPlaceHolder``
#: 用 ``nI.o.imgMaxCount``（18）。这里以模块值为准，另留覆盖开关。
LEGACY_IMG_MAX_COUNT = 9

#: 图片压缩档位（``a3b6``: ``l``/``p``/``m``/``n``）
IMAGE_FULL = {"width": 2048, "height": 2048, "quality": 0.9}
IMAGE_MAIN = {"width": 2048, "height": 2048, "quality": 0.9}
IMAGE_FULL_MAX = {"width": 3240, "height": 3240, "quality": 0.8}
IMAGE_THUMB = {"width": 1080, "height": 1080, "quality": 0.7}
VIDEO_COVER = {"width": 1080, "height": 1080, "quality": 0.7}

#: 视频裁剪目标分辨率上限（``calcTargetSize``）
CLIP_TARGET_WIDTH = 1920
CLIP_TARGET_HEIGHT = 1080
#: ``getClipVideoResult`` 轮询间隔
CLIP_POLL_INTERVAL = 5.0
