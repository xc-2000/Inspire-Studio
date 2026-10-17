import type { ObjectStorageFile } from "@/shared/types/object-storage";
import type { CanvasBackgroundMode } from "@/shared/lib/canvas-theme";
import type { GenerationStyleSnapshot, SkillType } from "@/services/api/server";
import type { VideoGenerationMode } from "@/features/settings/stores/use-config-store";

export interface CanvasViewTransform {
    x: number;
    y: number;
    k: number;
}

export type CanvasGenerationMode = "text" | "image" | "video";

export type CanvasSettingGraphSkillSnapshot = {
    id: number;
    name: string;
    targetType: "canvasSettingGraph";
    systemPrompt: string;
    /** 技能默认生成比例；历史节点缺失时按16:9处理。 */
    aspectRatio?: string;
};

export type CanvasImageGenerationType = "generation" | "edit";

export interface CanvasConnection {
    id: string;
    source: CanvasConnectionEndpoint;
    target: CanvasConnectionEndpoint;
}

export interface CanvasAssistantReference {
    id: string;
    type: CanvasNodeKind;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    objectStorage?: ObjectStorageFile;
    text?: string;
}

export interface CanvasAssistantImage {
    id: string;
    dataUrl: string;
    storageKey?: string;
    prompt: string;
    objectStorage?: ObjectStorageFile;
}

/** Lightweight skill selections; executable prompts are fetched only for a submitted request. */
export type CanvasAgentSkillSelection = { id: number; name: string; targetType: SkillType };
export type CanvasAgentSkillSource = "manual" | "auto";

export interface CanvasAssistantMessage {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    references?: CanvasAssistantReference[];
    generationStyles?: Array<{ id: number; name: string; generationType: "image" | "video" }>;
    skills?: CanvasAgentSkillSelection[];
    skillSource?: CanvasAgentSkillSource;
}

export interface CanvasAssistantSession {
    id: string;
    title: string;
    messages: CanvasAssistantMessage[];
    createdAt: string;
    updatedAt: string;
    infiniteAgent?: import("./infinite-agent/session").InfiniteAgentMemory;
}

export interface ConnectionHandle {
    nodeId: string;
    handleType: "source" | "target";
}

export interface SelectionBox {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    additive: boolean;
    initialSelectedNodeIds: string[];
}

type NodeContextMenuState = {
    type: "node";
    x: number;
    y: number;
    nodeId: string;
    nodeKind: CanvasNodeKind;
};

type ConnectionContextMenuState = {
    type: "connection";
    x: number;
    y: number;
    connectionId: string;
};

type CanvasContextMenuState = {
    type: "canvas";
    x: number;
    y: number;
    position: CanvasPoint;
};

type SelectionContextMenuState = {
    type: "selection";
    x: number;
    y: number;
    nodeIds: string[];
};

export type ContextMenuState = NodeContextMenuState | ConnectionContextMenuState | CanvasContextMenuState | SelectionContextMenuState;

export interface CanvasPoint {
    x: number;
    y: number;
}

export interface CanvasViewport {
    offsetX: number;
    offsetY: number;
    zoom: number;
}

export type CanvasNodeKind = "image" | "text" | "video" | "audio" | "storyboard" | "videoComposition" | "background";

export type CanvasExecutionPhase = "idle" | "running" | "succeeded" | "failed";

export interface CanvasExecutionState {
    phase: CanvasExecutionPhase;
    taskId?: string;
    progress?: number;
    errorMessage?: string;
    startedAt?: string;
    completedAt?: string;
}

export interface CanvasNodeFrame {
    position: CanvasPoint;
    width: number;
    height: number;
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
}

export interface CanvasImageContent {
    source: string;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    objectStorage?: ObjectStorageFile;
}

