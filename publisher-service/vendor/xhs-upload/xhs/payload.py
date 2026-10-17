"""发布 payload 构造：common / imageInfo / videoInfo。

字段清单来自 creator 发布页前端（project-publish-vue.*.js）：

- ``ta``/``e8`` 组装最终请求体：``{common, imageInfo, videoInfo}``
- 模块 ``99487`` 的 ``C`` 生成单张图片的元信息
- 模块 ``99519`` 的 ``l`` 做 snake_case 转换后 POST ``/web_api/sns/v2/note``

关键转换：整棵 payload 走一次 ``toSnakeCase(deep)``；随后若
``common.capa_trace_info.context_json`` 存在，则改名回 ``contextJson`` 并删除 snake 版本
（站点对 ``capaTraceInfo`` 只做了浅层特殊处理）。
"""

from __future__ import annotations

import json
import re
import time
from typing import Any, Iterable, Mapping, Sequence

__all__ = [
    "NOTE_TYPE",
    "to_snake_case",
    "build_common",
    "build_capa_context",
    "build_image_entry",
    "image_entry_from_upload",
    "build_image_info",
    "build_video_info",
    "build_cover",
    "build_segments",
    "build_timelines",
    "build_chapters",
    "cover_selection_source",
    "to_post_note_payload",
    "build_hash_tag",
    "HASH_TAG_TYPE",
    "HASH_TAG_TYPES",
    "build_business_binds",
    "build_source",
    "now_ms",
]

#: ``{0: "video", 1: "normal"}``（模块 9712 的 ``tn``）；音频统一按 ``normal``
NOTE_TYPE = {0: "video", 1: "normal"}

# 前端 source 字段默认值：``batchSourceFromParams("web")``
DEFAULT_SOURCE = {"type": "web", "ids": "", "extraInfo": json.dumps({"subType": "web", "systemId": "web", "topic_id": ""}, separators=(",", ":"))}


