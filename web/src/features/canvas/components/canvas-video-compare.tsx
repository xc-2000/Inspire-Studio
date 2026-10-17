"use client";

import { useEffect, useRef, useState } from "react";
import { App, Button, Select, Slider, Segmented } from "antd";
import { Pause, Play, RotateCcw, SplitSquareHorizontal, Link2 } from "lucide-react";
import type { CanvasVideoNode } from "../types";
import { CanvasToolDialog } from "./canvas-tool-dialog";
import styles from "./canvas-editor.module.css";

export function CanvasVideoCompare({ pair, onClose }: { pair: [CanvasVideoNode, CanvasVideoNode]; onClose: () => void }) {
    const { message } = App.useApp();
    const leftRef = useRef<HTMLVideoElement>(null), rightRef = useRef<HTMLVideoElement>(null);
    const [durations, setDurations] = useState([0, 0]);
    const [time, setTime] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(1);
    const [audio, setAudio] = useState("none");
    const [failed, setFailed] = useState<string[]>([]);
    const [layout, setLayout] = useState("horizontal");
    const playingRef = useRef(false);
    const playAttemptRef = useRef(0);
    const duration = durations.every((value) => value > 0 && Number.isFinite(value)) ? Math.min(...durations) : 0;
    const pause = () => {
        playAttemptRef.current += 1;
        playingRef.current = false;
        leftRef.current?.pause(); rightRef.current?.pause();
        setPlaying(false);
    };
    useEffect(() => {
        const left = leftRef.current, right = rightRef.current;
        return () => { playAttemptRef.current += 1; playingRef.current = false; left?.pause(); right?.pause(); };
    }, []);
    const seek = (value: number) => {
        const next = Math.min(duration, Math.max(0, value));
        [leftRef.current, rightRef.current].forEach((video) => { if (video && video.readyState >= 1) video.currentTime = next; });
        setTime(next);
    };
    const play = async () => {
        if (!duration || failed.length) return;
        if (playingRef.current) { pause(); return; }
        if (time >= duration - .05) seek(0);
        const videos = [leftRef.current, rightRef.current].filter((video): video is HTMLVideoElement => Boolean(video));
        videos.forEach((video) => { video.playbackRate = speed; });
        playingRef.current = true;
        const attempt = ++playAttemptRef.current;
        setPlaying(true);
        const results = await Promise.allSettled(videos.map((video) => video.play()));
        if (attempt !== playAttemptRef.current) return;
        if (results.some((result) => result.status === "rejected")) { pause(); message.error("视频暂时无法播放，请检查素材地址后重试"); }
        else setPlaying(true);
    };
    return <CanvasToolDialog title="视频对比" subtitle="同步查看两个镜头，比较画面、节奏与细节。" icon={<SplitSquareHorizontal />} width={1080} onClose={onClose}>
        <div className={styles.videoBody}>
        <Segmented className="mb-3" aria-label="视频对比布局" value={layout} onChange={setLayout} options={[{ label: "左右对比", value: "horizontal" }, { label: "上下对比", value: "vertical" }]} />
        <div className={styles.videoGrid} style={layout === "vertical" ? { gridTemplateColumns: "1fr" } : undefined}>
            {pair.map((node, index) => <section key={node.id} className={styles.videoCard}>
                <div className={styles.videoLabel}><span className={styles.videoLetter}>{index === 0 ? "A" : "B"}</span><span title={node.title}>{node.title}</span><span>{durations[index] ? `${durations[index].toFixed(1)}s` : "加载中"}</span></div>
                <video ref={index === 0 ? leftRef : rightRef} src={node.content.source} playsInline preload="metadata" muted={audio !== String(index)} onLoadedMetadata={(event) => { const value = event.currentTarget.duration; setDurations((current) => current.map((item, i) => i === index ? value : item)); }} onEnded={() => { pause(); seek(duration); }} onError={() => { pause(); setFailed((current) => [...new Set([...current, node.id])]); }} onTimeUpdate={(event) => {
                    if (index !== 0) return;
                    const current = event.currentTarget.currentTime;
                    setTime(duration ? Math.min(current, duration) : current);
                    if (playingRef.current && duration && current >= duration) { pause(); seek(duration); return; }
                    if (playingRef.current && rightRef.current && Math.abs(rightRef.current.currentTime - current) > .2) rightRef.current.currentTime = current;
                }} aria-label={`对比视频 ${index === 0 ? "A" : "B"}`} />
                {failed.includes(node.id) ? <p role="alert" className="px-3 py-2 text-xs text-red-500">视频加载失败，请检查节点中的素材是否可访问。</p> : null}
            </section>)}
        </div>
        <div className={styles.playback}>
        <div className={styles.playbackControls}>
            <Button type="primary" disabled={!duration || Boolean(failed.length)} onClick={() => void play()} icon={playing ? <Pause className="size-4" /> : <Play className="size-4" />}>{playing ? "同时暂停" : "同时播放"}</Button>
            <Button aria-label="重新播放对比" disabled={!duration} icon={<RotateCcw className="size-4" />} onClick={() => { pause(); seek(0); }} />
            <span className={styles.time}>{time.toFixed(1)} / {duration.toFixed(1)} 秒</span>
            <div className={styles.playbackOptions}>
            <Select aria-label="播放速度" value={speed} onChange={(value) => { setSpeed(value); [leftRef.current, rightRef.current].forEach((video) => { if (video) video.playbackRate = value; }); }} options={[.5, 1, 1.5, 2].map((value) => ({ value, label: `${value}×` }))} />
            <Select aria-label="对比音频" value={audio} onChange={setAudio} options={[{ value: "none", label: "静音" }, { value: "0", label: "播放 A 音频" }, { value: "1", label: "播放 B 音频" }]} />
            </div>
        </div>
        <Slider ariaLabelForHandle="同步播放进度" min={0} max={duration || 1} step={.01} value={Math.min(time, duration)} disabled={!duration} onChange={(value) => { pause(); seek(value); }} tooltip={{ formatter: (value) => `${(value || 0).toFixed(2)} 秒` }} />
        </div>
        <p className={styles.videoNote}><Link2 className="size-3" />同步进度 · 在较短视频结束时停止</p>
        </div>
    </CanvasToolDialog>;
}
