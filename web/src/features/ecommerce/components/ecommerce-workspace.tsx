"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { App, Button, Drawer, Dropdown, Input, Popconfirm, Select, Spin } from "antd";
import { Tabs } from "radix-ui";
import { ArrowRight, Check, ChevronDown, Clapperboard, Copy, FileText, FolderOpen, ImageIcon, Package, Plus, RefreshCw, Save, Search, ShoppingBag, SlidersHorizontal, Sparkles, Trash2, X } from "lucide-react";
import { nanoid } from "nanoid";
import { useQuery } from "@tanstack/react-query";
import { getAiTaskInfo, getServerMediaInfo, ServerResponseError, type ServerAiTask } from "@/services/api/server";
import { uploadImage } from "@/features/storage/services/image-storage";
import { ModelPicker } from "@/features/settings/components/model-picker";
import { useEffectiveConfig } from "@/features/settings/stores/use-config-store";
import { useUserStore } from "@/features/auth/stores/use-user-store";
import { ListPagination } from "@/shared/components/list-pagination";
import { CommerceResult } from "./commerce-result";
import { CommerceSkillPicker } from "./commerce-skill-picker";
import { listCommerceSkills } from "../api/skills";
import { resolveCommerceSkill } from "../lib/skills";
import { restorePlatformProject } from "../lib/platform-project";
import { isDefiniteCommerceRejection, prepareCommerceSubmission, restoreCommerceSubmission, type CommercePendingSubmission } from "../lib/pending-submission";
import { commercePlatforms, commerceOutputs, type CommerceKind, type CommercePlatform } from "../lib/catalog";
import { resolveCommerceGenerationSettings } from "../lib/generation-settings";
import { commerceImageGenerationModeFromRequest, resolveCommerceImageGenerationMode } from "../lib/image-generation-mode";
import {
    deleteCommerceProject,
    emptyCommerceData,
    generateCommerce,
    getCommerceProject,
    listCommerceJobs,
    listCommerceProjects,
    saveCommerceProject,
    type CommerceData,
    type CommerceJob,
    type CommerceProduct,
    type CommerceProject,
} from "../api/ecommerce";
import "./ecommerce.css";

type Draft = { id: string; revision: number; platform: CommercePlatform; title: string; data: CommerceData };
const freshDraft = (platform: CommercePlatform): Draft => ({ id: nanoid(), revision: 0, platform, title: "", data: emptyCommerceData() });
const normalizeDraft = (draft: Draft): Draft => ({ ...draft, data: { ...emptyCommerceData(), ...draft.data, imageGenerationMode: resolveCommerceImageGenerationMode(draft.data.imageGenerationMode, draft.data.references.length) } });
const fingerprint = (draft: Draft) => JSON.stringify({ title: draft.title, data: draft.data });
const errorText = (error: unknown) => (error instanceof Error ? error.message : "操作失败，请重试");
const resultGroups = [
    { id: "image", label: "图片", description: "商品主图、场景图与细节图", icon: ImageIcon, outputId: "hero" },
    { id: "text", label: "文案", description: "卖点文案、详情页文案与带货脚本", icon: FileText, outputId: "copy" },
    { id: "video", label: "视频", description: "商品展示与带货视频", icon: Clapperboard, outputId: "video" },
] as const;
type ResultGroup = (typeof resultGroups)[number]["id"];
const resultGroupForKind = (kind: CommerceKind): ResultGroup => (kind === "image" || kind === "video" ? kind : "text");
const rememberProject = (id?: string) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("project", id);
    else url.searchParams.delete("project");
    window.history.replaceState(null, "", url);
};

