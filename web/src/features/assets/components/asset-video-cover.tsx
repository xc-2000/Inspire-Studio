"use client";

import { useEffect, useRef, useState } from "react";
import { Video } from "lucide-react";

import { useAssetStore, type VideoAsset } from "../stores/use-asset-store";

type AssetVideoCoverProps = {
    asset: VideoAsset;
    className?: string;
    mediaClassName?: string;
};

export function AssetVideoCover({ asset, className = "", mediaClassName = "" }: AssetVideoCoverProps) {
    const ensureVideoCover = useAssetStore((state) => state.ensureVideoCover);
    const containerRef = useRef<HTMLDivElement>(null);
    const requestedSourceRef = useRef("");
    const [visible, setVisible] = useState(false);
    const [failedCover, setFailedCover] = useState("");
    const [failedVideo, setFailedVideo] = useState("");
    const [readyVideo, setReadyVideo] = useState("");
    const videoUrl = asset.data.url;
    const hasCover = Boolean(asset.coverUrl && asset.coverUrl !== failedCover);

    useEffect(() => {
        const container = containerRef.current;
        if (visible || !container) return;
        if (typeof IntersectionObserver === "undefined") {
            setVisible(true);
            return;
        }
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                setVisible(true);
                observer.disconnect();
            }
        });
        observer.observe(container);
        return () => observer.disconnect();
    }, [visible]);

    useEffect(() => {
        if (!visible || asset.coverUrl || !videoUrl) return;
        const source = `${asset.id}:${videoUrl}`;
        if (requestedSourceRef.current === source) return;
        requestedSourceRef.current = source;
        void ensureVideoCover(asset.id).catch(() => {
            // The original video remains available even when cover generation fails.
        });
    }, [visible, asset.id, asset.coverUrl, videoUrl, ensureVideoCover]);

    return (
        <div ref={containerRef} className={`relative overflow-hidden bg-[var(--studio-media)] ${className}`}>
            {hasCover ? (
                <img
                    src={asset.coverUrl}
                    alt={asset.title}
                    loading="lazy"
                    className={`size-full object-cover ${mediaClassName}`}
                    onError={() => setFailedCover(asset.coverUrl)}
                />
            ) : (
                <>
                    <div className="studio-empty absolute inset-0 flex flex-col items-center justify-center gap-2 border-0 p-4 text-center text-xs">
                        <Video className="size-8" aria-hidden="true" />
                        <span>视频可预览</span>
                    </div>
                    {visible && videoUrl && failedVideo !== videoUrl ? (
                        <video
                            key={videoUrl}
                            src={videoUrl}
                            muted
                            playsInline
                            preload="metadata"
                            aria-hidden="true"
                            tabIndex={-1}
                            className={`pointer-events-none absolute inset-0 size-full object-cover ${readyVideo === videoUrl ? "opacity-100" : "opacity-0"} ${mediaClassName}`}
                            onLoadedMetadata={(event) => {
                                // Seeking decodes a still frame without playback or a CORS canvas read.
                                const video = event.currentTarget;
                                try {
                                    video.currentTime = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(0.01, video.duration / 2) : 0.01;
                                } catch {
                                    // Some streams cannot seek; loadeddata can still expose their first frame.
                                }
                            }}
                            onLoadedData={() => setReadyVideo(videoUrl)}
                            onSeeked={(event) => {
                                if (event.currentTarget.readyState >= 2) setReadyVideo(videoUrl);
                            }}
                            onError={() => setFailedVideo(videoUrl)}
                        />
                    ) : null}
                </>
            )}
        </div>
    );
}
