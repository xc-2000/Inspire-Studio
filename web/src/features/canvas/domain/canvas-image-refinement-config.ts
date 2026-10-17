import type { AiConfig } from "@/features/settings/stores/use-config-store";

const IMAGE_RATIOS = ["1:1", "1:2", "2:1", "9:16", "16:9", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9", "9:21"];

/** Use the nearest supported image ratio so a global landscape preset cannot reshape a portrait edit. */
export function buildCanvasImageRefinementConfig(config: AiConfig, width: number, height: number): AiConfig {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("无法读取精修图片尺寸，请重新载入图片");
    const ratio = width / height;
    const size = IMAGE_RATIOS.reduce((best, value) => {
        const distance = (candidate: string) => {
            const [w, h] = candidate.split(":").map(Number);
            return Math.abs(Math.log(ratio / (w / h)));
        };
        return distance(value) < distance(best) ? value : best;
    }, IMAGE_RATIOS[0]);
    return { ...config, model: config.imageModel || config.model, size, count: "1" };
}
