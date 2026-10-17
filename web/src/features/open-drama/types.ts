export type OpenDramaObjectType = "role" | "scene" | "prop" | string;

export interface OpenDramaShot {
    sort: number;
    description?: string;
    shotType?: number;
    cameraType?: string;
    cameraAngle?: string;
    cameraMove?: string;
    duration?: number;
    hasAudio?: boolean;
    imagePrompt?: string;
    videoPrompt?: string;
    objectIds?: number[];
    imgUrl?: string;
    videoUrl?: string;
}

export interface OpenDramaChapter {
    id: number;
    sort: number;
    name: string;
    charCount?: number;
    content?: string;
    shotCount?: number;
    shots: OpenDramaShot[];
}

export interface OpenDramaObject {
    id: number;
    type: OpenDramaObjectType;
    typeLabel?: string;
    name: string;
    description?: string;
    prompt?: string;
    imageUrl?: string;
    imageStatus?: number;
    voiceName?: string;
}

export interface OpenDramaProjectSummary {
    id: number;
    name: string;
    description?: string;
    tags: string[];
    author?: string;
    forkCount: number;
    starCount: number;
    license?: string;
    style?: string;
    aspect?: string;
    cover?: string;
    localCover: string;
    chapterCount: number;
    shotCount: number;
    scriptChars: number;
    promptCount: number;
    objectCount: number;
    fetchedAt?: string;
}

export interface OpenDramaProject extends OpenDramaProjectSummary {
    forkSource?: unknown[];
    forkMode?: number;
    styleDesc?: string;
    storyType?: number;
    creativeMode?: number;
    imageModel?: string;
    imageModelResolution?: string;
    videoModel?: string;
    videoModelResolution?: string;
    voiceId?: number;
    voiceSpeed?: number;
    coverVideo?: string;
    chapters: OpenDramaChapter[];
    objects: OpenDramaObject[];
}

export interface OpenDramaStats {
    projects: number;
    chapters: number;
    shots: number;
    scriptChars: number;
    imagePrompts: number;
    videoPrompts: number;
    descriptions: number;
    objects: number;
    byObjectType?: Record<string, number>;
}

export interface OpenDramaCatalog {
    generatedAt: string;
    stats: OpenDramaStats;
    projects: OpenDramaProjectSummary[];
}
