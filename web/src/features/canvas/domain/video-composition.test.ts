import assert from "node:assert/strict";
import test from "node:test";

import { createAudioNode, createTextNode, createVideoCompositionNode, createVideoNode } from "../constants.ts";
import { readVideoCompositionConnectionError, canComposeVideo, readVideoCompositionAudioInputs, reorderVideoCompositionInputIds, synchronizeVideoCompositionInputs, videoCompositionAudioTracks, withVideoCompositionAudioTracks } from "./video-composition.ts";

test("合成视频节点只接收直接视频输入，且限制重复和最多二十段", () => {
    const composition = createVideoCompositionNode({ id: "composition-1", position: { x: 0, y: 0 } });
    const text = createTextNode({ id: "text-1", position: { x: 0, y: 0 } });
    const videos = Array.from({ length: 21 }, (_, index) => createVideoNode({ id: `video-${index + 1}`, position: { x: index * 20, y: 0 } }));
    const nodes = [composition, text, ...videos];
    const connections = videos.slice(0, 20).map((video, index) => ({
        id: `connection-${index + 1}`,
        source: { nodeId: video.id },
        target: { nodeId: composition.id },
    }));

    assert.equal(readVideoCompositionConnectionError(text.id, composition.id, nodes, []), "合成视频节点仅支持直接连接视频或音频节点");
    assert.equal(readVideoCompositionConnectionError(videos[0].id, composition.id, nodes, connections), "该视频已经连接到合成视频节点");
    assert.equal(readVideoCompositionConnectionError(videos[20].id, composition.id, nodes, connections), "单个合成视频节点最多连接20段视频");
});

test("合成视频输入随连线变化同步，并保留用户调整后的顺序", () => {
    const composition = createVideoCompositionNode({ id: "composition-1", position: { x: 0, y: 0 } });
    composition.composition.inputVideoNodeIds = ["video-2", "missing", "video-1"];
    const video1 = createVideoNode({ id: "video-1", position: { x: 0, y: 0 } });
    const video2 = createVideoNode({ id: "video-2", position: { x: 0, y: 0 } });
    const video3 = createVideoNode({ id: "video-3", position: { x: 0, y: 0 } });

    const synchronized = synchronizeVideoCompositionInputs(
        [composition, video1, video2, video3],
        [
            { id: "connection-1", source: { nodeId: "video-1" }, target: { nodeId: "composition-1" } },
            { id: "connection-2", source: { nodeId: "video-2" }, target: { nodeId: "composition-1" } },
            { id: "connection-3", source: { nodeId: "video-3" }, target: { nodeId: "composition-1" } },
        ],
    );
    const nextComposition = synchronized.find((node) => node.id === "composition-1");

    assert.equal(nextComposition?.kind, "videoComposition");
    if (nextComposition?.kind !== "videoComposition") throw new Error("应存在合成视频节点");
    assert.deepEqual(nextComposition.composition.inputVideoNodeIds, ["video-2", "video-1", "video-3"]);
    assert.deepEqual(reorderVideoCompositionInputIds(nextComposition.composition.inputVideoNodeIds, "video-3", "video-2"), ["video-3", "video-2", "video-1"]);
});

test("合成按钮仅在全部输入视频成功且已持久化时可用", () => {
    const composition = createVideoCompositionNode({ id: "composition-1", position: { x: 0, y: 0 } });
    composition.composition.inputVideoNodeIds = ["video-1", "video-2"];
    const video1 = createVideoNode({ id: "video-1", position: { x: 0, y: 0 } });
    const video2 = createVideoNode({ id: "video-2", position: { x: 0, y: 0 } });
    video1.execution = { phase: "succeeded" };
    video1.content.storageKey = "video:first";
    video2.execution = { phase: "running" };
    video2.content.storageKey = "video:second";
    const videoById = new Map([[video1.id, video1], [video2.id, video2]]);

    assert.equal(canComposeVideo(composition, videoById), false);
    video2.execution = { phase: "succeeded" };
    assert.equal(canComposeVideo(composition, videoById), true);
});

