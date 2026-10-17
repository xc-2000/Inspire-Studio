"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { homepageFallbackVideoUrls } from "../api/homepage-showcases";
import type { HomepageShowcase } from "@/services/api/server";

export function HomepageVideoHero({ items }: { items: HomepageShowcase[] }) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const reduceMotion = useReducedMotion();
    const [index, setIndex] = useState(0);
    const [paused, setPaused] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [failed, setFailed] = useState<string[]>([]);
    const remoteUrls = items.filter((item) => item.mediaType === "video" && item.mediaUrl).map((item) => item.mediaUrl);
    const urls = [...new Set(remoteUrls.length >= 2 ? remoteUrls : [...remoteUrls, ...homepageFallbackVideoUrls])].filter((url) => !failed.includes(url));
    const current = index % Math.max(urls.length, 1);
    const src = urls[current];
    const [motionOverride, setMotionOverride] = useState(false);
    const shouldPlay = !paused && (!reduceMotion || motionOverride);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        if (shouldPlay) void video.play().catch(() => setPlaying(false));
        else video.pause();
    }, [src, shouldPlay]);

    const move = (direction: number) => setIndex((current + direction + urls.length) % urls.length);
    const buttonClass = "grid size-11 place-items-center rounded-full border border-white/25 bg-black/40 text-white backdrop-blur transition-colors hover:bg-black/65 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

    return (
        <section aria-label="首页视频轮播" aria-roledescription="轮播" className="relative isolate h-[180px] w-full overflow-hidden rounded-2xl bg-black sm:h-[240px] lg:h-[300px]">
            {src ? <>
                <video
                    key={src}
                    ref={videoRef}
                    src={src}
                    aria-label={`精选视频 ${current + 1}`}
                    autoPlay={shouldPlay}
                    muted
                    playsInline
                    preload="auto"
                    className="absolute inset-0 size-full object-cover"
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onEnded={() => {
                        if (urls.length > 1) move(1);
                        else if (shouldPlay && videoRef.current) {
                            videoRef.current.currentTime = 0;
                            void videoRef.current.play().catch(() => setPlaying(false));
                        }
                    }}
                    onError={() => setFailed((previous) => [...previous, src])}
                />
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 bg-gradient-to-t from-black/45 to-transparent p-3 pt-10 sm:p-5 sm:pt-12">
                    <div className="flex items-center gap-2">
                        {urls.length > 1 && <button type="button" aria-label="上一个视频" onClick={() => move(-1)} className={buttonClass}><ChevronLeft className="size-4" /></button>}
                        <button type="button" aria-label={playing ? "暂停视频轮播" : "播放视频轮播"} onClick={() => {
                            setPaused(playing);
                            if (!playing) {
                                setMotionOverride(true);
                                void videoRef.current?.play().catch(() => setPlaying(false));
                            }
                        }} className={buttonClass}>{playing ? <Pause className="size-4" /> : <Play className="size-4" />}</button>
                        {urls.length > 1 && <button type="button" aria-label="下一个视频" onClick={() => move(1)} className={buttonClass}><ChevronRight className="size-4" /></button>}
                    </div>
                    <span aria-label={`第 ${current + 1} 个视频，共 ${urls.length} 个`} className="text-xs tabular-nums text-white/90">{String(current + 1).padStart(2, "0")} / {String(urls.length).padStart(2, "0")}</span>
                </div>
            </> : <div role="status" className="grid h-full place-content-center gap-3 text-center text-sm text-white/80">视频暂时无法播放<button type="button" className="min-h-11 underline" onClick={() => { setFailed([]); setIndex(0); }}>重新加载</button></div>}
        </section>
    );
}
