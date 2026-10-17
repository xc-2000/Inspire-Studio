import { inspectBeatExecutionStructure } from "./tapcanvas/video-authoring-stages/beat-structure.mjs";
import { clipProductionTimelineDraftSchema, compileClipProductionTimeline, renderClipSpokenLine, type ClipProductionTimelineDraft } from "./tapcanvas/clip-production-packet/timeline.mjs";
import type { FilmVoiceLine, FilmWorkflowInput } from "./film-workflow";
import { SPEECH_VOICE_OPTIONS } from "@/features/generation/lib/speech-voices";

export type FilmStoryAsset = { id: string; name: string; kind: "character" | "scene" | "prop"; identity: string; imagePrompt: string; sourceNodeId?: string; voice?: string };
/** 语音合成可用时的配音音色候选，与 get_generation_config.speech.voices 一致。 */
export const FILM_SPEECH_VOICES = SPEECH_VOICE_OPTIONS.map((voice) => voice.value);
/** 中文朗读估算语速（字/秒），用于给每句配音留出不重叠的时间窗。 */
const SPOKEN_CHARACTERS_PER_SECOND = 4.5;
export type FilmStoryBeat = {
    id: string; title: string; description: string; seconds: number; entryState: string; exitState: string;
    assetIds: string[];
    storyEvents: { sourceBeatId: string; event: string; entryState: string; exitState: string; startSeconds: number; endSeconds: number }[];
    dialogueScript: { lineId: string; speakerName: string; text: string; delivery: "on_screen" | "off_screen" | "voice_over" }[];
};
export type FilmStoryPlan = {
    title: string; script: string; visualStyle: string; targetDurationSeconds: number; durationRationale: string;
    assets: FilmStoryAsset[]; beats: FilmStoryBeat[];
    aspectRatio?: string;
    /** 旁白（voice_over 且说话人不是登记角色）使用的音色。 */
    narratorVoice?: string;
};
export type FilmClipDesign = { beatId: string; imagePrompt: string; timeline: ClipProductionTimelineDraft };

const text = { type: "string", minLength: 1 };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const array = (items: unknown, maxItems: number, minItems = 0) => ({ type: "array", items, minItems, maxItems });
const seconds = { type: "integer", minimum: 1, maximum: 300, description: "一次视频生成的总时长，必须属于当前videoDuration.options；按segmentPolicy优先利用较长档位承载连续剧情，内部可有多个镜头，不能把每个内部镜头另拆一次生成。" };
export const FILM_STORY_PLAN_PROPERTIES = {
    aspectRatio: { type: "string", enum: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], description: "整片实际生成画幅。用户明确指定时必须填写，不能只在风格文字中描述；未指定时沿用当前视频画幅。" },
    title: text, script: { ...text, description: "完整可拍正文。原创时由AI编写，已有稿时忠实沿用。" },
    visualStyle: { ...text, description: "整片唯一的画风、色彩与光线基线。必须明确写出是二维（如日式赛璐璐）还是三维/写实中的一种，不得混写两类渲染方式；启用的技能画风互相冲突时，以用户要求为准只保留一种。" },
    narratorVoice: { type: "string", description: "旁白音色ID，仅在语音合成可用且有旁白时填写，从 get_generation_config.speech.voices 选择" },
    targetDurationSeconds: { type: "integer", minimum: 1, maximum: 600 }, durationRationale: { ...text, description: "结合当前模型时长能力、剧情连续性与对白节奏，说明各段秒数、拆分边界和收尾安排；支持较长档位却采用短段时说明叙事理由。" },
    assets: array(object({ id: text, name: text, kind: { type: "string", enum: ["character", "scene", "prop"] }, identity: { ...text, description: "固定视觉身份，后续每段视频只凭首帧和这段文字维持外观，必须可直接画出：人物写性别年龄感、发型发色、服装与主配色、标志配件；非人角色写物种/类型、体型与相对比例（如及膝高的小型四足猫形机器人）、轮廓、材质与配色；场景写空间结构与主光色。不要只写性格或身份。" }, imagePrompt: text, sourceNodeId: { ...text, description: "已有真实参考图片节点ID；仅在需要复用时填写" }, voice: { type: "string", description: "有台词角色的配音音色ID，仅在语音合成可用时填写，从 get_generation_config.speech.voices 按角色年龄性别气质选择；不同角色用不同音色" } }, ["id", "name", "kind", "identity", "imagePrompt"]), 12),
    beats: array(object({ id: text, title: text, description: text, seconds, entryState: text, exitState: text,
        assetIds: { ...array(text, 12), uniqueItems: true },
        storyEvents: array(object({ sourceBeatId: { ...text, description: "本片段内唯一事件ID，供后续镜头绑定" }, event: text, entryState: text, exitState: text, startSeconds: { type: "number", minimum: 0 }, endSeconds: { type: "number", exclusiveMinimum: 0 } }), 30, 1),
        dialogueScript: array(object({ lineId: text, speakerName: text, text, delivery: { type: "string", enum: ["on_screen", "off_screen", "voice_over"] } }), 30),
    }), 20, 1),
};
/** Restated at the end of every media prompt: long shot descriptions otherwise outweigh the opening style line. */
function consistencyLock(plan: FilmStoryPlan, beat: FilmStoryBeat, scope: "image" | "video") {
    const characters = plan.assets.filter(asset => asset.kind === "character" && beat.assetIds.includes(asset.id));
    const lines = [`一致性锁定（优先于上文描述）：`, `- 画风：${plan.visualStyle}。${scope === "video" ? "全段每个内部镜头保持同一画风、线条与材质质感，切镜后不得改变渲染方式。" : "不得改变渲染方式。"}`];
    if (characters.length) {
        lines.push(`- 角色：${characters.map(asset => `${asset.name}（${asset.identity}）`).join("；")}。物种、体型比例、轮廓、发型、服装与配色${scope === "video" ? "全段与首帧一致；切镜后再次出现时按首帧外观还原，不重新设计" : "与参考图一致"}。`);
        lines.push("- 每个角色在同一画面中只出现一次：不复制、不分身、不叠加同一角色的远近两个版本；不变形、不放大成其他形态。");
        if (scope === "video") lines.push("- 不引入首帧与上述名单之外的新主要角色。");
    }
    return lines.join("\n");
}

