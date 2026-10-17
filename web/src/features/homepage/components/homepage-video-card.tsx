"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Play } from "lucide-react";
import { creatorMonogram } from "../lib/fantastic-show";
import { observeVideoPreview } from "../lib/observe-video-preview";
import type { HomepageVideoShowcase } from "../api/original-video-showcases";
import styles from "./homepage.module.css";

export const HomepageVideoCard = memo(function HomepageVideoCard({ item, active, onSelect, onPreviewStart, onPreviewEnd, onVisibility }: {
    item: HomepageVideoShowcase; active: boolean; onSelect: (id: number) => void; onPreviewStart: (id: number) => void; onPreviewEnd: (id: number) => void; onVisibility: (id: number, visible: boolean) => void;
}) {
    const frameRef = useRef<HTMLDivElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const [nearby, setNearby] = useState(false);
    const [previewRequested, setPreviewRequested] = useState(false);
    const [visible, setVisible] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [failed, setFailed] = useState(false);
    const shouldPlay = previewRequested && active && visible && !failed;

    useEffect(() => {
        const frame = frameRef.current;
        if (!frame) return;
        const unobserve = observeVideoPreview(frame, {
            nearby: () => setNearby(true),
            visible: isVisible => { setVisible(isVisible); onVisibility(item.id, isVisible); },
        });
        return () => { unobserve(); onVisibility(item.id, false); };
    }, [item.id, onVisibility]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        let canceled = false;
        if (shouldPlay) {
            if (video.ended) video.currentTime = 0;
            void video.play().catch(() => { if (!canceled) setPlaying(false); });
        } else {
            video.pause();
            // React removes src; load() also aborts the old transfer and releases its decoder.
            video.load();
        }
        return () => { canceled = true; video.pause(); };
    }, [shouldPlay, item.mediaUrl]);

    const startPreview = () => {
        if (failed) return;
        setNearby(true);
        setPreviewRequested(true);
        onPreviewStart(item.id);
    };

    const stopPreview = () => {
        videoRef.current?.pause();
        onPreviewEnd(item.id);
    };

    const toggle = () => {
        setNearby(true);
        setPreviewRequested(true);
        if (failed) { setFailed(false); videoRef.current?.load(); }
        // A direct gesture resumes playback when the browser blocks autoplay.
        if (!playing) void videoRef.current?.play().catch(() => setPlaying(false));
        if (playing) videoRef.current?.pause();
        if (playing || !active) onSelect(item.id);
    };

    return (
        <article className={styles.videoCard} data-playing={playing}
            onPointerEnter={(event) => { if (event.pointerType !== "touch") startPreview(); }}
            onPointerLeave={(event) => { if (event.pointerType !== "touch") stopPreview(); }}
            onPointerCancel={stopPreview}
            onFocusCapture={(event) => { if (event.currentTarget.contains(event.target) && event.target.matches(":focus-visible")) startPreview(); }}
            onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) stopPreview(); }}
        >
            <div ref={frameRef} className={styles.videoFrame}>
                <video ref={videoRef} src={shouldPlay ? item.mediaUrl : undefined} poster={nearby ? item.thumbnailUrl || undefined : undefined} muted playsInline loop preload="none" aria-label={item.title}
                    onPlaying={(event) => { if (shouldPlay) setPlaying(true); else event.currentTarget.pause(); }} onPause={() => setPlaying(false)}
                    onError={() => { if (shouldPlay) { setFailed(true); setPlaying(false); onPreviewEnd(item.id); } }}
                />
                <div className={styles.frameShade} />
                <span className={styles.categoryBadge}>{item.visualStyle || item.category}</span>
                <button type="button" className={styles.videoHitTarget} aria-label={`${playing ? "暂停" : failed ? "重试" : "播放"}：${item.title}`} onClick={toggle}>
                    {failed ? <span className={styles.playError}>暂时无法播放，点击重试</span> : !playing && <span className={styles.playHint} aria-hidden="true"><Play size={16} fill="currentColor" strokeWidth={0} /></span>}
                </button>
            </div>
            <div className={styles.cardInfo}>
                <div><h3 title={item.title}>{item.title}</h3><p title={item.description}>{item.description || item.creatorName}</p></div>
                <div className={styles.cardFooter}>
                    <span className={styles.creator} title={item.creatorName}><span className={styles.creatorAvatar}>{creatorMonogram(item.creatorName)}</span><span>{item.creatorName}</span></span>
                    <span className={styles.cardTag}>{item.category}</span>
                </div>
            </div>
        </article>
    );
});