export function EcommerceWorkspace() {
    const { message } = App.useApp();
    const config = useEffectiveConfig();
    const userId = useUserStore((state) => state.user?.id);
    const isAdmin = useUserStore((state) => state.user?.role === "admin");
    const localDraftKey = `inspire:ecommerce:draft:${userId || "anonymous"}`;
    const lastPlatformProjects = useRef<Record<string, string>>({});
    const rememberPlatformProject = useCallback(
        (project: Draft) => {
            if (!userId || !project.revision) return;
            const key = `${localDraftKey}:last-project:${project.platform}`;
            lastPlatformProjects.current[key] = project.id;
            try {
                localStorage.setItem(key, project.id);
            } catch {
                /* In-memory platform navigation still works when browser storage is disabled. */
            }
        },
        [localDraftKey, userId],
    );
    const [initialized, setInitialized] = useState(false);
    const [draft, setDraft] = useState<Draft>(() => freshDraft("taobao"));
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const savedFingerprint = useRef(fingerprint(draft));
    const [projects, setProjects] = useState<CommerceProject[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(6);
    const [keyword, setKeyword] = useState("");
    const [search, setSearch] = useState("");
    const [refresh, setRefresh] = useState(0);
    const [jobs, setJobs] = useState<CommerceJob[]>([]);
    const [resultGroup, setResultGroup] = useState<ResultGroup>("image");
    const filteredJobs = useMemo(() => jobs.filter((job) => resultGroupForKind(job.kind) === resultGroup), [jobs, resultGroup]);
    const activeResultGroup = resultGroups.find((group) => group.id === resultGroup)!;
    const ResultGroupIcon = activeResultGroup.icon;
    const newestJobId = filteredJobs[0]?.id;
    const [tasks, setTasks] = useState<Record<string, ServerAiTask>>({});
    const [jobPage, setJobPage] = useState(1);
    const [jobPageSize, setJobPageSize] = useState(6);
    const [historyError, setHistoryError] = useState("");
    const [historyLoading, setHistoryLoading] = useState(true);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const [uploading, setUploading] = useState(false);
    const [outputId, setOutputId] = useState("copy");
    const [libraryOpen, setLibraryOpen] = useState(false);
    const [editorTab, setEditorTab] = useState<"product" | "create">("product");
    const [mobileView, setMobileView] = useState<"editor" | "results">("editor");
    const [preferences, setPreferences] = useState<Record<string, { model?: string; size?: string; resolution?: string; seconds?: number }>>({});
    const pendingRequests = useRef(new Map<string, CommercePendingSubmission>());
    const [pendingRecoveryKey, setPendingRecoveryKey] = useState<string | null>(null);
    const currentPendingKey = `inspire:ecommerce:pending:${userId}:${draft.id}`;
    const hasPendingSubmission = pendingRecoveryKey === currentPendingKey;
    const uploadInput = useRef<HTMLInputElement>(null);
    const platformNav = useRef<HTMLElement>(null);
    const editorScroll = useRef<HTMLDivElement>(null);
    const resultsScroll = useRef<HTMLDivElement>(null);
    const platform = commercePlatforms.find((item) => item.id === draft.platform)!;
    const output = commerceOutputs.find((item) => item.id === outputId)!;
    const preferenceKey = `${draft.platform}:${output.taskType}`;
    const preference = preferences[preferenceKey] || {};
    const imageGenerationMode = resolveCommerceImageGenerationMode(draft.data.imageGenerationMode, draft.data.references.length);
    const isTextToImage = output.taskType === "image" && imageGenerationMode === "text-to-image";
    const settings = useMemo(
        () =>
            resolveCommerceGenerationSettings(config, {
                ...preference,
                taskType: output.taskType,
                size: preference.size || (output.taskType === "video" ? platform.videoRatio : platform.ratio),
                imageReferenceCount: draft.data.references.length,
                imageGenerationMode,
            }),
        [config, preference, output.taskType, platform, draft.data.references.length, imageGenerationMode],
    );
    const skillsQuery = useQuery({
        queryKey: ["ecommerce-skills", userId, draft.platform, outputId],
        queryFn: () => listCommerceSkills({ platform: draft.platform, outputType: outputId }),
        enabled: initialized && Boolean(userId),
        staleTime: 15_000,
        refetchOnWindowFocus: "always",
    });
    const selectedSkillId = draft.data.skillSelections?.[outputId];
    const skillState = resolveCommerceSkill(skillsQuery.data?.skills || [], draft.platform, outputId, selectedSkillId);
    const skillIssue = skillsQuery.isPending ? "正在读取创作技能" : skillsQuery.error ? `技能加载失败：${errorText(skillsQuery.error)}` : skillState.issue;
    const generationIssue = skillIssue || settings.issue;
    const selectSkill = (id?: string) =>
        setDraft((current) => {
            const selections = { ...current.data.skillSelections };
            if (id) selections[outputId] = id;
            else delete selections[outputId];
            return { ...current, data: { ...current.data, skillSelections: selections } };
        });
    const dirty = fingerprint(draft) !== savedFingerprint.current;
    const updatePreference = (patch: Partial<typeof preference>) => setPreferences((current) => ({ ...current, [preferenceKey]: { ...current[preferenceKey], ...patch } }));
    const updateProduct = (key: keyof CommerceProduct, value: string) => setDraft((current) => ({ ...current, ...(key === "name" ? { title: value } : {}), data: { ...current.data, product: { ...current.data.product, [key]: value } } }));

    useEffect(() => {
        if (!initialized || !userId) return;
        let pending = pendingRequests.current.get(currentPendingKey) || null;
        if (!pending) {
            try {
                pending = restoreCommerceSubmission(JSON.parse(sessionStorage.getItem(currentPendingKey) || "null"), draft.id);
            } catch {
                /* Ignore corrupt retry state. */
            }
        }
        if (pending) pendingRequests.current.set(currentPendingKey, pending);
        setPendingRecoveryKey(pending ? currentPendingKey : null);
    }, [currentPendingKey, draft.id, initialized, userId]);

    useEffect(() => {
        editorScroll.current?.scrollTo({ top: 0 });
    }, [editorTab, draft.id, mobileView]);

    useEffect(() => {
        resultsScroll.current?.scrollTo({ top: 0 });
    }, [draft.id, resultGroup, jobPage, newestJobId]);

    useEffect(() => {
        setJobPage((current) => Math.min(current, Math.max(1, Math.ceil(filteredJobs.length / jobPageSize))));
    }, [filteredJobs.length, jobPageSize]);

    useEffect(() => {
        const nav = platformNav.current;
        if (!nav) return;
        const revealPlatform = () => {
            const active = nav.querySelector<HTMLElement>('[aria-pressed="true"]');
            if (!active) return;
            const item = active.getBoundingClientRect();
            const bounds = nav.getBoundingClientRect();
            if (item.left < bounds.left) nav.scrollLeft -= bounds.left - item.left;
            else if (item.right > bounds.right) nav.scrollLeft += item.right - bounds.right;
        };
        revealPlatform();
        const observer = new ResizeObserver(revealPlatform);
        observer.observe(nav);
        return () => observer.disconnect();
    }, [draft.platform]);

    useEffect(() => {
        let id = new URLSearchParams(window.location.search).get("project");
        try {
            const cached = JSON.parse(sessionStorage.getItem(localDraftKey) || "null") as { draft?: Draft; baseline?: string } | null;
            if (cached?.draft && typeof cached.baseline === "string" && commercePlatforms.some((item) => item.id === cached.draft?.platform) && cached.draft.data?.product && Array.isArray(cached.draft.data.references) && (!id || id === cached.draft.id)) {
                if (fingerprint(cached.draft) !== cached.baseline || !cached.draft.revision) {
                    savedFingerprint.current = cached.baseline;
                    const restored = normalizeDraft(cached.draft);
                    draftRef.current = restored;
                    setDraft(restored);
                    setEditorTab(cached.draft.revision ? "create" : "product");
                    setInitialized(true);
                    return;
                }
                id = cached.draft.id;
            }
        } catch {
            /* A corrupt local draft must not block cloud projects. */
        }
        if (!id) {
            setInitialized(true);
            return;
        }
        let active = true;
        busyRef.current = true;
        setBusy(true);
        getCommerceProject(id)
            .then((project) => {
                if (!active) return;
                const restored = normalizeDraft(project);
                savedFingerprint.current = fingerprint(restored);
                setEditorTab("create");
                draftRef.current = restored;
                setDraft(restored);
                rememberProject(project.id);
            })
            .catch((error) => {
                if (active) {
                    message.error(errorText(error));
                    rememberProject();
                }
            })
            .finally(() => {
                if (active) {
                    busyRef.current = false;
                    setBusy(false);
                    setInitialized(true);
                }
            });
        return () => {
            active = false;
        };
    }, [message, localDraftKey]);

    useEffect(() => {
        if (!initialized || !userId) return;
        rememberPlatformProject(draft);
        try {
            sessionStorage.setItem(localDraftKey, JSON.stringify({ draft, baseline: savedFingerprint.current }));
        } catch {
            /* Cloud saving remains available if this tab has no storage quota. */
        }
    }, [draft, initialized, localDraftKey, userId, rememberPlatformProject]);

    useEffect(() => {
        const timer = setTimeout(() => {
            setSearch(keyword);
            setPage(1);
        }, 300);
        return () => clearTimeout(timer);
    }, [keyword]);
    useEffect(() => {
        let active = true;
        setLoading(true);
        listCommerceProjects({ platform: draft.platform, keyword: search, page, pageSize })
            .then((result) => {
                if (!active) return;
                if (!result.items.length && result.total > 0 && page > 1) {
                    setPage(1);
                    return;
                }
                setProjects(result.items);
                setTotal(result.total);
            })
            .catch((error) => {
                if (active) message.error(errorText(error));
            })
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => {
            active = false;
        };
    }, [draft.platform, search, page, pageSize, refresh, message]);

    // Read existing jobs only. Switching a project never cancels or recreates its paid tasks.
    useEffect(() => {
        if (!draft.revision) {
            setJobs([]);
            setTasks({});
            setHistoryError("");
            setHistoryLoading(false);
            return;
        }
        let active = true;
        setHistoryLoading(true);
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                const result = await listCommerceJobs(draft.id);
                const visibleJobs = result.jobs.filter((job) => resultGroupForKind(job.kind) === resultGroup).slice((jobPage - 1) * jobPageSize, jobPage * jobPageSize);
                const details = await Promise.all(visibleJobs.map((job) => getAiTaskInfo(job.taskId)));
                if (!active) return;
                setJobs(result.jobs);
                setTasks((current) => ({ ...current, ...Object.fromEntries(details.map((task) => [task.id, task])) }));
                setHistoryError("");
            } catch (error) {
                if (active) setHistoryError(errorText(error));
            } finally {
                if (active) {
                    setHistoryLoading(false);
                    timer = setTimeout(poll, 4500);
                }
            }
        };
        void poll();
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [draft.id, Boolean(draft.revision), refresh, resultGroup, jobPage, jobPageSize]);

    useEffect(() => {
        const preventLoss = (event: BeforeUnloadEvent) => {
            if (fingerprint(draftRef.current) !== savedFingerprint.current) {
                event.preventDefault();
                event.returnValue = "";
            }
        };
        window.addEventListener("beforeunload", preventLoss);
        return () => window.removeEventListener("beforeunload", preventLoss);
    }, []);

    async function saveCurrent(): Promise<Draft> {
        const current = draftRef.current;
        if (current.revision && fingerprint(current) === savedFingerprint.current) return current;
        const saved = await saveCommerceProject({ ...current, title: current.title.trim() || current.data.product.name.trim() || "未命名商品" });
        if (draftRef.current.id === current.id) {
            savedFingerprint.current = fingerprint(saved);
            draftRef.current = saved;
            setDraft(saved);
            rememberProject(saved.id);
        }
        setRefresh((value) => value + 1);
        return saved;
    }

    async function runLocked(action: () => Promise<void>) {
        if (busyRef.current || uploading) return;
        busyRef.current = true;
        setBusy(true);
        try {
            await action();
        } catch (error) {
            message.error(errorText(error));
        } finally {
            busyRef.current = false;
            setBusy(false);
        }
    }

    async function changeProject(next: Draft | (() => Promise<Draft>)) {
        await runLocked(async () => {
            if (fingerprint(draftRef.current) !== savedFingerprint.current) await saveCurrent();
            rememberPlatformProject(draftRef.current);
            const value = typeof next === "function" ? await next() : next;
            const references = await Promise.all(
                value.data.references.map(async (reference) => {
                    try {
                        const info = await getServerMediaInfo(reference.storageKey);
                        return { ...reference, url: info.url || reference.url };
                    } catch {
                        return reference;
                    }
                }),
            );
            const resolved = normalizeDraft({ ...value, data: { ...value.data, references } });
            rememberPlatformProject(resolved);
            if (resolved.platform !== draftRef.current.platform) {
                setPage(1);
                setKeyword("");
            }
            savedFingerprint.current = fingerprint(resolved);
            draftRef.current = resolved;
            setDraft(resolved);
            setEditorTab(resolved.revision ? "create" : "product");
            setMobileView("editor");
            setLibraryOpen(false);
            setJobPage(1);
            setJobs([]);
            setTasks({});
            rememberProject(resolved.revision ? resolved.id : undefined);
        });
    }

    async function switchPlatform(nextPlatform: CommercePlatform) {
        await changeProject(async () => {
            const key = `${localDraftKey}:last-project:${nextPlatform}`;
            let rememberedId: string | undefined = lastPlatformProjects.current[key];
            try {
                rememberedId ||= localStorage.getItem(key) || undefined;
            } catch {
                /* Fall back to this session or the platform's latest saved product. */
            }
            return restorePlatformProject<Draft>(nextPlatform, rememberedId, {
                get: getCommerceProject,
                latest: async (platform) => (await listCommerceProjects({ platform, keyword: "", page: 1, pageSize: 1 })).items[0],
                create: freshDraft,
                isMissing: (error) => error instanceof ServerResponseError && error.code === 4001,
            });
        });
    }

    async function upload(event: ChangeEvent<HTMLInputElement>) {
        const files = Array.from(event.target.files || []);
        event.target.value = "";
        if (!files.length || uploading || busyRef.current) return;
        if (files.length + draft.data.references.length > 6) {
            message.warning("每个商品最多上传 6 张参考图");
            return;
        }
        if (files.some((file) => !/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 15 * 1024 * 1024)) {
            message.warning("请上传 15MB 以内的 JPG、PNG 或 WebP 图片");
            return;
        }
        const projectId = draft.id;
        setUploading(true);
        try {
            for (const file of files) {
                const image = await uploadImage(file);
                setDraft((current) =>
                    current.id !== projectId ? current : { ...current, data: { ...current.data, references: [...current.data.references, { id: nanoid(), name: file.name, mimeType: image.mimeType, storageKey: image.storageKey, url: image.url }] } },
                );
            }
            message.success("商品图已上传");
        } catch (error) {
            message.error(errorText(error));
        } finally {
            setUploading(false);
        }
    }

    async function generate() {
        await runLocked(async () => {
            const projectId = draftRef.current.id;
            const pendingKey = `inspire:ecommerce:pending:${userId}:${projectId}`;
            let pending = pendingRequests.current.get(pendingKey) || null;
            if (!pending) {
                try {
                    pending = restoreCommerceSubmission(JSON.parse(sessionStorage.getItem(pendingKey) || "null"), projectId);
                } catch {
                    /* Ignore corrupt retry state. */
                }
            }
            const { request, recovering } = await prepareCommerceSubmission(pending, async () => {
                if (generationIssue) throw new Error(generationIssue);
                if (!draftRef.current.data.product.name.trim()) throw new Error("请先填写商品名称");
                if (!skillState.selected) throw new Error("请选择可用的电商技能");
                const project = await saveCurrent();
                return {
                    projectId: project.id,
                    requestId: nanoid(),
                    kind: output.kind,
                    variant: output.variant,
                    model: settings.model,
                    parameters: settings.parameters,
                    ...(output.kind === "image" ? { imageGenerationMode: settings.imageGenerationMode } : {}),
                    skillId: skillState.selected.id,
                    skillRevision: skillState.selected.revision,
                };
            });
            pendingRequests.current.set(pendingKey, { request });
            setPendingRecoveryKey(pendingKey);
            try {
                sessionStorage.setItem(pendingKey, JSON.stringify({ request }));
            } catch {
                /* In-memory idempotency remains active. */
            }
            const clearPending = () => {
                pendingRequests.current.delete(pendingKey);
                setPendingRecoveryKey((current) => (current === pendingKey ? null : current));
                try {
                    sessionStorage.removeItem(pendingKey);
                } catch {
                    /* Storage may be disabled. */
                }
            };
            const result = await generateCommerce(request).catch((error) => {
                // A confirmed business rejection may be retried after fixing inputs/balance.
                // Unknown network outcomes retain the key, so retry cannot charge twice.
                if (error instanceof ServerResponseError && isDefiniteCommerceRejection(error.code, error.message)) clearPending();
                throw error;
            });
            clearPending();
            setJobs((current) => [result.job, ...current.filter((job) => job.id !== result.job.id)]);
            setTasks((current) => ({ ...current, [result.task.id]: result.task }));
            setResultGroup(resultGroupForKind(result.job.kind));
            setJobPage(1);
            setRefresh((value) => value + 1);
            message.success(recovering ? "已确认上次提交的任务；如需使用当前设置创作，可再次点击开始创作" : "创作任务已提交");
            setMobileView("results");
        });
    }

    const refreshResults = useCallback(() => setRefresh((value) => value + 1), []);
    return (
        <div className="commerce-workspace">
            <header className="commerce-heading">
                <div className="commerce-title">
                    <span className="commerce-heading-icon">
                        <ShoppingBag size={19} />
                    </span>
                    <div>
                        <h1>电商工作台</h1>
                        <p>从商品到内容，让创作更简单</p>
                    </div>
                </div>
                <div className="commerce-header-actions">
                    <span className={`commerce-save-state ${dirty ? "is-dirty" : ""}`}>
                        <span />
                        {dirty ? "待保存" : draft.revision ? "已保存" : "新商品"}
                    </span>
                    <Button icon={<FolderOpen size={15} />} onClick={() => setLibraryOpen(true)}>
                        商品库
                    </Button>
                    <Button icon={<Plus size={15} />} disabled={busy || uploading} onClick={() => void changeProject(freshDraft(draft.platform))}>
                        新建
                    </Button>
                    <Button
                        icon={<Save size={15} />}
                        loading={busy}
                        disabled={uploading}
                        onClick={() =>
                            void runLocked(async () => {
                                await saveCurrent();
                                message.success("商品资料已保存");
                            })
                        }
                    >
                        保存
                    </Button>
                </div>
            </header>

            <div className="commerce-platform-bar">
                <nav ref={platformNav} aria-label="电商平台" className="commerce-platforms">
                    {commercePlatforms.map((item) => (
                        <button
                            key={item.id}
                            type="button"
                            aria-pressed={draft.platform === item.id}
                            disabled={busy || uploading}
                            className={`commerce-platform ${draft.platform === item.id ? "is-active" : ""}`}
                            onClick={() => {
                                if (item.id !== draft.platform) void switchPlatform(item.id);
                            }}
                        >
                            <span className="commerce-platform-mark" style={{ backgroundColor: item.color }}>
                                {item.mark}
                            </span>
                            {item.name}
                        </button>
                    ))}
                </nav>
                <span className="commerce-platform-description">{platform.description}</span>
            </div>

            <div className="commerce-mobile-views" role="group" aria-label="工作区视图">
                <button type="button" aria-pressed={mobileView === "editor"} onClick={() => setMobileView("editor")}>
                    <SlidersHorizontal size={14} />
                    商品与创作
                </button>
                <button type="button" aria-pressed={mobileView === "results"} onClick={() => setMobileView("results")}>
                    <ImageIcon size={14} />
                    创作成果 <span>{jobs.length}</span>
                </button>
            </div>

            <main className="commerce-workbench" data-mobile-view={mobileView}>
                <section className="commerce-editor" aria-label="商品与创作">
                    <div className="commerce-current-product">
                        <span className="commerce-current-cover">{draft.data.references[0]?.url ? <img src={draft.data.references[0].url} alt="当前商品" /> : <Package size={22} />}</span>
                        <div>
                            <strong>{draft.data.product.name || "添加你的第一件商品"}</strong>
                            <p>
                                {draft.data.product.brand || platform.name} · {draft.data.references.length} 张参考图
                            </p>
                        </div>
                        <Dropdown
                            disabled={!draft.data.product.name.trim() || busy || uploading}
                            menu={{
                                items: commercePlatforms
                                    .filter((item) => item.id !== draft.platform)
                                    .map((item) => ({
                                        key: item.id,
                                        label: item.name,
                                        onClick: () =>
                                            void changeProject({
                                                ...freshDraft(item.id),
                                                title: draft.title,
                                                data: { product: { ...draft.data.product }, references: draft.data.references.map((reference) => ({ ...reference, id: nanoid() })), imageGenerationMode, drafts: {} },
                                            }),
                                    })),
                            }}
                        >
                            <Button type="text" size="small" aria-label="复用到其他平台" title="复用到其他平台" icon={<Copy size={15} />}>
                                <ChevronDown size={12} />
                            </Button>
                        </Dropdown>
                    </div>
                    <div className="commerce-editor-tabs" role="group" aria-label="编辑区域">
                        <button type="button" aria-pressed={editorTab === "product"} onClick={() => setEditorTab("product")}>
                            <Package size={15} />
                            商品资料
                        </button>
                        <button type="button" aria-pressed={editorTab === "create"} onClick={() => setEditorTab("create")}>
                            <Sparkles size={15} />
                            创作设置
                        </button>
                    </div>

                    <div ref={editorScroll} className="commerce-editor-scroll">
                        <section hidden={editorTab !== "product"} aria-label="商品资料" className="commerce-editor-section">
                            <fieldset disabled={busy || uploading} className="min-w-0 border-0 p-0">
                                <div className="commerce-section-heading">
                                    <h2>商品参考图{isTextToImage && <small>可选</small>}</h2>
                                    <span>{draft.data.references.length} / 6</span>
                                </div>
                                <input ref={uploadInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden aria-label="上传商品参考图" onChange={(event) => void upload(event)} />
                                <div className="commerce-reference-grid">
                                    {draft.data.references.map((reference, index) => (
                                        <div key={reference.id} className="commerce-reference">
                                            <img src={reference.url} alt={reference.name} />
                                            {index === 0 && <span>视频首帧</span>}
                                            <button
                                                type="button"
                                                aria-label={`移除${reference.name}`}
                                                onClick={() => setDraft((current) => ({ ...current, data: { ...current.data, references: current.data.references.filter((item) => item.id !== reference.id) } }))}
                                            >
                                                <X size={12} />
                                            </button>
                                        </div>
                                    ))}
                                    {draft.data.references.length < 6 && (
                                        <button type="button" className="commerce-upload" onClick={() => uploadInput.current?.click()}>
                                            {uploading ? <Spin size="small" /> : <Plus size={20} />}
                                            <strong>{uploading ? "上传中" : "添加图片"}</strong>
                                            {!draft.data.references.length && <small>JPG / PNG / WebP，单张不超过 15 MB</small>}
                                        </button>
                                    )}
                                </div>
                                <p className="commerce-help">{isTextToImage ? "文生图无需上传图片，请在商品卖点或创作要求中描述商品外形、材质和颜色。已上传的图片会保留。" : "文生图无需图片；图生图使用商品参考图，视频使用第一张图作为首帧。"}</p>

                                <div className="commerce-product-fields">
                                    <label className="commerce-field commerce-field-wide">
                                        商品名称 <span className="text-red-500">*</span>
                                        <Input aria-label="商品名称" placeholder="例如：便携冷萃咖啡杯" maxLength={150} value={draft.data.product.name} onChange={(event) => updateProduct("name", event.target.value)} />
                                    </label>
                                    <label className="commerce-field">
                                        品牌
                                        <Input aria-label="品牌" placeholder="可选" value={draft.data.product.brand} onChange={(event) => updateProduct("brand", event.target.value)} />
                                    </label>
                                    <label className="commerce-field">
                                        商品品类
                                        <Input aria-label="商品品类" placeholder="例如：家居 / 食品" value={draft.data.product.category} onChange={(event) => updateProduct("category", event.target.value)} />
                                    </label>
                                    <label className="commerce-field">
                                        实际售价
                                        <Input aria-label="实际售价" placeholder="可选，如 ¥129" value={draft.data.product.price} onChange={(event) => updateProduct("price", event.target.value)} />
                                    </label>
                                    <label className="commerce-field">
                                        目标人群
                                        <Input aria-label="目标人群" placeholder="例如：城市通勤人群" value={draft.data.product.audience} onChange={(event) => updateProduct("audience", event.target.value)} />
                                    </label>
                                    <label className="commerce-field commerce-field-wide">
                                        商品卖点
                                        <Input.TextArea
                                            aria-label="商品卖点"
                                            placeholder="商品外形、颜色、真实材质、规格和优势，建议每行一个卖点"
                                            value={draft.data.product.sellingPoints}
                                            onChange={(event) => updateProduct("sellingPoints", event.target.value)}
                                            autoSize={{ minRows: 3, maxRows: 7 }}
                                            maxLength={5000}
                                        />
                                    </label>
                                </div>
                                <button type="button" className="commerce-next-step" onClick={() => setEditorTab("create")}>
                                    填写好了，选择创作内容 <ArrowRight size={14} />
                                </button>
                            </fieldset>
                        </section>

                        <section hidden={editorTab !== "create"} aria-label="创作设置" className="commerce-editor-section">
                            <div className="commerce-section-heading">
                                <h2>创作什么内容</h2>
                                <span>{platform.name}</span>
                            </div>
                            <div className="commerce-output-types" role="group" aria-label="创作类型">
                                {(
                                    [
                                        { type: "text", label: "文案", icon: FileText, first: "copy" },
                                        { type: "image", label: "图片", icon: ImageIcon, first: "hero" },
                                        { type: "video", label: "视频", icon: Clapperboard, first: "video" },
                                    ] as const
                                ).map(({ type, label, icon: Icon, first }) => (
                                    <button type="button" key={type} aria-pressed={output.taskType === type} disabled={busy} onClick={() => setOutputId(first)}>
                                        <Icon size={17} />
                                        {label}
                                    </button>
                                ))}
                            </div>
                            <div className="commerce-outputs" role="group" aria-label="内容模板">
                                {commerceOutputs
                                    .filter((item) => item.taskType === output.taskType)
                                    .map((item) => {
                                        const label = item.id === "copy" ? platform.copy : item.id === "hero" ? platform.image : item.id === "detail-copy" ? platform.detail : item.name;
                                        return (
                                            <button key={item.id} type="button" aria-pressed={item.id === outputId} disabled={busy} className="commerce-output" onClick={() => setOutputId(item.id)}>
                                                {item.id === outputId && <Check size={12} />}
                                                {label}
                                            </button>
                                        );
                                    })}
                            </div>
                            <p className="commerce-output-description">{isTextToImage && output.variant === "detail" ? "根据描述展示外观与表面质感" : output.description}</p>
                            {output.taskType === "image" && (
                                <div className="commerce-image-mode">
                                    <div className="commerce-image-mode-options" role="group" aria-label="图片生成方式">
                                        {(
                                            [
                                                { mode: "text-to-image", label: "文生图", icon: FileText },
                                                { mode: "image-to-image", label: "图生图", icon: ImageIcon },
                                            ] as const
                                        ).map(({ mode, label, icon: Icon }) => (
                                            <button
                                                key={mode}
                                                type="button"
                                                aria-pressed={imageGenerationMode === mode}
                                                disabled={busy || uploading}
                                                onClick={() => setDraft((current) => ({ ...current, data: { ...current.data, imageGenerationMode: mode } }))}
                                            >
                                                <Icon size={14} />
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                    <p id="commerce-image-mode-help">{isTextToImage ? "根据商品描述生成画面，无需上传参考图。" : "以商品参考图创作，保留商品外观与细节。"}</p>
                                </div>
                            )}
                            <CommerceSkillPicker
                                skills={skillState.available}
                                selected={skillState.selected}
                                selectedId={selectedSkillId}
                                platform={draft.platform}
                                outputId={outputId}
                                outputLabel={output.name}
                                loading={skillsQuery.isPending || skillsQuery.isFetching}
                                issue={skillsQuery.isFetching ? undefined : skillIssue}
                                disabled={busy || uploading}
                                isAdmin={isAdmin}
                                onSelect={selectSkill}
                                onRefresh={() => {
                                    void skillsQuery.refetch();
                                }}
                            />
                            <label className="commerce-field commerce-prompt-field">
                                创作要求 <span>可选</span>
                                <Input.TextArea
                                    aria-label="创作要求"
                                    aria-describedby={output.taskType === "image" ? "commerce-image-mode-help" : undefined}
                                    placeholder={isTextToImage ? "描述商品外形、材质、颜色，以及想要的场景、构图和风格。例如：奶白色磨砂陶瓷杯，圆润杯身与弧形手柄，放在晨光下的木质桌面。" : "想要什么风格与场景？也可以粘贴脚本，或说明需要避免的内容。"}
                                    value={draft.data.product.constraints}
                                    onChange={(event) => updateProduct("constraints", event.target.value)}
                                    autoSize={{ minRows: 5, maxRows: 9 }}
                                    maxLength={5000}
                                    disabled={busy || uploading}
                                />
                            </label>
                            <div className="commerce-generation-bar">
                                <div className="commerce-model-setting">
                                    <span className="commerce-setting-label">生成模型</span>
                                    <ModelPicker
                                        config={config}
                                        capability={output.taskType}
                                        value={settings.model}
                                        modelOptions={settings.modelOptions}
                                        onChange={(model) => updatePreference({ model, resolution: undefined, seconds: undefined })}
                                        fullWidth
                                        className="!h-9 !rounded-lg !shadow-none"
                                    />
                                </div>
                                {output.taskType !== "text" && (
                                    <label>
                                        <span className="commerce-setting-label">画面比例</span>
                                        <Select aria-label="画面比例" value={settings.selectedSizeRatio} options={settings.sizeOptions.map((value) => ({ value, label: value }))} onChange={(size) => updatePreference({ size })} className="w-full" />
                                    </label>
                                )}
                                {output.taskType !== "text" && (
                                    <label>
                                        <span className="commerce-setting-label">分辨率</span>
                                        <Select
                                            aria-label="分辨率"
                                            value={settings.parameters.resolution as string}
                                            options={settings.resolutionOptions.map((value) => ({ value, label: value }))}
                                            onChange={(resolution) => updatePreference({ resolution })}
                                            className="w-full"
                                        />
                                    </label>
                                )}
                                {output.taskType === "video" && (
                                    <label>
                                        <span className="commerce-setting-label">视频时长</span>
                                        <Select
                                            aria-label="视频时长"
                                            value={Number(settings.parameters.seconds)}
                                            options={settings.durationOptions.map((value) => ({ value, label: `${value} 秒` }))}
                                            onChange={(seconds) => updatePreference({ seconds })}
                                            className="w-full"
                                        />
                                    </label>
                                )}
                            </div>

                            <div className="commerce-reference-note">
                                <ImageIcon size={15} />
                                <span>
                                    {isTextToImage
                                        ? draft.data.references.length
                                            ? `文生图不使用参考图，已保存的 ${draft.data.references.length} 张商品图会保留`
                                            : "文生图无需参考图，直接描述商品即可创作"
                                        : draft.data.references.length
                                          ? output.taskType === "video"
                                              ? `首张商品图将作为视频首帧，共保存 ${draft.data.references.length} 张图`
                                              : `将使用 ${draft.data.references.length} 张商品参考图`
                                          : output.taskType === "video"
                                            ? "请添加商品参考图作为视频首帧"
                                            : output.taskType === "image"
                                              ? "图生图请至少添加一张商品参考图"
                                              : "可添加商品参考图，补充商品资料"}
                                </span>
                                <button type="button" onClick={() => setEditorTab("product")}>
                                    {draft.data.references.length ? "管理" : isTextToImage ? "商品资料" : "添加"}
                                    <ArrowRight size={12} />
                                </button>
                            </div>
                        </section>
                    </div>

                    <footer className="commerce-generate-footer">
                        <div className="commerce-quote">
                            <span>{output.name}</span>
                            <strong>{settings.quote.label}</strong>
                        </div>
                        <Button type="primary" icon={<Sparkles size={16} />} loading={busy} disabled={uploading || (!hasPendingSubmission && (Boolean(generationIssue) || !draft.data.product.name.trim()))} onClick={() => void generate()} block>
                            {hasPendingSubmission ? "确认上次提交" : "开始创作"} <ArrowRight size={15} />
                        </Button>
                        <p role={hasPendingSubmission || generationIssue ? "status" : undefined}>
                            {hasPendingSubmission ? "上次提交结果未确认，先恢复原任务；当前修改会保留" : !draft.data.product.name.trim() ? "请先填写商品名称" : generationIssue || "提交时自动保存商品资料"}
                        </p>
                    </footer>
                </section>

                <Tabs.Root
                    asChild
                    value={resultGroup}
                    onValueChange={(value) => {
                        setResultGroup(value as ResultGroup);
                        setJobPage(1);
                    }}
                >
                    <section className="commerce-results-pane" aria-label="创作结果">
                        <header className="commerce-results-heading">
                            <div>
                                <h2>
                                    创作成果 <span className="commerce-count">{jobs.length}</span>
                                </h2>
                                <p>按内容分类，随时查看与继续创作</p>
                            </div>
                            <Button type="text" size="small" icon={<RefreshCw size={14} />} onClick={refreshResults}>
                                刷新
                            </Button>
                        </header>
                        <Tabs.List className="commerce-result-tabs" aria-label="创作成果分类">
                            {resultGroups.map((group) => (
                                <Tabs.Trigger key={group.id} value={group.id} className="commerce-result-tab">
                                    <group.icon size={15} aria-hidden="true" />
                                    {group.label}
                                    <span>{jobs.filter((job) => resultGroupForKind(job.kind) === group.id).length}</span>
                                </Tabs.Trigger>
                            ))}
                        </Tabs.List>
                        <Tabs.Content key={resultGroup} value={resultGroup} ref={resultsScroll} className="commerce-results-scroll">
                            {historyError && (
                                <div role="alert" className="mb-3 rounded-xl bg-red-500/5 p-3 text-xs text-red-600">
                                    {historyError}
                                </div>
                            )}
                            {!filteredJobs.length && historyLoading ? (
                                <div className="commerce-empty" role="status">
                                    <Spin size="small" />
                                    <p>正在读取{activeResultGroup.label}成果…</p>
                                </div>
                            ) : !filteredJobs.length ? (
                                <div className="commerce-empty">
                                    <span>
                                        <ResultGroupIcon className="size-7" />
                                    </span>
                                    <h3>还没有{activeResultGroup.label}作品</h3>
                                    <p>{activeResultGroup.description}会展示在这里。</p>
                                    <div>
                                        <button
                                            type="button"
                                            className="commerce-empty-action"
                                            onClick={() => {
                                                setOutputId(activeResultGroup.outputId);
                                                setEditorTab(draft.data.product.name ? "create" : "product");
                                                setMobileView("editor");
                                            }}
                                        >
                                            创作{activeResultGroup.label} <ArrowRight size={14} />
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <div className="commerce-results-grid">
                                    {filteredJobs.slice((jobPage - 1) * jobPageSize, jobPage * jobPageSize).map((job) => (
                                        <CommerceResult
                                            key={job.id}
                                            disabled={busy || uploading}
                                            job={job}
                                            task={tasks[job.taskId]}
                                            draft={draft.data.drafts?.[job.id]}
                                            onDraft={(text) => setDraft((current) => ({ ...current, data: { ...current.data, drafts: { ...current.data.drafts, [job.id]: text } } }))}
                                            onUse={(text) => {
                                                updateProduct("constraints", text.slice(0, 5000));
                                                editorScroll.current?.scrollTo({ top: 0 });
                                                setEditorTab("create");
                                                setMobileView("editor");
                                                message.success("内容已填入创作要求，可继续选择图片或视频");
                                            }}
                                            onRetry={() =>
                                                void runLocked(async () => {
                                                    const nextOutput = job.kind === "image" ? job.variant || "hero" : job.kind;
                                                    const task = job.kind === "image" ? tasks[job.taskId] || (await getAiTaskInfo(job.taskId)) : undefined;
                                                    const restoredMode = task ? commerceImageGenerationModeFromRequest(task.requestData) : undefined;
                                                    if (job.kind === "image" && !restoredMode) throw new Error("无法读取原任务的图片生成方式，请刷新后重试");
                                                    setOutputId(nextOutput);
                                                    setDraft((current) => ({
                                                        ...current,
                                                        data: { ...current.data, ...(restoredMode ? { imageGenerationMode: restoredMode } : {}), ...(job.skillId ? { skillSelections: { ...current.data.skillSelections, [nextOutput]: job.skillId } } : {}) },
                                                    }));
                                                    editorScroll.current?.scrollTo({ top: 0 });
                                                    setEditorTab("create");
                                                    setMobileView("editor");
                                                    message.info(job.kind === "image" ? "已恢复创作类型和图片生成方式，可修改要求后重新提交" : "已选择同类创作，可修改要求后重新提交");
                                                })
                                            }
                                            onRefresh={refreshResults}
                                        />
                                    ))}
                                </div>
                            )}
                            {!!filteredJobs.length && (
                                <ListPagination
                                    label={`${activeResultGroup.label}成果分页`}
                                    current={jobPage}
                                    pageSize={jobPageSize}
                                    total={filteredJobs.length}
                                    pageSizeOptions={[6, 12, 24]}
                                    onChange={(next, size) => {
                                        setJobPage(next);
                                        setJobPageSize(size);
                                    }}
                                />
                            )}
                        </Tabs.Content>
                    </section>
                </Tabs.Root>
            </main>

            <Drawer
                title={
                    <span className="commerce-drawer-title">
                        <FolderOpen size={18} />
                        商品库 <small>{platform.name}</small>
                    </span>
                }
                open={libraryOpen}
                onClose={() => setLibraryOpen(false)}
                placement="left"
                width={360}
                className="commerce-library-drawer"
            >
                <div className="commerce-library">
                    <div className="flex items-center justify-between">
                        <h2>商品项目</h2>
                        <span className="commerce-count">{total}</span>
                    </div>
                    <Input aria-label="搜索商品" placeholder="搜索商品名称" prefix={<Search className="size-3.5 opacity-50" />} value={keyword} onChange={(event) => setKeyword(event.target.value)} allowClear className="!mt-4" />
                    <div className="mt-3 space-y-2" aria-busy={loading}>
                        {loading && !projects.length ? (
                            <div className="p-8 text-center">
                                <Spin size="small" />
                            </div>
                        ) : (
                            projects.map((project) => (
                                <div key={project.id} className={`commerce-project ${project.id === draft.id ? "is-active" : ""}`}>
                                    <button
                                        type="button"
                                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                                        disabled={busy || uploading}
                                        onClick={() => {
                                            if (project.id !== draft.id) void changeProject(() => getCommerceProject(project.id));
                                            else setLibraryOpen(false);
                                        }}
                                    >
                                        <span className="commerce-project-cover">{project.data.references[0]?.url ? <img src={project.data.references[0].url} alt="" /> : <Package className="size-5" />}</span>
                                        <span className="min-w-0">
                                            <strong className="block truncate text-xs font-medium">{project.title}</strong>
                                            <small className="mt-1 block text-[10px] text-[var(--studio-muted)]">{new Date(project.updatedAt).toLocaleDateString("zh-CN")}</small>
                                        </span>
                                    </button>
                                    <Popconfirm
                                        title="删除此商品项目？"
                                        description="项目与创作记录将移除，已保存的资产仍会保留。"
                                        okText="删除"
                                        cancelText="取消"
                                        onConfirm={() =>
                                            runLocked(async () => {
                                                await deleteCommerceProject(project.id, project.id === draft.id ? draft.revision : project.revision);
                                                if (project.id === draft.id) {
                                                    const next = freshDraft(draft.platform);
                                                    savedFingerprint.current = fingerprint(next);
                                                    draftRef.current = next;
                                                    setDraft(next);
                                                    setEditorTab("product");
                                                    rememberProject();
                                                }
                                                setRefresh((value) => value + 1);
                                                message.success("已删除商品项目");
                                            })
                                        }
                                    >
                                        <button type="button" aria-label={`删除${project.title}`} disabled={busy || uploading} className="commerce-icon-button">
                                            <Trash2 className="size-3.5" />
                                        </button>
                                    </Popconfirm>
                                </div>
                            ))
                        )}
                        {!loading && !projects.length && <p className="px-3 py-9 text-center text-xs leading-6 text-[var(--studio-muted)]">{search ? "没有找到对应商品" : "新建商品后，资料和作品会保存在这里。"}</p>}
                    </div>
                    <ListPagination
                        label="商品库分页"
                        current={page}
                        pageSize={pageSize}
                        total={total}
                        compact
                        pageSizeOptions={[6, 12, 24]}
                        onChange={(next, size) => {
                            setPage(next);
                            setPageSize(size);
                        }}
                    />
                </div>
            </Drawer>
        </div>
    );
}
