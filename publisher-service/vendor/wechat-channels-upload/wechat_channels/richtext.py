"""富文本：``finderTopicInfo`` XML + Quill ``richTextJson``。

对应 chunk-common 模块 ``7925``：

=========== ==========================================================
``i``       ``descToFinderTopicInfo`` —— 从编辑器 DOM 生成 ``<finder>`` XML
``l``       ``splitDesc`` —— 按第一个 ``\\n`` 切成两段
``k``       ``splitHeader`` —— 把 Quill ops 按 ``header:1`` 切成标题/正文
``g``       ``mergeObj`` —— 拼接标题与正文 ops，必要时补 ``\\n\\n``
``d``       ``descToDelta`` —— 从编辑器 DOM 生成 Quill ops
``m``       ``charLen`` —— 非 ASCII 记 2 字符
``e``       ``getErrMsg``
``b``       ``jsonSafeClone`` —— 环形引用替换成 ``null``
=========== ==========================================================

Python 侧没有 DOM，所以这里的接口以**结构化输入**为准：

- :func:`build_finder_topic_info` 接收 ``(text, topics, mentions)``，
  其中 ``text`` 是编辑器纯文本，``topics`` / ``mentions`` 是要高亮的词。
  它与前端的差别在 ``at`` 索引的算法 —— 前端用 ``childNodes`` 下标（含每个
  ``<br>`` 与 ``<span>`` 都是独立节点），本库按"每段文本节点一个 value 段"模拟。
  这一点**未在真机上验证**，见 README「未验证」一节。
- :func:`build_rich_text_json` 直接构造 Quill ops，绕过编辑器。
"""

from __future__ import annotations

import json
import re
from typing import Any, Iterable, Mapping, Sequence

__all__ = [
    "char_len",
    "split_desc",
    "split_header",
    "merge_ops",
    "build_finder_topic_info",
    "build_rich_text_json",
    "desc_to_delta",
    "escape_html",
    "unescape_html",
    "json_safe_clone",
    "extract_topics",
    "extract_mentions",
]

#: 前端：``s.replace(/[^\x00-\xff]/g, "aa").length``
_NON_ASCII = re.compile(r"[^\x00-\xff]")

#: 话题词：``#xxx``（编辑器里是 ``span.topic``）
TOPIC_PATTERN = re.compile(r"#([^#\s]+)#?")
#: @用户：``@nickname``（编辑器里是 ``span.at``）
MENTION_PATTERN = re.compile(r"@([^\s@]+)")


def char_len(value: str) -> int:
    """非 ASCII 计 2，ASCII 计 1（前端 ``charLen``）。"""
    return len(_NON_ASCII.sub("aa", value or ""))


def split_desc(value: str) -> list[str]:
    """``splitDesc``：只切第一个换行，返回 ``[head]`` 或 ``[head, tail]``。"""
    index = (value or "").find("\n")
    if index == -1:
        return [value or ""]
    return [value[:index], value[index + 1 :]]


def split_header(rich_text_json: str | Sequence[Mapping[str, Any]]) -> dict[str, list]:
    """``splitHeader``：按第一个 ``attributes.header == 1`` 的 op 切分。"""
    if isinstance(rich_text_json, str):
        try:
            ops = json.loads(rich_text_json or "[]")
        except ValueError:
            ops = []
    else:
        ops = list(rich_text_json or [])
    if not isinstance(ops, list):
        ops = []

    header_index = -1
    for index, op in enumerate(ops):
        if isinstance(op, Mapping) and (op.get("attributes") or {}).get("header") == 1:
            header_index = index
            break
    if header_index == -1:
        return {"headerList": [], "contentList": list(ops)}
    return {
        "headerList": ops[: header_index + 1],
        "contentList": ops[header_index + 1 :] if header_index < len(ops) - 1 else [],
    }


def merge_ops(header_list: Iterable[Mapping[str, Any]], content_list: Iterable[Mapping[str, Any]]):
    """``mergeObj``：拼接两组 ops；若末尾不是 ``\\n\\n`` 则补一个。"""
    merged = [dict(op) for op in (header_list or [])] + [
        dict(op) for op in (content_list or [])
    ]
    if merged:
        last = merged[-1]
        insert = last.get("insert")
        if last.get("attributes") or not (
            isinstance(insert, str) and insert.endswith("\n\n")
        ):
            merged.append({"insert": "\n\n"})
    return merged


