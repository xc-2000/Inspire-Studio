import assert from "node:assert/strict";
import test from "node:test";
import { restorePlatformProject } from "./platform-project.ts";
import type { CommercePlatform } from "./catalog";

type Project = { id: string; platform: CommercePlatform; jobs: string[] };
const taobao: Project = { id: "taobao-original", platform: "taobao", jobs: ["image-1", "copy-1", "image-2"] };
const jd: Project = { id: "jd-original", platform: "jd", jobs: ["video-1"] };
const missing = new Error("deleted project");
const source = {
    get: async (id: string) => {
        const project = [taobao, jd].find((item) => item.id === id);
        if (!project) throw missing;
        return project;
    },
    latest: async (platform: CommercePlatform) => [taobao, jd].find((item) => item.platform === platform),
    create: (platform: CommercePlatform): Project => ({ id: "new-draft", platform, jobs: [] }),
    isMissing: (error: unknown) => error === missing,
};

test("switching Taobao → JD → Taobao restores the same project and generated work", async () => {
    const switched = await restorePlatformProject("jd", jd.id, source);
    assert.equal(switched.id, jd.id);
    const returned = await restorePlatformProject("taobao", taobao.id, source);
    assert.equal(returned.id, taobao.id);
    assert.deepEqual(returned.jobs, ["image-1", "copy-1", "image-2"]);
});

test("remembered project takes priority over a more recently updated product", async () => {
    const reopened = await restorePlatformProject("taobao", taobao.id, {
        ...source,
        latest: async () => {
            throw new Error("must not replace the selected product");
        },
        create: () => {
            throw new Error("must not clear saved work");
        },
    });
    assert.equal(reopened, taobao);
});

test("first switch and a deleted remembered project recover the latest saved platform product", async () => {
    for (const id of [undefined, "deleted-id"]) assert.equal(await restorePlatformProject("taobao", id, source), taobao);
});

test("only a platform with no saved products opens a new draft", async () => {
    assert.deepEqual(await restorePlatformProject("douyin", undefined, source), { id: "new-draft", platform: "douyin", jobs: [] });
    assert.equal(await restorePlatformProject("jd", taobao.id, source), jd);
});

test("network errors do not silently replace an existing product with an empty draft", async () => {
    const offline = new Error("network unavailable");
    await assert.rejects(
        restorePlatformProject("taobao", taobao.id, {
            ...source,
            get: async () => {
                throw offline;
            },
        }),
        offline,
    );
    await assert.rejects(
        restorePlatformProject("jd", undefined, {
            ...source,
            latest: async () => {
                throw offline;
            },
        }),
        offline,
    );
});
