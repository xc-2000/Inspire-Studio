import { deleteCanvasProjects, getCanvasProject, listCanvasProjects, saveCanvasProject } from "@/services/api/server";

import type { CanvasDocument } from "../types";

export interface CanvasDocumentPersistence {
    loadDocuments: () => Promise<CanvasDocument[]>;
    loadDocument?: (id: string) => Promise<CanvasDocument>;
    saveDocument: (document: CanvasDocument) => Promise<void>;
    deleteDocuments: (documentIds: string[]) => Promise<void>;
}

export function createCanvasDocumentPersistence(): CanvasDocumentPersistence {
    return {
        loadDocuments: async () => {
            const { unpackDramaDocument } = await import("@/features/open-drama/drama-workspace");
            return (await listCanvasProjects<CanvasDocument>()).map(unpackDramaDocument);
        },
        loadDocument: async (id) => {
            const [document, { unpackDramaDocument }] = await Promise.all([
                getCanvasProject<CanvasDocument>(id), import("@/features/open-drama/drama-workspace"),
            ]);
            return unpackDramaDocument(document);
        },
        saveDocument: async (document) => {
            const { packDramaDocument } = await import("@/features/open-drama/drama-workspace");
            await saveCanvasProject(packDramaDocument(document));
        },
        deleteDocuments: async (documentIds) => {
            await deleteCanvasProjects(documentIds);
        },
    };
}
