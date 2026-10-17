import assert from "node:assert/strict";
import test from "node:test";
import { getHomepageCreationHref, homepageFallbackShowcases, homepageFallbackVideoUrls, paginateHomepageFallback } from "./homepage-showcases";
import type { HomepageVideoShowcase } from "./original-video-showcases";

test("source-only installation has an empty showcase without stale media URLs", () => {
    assert.deepEqual(homepageFallbackShowcases, []);
    assert.deepEqual(homepageFallbackVideoUrls, []);
    assert.deepEqual(paginateHomepageFallback({ page: 1, pageSize: 12 }), { items: [], total: 0, categories: [] });
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
