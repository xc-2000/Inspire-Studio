"use client";

import { ArrowUpRight, Building2, ImagePlus, Mountain, Package, Sparkles, Video } from "lucide-react";
import styles from "./creation-workspace.module.css";

const EXAMPLES = {
    image: [
        { title: "产品摄影", prompt: "一瓶透明玻璃香水置于浅灰色石台上，柔和侧光，干净背景，突出玻璃质感与自然阴影，商业产品摄影。" },
        { title: "城市插画", prompt: "绘制一幅雨后城市街角插画，暖黄色咖啡馆灯光倒映在路面，行人撑伞经过，细腻笔触，安静温暖的氛围。" },
        { title: "自然风景", prompt: "清晨薄雾中的山谷与湖泊，远山层次分明，金色阳光穿过云层，广角构图，写实风景摄影。" },
    ],
    video: [
        { title: "产品展示", prompt: "镜头缓慢环绕一瓶置于石台上的香水，柔和光线掠过玻璃瓶身，背景简洁，动作平稳，商业广告质感。" },
        { title: "城市漫游", prompt: "镜头平稳向前穿过雨后的城市街道，霓虹灯倒映在湿润地面，行人缓慢经过，电影感夜景。" },
        { title: "自然时刻", prompt: "清晨湖面升起薄雾，镜头缓慢推向远处山谷，阳光逐渐照亮水面，树叶随微风轻动，宁静自然。" },
    ],
};

export function CreationEmptyState({ mode, onChoosePrompt }: { mode: "image" | "video"; onChoosePrompt: (prompt: string) => void }) {
    const Icon = mode === "image" ? ImagePlus : Video;
    const exampleIcons = [Package, Building2, Mountain];
    const descriptions = mode === "image"
        ? ["光影与质感，呈现商品细节", "捕捉街角的色彩与生活气息", "山川、湖泊与清晨的第一束光"]
        : ["细腻运镜，呈现产品的每一面", "穿行霓虹街道，讲述城市故事", "让光线、微风与湖面动起来"];

    return (
        <section className={styles.empty} aria-label={mode === "image" ? "开始图片创作" : "开始视频创作"}>
            <div className={styles.emptyIntro}>
            <span className={styles.emptyMark}>
                <Icon className="size-5" strokeWidth={1.5} />
            </span>
            <p className={styles.eyebrow}>{mode === "image" ? "IMAGE STUDIO" : "VIDEO STUDIO"}</p>
            <h2>{mode === "image" ? "把灵感变成画面" : "让灵感动起来"}</h2>
            <p className={styles.description}>
                {mode === "image" ? "描述主体、构图与光线，或添加参考图。每一轮结果都会保留，方便继续细化。" : "描述镜头、动作与氛围，或添加参考素材。从第一个镜头开始，逐步完善你的故事。"}
            </p>
            </div>
            <div className={styles.examples}>
                <div className={styles.exampleHeading}><span><Sparkles size={13} />从灵感开始</span><span>选择示例，继续自由创作</span></div>
                <div className={styles.exampleGrid}>
                    {EXAMPLES[mode].map((example, index) => {
                        const ExampleIcon = exampleIcons[index];
                        return (
                        <button
                            key={example.title}
                            type="button"
                            onClick={() => onChoosePrompt(example.prompt)}
                            aria-label={`使用示例：${example.title}`}
                            className={styles.example}
                        >
                            <span className={styles.exampleTop}><span className={styles.exampleIcon}><ExampleIcon size={17} strokeWidth={1.5} /></span><ArrowUpRight size={14} className={styles.exampleArrow} /></span>
                            <strong>{example.title}</strong>
                            <small>{descriptions[index]}</small>
                        </button>
                    );})}
                </div>
            </div>
        </section>
    );
}