export interface CanvasImageGenerationSettings {
    /** Compiled film prompts already contain the relevant story context. */
    includeUpstreamText?: boolean;
    editMask?: import("@/features/generation/types/image").ReferenceImage;
    operation: "generation" | "edit";
    prompt: string;
    model: string;
    size: string;
    quality: string;
    resolution: string;
    count: number;
    references: string[];
    referenceObjectStorages: ObjectStorageFile[];
    generationStyleIds: number[];
    generationStyleSnapshots: GenerationStyleSnapshot[];
    settingGraph?: CanvasSettingGraphSkillSnapshot;
}

export interface CanvasImageGrouping {
    isRoot: boolean;
    rootId?: string;
    childIds: string[];
    usesReferenceImages: boolean;
    primaryImageId?: string;
    expanded: boolean;
}

/** 音频节点保存真实波形采样，播放状态只保留在组件中。 */
/** 音频节点的语音合成设置：文字 → 配音。 */
export interface CanvasAudioSpeechSettings {
    /** 要朗读的文字。 */
    text: string;
    /** 语音模型，空字符串表示使用默认语音模型。 */
    model: string;
    /** 音色。 */
    voice: string;
    /** 语速倍数，默认 1。 */
    speed?: number;
    /** 情绪、语气等表演指示。 */
    instructions?: string;
    /** 说话人（一键成片按角色分配音色时记录）。 */
    speaker?: string;
}

export interface CanvasAudioNode extends CanvasNodeBase<"audio"> {
    content: CanvasVideoContent & {
        waveformPeaks: number[];
        /** 裁剪片段在原音频中的起始位置，未设置时从0开始。 */
        trimStartMilliseconds?: number;
        /** 裁剪片段在原音频中的结束位置，未设置时使用原始时长。 */
        trimEndMilliseconds?: number;
        /** 连接到成片合成节点时，在成片时间轴上的起点（毫秒），未设置时从 0 开始。 */
        timelineStartMilliseconds?: number;
        /** 叠加到成片时的音量倍数，默认 1。 */
        timelineVolume?: number;
    };
    /** 语音合成设置；上传的音频没有此项。 */
    speech?: CanvasAudioSpeechSettings;
}

export interface CanvasVideoContent {
    source: string;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    durationMilliseconds?: number;
    objectStorage?: ObjectStorageFile;
}

export interface CanvasVideoGenerationSettings {
    includeUpstreamText?: boolean;
    prompt: string;
    model: string;
    size: string;
    seconds: string;
    quality: string;
    /** 视频生成模式；历史画布数据缺失时按文生视频处理。 */
    videoGenerationMode?: VideoGenerationMode;
    watermark: string;
    generateAudio?: string;
    count: number;
    /** 新版持久化的参考图片地址；历史数据可能缺失。 */
    references: string[];
    referenceObjectStorages: ObjectStorageFile[];
    /** 新版持久化的参考视频地址；历史数据可能缺失。 */
    audioReferences?: import("@/features/generation/types/media").ReferenceAudio[];
    videoReferences?: string[];
    /** 新版持久化的参考视频对象存储信息；历史数据可能缺失。 */
    videoReferenceObjectStorages?: ObjectStorageFile[];
    generationStyleIds: number[];
    generationStyleSnapshots: GenerationStyleSnapshot[];
}

interface CanvasNodeBase<Kind extends CanvasNodeKind> {
    dramaChapterId?: string;
    dramaShotId?: string;
    dramaStoryboardId?: string;
    workflowCondition?: import("./domain/canvas-workflow-run").WorkflowCondition;
    id: string;
    kind: Kind;
    title: string;
    frame: CanvasNodeFrame;
    execution: CanvasExecutionState;
}

export interface CanvasImageNode extends CanvasNodeBase<"image"> {
    content: CanvasImageContent;
    generation: CanvasImageGenerationSettings;
    grouping: CanvasImageGrouping;
}

export interface CanvasTextNode extends CanvasNodeBase<"text"> {
    content: {
        text: string;
        fontSize: number;
        /** Generation configuration text is an instruction, while regular text is material to rewrite. */
        role?: "text" | "generation-prompt";
    };
}