def _words(text: str) -> list[str]:
    """lodash ``words`` 的 ASCII 子集：切出 camelCase / PascalCase / 数字分组。"""
    out: list[str] = []
    for chunk in re.findall(r"[A-Za-z]+|[0-9]+", text):
        if chunk.isdigit():
            out.append(chunk)
            continue
        out.extend(re.findall(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+", chunk))
    return out


def _to_snake_key(key: str) -> str:
    words = _words(key)
    if not words:
        return key
    return "_".join(word.lower() for word in words)


def to_snake_case(value: Any, deep: bool = True) -> Any:
    """等价于 ``lodash.toSnakeCase(value, {deep: true})``。"""
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for key, item in value.items():
            new_key = _to_snake_key(str(key))
            result[new_key] = to_snake_case(item, deep) if deep else item
        return result
    if isinstance(value, (list, tuple)):
        return [to_snake_case(item, deep) if deep else item for item in value]
    return value


# --------------------------------------------------------------------------
# common
# --------------------------------------------------------------------------


def build_source(
    source_type: str = "web",
    ids: str = "",
    extra_info: Mapping[str, Any] | str | None = None,
) -> str:
    """``common.source`` 是一个被序列化过两次的 JSON 字符串。"""
    if extra_info is None:
        payload: Any = {"subType": source_type, "systemId": source_type, "topic_id": ""}
    elif isinstance(extra_info, str):
        payload = extra_info
    else:
        payload = dict(extra_info)
    inner = payload if isinstance(payload, str) else json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    return json.dumps({"type": source_type, "ids": ids, "extraInfo": inner}, separators=(",", ":"), ensure_ascii=False)


def build_business_binds(
    post_time_ms: int | None = None,
    collection_id: str = "",
    note_id: str | int = 0,
) -> str:
    """``common.businessBinds``：站点把一堆 Bind 对象 JSON 序列化成一个字符串。"""
    binds = {
        "version": 1,
        "noteId": note_id,
        "noteOrderBind": {},
        "notePostTiming": {"postTime": post_time_ms},
        "noteCollectionBind": {"id": collection_id},
    }
    return json.dumps(binds, separators=(",", ":"), ensure_ascii=False)


#: 站点模块 79037 的 ``xP`` 枚举（TOPIC=1 … INSTANT=20）到线上字符串的映射，
#: 即各处的 ``ep``/``C``/``j`` 表：``{1:"topic",17:"moment",18:"poi_v2",19:"map_traver",20:"instant"}``
HASH_TAG_TYPE = {
    1: "topic",       # xP.TOPIC
    17: "moment",     # xP.MOMENT
    18: "poi_v2",     # xP.POI
    19: "map_traver", # xP.TRAVEL
    20: "instant",    # xP.INSTANT
}
#: 线上合法的 hashTag type 值
HASH_TAG_TYPES = frozenset(HASH_TAG_TYPE.values())


def build_hash_tag(tags: Iterable[Any]) -> list[dict[str, str]]:
    """把话题规整成 ``common.hashTag`` 需要的结构。

    站点 ``w()``：``{...e, id, name, link, type}``，缺字段补空串；
    ``type`` 为数字时按 ``HASH_TAG_TYPE`` 翻译，否则原样保留。
    直接传字符串会被服务端拒绝：
    ``check: common.hash_tag, name: : required struct with json format, but got string``。
    """
    out: list[dict[str, str]] = []
    for tag in tags:
        if isinstance(tag, str):
            out.append({"id": "", "name": tag, "link": "", "type": "topic"})
            continue
        if not isinstance(tag, Mapping):
            continue
        raw_type = tag.get("type", "topic")
        if isinstance(raw_type, bool):
            raw_type = "topic"
        elif isinstance(raw_type, int):
            raw_type = HASH_TAG_TYPE.get(raw_type)
        elif isinstance(raw_type, str):
            if raw_type.isdigit():
                raw_type = HASH_TAG_TYPE.get(int(raw_type))
            elif raw_type not in HASH_TAG_TYPES:
                # 搜索接口回的 type 是话题来源（"official"/"user"），不是 hashTag 类型
                raw_type = "topic"
        if raw_type is None:
            continue
        out.append(
            {
                "id": str(tag.get("id") or ""),
                "name": str(tag.get("name") or ""),
                "link": str(tag.get("link") or ""),
                "type": str(raw_type),
            }
        )
    return out


def build_common(
    note_type: str = "normal",
    title: str = "",
    desc: str = "",
    note_id: str = "",
    ats: Sequence[Mapping[str, Any]] | None = None,
    topics: Sequence[Mapping[str, Any]] | None = None,
    source: str | None = None,
    privacy_type: int = 0,
    op_type: int = 1,
    user_ids: Sequence[str] | None = None,
    post_time_ms: int | None = None,
    collection_id: str = "",
    goods_info: Any = None,
    metadata: Mapping[str, Any] | None = None,
    biz_relations: Sequence[Mapping[str, Any]] | None = None,
    capa_context: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """构造 ``common``。

    :param note_type: ``"normal"``（图文/音频）或 ``"video"``
    :param topics: 话题列表；可传字符串，或 ``{"id","name","link","type"}``。
        经 :func:`build_hash_tag` 规整后填入 ``common.hashTag``
        （服务端要求 struct 数组，传字符串会直接报错）
    :param ats: @用户列表，形如 ``[{"id": ..., "name": ...}]``
    :param privacy_type: ``0`` 公开、``1`` 仅自己可见、``2``? 站点枚举来自 ``J.eZ``
    """
    privacy_info: dict[str, Any] = {"opType": op_type, "type": privacy_type}
    if user_ids is not None:
        privacy_info["userIds"] = list(user_ids)

    common: dict[str, Any] = {
        "type": note_type,
        "title": title,
        "noteId": note_id,
        "desc": desc,
        "source": source if source is not None else build_source(),
        "businessBinds": build_business_binds(post_time_ms, collection_id, note_id or 0),
        "ats": list(ats or []),
        "hashTag": build_hash_tag(topics or []),
        "postLoc": {},
        "privacyInfo": privacy_info,
    }
    if goods_info is not None:
        common["goodsInfo"] = goods_info
    if metadata is not None:
        common["metadata"] = dict(metadata)
    if biz_relations is not None:
        common["bizRelations"] = list(biz_relations)
    if capa_context is not None:
        # capaTraceInfo 里只有一个 contextJson（本身是 JSON 字符串）
        common["capaTraceInfo"] = {"contextJson": json.dumps(capa_context, separators=(",", ":"), ensure_ascii=False)}
    return common


def build_capa_context(
    topic_id: str | None = None,
    recommend_title_id: str | None = None,
    recommend_title_list: Sequence[Mapping[str, Any]] | None = None,
    recommend_topics_used: Sequence[Mapping[str, Any]] | None = None,
    pre_audit_id: str | None = None,
    long_text_to_image: Mapping[str, Any] | None = None,
    audio_info: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """构造 ``capaTraceInfo.contextJson`` 里的上下文对象（模块 ``ta`` 的 ``p``）。"""
    context: dict[str, Any] = {
        "recommend_title": {
            "recommend_title_id": recommend_title_id or "",
            "is_use": False,
            "used_index": -1,
        },
        "recommendTitle": [
            {"id": item.get("id", ""), "title": item.get("title", "")}
            for item in (recommend_title_list or [])
        ],
        "recommend_topics": {
            "used": [
                {k: v for k, v in ({"id": t.get("id"), "name": t.get("name"), "topic_source": t.get("topic_source")}).items() if v is not None}
                for t in (recommend_topics_used or [])
            ]
        },
    }
    if topic_id:
        context["recommend_topics"]["topic_id"] = topic_id
    if long_text_to_image:
        context["longTextToImage"] = dict(long_text_to_image)
    if pre_audit_id:
        context["preAuditInfo"] = {"preAuditId": pre_audit_id}
    if audio_info:
        context["audio_info"] = dict(audio_info)
        context["audio_to_text"] = False
        context["audio_summary"] = False
    return context


# --------------------------------------------------------------------------
# imageInfo
# --------------------------------------------------------------------------


def build_image_entry(
    file_id: str,
    width: int = 0,
    height: int = 0,
    mime_type: str = "image/png",
    index: int = 0,
    bg_cover_color: str = "",
    bg_inner_color: str = "",
    size_bytes: int = 0,
    original_metadata: Mapping[str, Any] | None = None,
    fonts: Sequence[Mapping[str, Any]] | None = None,
    stickers: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """单张图片的 ``imageInfo.images[i]``（模块 ``99487`` 的 ``C``）。"""
    entry: dict[str, Any] = {"fileId": file_id, "width": width, "height": height}
    if original_metadata:
        entry["originalMetadata"] = dict(original_metadata)
    entry["metadata"] = {"source": -1}
    if fonts:
        entry["fonts"] = list(fonts)
    if stickers:
        entry["stickers"] = dict(stickers)
    entry["extraInfoJson"] = json.dumps(
        {
            "mimeType": mime_type or "image/png",
            "image_metadata": {
                # 第一张图用 bgCoverColor，其余用 bgInnerColor
                "bg_color": (bg_cover_color if index == 0 else bg_inner_color) or "",
                "origin_size": (size_bytes or 0) / 1024,
            },
        },
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return entry


def build_image_info(images: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    return {"images": [dict(item) for item in images]}


def image_entry_from_upload(
    upload: Any,
    width: int = 0,
    height: int = 0,
    index: int = 0,
    mime_type: str = "image/png",
    size_bytes: int = 0,
    bg_cover_color: str = "",
    bg_inner_color: str = "",
) -> dict[str, Any]:
    """把 ``CosUploadResult`` 直接转成 ``imageInfo`` 里的一元素。"""
    return build_image_entry(
        file_id=getattr(upload, "file_id", upload if isinstance(upload, str) else ""),
        width=width,
        height=height,
        mime_type=mime_type,
        index=index,
        bg_cover_color=bg_cover_color,
        bg_inner_color=bg_inner_color,
        size_bytes=size_bytes,
    )


# --------------------------------------------------------------------------
# videoInfo
# --------------------------------------------------------------------------

# 封面来源选择（模块 89775 派生自 97101）
COVER_SOURCE_DEFAULT = "default"
COVER_SOURCE_UPLOAD = "upload"
COVER_SOURCE_RECOMMEND = "recommend"
COVER_SOURCE_FRAME = "frame"
COVER_SOURCE_AI = "ai"


def cover_selection_source(cover: Mapping[str, Any]) -> str:
    """推断 ``selectionSource``（模块 89775 的 ``sU`` 等价的 Python 版）。"""
    if cover.get("selectionSource"):
        return str(cover["selectionSource"])
    if cover.get("isAiCover") or cover.get("aiGenerated"):
        return COVER_SOURCE_AI
    extra = cover.get("extra_info_json") or cover.get("extraInfoJson") or ""
    try:
        parsed = json.loads(extra) if isinstance(extra, str) else (extra or {})
    except (TypeError, ValueError):
        parsed = {}
    if isinstance(parsed, dict):
        recommend = parsed.get("cover_recommend")
        if isinstance(recommend, dict) and recommend.get("isUseRecommend") is True:
            return COVER_SOURCE_RECOMMEND
    frame = cover.get("frame") or {}
    if frame.get("isUpload"):
        return COVER_SOURCE_UPLOAD
    if frame.get("isUserSelect") and (frame.get("ts") or 0) > 0:
        return COVER_SOURCE_FRAME
    if str(cover.get("source") or "") == "system":
        return COVER_SOURCE_RECOMMEND
    return COVER_SOURCE_DEFAULT


def _cover_frame(cover: Mapping[str, Any]) -> dict[str, Any]:
    source = cover_selection_source(cover)
    if source == COVER_SOURCE_UPLOAD:
        return {"ts": 0, "isUpload": True, "isUserSelect": False}
    if source in (COVER_SOURCE_RECOMMEND, COVER_SOURCE_FRAME):
        return {"ts": (cover.get("frame") or {}).get("ts", 0), "isUpload": False, "isUserSelect": True}
    if source == COVER_SOURCE_AI:
        return {"ts": 0, "isUpload": False, "isUserSelect": True}
    return {"ts": 0, "isUpload": False, "isUserSelect": False}


def _cover_extra_info(cover: Mapping[str, Any]) -> str:
    source = cover_selection_source(cover)
    extra_raw = cover.get("extra_info_json") or cover.get("extraInfoJson") or ""
    try:
        extra = json.loads(extra_raw) if isinstance(extra_raw, str) else dict(extra_raw or {})
    except (TypeError, ValueError):
        extra = {}
    if not isinstance(extra, dict):
        extra = {}
    recommend = extra.get("cover_recommend")
    recommend = dict(recommend) if isinstance(recommend, Mapping) else {}
    recommend["isUseRecommend"] = source == COVER_SOURCE_RECOMMEND
    recommend["isAiCover"] = source == COVER_SOURCE_AI
    extra["cover_recommend"] = recommend
    return json.dumps(extra, separators=(",", ":"), ensure_ascii=False)


def build_cover(
    fileid: str,
    width: int = 0,
    height: int = 0,
    source: str = COVER_SOURCE_UPLOAD,
    frame_ts: int = 0,
    stickers: Mapping[str, Any] | None = None,
    fonts: Sequence[Mapping[str, Any]] | None = None,
    cover_template_id: Any = None,
    mark_list: Sequence[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """构造 ``videoInfo.cover``（模块 97101 的 ``xO`` + ``u``）。"""
    cover: dict[str, Any] = {
        "fileid": fileid,
        "file_id": fileid,
        "width": width,
        "height": height,
        "selectionSource": source,
    }
    if cover_template_id is not None:
        cover["coverTemplateId"] = cover_template_id
    if stickers or fonts:
        cover["stickers"] = dict(stickers or {})
        if fonts:
            cover["fonts"] = list(fonts)
    cover.update(_cover_frame(cover))
    cover["extra_info_json"] = _cover_extra_info(cover)
    interior: dict[str, Any] = stickers or {}
    interior = dict(interior)
    interior["floating"] = list(mark_list or [])
    cover["stickers"] = interior
    return cover


def build_segments(
    duration_ms: int | float = 0,
    video_meta: Mapping[str, Any] | str | None = None,
    audio_meta: Mapping[str, Any] | str | None = None,
) -> dict[str, Any]:
    """``videoInfo.segments``：目前恒定单段、不切片、原速。"""
    def _parse(value: Any) -> dict[str, Any]:
        if isinstance(value, Mapping):
            return dict(value)
        if isinstance(value, str) and value:
            try:
                return json.loads(value)
            except ValueError:
                return {}
        return {}

    return {
        "count": 1,
        "needSlice": False,
        "items": [
            {
                "mute": 0,
                "speed": 1,
                "start": 0,
                "duration": duration_ms,
                "transcoded": 0,
                "mediaSource": 1,
                "originalMetadata": {
                    "video": _parse(video_meta),
                    "audio": _parse(audio_meta),
                },
            }
        ],
    }


def build_timelines(marks: Sequence[Mapping[str, Any]] | None = None) -> list[dict[str, Any]]:
    """``videoInfo.timelines``：站点把标记统一成 ``video_marks_v2``。"""
    out: list[dict[str, Any]] = []
    for mark in marks or []:
        try:
            out.append(
                {
                    "type": "video_marks_v2",
                    "start": int(1000 * mark.get("startTime", 0)),
                    "end": int(1000 * mark.get("endTime", 0)),
                    "detail": {"id": mark.get("markId"), **dict(mark.get("config") or {})},
                }
            )
        except Exception:  # noqa: BLE001 - 与站点一致：解析失败的标记直接丢弃
            continue
    return out


def build_chapters(chapters: Sequence[Mapping[str, Any]] | None = None) -> list[dict[str, Any]]:
    """``videoInfo.chapters``（模块 86888 的 ``m$``）。"""
    out: list[dict[str, Any]] = []
    for chapter in chapters or []:
        out.append(
            {
                "text": chapter.get("text", ""),
                "time": str(int(1000 * chapter.get("time", 0))),
                "description": chapter.get("description", ""),
            }
        )
    return out


def build_video_info(
    file_id: str,
    cover: Mapping[str, Any] | None = None,
    width: int = 0,
    height: int = 0,
    duration_ms: int | float = 0,
    video_meta: Mapping[str, Any] | str | None = None,
    audio_meta: Mapping[str, Any] | str | None = None,
    timelines: Sequence[Mapping[str, Any]] | None = None,
    chapters: Sequence[Mapping[str, Any]] | None = None,
    summary: str = "",
    segments: Mapping[str, Any] | None = None,
    replaced_video: Any = None,
    entrance: str = "web",
) -> dict[str, Any]:
    """构造 ``videoInfo``。

    ``videoPreviewType``：竖屏且 ``width/height <= 0.6`` 时是 ``full_vertical_screen``。

    注意 ``fileid`` 与 ``file_id`` 同时出现，站点两个字段都发（模块 97101 的 ``xO``）。
    """
    preview_type = "full_vertical_screen" if (height and width / height <= 0.6) else ""
    info: dict[str, Any] = {
        "fileid": file_id,
        "file_id": file_id,
        "formatWidth": width,
        "formatHeight": height,
        "videoPreviewType": preview_type,
        "compositeMetadata": {
            "video": _as_mapping(video_meta),
            "audio": _as_mapping(audio_meta),
        },
        "timelines": list(timelines or []),
        "cover": dict(cover or {}),
        "chapters": list(chapters or []),
        "summary": summary,
        "chapterSyncText": False,
        "segments": dict(segments or build_segments(duration_ms, video_meta, audio_meta)),
        "entrance": entrance,
        "replacedVideo": replaced_video,
    }
    return info


def _as_mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, str) and value:
        try:
            return json.loads(value)
        except ValueError:
            return {}
    return {}


# --------------------------------------------------------------------------
# 最终请求体
# --------------------------------------------------------------------------


def to_post_note_payload(
    common: Mapping[str, Any],
    image_info: Mapping[str, Any] | None = None,
    video_info: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """等价于模块 ``99519`` 的 ``l``：snake_case + ``contextJson`` 例外。"""
    payload: dict[str, Any] = {
        "common": dict(common),
        "imageInfo": dict(image_info) if image_info else None,
        "videoInfo": dict(video_info) if video_info else None,
    }
    payload = to_snake_case(payload, deep=True)

    trace = payload.get("common", {}).get("capa_trace_info")
    if isinstance(trace, dict) and "context_json" in trace:
        trace["contextJson"] = trace.pop("context_json")
    return payload


def now_ms() -> int:
    return int(time.time() * 1000)
