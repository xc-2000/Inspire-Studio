/** Agent-only types extracted from infinite-canvas; see README.md for provenance. */

export const CanvasNodeType = {
    Image: "image",
    Panorama: "panorama",
    Text: "text",
    Config: "config",
    Video: "video",
    Audio: "audio",
    Director: "director",
    Group: "group",
} as const;
export type CanvasNodeType = (typeof CanvasNodeType)[keyof typeof CanvasNodeType];

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeType;
    title: string;
    label?: string;
    dataUrl?: string;
    url?: string;
    storageKey?: string;
    mimeType?: string;
    text?: string;
};

export type CanvasAgentPhase =
    | "intake"
    | "concept"
    | "script"
    | "breakdown"
    | "references"
    | "storyboard"
    | "video"
    | "audio"
    | "review"
    | "complete";

export type CanvasAgentState = {
    phase: CanvasAgentPhase;
    brief?: string;
    targetDurationSeconds?: number;
    approvedPlan?: string;
    approvedNodeIds: string[];
    referenceNodeIds: string[];
    pendingTaskIds: string[];
    completedTaskIds: string[];
};

export type CanvasAgentContent =
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
    >;

export type CanvasAgentToolCall = {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    argumentsError?: string;
};

export type CanvasAgentProtocolMessage =
    | { role: "user" | "system"; content: CanvasAgentContent }
    | { role: "assistant"; content?: string; reasoningContent?: string; responseItems?: unknown[]; toolCalls?: CanvasAgentToolCall[] }
    | { role: "tool"; content: string; toolCallId: string; name: string };

export type CanvasAssistantMessageStatus = "thinking" | "running" | "waiting" | "success" | "error";

export type CanvasAgentJsonFallbackMode = "structured-json" | "prompt-json";
export type CanvasAgentToolMode = "native" | CanvasAgentJsonFallbackMode;