export type CanvasStoryboardShotSize = "大特写" | "特写" | "近景" | "头肩景" | "中景" | "中远景" | "全景" | "远景" | "大远景" | "大全景";

export type CanvasStoryboardAssetKind = "character" | "scene" | "prop";

export interface CanvasStoryboardAssetImage {
    source: string;
    storageKey?: string;
    mimeType?: string;
    objectStorage?: ObjectStorageFile;
}

export interface CanvasStoryboardShotVideo extends CanvasStoryboardAssetImage {
    poster?: string;
    /** Settings used by this take, for continuity checks before reusing it. */
    model?: string;
    size?: string;
    sourceSignature?: string;
    previousVideoStorageKey?: string;
}

export type CanvasStoryboardAssetGenerationPhase = "idle" | "running" | "succeeded" | "failed";

export type CanvasStoryboardAssetGenerationItemStatus = "pending" | "running" | "succeeded" | "failed";

export interface CanvasStoryboardAssetGenerationSettings {
    model: string;
    quality: string;
    imageResolution: string;
    size: string;
}

export interface CanvasStoryboardAssetGenerationState {
    phase: CanvasStoryboardAssetGenerationPhase;
    selectedAssetIds: string[];
    taskIds: Record<string, string>;
    statuses: Record<string, CanvasStoryboardAssetGenerationItemStatus>;
    errors: Record<string, string>;
    settings: CanvasStoryboardAssetGenerationSettings;
    progress: number;
    errorMessage?: string;
    startedAt?: string;
    completedAt?: string;
}

export interface CanvasStoryboardShotImageTask {
    taskId?: string;
    /** Distinguishes a new generation from late progress for a previous request. */
    requestVersion?: number;
    status: CanvasStoryboardAssetGenerationItemStatus;
    progress: number;
    error?: string;
}

export interface CanvasStoryboardShotImageGenerationState {
    batchId: string;
    phase: "running" | "succeeded" | "failed";
    selectedShotIds: string[];
    tasks: Record<string, CanvasStoryboardShotImageTask>;
}

export interface CanvasStoryboardAsset {
    id: string;
    kind: CanvasStoryboardAssetKind;
    name: string;
    description: string;
    image?: CanvasStoryboardAssetImage;
}

export interface CanvasShotContinuity {
    sceneId: string;
    time: string;
    transition: "establish" | "continue" | "cut" | "time-jump" | "flashback" | "return";
    openingState: string;
    closingState: string;
    storyBeat: string;
}

export interface CanvasStoryboardRevision {
    id: string;
    createdAt: string;
    sourceSignature: string;
    shots: CanvasStoryboardShot[];
    assets: CanvasStoryboardAsset[];
    instruction: string;
    visualStyle: string;
}

export interface CanvasStoryboardShot {
    continuity?: CanvasShotContinuity;
    imagePrompt?: string;
    videoPrompt?: string;
    /** The video prompt already contains rewritten narrative and continuity context. */
    videoPromptContextMode?: "self-contained";
    id: string;
    shotNumber: number;
    durationSeconds: number;
    visualDescription: string;
    shotSize: CanvasStoryboardShotSize;
    lightingAtmosphere: string;
    dialogueVoiceover: string;
    soundEffect: string;
    cameraMovement: string;
    finalPrompt: string;
    assetIds: string[];
    /** Legacy named-asset references were checked; later manual removal must persist. */
    assetReferenceVersion?: 1;
    image?: CanvasStoryboardAssetImage;
    video?: CanvasStoryboardShotVideo;
}

export interface CanvasStoryboardNode extends CanvasNodeBase<"storyboard"> {
    content: {
        instruction: string;
        visualStyle: string;
        model: string;
    };
    storyboard: {
        /** Persisted project asset references; expanded into assets in the editor. */
        projectAssetIds?: string[];
        shots: CanvasStoryboardShot[];
        assets: CanvasStoryboardAsset[];
        revisions?: CanvasStoryboardRevision[];
        assetGeneration?: CanvasStoryboardAssetGenerationState;
        shotImageGeneration?: CanvasStoryboardShotImageGenerationState;
    };
}

