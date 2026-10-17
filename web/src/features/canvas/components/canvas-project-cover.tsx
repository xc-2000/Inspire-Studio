"use client";

import { memo, useEffect, useRef, useState } from "react";
import { generateVideoCover } from "@/services/api/server";
import { createVideoCoverQueue } from "@/features/assets/lib/video-cover";
import type { CanvasProjectSummary } from "../domain/canvas-project-summary";
import styles from "./canvas-project-card.module.css";

const queueCover = createVideoCoverQueue(2);
const covers = new Map<string, string>();
const retryAfter = new Map<string, number>();

export const CanvasProjectCover = memo(function CanvasProjectCover({ document }: { document: CanvasProjectSummary }) {
    const candidates = document.covers;
    const container = useRef<HTMLDivElement>(null);
    const [visible, setVisible] = useState(false);
    const [failed, setFailed] = useState<string[]>([]);
    const [poster, setPoster] = useState<{ source: string; url: string }>();
    const primary = candidates.find(item => !failed.includes(item.url));
    const fallbackImage = candidates.find(item => item.kind === "image" && !failed.includes(item.url));
    const posterUrl = primary?.kind === "video" && poster?.source === primary.url ? poster.url : "";
    const imageUrl = primary?.kind === "image" ? primary.url : posterUrl || fallbackImage?.url;
    const reject = (url: string) => setFailed(previous => previous.includes(url) ? previous : [...previous, url]);

    useEffect(() => {
        if (!container.current || visible) return;
        if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
        const observer = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
        }, { rootMargin: "120px" });
        observer.observe(container.current);
        return () => observer.disconnect();
    }, [visible]);

    useEffect(() => {
        if (!visible || primary?.kind !== "video" || !primary.storageKey) return;
        const key = primary.storageKey, source = primary.url;
        let active = true;
        void queueCover(key, async () => {
            if (covers.has(key) || (retryAfter.get(key) || 0) > Date.now()) return;
            try { covers.set(key, (await generateVideoCover(key)).coverUrl); }
            catch { retryAfter.set(key, Date.now() + 60_000); }
        }).then(() => { const url = covers.get(key); if (active && url) setPoster({ source, url }); });
        return () => { active = false; };
    }, [visible, primary?.kind, primary?.url, primary?.storageKey]);

    const palette = [...document.identity.id].reduce((value, char) => value + char.charCodeAt(0), 0) % 4;
    return (
        <div ref={container} className={styles.cover} data-palette={palette}>
            <div className={styles.placeholder}>
                <div className={styles.coverArt} aria-hidden="true"><i /><i /><i /></div>
                <div className={styles.placeholderText}><span>创作项目</span><strong>{document.identity.title}</strong></div>
            </div>
            {imageUrl && !failed.includes(imageUrl) ? <img
                key={imageUrl} src={imageUrl} alt={`${document.identity.title} 封面`} loading="lazy" decoding="async" className={styles.coverMedia}
                onError={() => {
                    if (posterUrl === imageUrl && primary?.storageKey) { covers.delete(primary.storageKey); setPoster(undefined); retryAfter.set(primary.storageKey, Date.now() + 60_000); }
                    reject(imageUrl);
                }}
            /> : null}
            <div className={styles.coverShade} />
        </div>
    );
});
