import assert from "node:assert/strict";
import test from "node:test";
import { formatGenerationError } from "./generation-error.ts";

test("AutoDL reference header timeout shows its real cause without the URL", () => {
    const error = '参数 ref_image_0 URL地址不合法/不存在: Get "https://public.r2.dev/images/reference.png": net/http: timeout awaiting response headers';
    const displayed = formatGenerationError(error);
    assert.equal(displayed, "视频渠道读取参考图片超时，请重试");
    assert.doesNotMatch(displayed, /https?:|不存在|不合法/);
    assert.equal(formatGenerationError(displayed), displayed);
});

test("reference read timeout and deadline variants are normalized", () => {
    for (const cause of ["i/o timeout", "connection timed out", "context deadline exceeded"]) {
        assert.equal(formatGenerationError(`AutoDL: ref_image_2: ${cause}`), "视频渠道读取参考图片超时，请重试");
    }
});

test("actual invalid references and unrelated provider errors remain visible", () => {
    for (const error of [
        "参数 ref_image_0 URL地址不合法/不存在: HTTP 404",
        "ref_image_0: unsupported image format",
        "video generation timeout awaiting response headers",
        "余额不足，请充值",
    ]) assert.equal(formatGenerationError(error), error);
    assert.equal(formatGenerationError(undefined), "生成失败");
});

test("provider errors are translated while retaining the exhausted retry count", () => {
    for (const [raw, readable] of [
        ["task user quota exceed", "上游账号生成配额已用尽，请检查渠道额度后重试"],
        ["Upstream video generation did not complete", "上游视频任务生成失败，未返回成片"],
        ["ref_image_0: timeout awaiting response headers", "视频渠道读取参考图片超时，请重试"],
    ]) {
        assert.equal(formatGenerationError(raw), readable);
        assert.equal(formatGenerationError(`自动重试 3 次后仍失败：${raw}`), `自动重试 3 次后仍失败：${readable}`);
    }
});
