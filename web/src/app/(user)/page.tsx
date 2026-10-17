"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, Clapperboard, ImageIcon, LayoutGrid, Lightbulb, LoaderCircle, PanelsTopLeft, RotateCcw, SendToBack, ShoppingBag, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { NavigationLink as Link } from "@/features/app-shell/components/navigation-link";
import { useWorkspaceNavigation } from "@/features/app-shell/components/workspace-navigation";
import { useHomepageDiscovery } from "@/features/homepage/hooks/use-homepage-showcases";
import { HomepageVideoCard } from "@/features/homepage/components/homepage-video-card";
import styles from "@/features/homepage/components/homepage.module.css";

const entries = [
    { href: "/image", label: "图片创作", description: "让想象成为画面", icon: ImageIcon, tone: "blue", cover: "/homepage/entries/image-v5.webp" },
    { href: "/video", label: "视频创作", description: "让每个灵感动起来", icon: Clapperboard, tone: "purple", cover: "/homepage/entries/video-v5.webp" },
    { href: "/canvas", label: "无限画布", description: "连接灵感，自由创作", icon: SendToBack, tone: "teal", cover: "/homepage/entries/canvas-v5.webp" },
    { href: "/ecommerce", label: "电商工作台", description: "打造商品的高光时刻", icon: ShoppingBag, tone: "amber", cover: "/homepage/entries/commerce-v5.webp" },
];

const quickModes = [
    { value: "video", label: "视频", icon: Clapperboard },
    { value: "image", label: "图片", icon: ImageIcon },
] as const;

export default function IndexPage() {
    const discovery = useHomepageDiscovery();
    return (
        <main className={`studio-page h-full min-w-0 ${styles.page}`}>
            <div className={styles.content}>
                <section aria-labelledby="create-title" className={styles.launch}>
                    <div className={styles.launchHeading}>
                        <div>
                            <h1 id="create-title">你的 AI 创作工作室</h1>
                            <p>一句描述即可开始，生成图片与视频，或在无限画布上自由编排。</p>
                        </div>
                    </div>
                    <QuickCreate />
                    <nav className={styles.entries} aria-label="选择创作方式">
                        {entries.map((entry) => (
                            <Link key={entry.href} href={entry.href} className={styles.entry} data-tone={entry.tone}>
                                <div className={styles.entryText}>
                                    <span className={styles.entryIcon}><entry.icon size={20} strokeWidth={1.7} aria-hidden="true" /></span>
                                    <h2>{entry.label}<ArrowUpRight className={styles.entryArrow} size={15} strokeWidth={1.8} aria-hidden="true" /></h2>
                                    <p>{entry.description}</p>
                                </div>
                                <div className={styles.entryArt} aria-hidden="true">
                                    <img className={styles.entryCover} src={entry.cover} alt="" width={640} height={356} decoding="async" />
                                </div>
                            </Link>
                        ))}
                    </nav>
                </section>
                <DiscoveryWall discovery={discovery} />
            </div>
        </main>
    );
}

function QuickCreate() {
    const [prompt, setPrompt] = useState("");
    const [mode, setMode] = useState<(typeof quickModes)[number]["value"]>("video");
    const router = useRouter();
    const navigation = useWorkspaceNavigation();
    return <form className={styles.quickCreate} onSubmit={(event) => {
        event.preventDefault();
        if (!prompt.trim()) return;
        const href = `/${mode}?initialPrompt=${encodeURIComponent(prompt.trim())}`;
        if (navigation) navigation.navigate(href, {}); else router.push(href);
    }}>
        <Sparkles size={18} className={styles.promptIcon} aria-hidden="true" />
        <input aria-label="描述你的创意" placeholder="描述你的创意，让灵感在这里发生…" value={prompt} maxLength={2000} onChange={(event) => setPrompt(event.target.value)} />
        <div className={styles.quickActions}>
            <div className={styles.modeSwitch} role="group" aria-label="创作类型">
                {quickModes.map((item) => (
                    <button key={item.value} type="button" aria-pressed={mode === item.value} onClick={() => setMode(item.value)}>
                        <item.icon size={14} strokeWidth={1.8} aria-hidden="true" />{item.label}
                    </button>
                ))}
            </div>
            <Link href="/prompts" className={styles.promptLibrary} aria-label="找灵感"><Lightbulb size={14} aria-hidden="true" /><span>找灵感</span></Link>
            <button type="submit" disabled={!prompt.trim()} className={styles.quickSubmit}>开始创作<ArrowRight size={15} strokeWidth={2} aria-hidden="true" /></button>
        </div>
    </form>;
}

