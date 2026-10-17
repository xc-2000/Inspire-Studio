import assert from "node:assert/strict";
import { test } from "node:test";
import { canvasImageRefinementGeometry, canvasImageRefinementPreviewWidth } from "./canvas-image-refinement";

test("outpaint rounds the output once and stays within the 2048-pixel limit", () => {
    const geometry = canvasImageRefinementGeometry(3000, 2000, "outpaint", 35);
    assert.deepEqual(geometry, { width: 2048, height: 1365, sourceWidth: 1205, sourceHeight: 803, sourceX: 422, sourceY: 281 });
    assert.ok(geometry.width <= 2048 && geometry.height <= 2048);
});

test("extreme portrait and landscape sources always retain a nonzero axis", () => {
    for (const [width, height] of [[1, 5000], [5000, 1]]) {
        for (const mode of ["mask", "outpaint", "light", "angle"] as const) {
            const geometry = canvasImageRefinementGeometry(width, height, mode, 60);
            for (const value of [geometry.width, geometry.height, geometry.sourceWidth, geometry.sourceHeight]) {
                assert.ok(value >= 1 && value <= 2048);
            }
            assert.ok(geometry.sourceX >= 0 && geometry.sourceX + geometry.sourceWidth <= geometry.width);
            assert.ok(geometry.sourceY >= 0 && geometry.sourceY + geometry.sourceHeight <= geometry.height);
        }
    }
});

test("outpaint keeps the source centered and adds the requested margin before scaling", () => {
    const geometry = canvasImageRefinementGeometry(400, 800, "outpaint", 25);
    assert.deepEqual(geometry, { width: 600, height: 1200, sourceWidth: 400, sourceHeight: 800, sourceX: 100, sourceY: 200 });
    for (const padding of [10, 15, 25, 35, 60]) {
        const odd = canvasImageRefinementGeometry(1001, 667, "outpaint", padding);
        assert.ok(Math.abs(odd.sourceX - (odd.width - odd.sourceWidth - odd.sourceX)) <= 1);
        assert.ok(Math.abs(odd.sourceY - (odd.height - odd.sourceHeight - odd.sourceY)) <= 1);
    }
});

test("mask, lighting and perspective preserve the original processing dimensions", () => {
    for (const mode of ["mask", "light", "angle"] as const) {
        assert.deepEqual(canvasImageRefinementGeometry(398, 720, mode, 60), {
            width: 398, height: 720, sourceWidth: 398, sourceHeight: 720, sourceX: 0, sourceY: 0,
        });
        const large = canvasImageRefinementGeometry(4096, 2048, mode, 25);
        assert.equal(large.width, 2048);
        assert.equal(large.height, 1024);
    }
});

test("preview constrains wide, near-square and portrait images without changing aspect ratio", () => {
    for (const [width, height, availableWidth] of [[398, 720, 560], [2000, 1800, 560], [2000, 1000, 560], [1, 5000, 560]]) {
        const displayedWidth = Math.min(availableWidth, canvasImageRefinementPreviewWidth(width, height));
        const displayedHeight = displayedWidth * height / width;
        assert.ok(displayedHeight <= 384.000001);
        assert.ok(displayedWidth <= availableWidth);
        assert.ok(Math.abs(displayedWidth / displayedHeight - width / height) < 0.000001);
    }
});

test("invalid image dimensions fail before touching a canvas", () => {
    assert.throws(() => canvasImageRefinementGeometry(0, 720, "mask", 25), /原图尺寸无效/);
    assert.throws(() => canvasImageRefinementGeometry(400, Number.NaN, "mask", 25), /原图尺寸无效/);
});
