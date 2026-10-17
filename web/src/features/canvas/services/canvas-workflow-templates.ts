import localforage from "localforage";
import type { CanvasWorkflowTemplate } from "../domain/canvas-workflow-template";
import { listWorkspaceRecords, saveWorkspaceRecord, deleteWorkspaceRecord } from "./canvas-workspace";

const library = localforage.createInstance({ name: "inspire-canvas-workflows", storeName: "templates" });
const scope = (userId: string) => `${encodeURIComponent(userId)}:`;

export async function listCanvasWorkflowTemplates(userId: string, visibility = "mine"): Promise<CanvasWorkflowTemplate[]> {
    const remote: CanvasWorkflowTemplate[] = [];
    for (let page = 1; ; page++) {
        const result = await listWorkspaceRecords<CanvasWorkflowTemplate>("template", { page, pageSize: 100, scope: visibility });
        remote.push(...result.items.map((item) => ({ ...item.data, id: item.id, revision: item.revision, visibility: item.visibility, owned: item.owned })));
        if (remote.length >= result.total || !result.items.length) break;
    }
    if (visibility === "public") return remote;
    // Cloud records remain usable when the browser denies IndexedDB access.
    const keys = (await library.keys().catch(() => [])).filter((key) => key.startsWith(scope(userId)));
    const values = await Promise.all(keys.map((key) => library.getItem<CanvasWorkflowTemplate>(key)));
    for (const value of values) {
        if (!value || remote.some(item => item.id === value.id)) continue;
        const saved = await saveCanvasWorkflowTemplate(userId, value);
        remote.push(saved);
        await library.removeItem(`${scope(userId)}${value.id}`).catch(() => undefined);
    }
    return remote.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function saveCanvasWorkflowTemplate(userId: string, template: CanvasWorkflowTemplate) {
    const item = await saveWorkspaceRecord({ id: template.id, kind: "template", title: template.name, revision: template.revision, visibility: template.visibility, data: template });
    return { ...item.data, revision: item.revision, visibility: item.visibility, owned: true };
}

export async function deleteCanvasWorkflowTemplate(userId: string, templateId: string) {
    await deleteWorkspaceRecord(templateId);
    await library.removeItem(`${scope(userId)}${templateId}`).catch(() => undefined);
}
