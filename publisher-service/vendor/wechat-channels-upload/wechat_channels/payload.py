"""``post_create`` / ``post_draft`` 请求体构造。

复刻模块 ``fae3`` 的 ``kg``：``tempPost`` 与 ``objectDesc`` 合成 payload，
再包成 ``{post, clientId}`（发布）、``{postReq, objectId}`（草稿）。

``tempPost`` 默认值（``ky()``）::

    {"objectType": 0, "longitude": 0, "latitude": 0, "feedLongitude": 0,
     "feedLatitude": 0, "originalFlag": 0, "topics": []}

``objectDesc`` 默认值（``kb()``）::

    {"mpTitle": "", "description": "", "extReading": {"link": "", "title": ""},
     "mediaType": 2, "location": {}, "topic": {"finderTopicInfo": ""},
     "event": {}, "mentionedUser": [], "media": []}

``getCreateOrPreviewParams`` 在此基础上加::

    isFullPost = 1
    handleFlag = 2
    videoClipTaskId = clipTicket.draftId or ""
    traceInfo = {...createPostStatus.traceInfo, traceKey}
    objectDesc = <上面那个>

并按需加 ``report``（有 ``fileSize`` 时）与 ``effectiveTime``（定时发表）。
"""

from __future__ import annotations

import json
from typing import Any, Iterable, Mapping, Sequence

from .constants import (
    DESC_LENGTH_LIMIT,
    MP_TITLE_MAX_LENGTH,
    TITLE_MAX_LENGTH,
    MMFinderPostFlagAttachOriginalFlag,
    ObjectType,
    PostMediaType,
)
from .errors import LogicError
from .richtext import (
    build_finder_topic_info,
    build_rich_text_json,
    char_len,
    extract_mentions,
    extract_topics,
    json_safe_clone,
)

__all__ = [
    "default_temp_post",
    "default_object_desc",
    "build_object_desc",
    "build_post_payload",
    "build_create_body",
    "build_draft_body",
    "build_preview_body",
    "validate_payload",
]

#: 描述长度上限。前端 ``descLengthLimit = a3b6.j / 2 = 1000``，判定用 ``charLen``。
DESC_LIMIT = DESC_LENGTH_LIMIT


def default_temp_post() -> dict[str, Any]:
    return {
        "objectType": ObjectType.default,
        "longitude": 0,
        "latitude": 0,
        "feedLongitude": 0,
        "feedLatitude": 0,
        "originalFlag": 0,
        "topics": [],
    }


def default_object_desc() -> dict[str, Any]:
    return {
        "mpTitle": "",
        "description": "",
        "extReading": {"link": "", "title": ""},
        "mediaType": PostMediaType.image,
        "location": {},
        "topic": {"finderTopicInfo": ""},
        "event": {},
        "mentionedUser": [],
        "media": [],
    }


def build_object_desc(
    *,
    media: Sequence[Mapping[str, Any]],
    media_type: int,
    description: str = "",
    topics: Sequence[str] | None = None,
    mentions: Sequence[str] | None = None,
    title: str = "",
    mp_title: str = "",
    ext_link: str = "",
    ext_link_title: str = "",
    location: Mapping[str, Any] | None = None,
    event: Mapping[str, Any] | None = None,
    collection_id: str = "",
    collection_name: str = "",
    from_rich_publisher: bool = True,
) -> dict[str, Any]:
    """组装 ``objectDesc``。

    图文模式（``mediaType = 2``）额外需要 ``finderNewlifeDesc``：

    - ``richTextTitle``：标题（<= 22 个"字符"，见 :func:`wechat_channels.richtext.char_len`）
    - ``richTextJson``：``mergeObj(genTitleRichText(), descToDelta(...))``
    - ``fromRichPublisher``：固定 1

    话题与 @ 用户会同时写进 ``topic.finderTopicInfo``（XML）与 ``topics`` / ``mentionedUser``。
    """
    topic_list = list(topics or [])
    mention_list = list(mentions or [])
    info = build_finder_topic_info(description, topics=topic_list, mentions=mention_list)

    desc: dict[str, Any] = default_object_desc()
    desc.update(
        {
            "mediaType": media_type,
            "description": description,
            "media": [dict(item) for item in media],
        }
    )
    desc["mentionedUser"] = info["mentionedUser"]
    desc["topic"] = {"finderTopicInfo": info["finderTopicInfo"]}
    if collection_id:
        desc["topic"]["collectionId"] = collection_id
        if collection_name:
            desc["topic"]["collectionName"] = collection_name
    if mp_title:
        desc["mpTitle"] = mp_title
    if ext_link or ext_link_title:
        desc["extReading"] = {"link": ext_link, "title": ext_link_title}
    if location:
        desc["location"] = dict(location)
    if event:
        desc["event"] = dict(event)

    if media_type == PostMediaType.image:
        if title:
            title = title.strip()
            if char_len(title) > TITLE_MAX_LENGTH:
                raise LogicError(
                    f"图文标题超过{TITLE_MAX_LENGTH}字限制（当前 {char_len(title)}）",
                    "validTitle",
                )
        desc["finderNewlifeDesc"] = {
            "richTextTitle": title,
            "richTextJson": build_rich_text_json(
                title, description, topics=topic_list, mentions=mention_list
            ),
            "fromRichPublisher": 1 if from_rich_publisher else 0,
        }
    return desc


