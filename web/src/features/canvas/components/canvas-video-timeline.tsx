"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { App, Button, Checkbox, Input, InputNumber, Select, Slider, Space, Table } from "antd";
import { ArrowDown, ArrowUp, Captions, Scissors, Trash2, Video } from "lucide-react";
import { nanoid } from "nanoid";
import { saveAs } from "file-saver";
import { composeVideo, type VideoCompositionTask, type VideoEditingOptions } from "@/services/api/video-composition";
import type { CanvasVideoNode } from "../types";
import { parseSrt, exportSrt, splitTimelineClip, type TimelineDraft, type TimelineClip } from "../domain/canvas-timeline";
import { CanvasToolDialog } from "./canvas-tool-dialog";

export function CanvasVideoTimeline({
    videos,
    selected,
    initial,
    onDraft,
    onTask,
    onClose,
}: {
    videos: CanvasVideoNode[];
    selected: string[];
    initial?: TimelineDraft;
    onDraft: (draft: TimelineDraft) => void;
    onTask: (task: VideoCompositionTask, sources: string[], options: VideoEditingOptions) => void;
    onClose: () => void;
}) {
    const { message } = App.useApp();
    const makeClip = (video: CanvasVideoNode): TimelineClip => ({ id: nanoid(), nodeId: video.id, startMs: 0, endMs: video.content.durationMilliseconds || 0, muted: false });
    const [clips, setClips] = useState<TimelineClip[]>(
        () =>
            initial?.clips ||
            videos
                .filter((v) => selected.includes(v.id))
                .map(makeClip),
    );
    const [subtitles, setSubtitles] = useState(initial?.subtitles || []);
    const [fontSize, setFontSize] = useState(initial?.fontSize || 36),
        [index, setIndex] = useState(0),
        [page, setPage] = useState(1);
    const [time, setTime] = useState(0),
        [submitting, setSubmitting] = useState(false),
        [error, setError] = useState("");
    const player = useRef<HTMLVideoElement>(null),
        upload = useRef<HTMLInputElement>(null);
    const playingIntent = useRef(false);
    const completedClipId = useRef<string | null>(null);
    const autoplayClipId = useRef<string | null>(null);
    const callback = useRef(onDraft);
    callback.current = onDraft;
    useEffect(() => {
        callback.current({ clips, subtitles, fontSize });
    }, [clips, subtitles, fontSize]);
    const clip = clips[index],
        video = videos.find((node) => node.id === clip?.nodeId);
    const activeClipId = useRef(clip?.id);
    activeClipId.current = clip?.id;
    const offset = clips.slice(0, index).reduce((sum, item) => sum + Math.max(0, item.endMs - item.startMs), 0);
    const total = clips.reduce((sum, item) => sum + Math.max(0, item.endMs - item.startMs), 0);
    const timelineTime = offset + Math.max(0, time - (clip?.startMs || 0));
    const clipLimitError = clips.length > 20 ? `当前有 ${clips.length} 段视频，单次剪辑最多 20 段。请分段导出，或在短剧工作台合成完整短剧。` : "";
    const caption = subtitles
        .filter((s) => timelineTime >= s.startMs && timelineTime < s.endMs)
        .map((s) => s.text)
        .join("\n");
    const updateClip = (patch: Partial<TimelineClip>) => setClips((items) => items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
    const seek = (ms: number) => {
        if (player.current) player.current.currentTime = ms / 1000;
        setTime(ms);
    };
    useLayoutEffect(() => {
        completedClipId.current = null;
        if (clip) {
            seek(clip.startMs);
            if (autoplayClipId.current !== clip.id) {
                autoplayClipId.current = null;
                playingIntent.current = false;
            }
        }
    }, [clip?.id]);
    const advancePreview = (element: HTMLVideoElement) => {
        if (!clip || activeClipId.current !== clip.id || completedClipId.current === clip.id || (!playingIntent.current && !element.ended)) return;
        completedClipId.current = clip.id;
        const next = clips[index + 1];
        if (next) {
            autoplayClipId.current = next.id;
            element.pause();
            setIndex(index + 1);
            setTime(next.startMs);
        } else {
            autoplayClipId.current = null;
            playingIntent.current = false;
            element.pause();
        }
    };
    const exportVideo = async () => {
        if (submitting) return;
        setSubmitting(true);
        setError("");
        try {
            if (clipLimitError) throw new Error(clipLimitError);
            if (!clips.length || clips.some((item) => item.endMs - item.startMs < 100)) throw new Error("请添加视频，并为每个片段设置至少 0.1 秒的有效范围");
            if (subtitles.some((s) => s.startMs < 0 || s.endMs <= s.startMs || s.endMs > total)) throw new Error("字幕时间应在最终成片时长内，且结束晚于开始");
            const keys = clips.map((item) => videos.find((v) => v.id === item.nodeId)?.content.storageKey);
            if (keys.some((key) => !key)) throw new Error("部分视频尚未保存到对象存储或已从画布删除");
            const options: VideoEditingOptions = {
                clips: clips.map(({ startMs, endMs, muted }) => ({ startMs: Math.round(startMs), endMs: Math.round(endMs), muted })),
                subtitles: subtitles.map((s) => ({ startMs: Math.round(s.startMs), endMs: Math.round(s.endMs), text: s.text })),
                fontSize,
            };
            const task = await composeVideo(keys as string[], options);
            onTask(
                task,
                clips.map((item) => item.nodeId),
                options,
            );
            message.success("剪辑任务已提交，可在画布查看进度");
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : "提交失败");
        } finally {
            setSubmitting(false);
        }
    };
    return (
        <CanvasToolDialog title="视频剪辑" subtitle="调整镜头顺序和长度，添加字幕，输出完整成片。草稿随画布自动保存。" icon={<Scissors />} width={1120} onClose={onClose}>
            <div className="max-h-[72vh] overflow-auto p-5">
                {(error || clipLimitError) && (
                    <p role="alert" className="mb-4 text-sm text-red-500">
                        {error || clipLimitError}
                    </p>
                )}
                <div className="grid gap-4 md:grid-cols-[minmax(0,1.4fr)_minmax(240px,1fr)]">
                    <div className="relative flex min-h-48 items-center justify-center overflow-hidden rounded-2xl bg-black">
                        {video ? (
                            <video
                                key={clip.id}
                                ref={player}
                                src={video.content.source}
                                controls
                                playsInline
                                muted={clip?.muted}
                                className="max-h-80 w-full object-contain"
                                onLoadedMetadata={(event) => {
                                    const duration = Math.round(event.currentTarget.duration * 1000);
                                    if (Number.isFinite(duration) && duration > 0) setClips((items) => items.map((item) => (item.nodeId === video.id && !item.endMs ? { ...item, endMs: duration } : item)));
                                    seek(clip.startMs);
                                    if (autoplayClipId.current === clip.id) {
                                        autoplayClipId.current = null;
                                        void event.currentTarget.play().catch(() => { playingIntent.current = false; });
                                    }
                                }}
                                onPlay={(event) => {
                                    playingIntent.current = true;
                                    completedClipId.current = null;
                                    if (clip.endMs > 0 && event.currentTarget.currentTime * 1000 >= clip.endMs) seek(clip.startMs);
                                }}
                                onPause={(event) => {
                                    const atEnd = event.currentTarget.ended || (clip.endMs > 0 && event.currentTarget.currentTime * 1000 >= clip.endMs);
                                    if (!autoplayClipId.current && !atEnd) playingIntent.current = false;
                                }}
                                onEnded={(event) => advancePreview(event.currentTarget)}
                                onError={() => {
                                    autoplayClipId.current = null;
                                    playingIntent.current = false;
                                    setError(`片段 ${index + 1} 无法播放，请检查视频文件后继续。`);
                                }}
                                onTimeUpdate={(event) => {
                                    const ms = event.currentTarget.currentTime * 1000;
                                    setTime(ms);
                                    if (clip.endMs > 0 && ms >= clip.endMs) advancePreview(event.currentTarget);
                                }}
                            />
                        ) : (
                            <span className="text-sm text-white/50">添加一个视频开始剪辑</span>
                        )}
                        {caption && (
                            <div className="pointer-events-none absolute bottom-12 left-4 right-4 whitespace-pre-line text-center font-medium text-white [text-shadow:0_1px_4px_black]" style={{ fontSize: Math.min(28, fontSize * 0.5) }}>
                                {caption}
                            </div>
                        )}
                    </div>
                    <div className="space-y-4">
                        <Select
                            className="w-full"
                            placeholder="从画布添加视频"
                            aria-label="添加剪辑视频"
                            value={null}
                            disabled={clips.length >= 20}
                            onChange={(id) => {
                                const node = videos.find((v) => v.id === id);
                                if (node) {
                                    setClips((items) => [...items, makeClip(node)]);
                                    setIndex(clips.length);
                                }
                            }}
                            options={videos.map((node) => ({ label: node.title, value: node.id }))}
                        />
                        {clip && (
                            <>
                                <p className="text-sm font-medium">
                                    片段 {index + 1} · {video?.title || "源视频已删除"}
                                </p>
                                <Space wrap>
                                    <label className="text-xs">
                                        起点（秒）
                                        <InputNumber aria-label="视频裁剪起点" min={0} step={0.1} value={clip.startMs / 1000} onChange={(value) => updateClip({ startMs: Math.round((value || 0) * 1000) })} />
                                    </label>
                                    <label className="text-xs">
                                        终点（秒）
                                        <InputNumber aria-label="视频裁剪终点" min={0.1} step={0.1} value={clip.endMs / 1000} onChange={(value) => updateClip({ endMs: Math.round((value || 0) * 1000) })} />
                                    </label>
                                </Space>
                                <Checkbox checked={clip.muted} onChange={(event) => updateClip({ muted: event.target.checked })}>
                                    片段静音
                                </Checkbox>
                                <Space wrap>
                                    <Button
                                        icon={<Scissors size={14} />}
                                        disabled={clips.length >= 20}
                                        onClick={() => {
                                            try {
                                                setClips(splitTimelineClip(clips, index, Math.round(time), nanoid()));
                                            } catch (e) {
                                                message.warning((e as Error).message);
                                            }
                                        }}
                                    >
                                        在播放头分割
                                    </Button>
                                    <Button
                                        aria-label="片段前移"
                                        disabled={index === 0}
                                        icon={<ArrowUp size={14} />}
                                        onClick={() => {
                                            const next = [...clips];
                                            [next[index - 1], next[index]] = [next[index], next[index - 1]];
                                            setClips(next);
                                            setIndex(index - 1);
                                        }}
                                    />
                                    <Button
                                        aria-label="片段后移"
                                        disabled={index >= clips.length - 1}
                                        icon={<ArrowDown size={14} />}
                                        onClick={() => {
                                            const next = [...clips];
                                            [next[index + 1], next[index]] = [next[index], next[index + 1]];
                                            setClips(next);
                                            setIndex(index + 1);
                                        }}
                                    />
                                    <Button
                                        danger
                                        aria-label="删除剪辑片段"
                                        icon={<Trash2 size={14} />}
                                        onClick={() => {
                                            setClips((items) => items.filter((_, i) => i !== index));
                                            setIndex(Math.max(0, index - 1));
                                        }}
                                    />
                                </Space>
                            </>
                        )}
                        <p className="text-xs opacity-60">
                            总时长 {(total / 1000).toFixed(1)} 秒 · 当前 {(timelineTime / 1000).toFixed(1)} 秒
                        </p>
                    </div>
                </div>
                <div className="my-5 flex gap-1 overflow-x-auto rounded-xl border border-current/10 p-2" aria-label="视频时间轴">
                    {clips.map((item, i) => (
                        <button
                            key={item.id}
                            onClick={() => setIndex(i)}
                            type="button"
                            aria-pressed={index === i}
                            className={`min-w-24 shrink-0 rounded-lg border p-3 text-left text-xs ${index === i ? "border-cyan-500 bg-cyan-500/15" : "border-current/10 bg-current/5"}`}
                            style={{ flexBasis: Math.max(96, ((item.endMs - item.startMs) / Math.max(total, 1)) * 700) }}
                        >
                            <Video size={14} className="mb-2" />
                            {i + 1}. {videos.find((v) => v.id === item.nodeId)?.title || "已删除"}
                            <span className="mt-1 block opacity-60">{((item.endMs - item.startMs) / 1000).toFixed(1)} 秒</span>
                        </button>
                    ))}
                </div>
                {clip && clip.endMs > clip.startMs && (
                    <Slider
                        ariaLabelForHandle="片段播放位置"
                        min={clip.startMs}
                        max={clip.endMs}
                        step={10}
                        value={Math.max(clip.startMs, Math.min(time, clip.endMs))}
                        onChange={seek}
                        tooltip={{ formatter: (value) => `${((value || 0) / 1000).toFixed(2)} 秒` }}
                    />
                )}
                <div className="mb-3 mt-6 flex flex-wrap items-center justify-between gap-3">
                    <h3 className="flex items-center gap-2 text-sm font-semibold">
                        <Captions size={16} />
                        字幕
                    </h3>
                    <Space wrap>
                        <Button onClick={() => upload.current?.click()}>导入 SRT / VTT</Button>
                        <Button disabled={!subtitles.length} onClick={() => saveAs(new Blob([exportSrt(subtitles)], { type: "text/plain;charset=utf-8" }), "subtitles.srt")}>
                            导出字幕
                        </Button>
                        <InputNumber aria-label="字幕字号" min={12} max={120} value={fontSize} onChange={(value) => setFontSize(value || 36)} />
                        <Button
                            disabled={!total || subtitles.length >= 500}
                            onClick={() => setSubtitles((items) => [...items, { id: nanoid(), startMs: Math.round(Math.min(timelineTime, Math.max(0, total - 100))), endMs: Math.round(Math.min(total, timelineTime + 2000)), text: "输入字幕" }])}
                        >
                            添加字幕
                        </Button>
                    </Space>
                </div>
                <input
                    ref={upload}
                    type="file"
                    className="hidden"
                    accept=".srt,.vtt"
                    onChange={async (event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (!file) return;
                        try {
                            setSubtitles(parseSrt(await file.text()));
                            setPage(1);
                        } catch (e) {
                            message.error((e as Error).message);
                        }
                    }}
                />
                <Table
                    size="small"
                    dataSource={subtitles}
                    rowKey="id"
                    pagination={{ current: page, pageSize: 5, onChange: setPage, hideOnSinglePage: true }}
                    columns={[
                        {
                            title: "开始 / 结束（秒）",
                            width: 205,
                            render: (_, item) => (
                                <Space>
                                    <InputNumber
                                        aria-label="字幕开始时间"
                                        min={0}
                                        step={0.1}
                                        value={item.startMs / 1000}
                                        onChange={(value) => setSubtitles((items) => items.map((s) => (s.id === item.id ? { ...s, startMs: Math.round((value || 0) * 1000) } : s)))}
                                    />
                                    <InputNumber
                                        aria-label="字幕结束时间"
                                        min={0.1}
                                        step={0.1}
                                        value={item.endMs / 1000}
                                        onChange={(value) => setSubtitles((items) => items.map((s) => (s.id === item.id ? { ...s, endMs: Math.round((value || 0) * 1000) } : s)))}
                                    />
                                </Space>
                            ),
                        },
                        {
                            title: "字幕内容",
                            render: (_, item) => (
                                <Input.TextArea aria-label="字幕内容" rows={1} maxLength={1000} value={item.text} onChange={(event) => setSubtitles((items) => items.map((s) => (s.id === item.id ? { ...s, text: event.target.value } : s)))} />
                            ),
                        },
                        { title: "", width: 40, render: (_, item) => <Button type="text" danger aria-label="删除字幕" icon={<Trash2 size={14} />} onClick={() => setSubtitles((items) => items.filter((s) => s.id !== item.id))} /> },
                    ]}
                />
                <div className="mt-5 flex justify-end">
                    <Button type="primary" loading={submitting} disabled={!clips.length || Boolean(clipLimitError)} onClick={() => void exportVideo()}>
                        导出成片到画布
                    </Button>
                </div>
            </div>
        </CanvasToolDialog>
    );
}