def escape_html(value: str) -> str:
    """``escapeHtml``：转义 ``<``/``>``，再把 ``em`` / ``br`` 还原回来。"""
    if not isinstance(value, str):
        return value
    escaped = value.replace("<", "&lt;").replace(">", "&gt;")
    return re.sub(
        r"&lt;(em|/em|br|br/)(.*?)&gt;",
        lambda match: f"<{match.group(1)}{match.group(2)}>",
        escaped,
        flags=re.IGNORECASE,
    )


def unescape_html(value: str) -> str:
    """``escapeHtml`` 的逆（用于把 ``description`` 还原成编辑器里的样子）。"""
    if not isinstance(value, str):
        return value
    return (
        value.replace("&lt;em&gt;", "<em>")
        .replace("&lt;/em&gt;", "</em>")
        .replace("&lt;br&gt;", "<br>")
        .replace("&lt;br/&gt;", "<br/>")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
    )


def json_safe_clone(value: Any, _seen: tuple[int, ...] = ()) -> Any:
    """模块 ``7925`` 的 ``k`` / ``b``：环形引用替换成 ``None``（前端是 ``null``）。"""
    if not isinstance(value, (dict, list)):
        return value
    if id(value) in _seen:
        return None
    seen = _seen + (id(value),)
    if isinstance(value, list):
        return [json_safe_clone(item, seen) for item in value]
    return {str(key): json_safe_clone(item, seen) for key, item in value.items()}


# --------------------------------------------------------------------------
# finderTopicInfo
# --------------------------------------------------------------------------


def _build_at_style(indexes: Sequence[int]) -> str:
    """``<style><at>i,j</at></style>``；没有 at 时为空串。"""
    return ",".join(str(index) for index in indexes)


def build_finder_topic_info(
    text: str,
    *,
    topics: Sequence[str] | None = None,
    mentions: Sequence[str] | None = None,
) -> dict[str, Any]:
    """生成 ``topic.finderTopicInfo``。

    返回值：::

        {"topics": [...], "mentionedUser": [{"nickname": ...}], "finderTopicInfo": "<finder>..."}

    ``text`` 里仍要保留 ``#话题#`` / ``@昵称`` 的字面文字（前端就是这么做的，
    高亮只是 DOM 上的 span 样式，``description`` 存的是 ``innerText``）。
    """
    raw_topics = [str(item).strip() for item in (topics or []) if str(item).strip()]
    mention_names = [str(item).strip() for item in (mentions or []) if str(item).strip()]

    mentioned_user = [{"nickname": name} for name in mention_names]

    lines = (text or "").split("\n")
    segments: list[str] = []
    at_indexes: list[int] = []
    index = 0

    for line_index, line in enumerate(lines):
        if line_index:
            segments.append(f"<value{index}><![CDATA[\n]]></value{index}>")
            index += 1
        # 逐段切分 @ 与 #，每个高亮片段独立成 value 段（模拟 DOM 的 span 子节点）
        cursor = 0
        for match in _iter_highlights(line, raw_topics, mention_names):
            start, end, kind, name = match
            if start > cursor:
                segments.append(_text_value(index, line[cursor:start]))
                index += 1
            if kind == "at":
                at_indexes.append(index)
                segments.append(
                    f"<value{index}><![CDATA[{name} ]]></value{index}>"
                )
            else:
                segments.append(
                    f"<value{index}><topic><![CDATA[{name}#]]></topic></value{index}>"
                )
            index += 1
            cursor = end
        if cursor < len(line):
            segments.append(_text_value(index, line[cursor:]))
            index += 1
        elif not segments or cursor == 0:
            segments.append(_text_value(index, line))
            index += 1

    xml = (
        "<finder><version>1</version>"
        f"<valuecount>{len(segments)}</valuecount>"
        f"<style><at>{_build_at_style(at_indexes)}</at></style>"
        f"{''.join(segments)}</finder>"
    )
    return {
        "topics": raw_topics,
        "mentionedUser": mentioned_user,
        "finderTopicInfo": xml,
    }


def _text_value(index: int, text: str) -> str:
    return f"<value{index}><![CDATA[{text}]]></value{index}>"


