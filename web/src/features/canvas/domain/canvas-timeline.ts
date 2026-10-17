export type TimelineClip = { id: string; nodeId: string; startMs: number; endMs: number; muted: boolean };
export type TimelineSubtitle = { id: string; startMs: number; endMs: number; text: string };
export type TimelineDraft = { clips: TimelineClip[]; subtitles: TimelineSubtitle[]; fontSize: number };
export function splitTimelineClip(clips: TimelineClip[], index: number, localMs: number, newId: string): TimelineClip[] {
    const clip = clips[index];
    if (!clip || localMs - clip.startMs < 100 || clip.endMs - localMs < 100) throw new Error("分割点应距离片段两端至少 0.1 秒");
    return [...clips.slice(0, index), { ...clip, endMs: localMs }, { ...clip, id: newId, startMs: localMs }, ...clips.slice(index + 1)];
}
export function subtitleTimestamp(ms: number) {
    const value = Math.max(0, Math.round(ms));
    return `${String(Math.floor(value / 3600000)).padStart(2, "0")}:${String(Math.floor(value / 60000) % 60).padStart(2, "0")}:${String(Math.floor(value / 1000) % 60).padStart(2, "0")},${String(value % 1000).padStart(3, "0")}`;
}
export function exportSrt(subtitles: TimelineSubtitle[]) {
    return [...subtitles]
        .sort((a, b) => a.startMs - b.startMs)
        .map((s, i) => `${i + 1}\n${subtitleTimestamp(s.startMs)} --> ${subtitleTimestamp(s.endMs)}\n${s.text}`)
        .join("\n\n");
}
export function parseSrt(text: string): TimelineSubtitle[] {
    const rows = text
        .replace(/\r/g, "")
        .replace(/^\uFEFF/, "")
        .split(/\n\s*\n/);
    const result: TimelineSubtitle[] = [];
    const time = (hours: string, minutes: string, seconds: string, ms: string) => +hours * 3600000 + +minutes * 60000 + +seconds * 1000 + +(ms || "0").padEnd(3, "0");
    for (const block of rows) {
        const match = block.match(/(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{1,3})[^\n]*\n([\s\S]+)/);
        if (!match) continue;
        const startMs = time(match[1] || "0", match[2], match[3], match[4]),
            endMs = time(match[5] || "0", match[6], match[7], match[8]);
        if (endMs <= startMs) throw new Error("字幕结束时间必须晚于开始时间");
        result.push({ id: `subtitle-${result.length}`, startMs, endMs, text: match[9].trim() });
    }
    if (!result.length) throw new Error("文件中没有可识别的 SRT / VTT 字幕");
    if (result.length > 500) throw new Error("单次最多 500 段字幕");
    return result;
}
