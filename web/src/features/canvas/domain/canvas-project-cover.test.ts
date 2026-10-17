import assert from "node:assert/strict";
import test from "node:test";
import { createImageNode, createVideoNode, createVideoCompositionNode, createStoryboardNode } from "../constants";
import { createCanvasDocument } from "./canvas-document";
import { canvasProjectCovers, canvasProjectMediaSummary } from "./canvas-project-cover";

const project = () => createCanvasDocument({ id: "test", title: "雨桥夺匣", now: "2026-10-09T00:00:00Z" });
const image = (id: string, source = `https://media.example/${id}.jpg`) => ({ ...createImageNode({ id, position: { x: 0, y: 0 } }), content: { source } });

test("opening frame linked to video wins over shared character reference and duplicate URLs", () => {
    const doc = project(), clip = createVideoNode({ id: "clip", position: { x: 0, y: 0 } });
    doc.scene.nodes = [image("character"), image("opening"), image("copy", "https://media.example/opening.jpg"), clip];
    doc.scene.connections = [{ id: "edge", source: { nodeId: "opening" }, target: { nodeId: "clip" } }];
    assert.deepEqual(canvasProjectCovers(doc).map(cover => cover.url), ["https://media.example/opening.jpg", "https://media.example/character.jpg"]);
    assert.deepEqual(canvasProjectMediaSummary(doc), { images: 2, videos: 0, label: "视频创作" });
});

test("successful composition uses real video cover, and unfinished result falls back to existing image", () => {
    const doc = project(), result = createVideoNode({ id: "result", position: { x: 0, y: 0 } });
    result.content = { source: "https://media.example/final.mp4", storageKey: "video:final" };
    result.execution = { phase: "succeeded" };
    const compose = createVideoCompositionNode({ id: "compose", position: { x: 0, y: 0 } });
    compose.composition.resultVideoNodeId = result.id;
    doc.scene.nodes = [image("opening"), compose, result];
    assert.deepEqual(canvasProjectCovers(doc)[0], { kind: "video", url: result.content.source, storageKey: "video:final" });
    assert.equal(canvasProjectMediaSummary(doc).label, "已成片");
    result.execution.phase = "failed";
    assert.equal(canvasProjectCovers(doc)[0].kind, "image");
    assert.notEqual(canvasProjectMediaSummary(doc).label, "已成片");
});

test("persisted object storage replaces expired blob addresses and empty projects need no media request", () => {
    const doc = project();
    assert.deepEqual(canvasProjectCovers(doc), []);
    doc.scene.nodes = [image("expired", "blob:old-session"), image("invalid", "javascript:alert(1)"), image("relative", "/open-drama/frame.jpg")];
    assert.deepEqual(canvasProjectCovers(doc).map(cover => cover.url), ["/open-drama/frame.jpg"]);
});

test("storyboard poster is used even when the project has no standalone image nodes", () => {
    const doc = project(), board = createStoryboardNode({ id: "board", position: { x: 0, y: 0 } });
    board.storyboard.shots = [{ id: "s1", shotNumber: 1, durationSeconds: 5, visualDescription: "", shotSize: "中景", lightingAtmosphere: "", dialogueVoiceover: "", soundEffect: "", cameraMovement: "", finalPrompt: "", assetIds: [], image: { source: "/opening.jpg" }, video: { source: "/clip.mp4", poster: "/poster.jpg" } }];
    doc.scene.nodes = [board];
    assert.equal(canvasProjectCovers(doc)[0].url, "/poster.jpg");
    assert.deepEqual(canvasProjectMediaSummary(doc), { images: 1, videos: 1, label: "视频创作" });
});
