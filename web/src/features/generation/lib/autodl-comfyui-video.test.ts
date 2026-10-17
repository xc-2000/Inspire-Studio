import assert from "node:assert/strict";
import test from "node:test";

import {
    AUTO_DL_H3_WORKFLOW_ID,
    isAutoDlComfyUiVideoConfig,
    normalizeAutoDlVideoDuration,
    normalizeAutoDlVideoRatio,
    normalizeAutoDlVideoResolution,
} from "./autodl-comfyui-video.ts";

test("识别任意已配置的 AutoDL 工作流", () => {
    assert.equal(isAutoDlComfyUiVideoConfig({
        apiFormat: "autodl-comfyui",
        model: AUTO_DL_H3_WORKFLOW_ID,
        videoModel: "",
        baseUrl: "https://autodl.art",
    }), true);
    assert.equal(isAutoDlComfyUiVideoConfig({
        apiFormat: "autodl-comfyui",
        model: "custom_video_workflow_v2",
        videoModel: "",
        baseUrl: "https://autodl.art",
    }), true);
    assert.equal(isAutoDlComfyUiVideoConfig({
        apiFormat: "minimax",
        model: AUTO_DL_H3_WORKFLOW_ID,
        videoModel: "",
        baseUrl: "https://autodl.art",
    }), false);
});

test("规范化 AutoDL 分辨率、横竖方向和时长", () => {
    assert.equal(normalizeAutoDlVideoResolution("480"), "480p");
    assert.equal(normalizeAutoDlVideoResolution("1080p"), "768p");
    assert.equal(normalizeAutoDlVideoRatio("1280x720"), "16:9");
    assert.equal(normalizeAutoDlVideoRatio("3:4"), "9:16");
    assert.equal(normalizeAutoDlVideoDuration("0"), 1);
    assert.equal(normalizeAutoDlVideoDuration("20"), 15);
});
