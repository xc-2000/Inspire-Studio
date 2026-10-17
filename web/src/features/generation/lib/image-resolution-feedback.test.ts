import assert from "node:assert/strict";
import test from "node:test";
import { imageResolutionWarning } from "./image-resolution-feedback";

test("detects the real 2K and 4K upstream downgrade", () => {
    assert.match(imageResolutionWarning(1254, 1254, "2K", "1:1"), /2048×2048.*1254×1254/);
    assert.match(imageResolutionWarning(1254, 1254, "4K", "1:1"), /4096×4096.*1254×1254/);
});
test("accepts a correct portrait image and provider alignment", () => {
    assert.equal(imageResolutionWarning(1152, 2048, "2K", "9:16"), "");
    assert.equal(imageResolutionWarning(2048, 1360, "2K", "3:2"), "");
    assert.equal(imageResolutionWarning(2040, 2040, "2K", "1:1"), "");
});
test("does not infer requested resolution for missing or automatic settings", () => {
    assert.equal(imageResolutionWarning(1254, 1254, undefined, "1:1"), "");
    assert.equal(imageResolutionWarning(1254, 1254, "4K", "auto"), "");
    assert.equal(imageResolutionWarning(undefined, undefined, "4K", "1:1"), "");
    assert.equal(imageResolutionWarning(1254, 1254, "4K", "0:1"), "");
});
test("explicit pixel dimensions take precedence over the resolution preset", () => {
    assert.equal(imageResolutionWarning(1024, 1024, "4K", "1024x1024"), "");
    assert.match(imageResolutionWarning(1024, 1024, "1K", "4096x4096"), /未按所选尺寸输出/);
});
