import assert from "node:assert/strict";
import test from "node:test";
import { statSync } from "node:fs";
import { getHomepageCreationHref, homepageFallbackShowcases, homepageFallbackVideoUrls, paginateHomepageFallback } from "./homepage-showcases";
import type { HomepageVideoShowcase } from "./original-video-showcases";

test("fresh installations include playable local showcase videos and covers", () => {
    assert.ok(homepageFallbackShowcases.length > 0);
    assert.equal(new Set(homepageFallbackShowcases.map((item) => item.id)).size, homepageFallbackShowcases.length);
    const publicRoot = new URL("../../../../public/", import.meta.url);
    for (const item of homepageFallbackShowcases) {
        assert.equal(item.mediaType, "video");
        assert.match(item.mediaUrl, /^\/homepage\/originals\/[\w-]+\.mp4$/);
        assert.match(item.thumbnailUrl, /^\/homepage\/originals\/[\w-]+\.jpg$/);
        for (const path of [item.mediaUrl, item.thumbnailUrl, item.fullVideoUrl].filter(Boolean)) {
            const asset = statSync(new URL(path!.slice(1), publicRoot));
            assert.ok(asset.isFile() && asset.size > 0, path);
        }
    }
    assert.deepEqual(homepageFallbackVideoUrls, homepageFallbackShowcases.slice(0, 2).map((item) => item.mediaUrl));
});

test("bundled showcases remain available across scrolling pages and categories", () => {
    const ids: number[] = [];
    const pageSize = 12;
    for (let page = 1; page <= Math.ceil(homepageFallbackShowcases.length / pageSize); page++) {
        const result = paginateHomepageFallback({ page, pageSize });
        assert.equal(result.total, homepageFallbackShowcases.length);
        ids.push(...result.items.map((item) => item.id));
    }
    assert.deepEqual(ids, homepageFallbackShowcases.map((item) => item.id));
    for (const category of new Set(homepageFallbackShowcases.map((item) => item.category))) {
        const result = paginateHomepageFallback({ page: 1, pageSize: homepageFallbackShowcases.length, category });
        assert.deepEqual(result.items, homepageFallbackShowcases.filter((item) => item.category === category));
    }
    assert.deepEqual(paginateHomepageFallback({ page: 1, pageSize, category: "Missing" }).items, []);
});

const sample: HomepageVideoShowcase = {
    id: 1, title: "Example", description: "Example", category: "Demo", creatorName: "Example",
    mediaType: "video", mediaUrl: "https://example.invalid/video.mp4", thumbnailUrl: "", targetType: "video",
    targetPath: "/video", promptContent: "A paper boat", sortOrder: 1, status: 1,
};

test("configured showcase content still supports category filtering and pagination", () => {
    const items = [sample, { ...sample, id: 2 }, { ...sample, id: 3, category: "Other" }];
    const page = paginateHomepageFallback({ page: 2, pageSize: 1, category: "Demo" }, items);
    assert.equal(page.total, 2);
    assert.deepEqual(page.items.map(item => item.id), [2]);
    assert.deepEqual(page.categories, ["Demo", "Other"]);
    assert.deepEqual(paginateHomepageFallback({ page: 1, pageSize: 12, category: "Missing" }, items).items, []);
});

test("configured showcase links preserve the administrator's prompt", () => {
    const url = new URL(getHomepageCreationHref(sample), "https://example.invalid");
    assert.equal(url.pathname, "/video");
    assert.equal(url.searchParams.get("initialPrompt"), sample.promptContent);
});
