import type { CanvasStoryboardShot } from "@/features/canvas/types";

export type DramaStoryQualityIssue = {
    severity: "warning" | "error";
    code: "repeated-dialogue" | "speech-too-long" | "unplanned-prose" | "missing-continuity" | "missing-state" | "invalid-continuation";
    message: string;
    shotId: string;
    relatedShotId?: string;
};

const normalizeSpeech = (text: string) => text.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function spokenUnits(text: string): number {
    return (text.match(/\p{Script=Han}|[^\p{Script=Han}\P{L}]+|\p{N}+/gu) || []).reduce((sum, word) => sum + (/^\p{Script=Han}/u.test(word) ? 1 : 2), 0);
}

function spokenSegments(text: string): string[] {
    if (["", "无", "无对白", "无旁白", "无对白或旁白", "无对白/旁白", "none"].includes(text.trim().toLowerCase())) return [];
    const quoted = [...text.matchAll(/[“"]([^”"]+)[”"]|「([^」]+)」|『([^』]+)』/g)].map(match => (match[1] || match[2] || match[3]).trim());
    if (quoted.length) return quoted;
    return text.split(/[\n；;]+/).map(line => line.replace(/[（(][^）)]*[）)]|\[[^\]]*\]|【[^】]*】/g, "").replace(/^[^：:]{1,24}[：:]/, "").trim()).filter(Boolean);
}

/** Shares the backend pacing rule: four Chinese units/second; each Latin word counts as two. */
export function estimateDramaSpeechSeconds(text: string): number {
    return spokenSegments(text).reduce((sum, part) => sum + spokenUnits(part), 0) / 4;
}

function readSpeech(shot: CanvasStoryboardShot): string[] {
    if (shot.dialogueVoiceover.trim()) return spokenSegments(shot.dialogueVoiceover);
    // Imported novels often left dialogueVoiceover empty and kept dialogue inside the prose.
    const quoted = [...shot.visualDescription.matchAll(/[“「『"]([^”」』"\n]{2,})[”」』"]/g)].map(match => match[1].trim());
    return quoted;
}

/** Structural and pacing warnings are review aids; they do not certify story completeness. */
export function readDramaStoryQuality(shots: CanvasStoryboardShot[]): DramaStoryQualityIssue[] {
    const issues: DramaStoryQualityIssue[] = [];
    const ordered = [...shots].sort((a, b) => a.shotNumber - b.shotNumber);
    const spoken = new Map<string, string>();
    ordered.forEach((shot, index) => {
        const add = (issue: Omit<DramaStoryQualityIssue, "shotId">) => issues.push({ ...issue, shotId: shot.id });
        const speech = readSpeech(shot);
        const duplicates = new Set<string>();
        speech.filter(line => spokenUnits(line) >= 16).forEach(line => {
            const key = normalizeSpeech(line);
            const previous = [...spoken.entries()].find(([text, id]) => id !== shot.id && (text.includes(key) || key.includes(text)))?.[1];
            if (previous && previous !== shot.id && !duplicates.has(previous)) {
                duplicates.add(previous);
                add({ code: "repeated-dialogue", severity: "warning", relatedShotId: previous, message: `镜头 ${shot.shotNumber} 与前面镜头重复台词，请确认是否有明确的回忆或复述意图。` });
            }
            if (!previous) spoken.set(key, shot.id);
        });
        const spokenSeconds = speech.reduce((sum, part) => sum + spokenUnits(part), 0) / 4;
        if (Number.isFinite(shot.durationSeconds) && shot.durationSeconds > 0 && spokenSeconds > shot.durationSeconds) {
            add({ code: "speech-too-long", severity: "error", message: `镜头 ${shot.shotNumber} 的台词预计至少需要 ${Math.ceil(spokenSeconds)} 秒，超过当前 ${shot.durationSeconds} 秒，请拆镜、精简台词或增加时长。` });
        }
        const continuity = shot.continuity;
        if (!continuity) {
            add({ code: "missing-continuity", severity: "warning", message: `镜头 ${shot.shotNumber} 缺少场景、时间和镜头衔接信息，建议先优化剧情分镜。` });
        } else {
            if (!continuity.openingState.trim() || !continuity.closingState.trim()) {
                add({ code: "missing-state", severity: "warning", message: `镜头 ${shot.shotNumber} 缺少起始或结束状态，下一镜难以准确承接动作。` });
            }
            const previous = ordered[index - 1]?.continuity;
            if (continuity.transition === "continue" && (!previous ||
                (previous.sceneId.trim() && continuity.sceneId.trim() && previous.sceneId.trim() !== continuity.sceneId.trim()) ||
                (previous.time.trim() && continuity.time.trim() && previous.time.trim() !== continuity.time.trim()))) {
                add({ code: "invalid-continuation", severity: "error", relatedShotId: ordered[index - 1]?.id, message: `镜头 ${shot.shotNumber} 标记为连续动作，但前镜缺失或场景、时间不一致，请改为明确的转场。` });
            }
        }
        const visual = shot.visualDescription.trim();
        const copiedPrompt = !shot.videoPrompt?.trim() || shot.videoPrompt.trim() === visual;
        if (!continuity && copiedPrompt && !shot.cameraMovement.trim() && !shot.dialogueVoiceover.trim() &&
            (visual.length > 110 || /心想|暗想|回想起|心里|从小|曾经|与此同时|第二天|多年以前/.test(visual))) {
            add({ code: "unplanned-prose", severity: "warning", message: `镜头 ${shot.shotNumber} 仍像小说段落，尚未拆成可拍摄的动作、台词和时空转换。` });
        }
    });
    return issues;
}