/** 旁白音色只在有旁白且语音可用时填写，其余字段都必须给出。 */
export const FILM_STORY_PLAN_REQUIRED = Object.keys(FILM_STORY_PLAN_PROPERTIES).filter((key) => key !== "narratorVoice");
export const FILM_CLIPS_SCHEMA = array(object({ beatId: text, imagePrompt: text, timeline: clipProductionTimelineDraftSchema }), 20, 1);

function fail(message: string): never { throw new Error(`成片编排校验：${message}；尚未提交媒体生成`); }
function required(value: unknown, label: string): string {
    if (typeof value !== "string" || !value.trim()) fail(`${label}不能为空`);
    return value.trim();
}
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("计划必须是对象");
    return value as Record<string, unknown>;
}
function list(value: unknown, label: string, min: number, max: number): unknown[] {
    if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${label}需要 ${min}–${max} 项`);
    return Array.from(value);
}
function unique(values: string[], label: string) { if (new Set(values).size !== values.length) fail(`${label}不能重复`); }

const stateText = (value: unknown) => typeof value === "string" ? value.trim() : "";
const stateKey = (value: string) => value.replace(/[\s\p{P}\p{S}]/gu, "");
function bigrams(value: string): string[] {
    const chars = Array.from(value);
    return chars.length < 2 ? chars : chars.slice(1).map((char, index) => chars[index] + char);
}
/** True when two continuity states are the same fact with cosmetic drift (punctuation, a few words). */
export function sameContinuityState(left: string, right: string): boolean {
    const a = stateKey(left), b = stateKey(right);
    if (!a || !b) return false;
    if (a === b) return true;
    const shorter = a.length <= b.length ? a : b, longer = shorter === a ? b : a;
    if (shorter.length >= 8 && longer.includes(shorter) && shorter.length / longer.length >= 0.6) return true;
    const x = bigrams(a), y = bigrams(b), pool = new Map<string, number>();
    for (const gram of y) pool.set(gram, (pool.get(gram) || 0) + 1);
    let shared = 0;
    for (const gram of x) { const left = pool.get(gram) || 0; if (left) { shared++; pool.set(gram, left - 1); } }
    return (2 * shared) / (x.length + y.length) >= 0.8;
}
/**
 * Continuity states are copies by contract (event entry = previous exit, beat exit = last event exit,
 * next beat entry = beat exit). Models often re-type a copy with cosmetic drift; snap those to the
 * authored exit state. Real differences are left untouched so the validator still rejects story jumps.
 */
export function alignContinuityStates(raw: Record<string, unknown>): Record<string, unknown> {
    if (!Array.isArray(raw.beats)) return raw;
    const snap = (target: Record<string, unknown>, key: string, source: string) => {
        const current = stateText(target[key]);
        if (source && current !== source && sameContinuityState(current, source)) target[key] = source;
    };
    let previousExit = "";
    const beats = raw.beats.map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return value;
        const beat = { ...(value as Record<string, unknown>) };
        snap(beat, "entryState", previousExit);
        let cursor = stateText(beat.entryState);
        if (Array.isArray(beat.storyEvents)) {
            beat.storyEvents = beat.storyEvents.map((item) => {
                if (!item || typeof item !== "object" || Array.isArray(item)) return item;
                const event = { ...(item as Record<string, unknown>) };
                snap(event, "entryState", cursor);
                cursor = stateText(event.exitState);
                return event;
            });
            snap(beat, "exitState", cursor);
        }
        previousExit = stateText(beat.exitState);
        return beat;
    });
    return { ...raw, beats };
}

/** Freeze model-authored facts before downstream media prompts are written. No host-written story or timing. */
export function normalizeFilmStoryPlan(value: unknown): FilmStoryPlan {
    const raw = alignContinuityStates(record(value));
    if (raw.aspectRatio !== undefined && !["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(String(raw.aspectRatio))) fail("成片画幅不合法");
    const assets = list(raw.assets, "共享资产", 0, 12).map(value => {
        const asset = record(value);
        if (!["character", "scene", "prop"].includes(String(asset.kind))) fail("资产类型不合法");
        return { id: required(asset.id, "资产ID"), name: required(asset.name, "资产名称"), kind: asset.kind as FilmStoryAsset["kind"], identity: required(asset.identity, "身份特征"), imagePrompt: required(asset.imagePrompt, "资产图片提示词"), ...(asset.sourceNodeId === undefined ? {} : { sourceNodeId: required(asset.sourceNodeId, "参考节点ID") }), ...(typeof asset.voice === "string" && asset.voice.trim() ? { voice: asset.voice.trim() } : {}) };
    });
    unique(assets.map(asset => asset.id), "资产ID");
    const beats = list(raw.beats, "剧情片段", 1, 20).map((value, index) => {
        const beat = record(value);
        if (!Number.isSafeInteger(beat.seconds) || Number(beat.seconds) < 1 || Number(beat.seconds) > 300) fail(`片段 ${index + 1} 秒数不合法`);
        const error = inspectBeatExecutionStructure({ ...beat, durationSeconds: beat.seconds }, index);
        if (error) fail(error);
        const events = list(beat.storyEvents, "剧情事件", 1, 30).map(value => {
            const event = record(value);
            return { sourceBeatId: required(event.sourceBeatId, "事件ID"), event: required(event.event, "事件动作"), entryState: required(event.entryState, "进入状态"), exitState: required(event.exitState, "退出状态"), startSeconds: event.startSeconds as number, endSeconds: event.endSeconds as number };
        });
        unique(events.map(event => event.sourceBeatId), "片段内事件ID");
        let cursor = 0;
        for (const event of events) {
            if (event.startSeconds < cursor || event.endSeconds > Number(beat.seconds)) fail(`片段 ${index + 1} 事件时间越界或重叠`);
            cursor = event.endSeconds;
        }
        const dialogueScript = list(beat.dialogueScript, "对白", 0, 30).map(value => {
            const line = record(value);
            return { lineId: required(line.lineId, "对白ID"), speakerName: required(line.speakerName, "说话人"), text: required(line.text, "对白内容"), delivery: line.delivery as FilmStoryBeat["dialogueScript"][number]["delivery"] };
        });
        unique(dialogueScript.map(line => line.lineId), "片段内对白ID");
        const assetIds = list(beat.assetIds, "片段资产", 0, 12).map(id => required(id, "资产ID"));
        unique(assetIds, "片段资产");
        if (assetIds.some(id => !assets.some(asset => asset.id === id))) fail(`片段 ${index + 1} 引用了未登记资产`);
        const entryState = required(beat.entryState, "进入状态");
        if (events[0].entryState !== entryState) fail(`片段 ${index + 1} 首事件必须承接片段进入状态`);
        return { id: required(beat.id, "片段ID"), title: required(beat.title, "片段标题"), description: required(beat.description, "片段正文"), seconds: beat.seconds as number, entryState, exitState: required(beat.exitState, "退出状态"), storyEvents: events, dialogueScript, assetIds };
    });
    unique(beats.map(beat => beat.id), "片段ID");
    for (let i = 1; i < beats.length; i++) {
        if (beats[i].entryState !== beats[i - 1].exitState) fail(`片段 ${i + 1} 进入状态必须原样承接上一片段退出状态；转场或时间跳跃请写成可见事件`);
    }
    if (assets.some(asset => !beats.some(beat => beat.assetIds.includes(asset.id)))) fail("共享资产必须有片段实际引用，不能生成无用资产");
    const total = beats.reduce((sum, beat) => sum + beat.seconds, 0);
    if (!Number.isSafeInteger(raw.targetDurationSeconds) || raw.targetDurationSeconds !== total) fail(`计划总时长必须等于各片段之和 ${total} 秒`);
    return { title: required(raw.title, "标题"), script: required(raw.script, "剧本"), visualStyle: required(raw.visualStyle, "整体风格"), targetDurationSeconds: total, durationRationale: required(raw.durationRationale, "时长依据"), assets, beats, ...(raw.aspectRatio ? { aspectRatio: String(raw.aspectRatio) } : {}), ...(typeof raw.narratorVoice === "string" && raw.narratorVoice.trim() ? { narratorVoice: raw.narratorVoice.trim() } : {}) };
}

export function normalizeFilmClips(value: unknown): FilmClipDesign[] {
    return list(value, "片段镜头设计", 1, 20).map(value => {
        const clip = record(value);
        return { beatId: required(clip.beatId, "片段ID"), imagePrompt: required(clip.imagePrompt, "分镜图提示词"), timeline: record(clip.timeline) as FilmClipDesign["timeline"] };
    });
}

/** Directly uses TapCanvas's production compiler: every frozen event and line must be covered in order. */
export function compileFilmStoryPlan(planInput: FilmStoryPlan, clipsInput: unknown): FilmWorkflowInput {
    const plan = normalizeFilmStoryPlan(planInput), clips = normalizeFilmClips(clipsInput);
    if (clips.length !== plan.beats.length || clips.some((clip, index) => clip.beatId !== plan.beats[index].id)) fail("片段设计必须完整覆盖已冻结剧情，顺序与ID不得改变");
    const shots = plan.beats.map((beat, index) => {
        const clip = clips[index];
        const speechEvents = beat.dialogueScript.map((line, eventIndex) => ({ speechEventId: line.lineId, speaker: line.speakerName, text: line.text, delivery: "", voice: line.delivery === "voice_over" ? "narration" as const : line.delivery === "off_screen" ? "offscreen" as const : "onscreen" as const, textOrigin: "authored" as const, eventIndex, clipId: beat.id, sceneId: beat.id, scope: "beat" as const, sourceRanges: [] }));
        const prompt = compileClipProductionTimeline({ draft: clip.timeline,
            storyEvents: beat.storyEvents.map((event, eventIndex) => ({ eventId: event.sourceBeatId, eventIndex })),
            speechEvents,
        });
        const dubbedPrompt = silenceSpokenLines(prompt, speechEvents);
        const identity = plan.assets.filter(asset => beat.assetIds.includes(asset.id)).map(asset => `${asset.name}：${asset.identity}`).join("\n");
        const visual = `统一画风：${plan.visualStyle}${identity ? `\n共享身份（保持外观）：\n${identity}` : ""}`;
        const transition = `进入状态：${beat.entryState}\n结束状态：${beat.exitState}`;
        return { title: beat.title, description: `${beat.description}\n\n${transition}\n\n${prompt}`, imagePrompt: `单幅连续画面，仅表现片段开始的一个瞬间；不要分屏、拼图、分镜格、字幕或时间码。参考图只用于身份与造型，不沿用拼图排版。\n${visual}\n首帧状态：${beat.entryState}\n${clip.imagePrompt}\n${consistencyLock(plan, beat, "image")}`, videoPrompt: `本次生成总时长：${beat.seconds} 秒，以下内部镜头共同组成这一段连续视频。完整呈现动作、对白与状态变化，不用静止画面或重复动作填充。\n${visual}\n${transition}\n${prompt}\n${consistencyLock(plan, beat, "video")}`,
            dubbedVideoPrompt: `本次生成总时长：${beat.seconds} 秒，以下内部镜头共同组成这一段连续视频。完整呈现动作与状态变化，不用静止画面或重复动作填充。\n${visual}\n${transition}\n${dubbedPrompt}\n${consistencyLock(plan, beat, "video")}\n${DUBBED_AUDIO_RULE}`, seconds: beat.seconds, referenceAssetIds: beat.assetIds };
    });
    return { title: plan.title, script: plan.script, targetDurationSeconds: plan.targetDurationSeconds, durationRationale: plan.durationRationale, aspectRatio: plan.aspectRatio, shots, voiceover: planVoiceover(plan, clips), assets: plan.assets.map(asset => ({ ...asset, imagePrompt: `只生成单幅资产参考图，不要分屏、拼图、剧情分镜、字幕或时间码。\n统一画风：${plan.visualStyle}\n${asset.identity}\n${asset.imagePrompt}` })), productionVersion: "tapcanvas-adapted/v1" };
}

/**
 * 把已冻结的对白/旁白换算成成片时间轴上的配音：起点取该句所在内部镜头首个剧情事件的开始时间，
 * 同段内按估算朗读时长顺延避免重叠；时间窗截止到下一句或片段结尾。
 */
export function planVoiceover(plan: FilmStoryPlan, clips: FilmClipDesign[]): FilmVoiceLine[] {
    const lines: FilmVoiceLine[] = [];
    const speakers: string[] = [];
    let offset = 0;
    plan.beats.forEach((beat, beatIndex) => {
        const shots = clips[beatIndex]?.timeline?.shots || [];
        let cursor = 0;
        const timed = beat.dialogueScript.map((line) => {
            const shot = shots.find((item) => item.speechEventIds?.includes(line.lineId));
            const eventStarts = (shot?.storyEventIds || []).map((id) => beat.storyEvents.find((event) => event.sourceBeatId === id)?.startSeconds).filter((value): value is number => typeof value === "number");
            const anchor = eventStarts.length ? Math.min(...eventStarts) : cursor;
            const start = Math.min(Math.max(anchor, cursor), Math.max(0, beat.seconds - 0.5));
            cursor = start + Math.max(0.8, line.text.length / SPOKEN_CHARACTERS_PER_SECOND) + 0.2;
            return { line, start };
        });
        timed.forEach(({ line, start }, index) => {
            const end = index + 1 < timed.length ? timed[index + 1].start : beat.seconds;
            if (!speakers.includes(line.speakerName)) speakers.push(line.speakerName);
            lines.push({
                lineId: `${beat.id}:${line.lineId}`, beatId: beat.id, speaker: line.speakerName, text: line.text, delivery: line.delivery,
                voice: voiceFor(plan, line.speakerName, line.delivery, speakers.indexOf(line.speakerName)),
                startMs: Math.round((offset + start) * 1000), maxDurationMs: Math.max(500, Math.round((end - start) * 1000)),
            });
        });
        offset += beat.seconds;
    });
    return lines;
}

function voiceFor(plan: FilmStoryPlan, speaker: string, delivery: FilmStoryBeat["dialogueScript"][number]["delivery"], speakerIndex: number): string {
    const character = plan.assets.find((asset) => asset.kind === "character" && asset.name === speaker);
    if (character?.voice) return character.voice;
    if (delivery === "voice_over" && !character && plan.narratorVoice) return plan.narratorVoice;
    return FILM_SPEECH_VOICES[speakerIndex % FILM_SPEECH_VOICES.length];
}

/** 后期配音时视频本身不能出人声，否则成片里同一句台词会被念两遍。 */
export const DUBBED_AUDIO_RULE = "声音要求（优先于上文）：本段不要生成任何人声——不说话、不念台词、不出旁白、不唱歌、不发出拟声人声；只保留环境音和动作音效。所有台词与旁白由后期配音，画面中的角色口型保持自然。";

/** 把提示词里的台词原文换成无声提示：视频模型看到台词原文就会把它念出来。 */
export function silenceSpokenLines(prompt: string, speechEvents: Array<{ speaker: string; text: string; delivery: string; voice: "onscreen" | "offscreen" | "narration" }>): string {
    return speechEvents.reduce((text, event) => {
        const rendered = renderClipSpokenLine(event);
        const placeholder = event.voice === "onscreen" ? `${event.speaker}开口说了一句话（不发声，台词后期配音）`
            : event.voice === "offscreen" ? `（此处有${event.speaker}的画外音，后期配音，画面中无人说话）`
            : "（此处是旁白，后期配音，画面中无人说话）";
        return text.split(rendered).join(placeholder);
    }, prompt);
}
