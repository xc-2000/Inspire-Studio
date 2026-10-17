"use client";

import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { AudioLines, LoaderCircle, Mic, Pause, Play, Upload } from "lucide-react";
import { App, theme as antDesignTheme } from "antd";
import type { CanvasAudioNode } from "../types";
import { useCanvasTheme } from "../components/canvas-theme-provider";
import { useNodeActions } from "./node-action-context";
import { CanvasConnectionHandles, CanvasNodeTitle, NodeHoverSurface } from "./shared";
import { formatAudioTime } from "@/features/storage/utils/audio-waveform";
import { audioNodeTrimRange } from "../utils/audio-trim";

import { activateCanvasAudio, releaseCanvasAudio } from "../services/canvas-audio-playback";
import { DEFAULT_SPEECH_VOICE, MAX_SPEECH_TEXT_LENGTH, SPEECH_VOICE_OPTIONS } from "@/features/generation/lib/speech-voices";
import { useEffectiveConfig, selectableModelsByCapability } from "@/features/settings/stores/use-config-store";
import { ModelPicker } from "@/features/settings/components/model-picker";

/** 文字配音表单：输入台词与音色后生成配音；画布快捷键不应在输入时触发。 */
function SpeechPanel({ data, onCancel }: { data: CanvasAudioNode; onCancel?: () => void }) {
    const theme = useCanvasTheme();
    const actions = useNodeActions();
    const config = useEffectiveConfig();
    const models = selectableModelsByCapability(config, "audio");
    const [selectedModel, setSelectedModel] = useState(data.speech?.model || "");
    const model = models.includes(selectedModel) ? selectedModel : models.includes(config.audioModel) ? config.audioModel : models[0] || "";
    const [text, setText] = useState(data.speech?.text || "");
    const [voice, setVoice] = useState(data.speech?.voice || DEFAULT_SPEECH_VOICE);
    const running = data.execution.phase === "running";
    const voices = SPEECH_VOICE_OPTIONS.some((option) => option.value === voice) ? SPEECH_VOICE_OPTIONS : [...SPEECH_VOICE_OPTIONS, { value: voice, label: voice }];
    const submit = () => {
        if (!text.trim() || !model || running) return;
        actions.onGenerateSpeech?.(data, { ...data.speech, text: text.trim(), voice, model });
        onCancel?.();
    };
    if (running) return <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm" style={{ color: theme.node.muted }}>
        <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />配音生成中{data.execution.progress ? ` ${data.execution.progress}%` : "…"}
    </div>;
    return <div className="nodrag nopan nowheel flex min-h-0 flex-1 flex-col gap-2" data-canvas-no-zoom onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
        <ModelPicker config={config} capability="audio" value={model} onChange={setSelectedModel} placeholder="选择语音模型" fullWidth className="!h-7 shrink-0 !rounded-md !px-2 !text-xs" />
        <textarea aria-label="配音文字" value={text} maxLength={MAX_SPEECH_TEXT_LENGTH} onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(); }}
            placeholder={actions.speechAvailable === false ? "后台还没有配置语音模型" : "输入要配音的台词或旁白，Ctrl+Enter 生成"}
            className="min-h-0 flex-1 resize-none rounded-md border p-2 text-xs leading-5 outline-none focus-visible:outline-2"
            style={{ background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }} />
        {data.execution.phase === "failed" && data.execution.errorMessage ? <div className="line-clamp-2 text-[11px] text-red-500" title={data.execution.errorMessage}>{data.execution.errorMessage}</div> : null}
        <div className="flex shrink-0 items-center gap-2">
            <select aria-label="音色" value={voice} onChange={(event) => setVoice(event.target.value)} className="h-7 min-w-0 flex-1 rounded-md border px-1 text-xs" style={{ background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}>
                {voices.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            {onCancel ? <button type="button" className="h-7 rounded-md px-2 text-xs" style={{ color: theme.node.muted }} onClick={onCancel}>取消</button>
                : <button type="button" aria-label="上传音频" title="上传音频" className="grid size-7 place-items-center rounded-md border" style={{ borderColor: theme.node.stroke, color: theme.node.muted }} onClick={() => actions.onUpload(data)}><Upload className="size-3.5" /></button>}
            <button type="button" disabled={!text.trim() || !model} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium disabled:opacity-40" style={{ background: theme.node.activeStroke, color: "#fff" }} onClick={submit}><Mic className="size-3.5" />生成配音</button>
        </div>
    </div>;
}

/** 进度滑块自己消费的按键；其余按键（如 Delete）要放行给画布快捷键。 */
const AUDIO_SEEK_KEYS = ["ArrowLeft", "ArrowRight", "Home", "End"];

/** 在画布内部播放音频，播放状态不写入文档，卸载时释放媒体资源。 */
export const AudioNode = memo(function AudioNode({ data, selected }: NodeProps<Node<CanvasAudioNode>>) {
    const theme = useCanvasTheme();
    const actions = useNodeActions();
    const { token } = antDesignTheme.useToken();
    const { message } = App.useApp();
    const audioRef = useRef<HTMLAudioElement>(null);
    const waveformRef = useRef<HTMLDivElement>(null);
    const playbackRequestRef = useRef(false);
    const playbackPointerRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
    const seekPointerIdRef = useRef<number | null>(null);
    const [playing, setPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [failed, setFailed] = useState(false);
    const [editingSpeech, setEditingSpeech] = useState(false);
    const trim = audioNodeTrimRange(data.content);
    const trimStart = trim.startMs / 1000;
    const trimEnd = trim.endMs / 1000;
    const duration = trim.durationMs / 1000;
    const progress = duration ? Math.min(1, Math.max(0, (currentTime - trimStart) / duration)) : 0;

    const updatePlaybackTime = useCallback((time: number) => {
        const audio = audioRef.current;
        if (!audio || !duration) return;
        const nextTime = Math.min(trimEnd, Math.max(trimStart, time));
        audio.currentTime = nextTime;
        audio.pause();
        setCurrentTime(nextTime);
        setPlaying(false);
    }, [duration, trimEnd, trimStart]);

    const updatePlaybackPosition = useCallback((clientX: number) => {
        const waveform = waveformRef.current;
        if (!waveform || !duration) return;
        const bounds = waveform.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width));
        updatePlaybackTime(trimStart + ratio * (trimEnd - trimStart));
    }, [duration, trimEnd, trimStart, updatePlaybackTime]);

    const handleSeekPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
        if (!selected || !duration) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        seekPointerIdRef.current = event.pointerId;
        updatePlaybackPosition(event.clientX);
    }, [duration, selected, updatePlaybackPosition]);

    const handleSeekPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
        if (seekPointerIdRef.current !== event.pointerId) return;
        updatePlaybackPosition(event.clientX);
    }, [updatePlaybackPosition]);

    const handleSeekPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
        if (seekPointerIdRef.current !== event.pointerId) return;
        seekPointerIdRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }, []);

    const handleSeekKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
        if (!selected || !duration || !AUDIO_SEEK_KEYS.includes(event.key)) return;
        event.preventDefault();
        const step = event.shiftKey ? 1 : 0.1;
        const nextTime = event.key === "Home" ? trimStart : event.key === "End" ? trimEnd : currentTime + (event.key === "ArrowRight" ? step : -step);
        updatePlaybackTime(nextTime);
    }, [currentTime, duration, selected, trimEnd, trimStart, updatePlaybackTime]);

    useEffect(() => {
        const audio = audioRef.current;
        if (audio) {
            audio.src = data.content.source;
        }
        setPlaying(false);
        setCurrentTime(trimStart);
        setFailed(false);
        playbackRequestRef.current = false;
        playbackPointerRef.current = null;
        return () => {
            if (!audio) return;
            playbackRequestRef.current = false;
            releaseCanvasAudio(audio);
            audio.removeAttribute("src");
            audio.load();
        };
    }, [data.content.source, trimStart, trimEnd]);

    /** 点击后才允许播放，播放失败保留替换和重试入口。 */
    const togglePlayback = async () => {
        const audio = audioRef.current;
        if (!audio) return;
        if (!audio.paused) {
            playbackRequestRef.current = false;
            return audio.pause();
        }
        activateCanvasAudio(audio);
        if (failed) audio.load();
        if (audio.ended || audio.currentTime < trimStart || audio.currentTime >= trimEnd - 0.01) audio.currentTime = trimStart;
        playbackRequestRef.current = true;
        try {
            await audio.play();
            setFailed(false);
        } catch (error) {
            playbackRequestRef.current = false;
            if (error instanceof DOMException && error.name === "AbortError") return;
            setFailed(true);
            message.error("音频播放失败，请重试或替换文件");
        }
    };

    return <>
        <NodeResizer minWidth={280} minHeight={150} isVisible={selected} lineStyle={{ borderColor: theme.node.activeStroke }} handleStyle={{ borderColor: theme.node.activeStroke, backgroundColor: theme.node.panel }} onResizeEnd={(_, frame) => actions.onResize?.(data.id, frame.width, frame.height, { x: frame.x, y: frame.y })} />
        <NodeHoverSurface nodeId={data.id} className="relative flex h-full w-full select-none flex-col rounded-lg border p-3" style={{ background: theme.node.fill, borderColor: selected ? theme.node.activeStroke : theme.node.stroke, color: theme.node.text }}>
            <CanvasNodeTitle nodeId={data.id} title={data.title} defaultTitle="音频" onTitleChange={actions.onTitleChange} />
            {editingSpeech || (data.content.source && data.execution.phase === "running" && data.speech) ? <SpeechPanel data={data} onCancel={data.execution.phase === "running" ? undefined : () => setEditingSpeech(false)} /> : data.content.source ? <div className="nopan nowheel flex min-h-0 flex-1 flex-col gap-2" data-canvas-no-zoom onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (AUDIO_SEEK_KEYS.includes(event.key)) event.stopPropagation(); }}>
                <audio ref={audioRef} src={data.content.source} preload="metadata" onLoadedMetadata={(event) => { event.currentTarget.currentTime = trimStart; setCurrentTime(trimStart); }} onPlay={(event) => { if (!playbackRequestRef.current) { event.currentTarget.pause(); return; } playbackRequestRef.current = false; activateCanvasAudio(event.currentTarget); setPlaying(true); }} onPause={() => { playbackRequestRef.current = false; setPlaying(false); }} onEnded={() => { playbackRequestRef.current = false; setPlaying(false); setCurrentTime(trimEnd); }} onError={() => setFailed(true)} onTimeUpdate={(event) => { const time = event.currentTarget.currentTime; if (time >= trimEnd) { event.currentTarget.pause(); event.currentTarget.currentTime = trimEnd; } setCurrentTime(Math.min(trimEnd, Math.max(trimStart, time))); }} />
                <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg focus-within:outline focus-within:outline-2 focus-within:outline-offset-2" style={{ background: theme.node.panel }}>
                    <svg className="absolute inset-0 h-full w-full p-4" viewBox="0 0 512 100" preserveAspectRatio="none" aria-hidden="true">
                        {data.content.waveformPeaks.map((peak, index) => <line key={index} x1={index * 4 + 2} x2={index * 4 + 2} y1={50 - Math.max(1, peak * 44)} y2={50 + Math.max(1, peak * 44)} stroke={index / 128 <= progress ? theme.node.text : theme.node.muted} strokeWidth={2} strokeLinecap="round" />)}
                    </svg>
                    <div className="nodrag nopan absolute inset-0 p-4">
                        <div ref={waveformRef} className="relative h-full w-full">
                            <div role="slider" tabIndex={selected && duration ? 0 : -1} aria-label="音频播放进度" aria-valuemin={trimStart} aria-valuemax={trimEnd} aria-valuenow={Math.min(trimEnd, Math.max(trimStart, currentTime))} aria-valuetext={`${formatAudioTime(Math.max(0, currentTime - trimStart))} / ${formatAudioTime(duration)}`} className={`${selected ? "pointer-events-auto" : "pointer-events-none"} nodrag nopan absolute inset-y-0 z-10 w-4 -translate-x-1/2 cursor-ew-resize touch-none`} style={{ left: `${progress * 100}%` }} onPointerDown={handleSeekPointerDown} onPointerMove={handleSeekPointerMove} onPointerUp={handleSeekPointerUp} onPointerCancel={handleSeekPointerUp} onKeyDown={handleSeekKeyDown}>
                                <span className="absolute left-1/2 top-0 h-full w-1 -translate-x-1/2 rounded-full" style={{ background: token.colorError }} />
                            </div>
                        </div>
                    </div>
                </div>
                <div className="relative flex h-8 shrink-0 items-center justify-between text-sm tabular-nums" style={{ color: theme.node.muted }}>
                    <span>{formatAudioTime(Math.max(0, currentTime - trimStart))} / {formatAudioTime(duration)}</span>
                    <button type="button" aria-label={playing ? "暂停音频" : failed ? "重试播放音频" : "播放音频"} title={playing ? "暂停" : "播放"} className="absolute left-1/2 grid size-8 -translate-x-1/2 place-items-center rounded-full border focus-visible:outline-2" style={{ borderColor: theme.node.stroke }} onPointerDown={(event) => { event.stopPropagation(); playbackPointerRef.current = { x: event.clientX, y: event.clientY, moved: false }; }} onPointerMove={(event) => { const pointer = playbackPointerRef.current; if (pointer && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 3) pointer.moved = true; }} onClick={(event) => { const pointer = playbackPointerRef.current; playbackPointerRef.current = null; if (pointer?.moved) return; void togglePlayback(); }}>{playing ? <Pause className="size-4" /> : <Play className="size-4" />}</button>
                    {failed ? <button type="button" className="text-xs" onClick={() => actions.onUpload(data)}>播放失败，替换文件</button>
                        : data.speech && actions.onGenerateSpeech ? <button type="button" className="inline-flex items-center gap-1 text-xs" title={data.speech.text} onClick={() => setEditingSpeech(true)}><Mic className="size-3.5" />重新配音</button>
                        : <AudioLines className="size-4" aria-hidden="true" />}
                </div>
            </div> : actions.onGenerateSpeech ? <SpeechPanel data={data} />
                : <button type="button" className="nodrag nopan flex flex-1 flex-col items-center justify-center gap-2 text-sm" style={{ color: theme.node.muted }} onClick={() => actions.onUpload(data)}><Upload className="size-6" />{data.execution.phase === "failed" ? "上传失败，重新上传" : "上传音频"}</button>}
            <CanvasConnectionHandles />
        </NodeHoverSurface>
    </>;
});