def _iter_highlights(
    line: str, topics: Sequence[str], mentions: Sequence[str]
) -> list[tuple[int, int, str, str]]:
    """在一行里按出现顺序找出 ``#话题`` 与 ``@昵称`` 的位置。"""
    found: list[tuple[int, int, str, str]] = []
    lowered = line
    for name in topics:
        for match in re.finditer(re.escape("#" + name), lowered):
            end = match.end()
            if end < len(lowered) and lowered[end] == "#":
                end += 1
            found.append((match.start(), end, "topic", name))
    for name in mentions:
        for match in re.finditer(re.escape("@" + name), lowered):
            found.append((match.start(), match.end(), "at", name))
    found.sort(key=lambda item: (item[0], -(item[1] - item[0])))
    # 去掉重叠片段
    pruned: list[tuple[int, int, str, str]] = []
    last_end = -1
    for item in found:
        if item[0] < last_end:
            continue
        pruned.append(item)
        last_end = item[1]
    return pruned


def extract_topics(text: str) -> list[str]:
    """从纯文本里抽 ``#话题``（调试/CLI 用）。"""
    return [match.group(1) for match in TOPIC_PATTERN.finditer(text or "")]


def extract_mentions(text: str) -> list[str]:
    """从纯文本里抽 ``@昵称``（调试/CLI 用）。"""
    return [match.group(1) for match in MENTION_PATTERN.finditer(text or "")]


# --------------------------------------------------------------------------
# richTextJson（Quill ops）
# --------------------------------------------------------------------------


def desc_to_delta(
    text: str,
    *,
    topics: Sequence[str] | None = None,
    mentions: Sequence[str] | None = None,
) -> list[dict[str, Any]]:
    """``descToDelta``：纯文本 -> Quill ops。

    规则（对应模块 ``7925`` 的 ``j``）：

    - ``@昵称`` -> ``{"attributes": {"at_ref": '{"1":{"1":"","2":0,"3":"<昵称>"}}'}, "insert": "@昵称"}``
    - ``#话题`` -> ``{"attributes": {"topic_ref": "#话题"}, "insert": "#话题"}``
    - 换行 -> 独立的 ``{"insert": "\\n"}``
    """
    topic_list = list(topics or [])
    mention_list = list(mentions or [])
    ops: list[dict[str, Any]] = []
    for line_index, line in enumerate((text or "").split("\n")):
        if line_index:
            ops.append({"insert": "\n"})
        cursor = 0
        for start, end, kind, name in _iter_highlights(line, topic_list, mention_list):
            if start > cursor:
                ops.append({"insert": line[cursor:start]})
            if kind == "at":
                ops.append(
                    {
                        "attributes": {
                            "at_ref": json.dumps(
                                {"1": {"1": "", "2": 0, "3": name}},
                                separators=(",", ":"),
                                ensure_ascii=False,
                            )
                        },
                        "insert": "@" + name,
                    }
                )
            else:
                ops.append(
                    {"attributes": {"topic_ref": "#" + name}, "insert": "#" + name}
                )
            cursor = end
        if cursor < len(line):
            ops.append({"insert": line[cursor:]})
    return ops


def build_rich_text_json(
    title: str,
    content: str = "",
    *,
    topics: Sequence[str] | None = None,
    mentions: Sequence[str] | None = None,
) -> str:
    """组装图文模式的 ``finderNewlifeDesc.richTextJson``。

    结构对应 ``mergeObj(genTitleRichText(), contentList)``：

    - 第一段是标题：``[{"insert": "<title>"}, {"attributes": {"header": 1}, "insert": "\\n"}]``
    - 之后是正文 ops
    - 若正文已存在则用 :func:`merge_ops` 合并（末尾补 ``\\n\\n``）
    """
    header_ops: list[dict[str, Any]] = [
        {"insert": (title or "").strip()},
        {"attributes": {"header": 1}, "insert": "\n"},
    ]
    content_ops = desc_to_delta(content, topics=topics, mentions=mentions)
    ops = merge_ops(header_ops, content_ops)
    return json.dumps(ops, ensure_ascii=False, separators=(",", ":"))


def title_from_rich_text(rich_text_json: str | Sequence[Mapping[str, Any]]) -> str:
    """从 ``richTextJson`` 里回读标题（第一个 ``header:1`` 之前的文本）。"""
    parsed = split_header(rich_text_json)
    head = parsed["headerList"]
    if not head:
        return ""
    text = "".join(
        op.get("insert", "") for op in head if isinstance(op.get("insert"), str)
    )
    return text.strip()