function DiscoveryWall({ discovery }: { discovery: ReturnType<typeof useHomepageDiscovery> }) {
    const { items, loading, fetching, error, reload, category, changeCategory, hasNextPage, fetchingMore, loadMore, loadMoreError } = discovery;
    const scrollRef = useRef<HTMLDivElement>(null);
    const loadMoreRef = useRef<HTMLDivElement>(null);
    const [activeId, setActiveId] = useState<number | null>(null);
    const [density, setDensity] = useState("compact");
    useEffect(() => {
        const stopWhenHidden = () => { if (document.hidden) setActiveId(null); };
        document.addEventListener("visibilitychange", stopWhenHidden);
        return () => document.removeEventListener("visibilitychange", stopWhenHidden);
    }, []);
    useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
        setActiveId(null);
    }, [category]);
    useEffect(() => {
        const target = loadMoreRef.current;
        const root = scrollRef.current;
        if (!target || !root || !hasNextPage || fetching || loadMoreError || error) return;
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) void loadMore();
        }, { root, rootMargin: "0px 0px 480px 0px" });
        observer.observe(target);
        return () => observer.disconnect();
    }, [hasNextPage, fetching, loadMoreError, error, loadMore]);
    const onVisibility = useCallback((id: number, visible: boolean) => {
        if (!visible) setActiveId((current) => current === id ? null : current);
    }, []);
    const startPreview = useCallback((id: number) => setActiveId(id), []);
    const stopPreview = useCallback((id: number) => setActiveId(current => current === id ? null : current), []);
    const togglePreview = useCallback((id: number) => setActiveId(current => current === id ? null : id), []);
    const videos = items.filter((item) => item.mediaType === "video");

    return (
        <section className={styles.discovery} aria-labelledby="discovery-title" aria-busy={fetching}>
            <div className={styles.discoveryHeading}>
                <div>
                    <div className={styles.titleLine}><h2 id="discovery-title">精选灵感</h2><span className={styles.sectionLabel}>SHOWCASE</span></div>
                </div>
            </div>
            {!error && (
                <div className={styles.filterRow}>
                    <div className={styles.categories} aria-label="视频分类">
                        {["全部", ...discovery.categories].map((value) => (
                            <button key={value} type="button" aria-pressed={value === category} onClick={() => changeCategory(value)}>{value}</button>
                        ))}
                    </div>
                    <div className={styles.viewOptions} aria-label="卡片大小">
                        <button type="button" aria-label="紧凑卡片" title="紧凑卡片" aria-pressed={density === "compact"} onClick={() => setDensity("compact")}><LayoutGrid size={15} /></button>
                        <button type="button" aria-label="大卡片" title="大卡片" aria-pressed={density === "comfortable"} onClick={() => setDensity("comfortable")}><PanelsTopLeft size={15} /></button>
                    </div>
                </div>
            )}
            <div ref={scrollRef} className={styles.discoveryScroll} data-homepage-scroll role="region" aria-label="精选创作视频列表" tabIndex={0}>
            {loading ? (
                <div className={styles.grid} data-density={density} role="status" aria-label="正在加载视频">
                    {[0, 1, 2, 3, 4].map((item) => <div key={item} className={`studio-skeleton ${styles.skeleton}`} />)}
                </div>
            ) : error ? (
                <div className={styles.empty} role="status">
                    <Clapperboard size={28} strokeWidth={1.3} />
                    <p>视频暂时无法加载</p>
                    <button type="button" onClick={() => { setActiveId(null); void reload(); }}><RotateCcw size={14} />重新加载</button>
                </div>
            ) : videos.length ? (
                <>
                    <div className={styles.grid} data-density={density}>
                        {videos.map((item) => (
                            <HomepageVideoCard
                                key={`${item.id}:${item.mediaUrl}`}
                                item={item}
                                active={activeId === item.id}
                                onVisibility={onVisibility}
                                onPreviewStart={startPreview}
                                onPreviewEnd={stopPreview}
                                onSelect={togglePreview}
                            />
                        ))}
                    </div>
                    <div ref={loadMoreRef} className={styles.scrollStatus} role="status" aria-live="polite">
                        {loadMoreError ? (
                            <><span>更多视频暂时无法加载</span><button type="button" onClick={() => void loadMore()}><RotateCcw size={13} />重试</button></>
                        ) : fetchingMore ? (
                            <><LoaderCircle size={15} className={styles.loadingIcon} /><span>正在加载更多视频</span></>
                        ) : <span>{hasNextPage ? "向下滚动查看更多" : "已展示全部视频"}</span>}
                    </div>
                    <div className={styles.galleryFooter}><span>灵感从这里开始</span><Link href="/video">创作我的视频<ArrowRight size={14} /></Link></div>
                </>
            ) : (
                <div className={styles.empty}><Clapperboard size={28} strokeWidth={1.3} /><p>这个分类还没有视频</p><button type="button" onClick={() => changeCategory("全部")}>查看全部</button></div>
            )}
            </div>
        </section>
    );
}
