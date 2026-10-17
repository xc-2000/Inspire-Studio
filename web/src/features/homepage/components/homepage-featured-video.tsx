"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { useReducedMotion } from "motion/react";
import type { HomepageVideoShowcase } from "../api/original-video-showcases";
import styles from "./homepage-featured-video.module.css";

type HomepageFeaturedVideoProps = {
    items: HomepageVideoShowcase[];
    loading: boolean;
};

export function HomepageFeaturedVideo({ items, loading }: HomepageFeaturedVideoProps) {
    const frameRef = useRef<HTMLElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const reduceMotion = useReducedMotion();
    const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
    const [failedUrls, setFailedUrls] = useState<string[]>([]);
    const [motionOverride, setMotionOverride] = useState(false);
    const [inView, setInView] = useState(false);
    const [pageVisible, setPageVisible] = useState(false);

    const videos = useMemo(() => {
        const seen = new Set<string>();
        const result: HomepageVideoShowcase[] = [];
        for (const item of items) {
            const url = item.mediaUrl?.trim();
            if (item.mediaType !== "video" || !url || seen.has(url)) continue;
            seen.add(url);
            result.push({ ...item, mediaUrl: url });
            if (result.length === 4) break;
        }
        return result;
    }, [items]);
    const available = videos.filter((item) => !failedUrls.includes(item.mediaUrl));
    // Keep the selected film when the list changes, and safely fall back to its first valid item.
    const index = Math.max(0, available.findIndex((item) => item.mediaUrl === selectedUrl));
    const current = available[index];
    const src = current?.mediaUrl;
    const shouldPlay = inView && pageVisible && (reduceMotion === false || motionOverride);
    const allFailed = videos.length > 0 && available.length === 0;

    useEffect(() => {
        const frame = frameRef.current;
        if (!frame) return;
        let lastVisible: boolean | null = null;
        const observer = new IntersectionObserver(([entry]) => {
            const visible = entry.isIntersecting && entry.intersectionRatio > 0;
            if (lastVisible === visible) return;
            lastVisible = visible;
            if (!visible) videoRef.current?.pause();
            setInView(visible);
        }, { threshold: [0, 0.01] });
        observer.observe(frame);

        const updatePageVisibility = () => {
            if (document.hidden) videoRef.current?.pause();
            setPageVisible(!document.hidden);
        };
        updatePageVisibility();
        document.addEventListener("visibilitychange", updatePageVisibility);
        return () => {
            observer.disconnect();
            document.removeEventListener("visibilitychange", updatePageVisibility);
        };
    }, []);

    useEffect(() => {
        const video = videoRef.current;
        if (!video || !src) return;
        if (shouldPlay) {
            if (video.ended) video.currentTime = 0;
            void video.play().catch(() => undefined);
        } else {
            video.pause();
        }
        return () => video.pause();
    }, [src, shouldPlay]);

    const move = (direction: number) => {
        if (available.length < 2) return;
        setSelectedUrl(available[(index + direction + available.length) % available.length].mediaUrl);
    };

    const retry = () => {
        setFailedUrls([]);
        setSelectedUrl(videos[0]?.mediaUrl ?? null);
        setMotionOverride(true);
    };

    return (
        <section ref={frameRef} className={styles.featured} aria-label="精选视频" aria-roledescription="轮播">
            <span className={styles.badge}>精选作品</span>
            {current && src ? <>
                <video
                    key={src}
                    ref={videoRef}
                    className={styles.video}
                    src={src}
                    aria-label={current.title}
                    autoPlay={shouldPlay}
                    muted
                    playsInline
                    preload="metadata"
                    onEnded={(event) => {
                        if (!shouldPlay) return;
                        if (available.length > 1) move(1);
                        else {
                            event.currentTarget.currentTime = 0;
                            void event.currentTarget.play().catch(() => undefined);
                        }
                    }}
                    onError={() => {
                        setFailedUrls((previous) => previous.includes(src) ? previous : [...previous, src]);
                        if (available.length > 1) setSelectedUrl(available[(index + 1) % available.length].mediaUrl);
                    }}
                />
                <div className={styles.bottom}>
                    <div className={styles.caption}>
                        <span className={styles.category}>{current.visualStyle || current.category || "原创短片"}</span>
                        <h2 className={styles.title} title={current.title}>{current.title}</h2>
                    </div>
                </div>
            </> : <div className={styles.empty} role="status">
                <p>{allFailed ? "精选视频暂时无法播放" : loading ? "精选作品加载中…" : "精选作品即将呈现"}</p>
                {allFailed && <button type="button" className={styles.retry} onClick={retry}><RotateCcw size={14} aria-hidden="true" />重新播放</button>}
            </div>}
        </section>
    );
}