def build_post_payload(
    object_desc: Mapping[str, Any],
    *,
    trace_key: str = "",
    topics: Sequence[str] | None = None,
    object_type: int = ObjectType.default,
    post_flag: int = 0,
    original_mark: bool = False,
    video_clip_task_id: str = "",
    report: Mapping[str, Any] | None = None,
    effective_time: int | None = None,
    extra_temp_post: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """组装完整 payload（``{post: ...}`` 里的 ``post``）。"""
    payload = default_temp_post()
    payload["objectType"] = object_type
    payload["topics"] = list(topics or [])
    payload["postFlag"] = (
        post_flag | MMFinderPostFlagAttachOriginalFlag
        if original_mark
        else post_flag & ~MMFinderPostFlagAttachOriginalFlag
    )
    if extra_temp_post:
        payload.update(dict(extra_temp_post))

    payload.update(
        {
            "isFullPost": 1,
            "handleFlag": 2,
            "videoClipTaskId": video_clip_task_id or "",
            "traceInfo": {"traceKey": trace_key or ""},
            "objectDesc": dict(object_desc),
        }
    )
    if report:
        payload["report"] = dict(report)
    if effective_time:
        payload["effectiveTime"] = int(effective_time)
    # 环形引用 -> null（前端 jsonSafeClone 的作用；本库正常不会出现，防御性保留）
    return json_safe_clone(payload)


def build_create_body(
    payload: Mapping[str, Any], client_id: str
) -> dict[str, Any]:
    """``post_create`` 请求体：**扁平** payload + 小写 ``clientid``。

    实测定论（同一份媒体、同一账号）：

    =======================================  ==================
    body                                     结果
    =======================================  ==================
    ``{...payload, "clientid": <uuid>}``     ``errCode: 0`` + ``exportId``
    ``{"post": {...}, "clientId": <uuid>}``  ``errCode: 300002``
    =======================================  ==================

    即 ``post_create`` 和 ``post_draft`` 的 body 形状一致（扁平 + ``clientid``），
    只有端点不同。前端确实是 ``{post, clientId}`` 两层结构，但那是
    ``getCreateOrPreviewParams()`` 的返回值在页面内的形态；
    ``postStore.createPost(e)`` 收到的是**已经拆开的 ``e.post``**（页面里
    ``o = await C.postStore.createPost(r)``，``r`` 就是那个扁平对象），
    再补上 ``clientid`` 后原样作为 body 发出。
    """
    body = dict(payload)
    body["clientid"] = client_id
    return body


def build_draft_body(
    payload: Mapping[str, Any], client_id: str, object_id: str | None = None
) -> dict[str, Any]:
    """``post_draft`` 请求体：``{"postReq": {...payload, clientid}, "objectId": ...}``。

    注意草稿用的是小写 ``clientid``，且 ``objectId`` 为 ``None`` 时也要显式出现在
    body 里（前端 ``objectId: i || null``）。
    """
    post_req = dict(payload)
    post_req["clientid"] = client_id
    return {"postReq": post_req, "objectId": object_id or None}


def build_preview_body(
    payload: Mapping[str, Any], client_id: str, scene: int
) -> dict[str, Any]:
    """``post_preview`` 请求体：``{"postReq": {...payload, clientid}, "scene": n}``。"""
    post_req = dict(payload)
    post_req["clientid"] = client_id
    return {"postReq": post_req, "scene": scene}


def validate_payload(
    payload: Mapping[str, Any], *, for_publish: bool = True
) -> list[str]:
    """本地复刻 ``validPost`` / ``validDraft`` 的检查，返回警告列表。

    与前端一致的分支：

    - ``media[0]`` 必须存在（``validPost`` 首条）
    - 视频模式必须有 ``thumbUrl``，除非 ``enableAllowAstraThumbCover``
      （前端文案 ``"请设置视频封面"``）
    - 图片模式必须有 ``finderNewlifeDesc.richTextTitle``（``"请输入图文标题"``）
    - 描述 ``charLen > descLengthLimit``（``"描述超过1000字限制"``）
    - ``mpTitle`` 超过 30（``"标题超过30字限制"``）
    - ``effectiveTime`` 必须是未来时间（``"请选择正确的定时发表时间"``）

    ``validDraft`` 不做封面与标题检查，所以 ``for_publish=False`` 时只查基础项。
    """
    warn: list[str] = []
    desc = payload.get("objectDesc") or {}
    media = desc.get("media") or []
    media_type = desc.get("mediaType")

    if not media:
        warn.append("没有素材（objectDesc.media 为空）")
        return warn

    if for_publish and media_type == PostMediaType.video:
        if not media[0].get("thumbUrl"):
            warn.append("请设置视频封面（media[0].thumbUrl 为空）")
    if for_publish and media_type == PostMediaType.image:
        title = ((desc.get("finderNewlifeDesc") or {}).get("richTextTitle")) or ""
        if not title.strip():
            warn.append("请输入图文标题")

    length = char_len(str(desc.get("description") or ""))
    if length > DESC_LIMIT:
        warn.append(f"描述超过{DESC_LIMIT}字限制（当前 {length}）")
    mp_title = str(desc.get("mpTitle") or "")
    if mp_title and char_len(mp_title) > MP_TITLE_MAX_LENGTH:
        warn.append(f"标题超过{MP_TITLE_MAX_LENGTH}字限制")
    effective_time = payload.get("effectiveTime")
    if effective_time:
        import time

        if int(effective_time) < int(time.time()):
            warn.append("请选择正确的定时发表时间")
    return warn


def collect_topics_from_text(
    text: str, explicit: Iterable[str] | None = None
) -> list[str]:
    """显式传入的优先；否则从 ``#话题#`` 抽。"""
    if explicit:
        return [str(item).strip() for item in explicit if str(item).strip()]
    return extract_topics(text)


def collect_mentions_from_text(
    text: str, explicit: Iterable[str] | None = None
) -> list[str]:
    if explicit:
        return [str(item).strip() for item in explicit if str(item).strip()]
    return extract_mentions(text)


def dumps(payload: Mapping[str, Any]) -> str:
    """调试用：稳定的 JSON 字符串。"""
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False)
