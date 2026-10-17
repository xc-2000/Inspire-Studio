import assert from "node:assert/strict";
import test from "node:test";
import { splitTimelineClip, parseSrt, exportSrt } from "./canvas-timeline.ts";

test("splitting retains source, mute and exact continuous ranges", () => {
    const clips = [{ id: "one", nodeId: "video", startMs: 1000, endMs: 5000, muted: true }];
    const result = splitTimelineClip(clips, 0, 2500, "two");
    assert.deepEqual(result.map(c => [c.nodeId, c.startMs, c.endMs, c.muted]), [["video", 1000, 2500, true], ["video", 2500, 5000, true]]);
    assert.equal(clips[0].endMs, 5000);
    assert.throws(() => splitTimelineClip(clips, 0, 1050, "two"));
});
test("SRT roundtrip preserves Chinese multiline text and millisecond boundaries", () => {
    const rows = parseSrt("1\r\n00:00:01,234 --> 00:00:03,567\r\n你好\r\n第二行\r\n\r\n2\r\n00:01:00,000 --> 00:01:01,100\r\n再见");
    assert.equal(rows[0].startMs, 1234);
    assert.equal(rows[0].text, "你好\n第二行");
    assert.deepEqual(parseSrt(exportSrt(rows)), rows);
});
test("WebVTT accepts cue identifiers, short timestamps and settings", () => {
    const rows = parseSrt("WEBVTT\n\nintro\n00:01.200 --> 00:02.300 align:center\n开场");
    assert.equal(rows[0].startMs, 1200);
    assert.equal(rows[0].endMs, 2300);
    assert.throws(() => parseSrt("1\n00:00:03,000 --> 00:00:01,000\n倒序"));
    assert.throws(() => parseSrt("not captions"));
});