test("单个视频分割后支持重复输入，断开来源后拒绝再次导出", () => {
    const composition = createVideoCompositionNode({ id: "edit", position: { x: 0, y: 0 } });
    const video = createVideoNode({ id: "source", position: { x: 0, y: 0 } });
    video.execution = { phase: "succeeded" }; video.content.storageKey = "video:source";
    composition.composition = { inputVideoNodeIds: ["source"], editingSourceNodeIds: ["source", "source"], editingOptions: { clips: [{startMs:0,endMs:1000,muted:false},{startMs:1000,endMs:2000,muted:false}], subtitles:[], fontSize:36 } };
    assert.equal(canComposeVideo(composition, new Map([[video.id,video]])),true);
    composition.composition.inputVideoNodeIds=[];
    assert.equal(canComposeVideo(composition, new Map([[video.id,video]])),false);
});

test("配音音频可连接到合成节点，按时间轴起点生成叠加音轨且不占视频名额", () => {
    const composition = createVideoCompositionNode({ id: "composition-1", position: { x: 0, y: 0 } });
    const videos = Array.from({ length: 20 }, (_, index) => createVideoNode({ id: `video-${index + 1}`, position: { x: 0, y: 0 } }));
    const later = { ...createAudioNode({ id: "audio-b", position: { x: 0, y: 0 } }), execution: { phase: "succeeded" as const } };
    later.content = { ...later.content, source: "https://cdn/b.mp3", storageKey: "audio:b", timelineStartMilliseconds: 12000, timelineVolume: 1.2 };
    const earlier = { ...createAudioNode({ id: "audio-a", position: { x: 0, y: 0 } }), execution: { phase: "succeeded" as const } };
    earlier.content = { ...earlier.content, source: "https://cdn/a.mp3", storageKey: "audio:a", timelineStartMilliseconds: 1500 };
    const unsaved = createAudioNode({ id: "audio-c", position: { x: 0, y: 0 } });
    const nodes = [composition, ...videos, later, earlier, unsaved];
    const connections = [...videos, later, earlier, unsaved].map((node, index) => ({ id: `c-${index}`, source: { nodeId: node.id }, target: { nodeId: composition.id } }));
    assert.equal(readVideoCompositionConnectionError("audio-a", composition.id, nodes, connections.filter((edge) => edge.source.nodeId !== "audio-a")), null, "20 videos do not block audio");
    assert.equal(readVideoCompositionConnectionError("audio-a", composition.id, nodes, connections), "该音频已经连接到合成视频节点");
    const inputs = readVideoCompositionAudioInputs(composition.id, nodes, connections);
    assert.deepEqual(inputs.map((node) => node.id), ["audio-c", "audio-a", "audio-b"]);
    const tracks = videoCompositionAudioTracks(inputs);
    assert.deepEqual(tracks, [{ storageKey: "audio:a", startMs: 1500 }, { storageKey: "audio:b", startMs: 12000, volume: 1.2 }]);
    assert.deepEqual(withVideoCompositionAudioTracks(undefined, tracks), { clips: [], subtitles: [], fontSize: 36, audioTracks: tracks });
    assert.equal(withVideoCompositionAudioTracks(undefined, []), undefined, "no audio keeps the legacy request");
    const single = { ...composition, composition: { ...composition.composition, inputVideoNodeIds: ["video-1"] } };
    const ready = { ...videos[0], execution: { phase: "succeeded" as const }, content: { ...videos[0].content, source: "https://cdn/v.mp4", storageKey: "video:1" } };
    const byId = new Map([["video-1", ready]]);
    assert.equal(canComposeVideo(single, byId), false);
    assert.equal(canComposeVideo(single, byId, 1), true, "one shot plus voiceover is a valid film");
});

test("合成可指定视频原声音量，静音时把 originalVolume 0 传给服务端", () => {
    const tracks = [{ storageKey: "audio:a", startMs: 0 }];
    assert.deepEqual(withVideoCompositionAudioTracks(undefined, tracks, 0), { clips: [], subtitles: [], fontSize: 36, audioTracks: tracks, originalVolume: 0 });
    assert.equal(withVideoCompositionAudioTracks(undefined, tracks)?.originalVolume, undefined, "unset keeps the server default");
    assert.equal(withVideoCompositionAudioTracks(undefined, [], 0), undefined, "volume alone never changes a plain composition");
});
