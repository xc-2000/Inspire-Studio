/** Agent context contract extracted from upstream; the host builds this from its own canvas model. */
import type { CanvasNodeType, CanvasAgentState, CanvasConnection } from "./types";
import type { readFilmPlanningConstraints } from "../film-planning";

export type CanvasAgentContextNode = {
    id: string;
    type: CanvasNodeType;
    title: string;
    text?: string;
    mediaUrl?: string;
    hasMedia?: boolean;
    status?: string;
    prompt?: string;
    model?: string;
    size?: string;
    seconds?: string;
    generateAudio?: string;
    taskId?: string;
    error?: string;
    groupId?: string;
};

export type CanvasAgentContext = {
    project: {
        id: string;
        title: string;
        nodeCount: number;
        connectionCount: number;
    };
    agentState: CanvasAgentState;
    selectedNodeIds: string[];
    nodes: CanvasAgentContextNode[];
    connections: CanvasConnection[];
    generation: {
        autoGenerateMedia: boolean;
        textModel: string;
        imageModel: string;
        videoModel: string;
        audioModel: string;
        imageQuality: string;
        imageSize: string;
        videoQuality: string;
        videoSize: string;
        imageCount: string;
        videoSeconds: string;
        filmPlanning?: ReturnType<typeof readFilmPlanningConstraints>;
        videoGenerateAudio: string;
        /** Omitted when the selected gateway model has no verified audio capability metadata. */
        videoSupportsAudio?: boolean;
        audioVoice: string;
        audioLanguage: string;
        audioFormat: string;
        audioSpeed: string;
    };
    tasks: Array<{
        nodeId: string;
        type: CanvasNodeType;
        status: string;
        taskId: string;
        progress?: number;
        error?: string;
    }>;
};

export function serializeCanvasAgentContext(context: CanvasAgentContext) {
    return JSON.stringify(context);
}
