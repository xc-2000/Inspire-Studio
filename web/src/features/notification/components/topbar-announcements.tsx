"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useNotificationStore } from "@/features/notification/stores/use-notification-store";
import { NotificationDetailModal } from "./notification-detail-modal";
import styles from "./topbar-announcements.module.css";

export function TopbarAnnouncements() {
    const notifications = useNotificationStore((state) => state.notifications);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [detailId, setDetailId] = useState<number | null>(null);
    const [hovered, setHovered] = useState(false);
    const [focusWithin, setFocusWithin] = useState(false);
    const [pageVisible, setPageVisible] = useState(false);
    const reduceMotion = useReducedMotion();
    const published = useMemo(() => notifications.filter((notice) => notice.status === 1), [notifications]);
    const index = Math.max(0, published.findIndex((notice) => notice.id === selectedId));
    const current = published[index];
    const detail = published.find((notice) => notice.id === detailId) ?? null;
    const rotationPaused = hovered || focusWithin || Boolean(detail) || !pageVisible;

    useEffect(() => {
        const updateVisibility = () => setPageVisible(!document.hidden);
        updateVisibility();
        document.addEventListener("visibilitychange", updateVisibility);
        return () => document.removeEventListener("visibilitychange", updateVisibility);
    }, []);

    useEffect(() => {
        if (published.length < 2 || rotationPaused) return;
        const timer = window.setTimeout(() => {
            setSelectedId(published[(index + 1) % published.length].id);
        }, 5000);
        return () => window.clearTimeout(timer);
    }, [published, index, rotationPaused]);

    return (
        <>
            <section
                className={styles.bar}
                aria-label="公告栏"
                aria-roledescription="轮播"
                onPointerEnter={(event) => { if (event.pointerType === "mouse" || event.pointerType === "pen") setHovered(true); }}
                onPointerLeave={() => setHovered(false)}
                onPointerCancel={() => setHovered(false)}
                onFocusCapture={() => setFocusWithin(true)}
                onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusWithin(false); }}
            >
                {current ? (
                    <button type="button" className={styles.notice} aria-label={`查看公告：${current.title}`} onClick={() => setDetailId(current.id)}>
                        <AnimatePresence initial={false}>
                            <motion.span
                                key={current.id}
                                className={styles.noticeContent}
                                initial={reduceMotion ? false : { y: "100%", opacity: 0 }}
                                animate={{ y: 0, opacity: 1 }}
                                exit={reduceMotion ? { opacity: 1 } : { y: "-100%", opacity: 0 }}
                                transition={{ duration: reduceMotion ? 0 : 0.42, ease: [0.22, 1, 0.36, 1] }}
                            >
                                {!current.read && <span className={styles.unread} title="未读公告" />}
                                {current.priority === "high" && <span className={styles.priority}>重要</span>}
                                <span className={styles.title}>{current.title}</span>
                                {current.content && <span className={styles.summary}>{current.content}</span>}
                            </motion.span>
                        </AnimatePresence>
                    </button>
                ) : <span className={styles.empty}>暂无公告</span>}
            </section>
            <NotificationDetailModal notification={detail} onClose={() => setDetailId(null)} />
        </>
    );
}
