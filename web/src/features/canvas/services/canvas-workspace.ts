import { serverPost } from "@/services/api/server";

export type WorkspaceKind = "template" | "version" | "run";
export type WorkspaceRecord<T> = { id: string; kind: WorkspaceKind; projectId: string; title: string; revision: number; visibility: "private" | "public"; owned: boolean; data: T; createdAt: string; updatedAt: string };
export const listWorkspaceRecords = <T>(kind: WorkspaceKind, options: { projectId?: string; search?: string; scope?: string; page?: number; pageSize?: number } = {}) =>
    serverPost<{ items: WorkspaceRecord<T>[]; total: number }>("/canvas/workspace/list", { kind, ...options });
export const getWorkspaceRecord = <T>(id: string) => serverPost<WorkspaceRecord<T>>("/canvas/workspace/get", { id });
export const saveWorkspaceRecord = <T>(record: { id: string; kind: WorkspaceKind; projectId?: string; title: string; revision?: number; visibility?: string; data: T }) => serverPost<WorkspaceRecord<T>>("/canvas/workspace/save", record);
export const deleteWorkspaceRecord = (id: string) => serverPost("/canvas/workspace/delete", { id });