export interface CanvasVideoNode extends CanvasNodeBase<"video"> {
    /** Input snapshot survives refresh so late completions cannot certify edited storyboards. */
    dramaVideoPlan?: { boardId: string; shotId: string; signature: string; previousVideoStorageKey?: string };
    /** 已检查短剧视频的自动参考图布局；避免重载时覆盖后续手动选择。 */
    dramaVideoReferenceVersion?: 1;
    content: CanvasVideoContent;
    generation: CanvasVideoGenerationSettings;
}

/** 视频合成节点的持久化数据。 */
export interface CanvasVideoCompositionData {
    editingSourceNodeIds?: string[];
    editingOptions?: import("@/services/api/video-composition").VideoEditingOptions;
    /** 按最终合成顺序排列的直接输入视频节点ID。 */
    inputVideoNodeIds: string[];
    /** 本次合成实际使用的有序媒体键；来源节点原地重新生成后不得复用旧成片。 */
    inputStorageKeys?: string[];
    /** 本次合成叠加的配音/旁白音频媒体键。 */
    inputAudioStorageKeys?: string[];
    /** 叠加配音时视频原声的音量倍数（0 为静音）；未设置时服务端默认 0.6。 */
    originalAudioVolume?: number;
    /** 最近一次合成创建的结果视频节点ID。 */
    resultVideoNodeId?: string;
}

/** 画布视频合成节点。 */
export interface CanvasVideoCompositionNode extends CanvasNodeBase<"videoComposition"> {
    /** 视频合成业务数据。 */
    composition: CanvasVideoCompositionData;
}

/** 画布背景板节点，使用绝对坐标包裹一组普通内容节点。 */
export interface CanvasBackgroundNode extends CanvasNodeBase<"background"> {
    /** 背景板填充颜色，使用主题预设颜色标识。 */
    backgroundColor: string;
    /** 背景板直接包含的普通节点标识。 */
    memberNodeIds: string[];
}

export type CanvasNode = CanvasAudioNode | CanvasImageNode | CanvasTextNode | CanvasVideoNode | CanvasStoryboardNode | CanvasVideoCompositionNode | CanvasBackgroundNode;

export interface CanvasConnectionEndpoint {
    nodeId: string;
    portId?: string | null;
}

export interface CanvasScene {
    nodes: CanvasNode[];
    connections: CanvasConnection[];
    viewport: CanvasViewport;
}

export interface CanvasDocumentIdentity {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
}

export interface CanvasConversation {
    sessions: CanvasAssistantSession[];
    activeSessionId: string | null;
}

export interface CanvasPreferences {
    drama?: CanvasDramaProject;
    videoTimeline?: import("./domain/canvas-timeline").TimelineDraft;
    background: CanvasBackgroundMode;
    showImageInformation: boolean;
}

export interface CanvasDramaChapter {
    id: string;
    title: string;
    assembly?: import("@/features/open-drama/drama-chapter-assembly").ChapterAssemblyCheckpoint;
    scriptNodeId?: string;
    storyboardNodeId: string;
    viewport?: CanvasViewport;
}

export interface CanvasDramaProject {
    version: 1;
    assembly?: import("@/features/open-drama/drama-assembly").DramaAssemblyState;
    sourceId?: number;
    chapters: CanvasDramaChapter[];
    assets: CanvasStoryboardAsset[];
    activeChapterId: string | null;
    view: "shots" | "canvas" | "overview";
    cover?: string;
}

export interface CanvasDocument {
    identity: CanvasDocumentIdentity;
    scene: CanvasScene;
    conversation: CanvasConversation;
    preferences: CanvasPreferences;
}
