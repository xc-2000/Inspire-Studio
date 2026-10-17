import assert from "node:assert/strict";
import test from "node:test";

import type { ReferenceImage } from "@/features/generation/types/image";
import { selectCanvasImageGenerationReferences, type CanvasImageGenerationReferenceInputs } from "./canvas-image-generation-references";

function reference(id: string): ReferenceImage {
    return { id, name: `${id}.png`, type: "image/png", dataUrl: `https://fixture.test/${id}.png`, storageKey: `image:${id}` };
}
const saved = reference("saved-original");
const source = reference("current-result");
const upstream = reference("connected-input");
function input(patch: Partial<CanvasImageGenerationReferenceInputs> = {}): CanvasImageGenerationReferenceInputs {
    return { masked: false, isEdit: false, isSettingGraph: false, savedReferences: [], sourceReferences: [], upstreamReferences: [], ...patch };
}

test("drama identity references keep their image numbers and cannot be replaced by a previous shot's face", () => {
    const identity = reference("character-sheet");
    const secondIdentity = reference("second-character-sheet");
    assert.deepEqual(selectCanvasImageGenerationReferences(input({
        isEdit: true, identityReferences: [identity, secondIdentity], savedReferences: [secondIdentity, saved, identity],
        sourceReferences: [source], upstreamReferences: [upstream, identity],
    })), [identity, secondIdentity, saved, upstream]);
});

test("drama identity references do not bypass missing manual references or mask-original requirements", () => {
    assert.throws(() => selectCanvasImageGenerationReferences(input({ identityReferences: [upstream], savedReferences: null })), /参考图片读取失败/);
    assert.deepEqual(selectCanvasImageGenerationReferences(input({ masked: true, identityReferences: [upstream], savedReferences: [saved] })), [saved]);
});

test("masked edits always retain exactly the saved original rather than the current result or upstream image", () => {
    for (const isSettingGraph of [false, true]) {
        const selected = selectCanvasImageGenerationReferences(input({
            masked: true, isEdit: true, isSettingGraph, savedReferences: [saved], sourceReferences: [source], upstreamReferences: [upstream],
        }));
        assert.deepEqual(selected, [saved]);
        assert.equal(selected[0], saved);
    }
});

test("masked edits reject absent, unresolved or multiple saved originals despite live alternative images", () => {
    for (const savedReferences of [null, [], [saved, reference("another-original")]]) {
        assert.throws(() => selectCanvasImageGenerationReferences(input({
            masked: true, isEdit: true, savedReferences, sourceReferences: [source], upstreamReferences: [upstream],
        })), /蒙版编辑/);
    }
});

test("setting graphs preserve upstream-only selection and never reuse their own previous output", () => {
    const extra = reference("connected-input-2");
    assert.deepEqual(selectCanvasImageGenerationReferences(input({
        isSettingGraph: true, isEdit: true, savedReferences: [saved], sourceReferences: [source], upstreamReferences: [upstream, extra],
    })), [upstream, extra]);
    assert.deepEqual(selectCanvasImageGenerationReferences(input({
        isSettingGraph: true, isEdit: true, savedReferences: null, sourceReferences: [source],
    })), []);
});

test("ordinary requests prioritize source images then connected upstream material before saved edit references", () => {
    const extra = reference("source-2");
    assert.deepEqual(selectCanvasImageGenerationReferences(input({
        isEdit: true, savedReferences: [saved], sourceReferences: [source, extra], upstreamReferences: [upstream],
    })), [source, extra]);
    assert.deepEqual(selectCanvasImageGenerationReferences(input({
        isEdit: true, savedReferences: [saved], upstreamReferences: [upstream],
    })), [upstream]);
    // Unresolved old references do not invalidate an edit when the chosen live source exists.
    assert.deepEqual(selectCanvasImageGenerationReferences(input({
        isEdit: true, savedReferences: null, sourceReferences: [source],
    })), [source]);
    assert.deepEqual(selectCanvasImageGenerationReferences(input({
        isEdit: true, savedReferences: null, upstreamReferences: [upstream],
    })), [upstream]);
});

test("disconnected ungenerated lighting and angle edits fall back to their saved original", () => {
    for (const title of ["打光调整", "视角调整"]) {
        const savedOriginal = { ...saved, name: `${title} · 原图` };
        assert.deepEqual(selectCanvasImageGenerationReferences(input({ isEdit: true, savedReferences: [savedOriginal] })), [savedOriginal]);
    }
    const extra = reference("saved-original-2");
    assert.deepEqual(selectCanvasImageGenerationReferences(input({ isEdit: true, savedReferences: [saved, extra] })), [saved, extra]);
});

test("edit references that are empty or could not be loaded fail explicitly instead of becoming text-to-image", () => {
    assert.throws(() => selectCanvasImageGenerationReferences(input({ isEdit: true, savedReferences: [] })), /缺少参考图.*不能改为文生图/);
    assert.throws(() => selectCanvasImageGenerationReferences(input({ isEdit: true, savedReferences: null })), /读取失败.*不能改为文生图/);
});

test("ordinary text-to-image requests with no live images do not pick stale saved references", () => {
    assert.deepEqual(selectCanvasImageGenerationReferences(input({ savedReferences: [saved] })), []);
    assert.deepEqual(selectCanvasImageGenerationReferences(input({ savedReferences: null })), []);
    assert.deepEqual(selectCanvasImageGenerationReferences(input({ sourceReferences: [source] })), [source]);
    assert.deepEqual(selectCanvasImageGenerationReferences(input({ upstreamReferences: [upstream] })), [upstream]);
});

test("selection preserves input arrays, reference identities and order without exposing a mutable array alias", () => {
    for (const field of ["savedReferences", "sourceReferences", "upstreamReferences"] as const) {
        const originals = [reference(`${field}-1`), reference(`${field}-2`)];
        const values = input({ isEdit: true, [field]: originals });
        const selected = selectCanvasImageGenerationReferences(values);
        assert.notEqual(selected, originals);
        assert.deepEqual(selected, originals);
        assert.equal(selected[0], originals[0]);
        selected.reverse();
        selected.pop();
        assert.equal(originals.length, 2);
        assert.equal(originals[0].id, `${field}-1`);
    }
});
