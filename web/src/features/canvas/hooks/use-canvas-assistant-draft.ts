"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";
import { createAssistantDraftStore, EMPTY_ASSISTANT_DRAFT, type CanvasAssistantDraft } from "../domain/canvas-assistant-workspace";

const drafts = createAssistantDraftStore(() => window.sessionStorage);

export function useCanvasAssistantDraft(key: string, onStorageError: () => void) {
    const warned = useRef(false);
    const read = useCallback(() => drafts.read(key), [key]);
    const draft = useSyncExternalStore(drafts.subscribe, read, () => EMPTY_ASSISTANT_DRAFT);
    const update = useCallback((updater: (current: CanvasAssistantDraft) => CanvasAssistantDraft) => {
        if (!drafts.update(key, updater) && !warned.current) {
            warned.current = true;
            onStorageError();
        }
    }, [key, onStorageError]);
    return [draft, update] as const;
}
