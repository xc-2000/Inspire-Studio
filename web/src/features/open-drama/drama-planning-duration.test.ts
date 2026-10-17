import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, type AiConfig } from "@/features/settings/stores/use-config-store";
import { readDramaPlanningShotSeconds, selectDramaPlanningShotSeconds, dramaPlanningShotSecondsLabel } from "./drama-planning-duration";

function configFor(format: "muse" | "dola" | "openai-video-json", model: string): AiConfig {
    const id = `${format}::${model}`;
    return { ...defaultConfig, model: id, videoModel: id, videoModels: [id], channels: [{ id: format, name: format, baseUrl: "https://video.example/v1", apiKey: "test", apiFormat: format, models: [model] }] };
}

test("Muse 规划只允许确切 10 秒，而不是 1 至 10 秒", () => {
    assert.deepEqual(readDramaPlanningShotSeconds(configFor("muse", "sora-2")), [10]);
});

test("Dola 规划只使用合法的离散档位，不会产生 8 或 11 秒", () => {
    assert.deepEqual(readDramaPlanningShotSeconds(configFor("dola", "Doubao-Seedance-2.0")), [10]);
    assert.deepEqual(readDramaPlanningShotSeconds(configFor("dola", "Doubao-Seedance-2.5")), [10]);
});

test("Seedance Mini 保留 4 至 8 秒范围，普通模型优先短镜", () => {
    assert.deepEqual(readDramaPlanningShotSeconds(configFor("openai-video-json", "Doubao-Seedance-2.0-mini")), [4, 5, 6, 7, 8]);
    assert.deepEqual(readDramaPlanningShotSeconds(configFor("openai-video-json", "Doubao-Seedance-2.5")), [4, 5, 6, 7, 8, 9, 10]);
});

test("最短 15 秒的模型保留 15 秒，非法值和未配置模型不产生虚构档位", () => {
    assert.deepEqual(selectDramaPlanningShotSeconds([30, 15, 15, 0, 2.5, 31]), [15]);
    assert.deepEqual(selectDramaPlanningShotSeconds([5, 10, 15, 30]), [5, 10]);
    assert.deepEqual(readDramaPlanningShotSeconds(defaultConfig), []);
    assert.equal(dramaPlanningShotSecondsLabel([10]), "10 秒");
    assert.equal(dramaPlanningShotSecondsLabel([5, 10]), "5 / 10 秒");
});
