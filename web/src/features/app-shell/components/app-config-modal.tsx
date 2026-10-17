"use client";

import { VideoDurationEditor } from "@/features/settings/components/video-duration-editor";

import { App, Button, Checkbox, Form, Grid, Input, InputNumber, Modal, Select, Space, Switch, Tabs } from "antd";
import type { TextAreaRef } from "antd/es/input/TextArea";
import { nanoid } from "nanoid";
import { Braces, CheckCircle2, ChevronDown, ChevronUp, CloudUpload, Image, Info, Monitor, Pencil, Plus, RefreshCw, Sparkles, TextCursorInput, Trash2, Video, Wifi } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useUserStore } from "@/features/auth/stores/use-user-store";
import { ModelPicker, ModelNewBadge } from "@/features/settings/components/model-picker";
import { ModelPricingPanel } from "@/features/settings/components/model-pricing-panel";
import {
    configFromModelConfigs,
    createObjectStorageConfig,
    MODEL_CAPABILITY_OPTIONS,
    modelOptionAdminLabel as modelOptionLabel,
    normalizeModelOptionValue,
    useConfigStore,
    type ConfigDialogTabKey,
    type CustomModelGroupConfig,
    type ModelCapability,
    type VideoBillingConfiguration,
    type VideoGenerationMode,
    type VideoResolution,
} from "@/features/settings/stores/use-config-store";
import { VIDEO_GENERATION_CAPABILITY_OPTIONS, VIDEO_GENERATION_MODE_OPTIONS, VIDEO_RESOLUTION_OPTIONS, createVideoBillingConfiguration } from "@/features/generation/lib/video-billing";
import { isObjectStorageReady, objectStorageReadyMessage, testObjectStorageUpload } from "@/features/storage/services/object-storage";
import { isOpenAiTextModel, isReasoningEffortDisabled, reasoningEffortOptions } from "@/features/settings/lib/model-thinking-configuration";
import { reconcileModelConfigDraftIds, retainCapabilityModelDrafts } from "@/features/settings/lib/model-config-draft-merge";
import { configuredVideoResolutions } from "@/features/settings/lib/video-resolution-configuration";
import {
    createModelConfig,
    createObjectStorage as createServerObjectStorage,
    deleteModelConfig,
    deleteObjectStorage as deleteServerObjectStorage,
    getCreditSettings,
    getCheckInRewardSettings,
    getInvitationRewardSettings,
    setDefaultModel,
    setDefaultObjectStorage as setServerDefaultObjectStorage,
    updateCheckInRewardSettings,
    updateCreditSettings,
    updateInvitationRewardSettings,
    updateModelConfig,
    updateObjectStorage as updateServerObjectStorage,
    type ServerModelConfig,
} from "@/services/api/server";
import type { ObjectStorageConfig, ObjectStorageProvider } from "@/shared/types/object-storage";
import { ListPagination } from "@/shared/components/list-pagination";
import { usePaginatedList } from "@/shared/hooks/use-paginated-list";

type ModelGroup = {
    capability: ModelCapability;
    modelKey: "imageModel" | "videoModel" | "textModel" | "audioModel";
    modelsKey: "imageModels" | "videoModels" | "textModels" | "audioModels";
    defaultLabel: string;
    optionsLabel: string;
};

const modelGroups: ModelGroup[] = [
    { capability: "image", modelKey: "imageModel", modelsKey: "imageModels", defaultLabel: "默认生图模型", optionsLabel: "生图模型可选项" },
    { capability: "video", modelKey: "videoModel", modelsKey: "videoModels", defaultLabel: "默认视频模型", optionsLabel: "视频模型可选项" },
    { capability: "text", modelKey: "textModel", modelsKey: "textModels", defaultLabel: "默认文本模型", optionsLabel: "文本模型可选项" },
    { capability: "audio", modelKey: "audioModel", modelsKey: "audioModels", defaultLabel: "默认语音模型", optionsLabel: "语音模型可选项" },
];

const capabilityGroups: Array<{ capability: ModelCapability; modelsKey: "textModels" | "imageModels" | "videoModels" | "audioModels"; label: string }> = [
    { capability: "text", modelsKey: "textModels", label: "文本模型" },
    { capability: "image", modelsKey: "imageModels", label: "图像模型" },
    { capability: "video", modelsKey: "videoModels", label: "视频模型" },
    { capability: "audio", modelsKey: "audioModels", label: "语音模型" },
];

const objectStorageProviderOptions: Array<{ label: string; value: ObjectStorageProvider }> = [
    { label: "腾讯云COS", value: "tencentCos" },
    { label: "阿里云OSS", value: "aliyunOss" },
    { label: "七牛云Kodo", value: "qiniuKodo" },
    { label: "Cloudflare R2", value: "cloudflareR2" },
];

const qiniuRegionOptions = [
    { label: "华东-浙江（z0）", value: "z0" },
    { label: "华东-浙江2（cn-east-2）", value: "cn-east-2" },
    { label: "华北-河北（z1）", value: "z1" },
    { label: "华南-广东（z2）", value: "z2" },
    { label: "北美-洛杉矶（na0）", value: "na0" },
    { label: "亚太-新加坡（as0）", value: "as0" },
];

const objectStorageProviderFields: Record<ObjectStorageProvider, { accessKeyLabel: string; secretKeyLabel: string; bucketPlaceholder: string; regionLabel: string; regionPlaceholder: string; publicBaseUrlExtra: string }> = {
    tencentCos: {
        accessKeyLabel: "SecretId",
        secretKeyLabel: "SecretKey",
        bucketPlaceholder: "example-1250000000",
        regionLabel: "Region",
        regionPlaceholder: "ap-guangzhou",
        publicBaseUrlExtra: "留空时自动使用 https://{bucket}.cos.{region}.myqcloud.com/{key}",
    },
    aliyunOss: {
        accessKeyLabel: "AccessKey ID",
        secretKeyLabel: "AccessKey Secret",
        bucketPlaceholder: "example-bucket",
        regionLabel: "地域ID",
        regionPlaceholder: "cn-hangzhou",
        publicBaseUrlExtra: "留空时按 Bucket 和公开 Endpoint 自动生成访问地址。",
    },
    qiniuKodo: {
        accessKeyLabel: "AccessKey",
        secretKeyLabel: "SecretKey",
        bucketPlaceholder: "example-bucket",
        regionLabel: "区域",
        regionPlaceholder: "请选择区域",
        publicBaseUrlExtra: "必须填写已绑定当前 Bucket 的 CDN 或自定义域名。",
    },
    cloudflareR2: {
        accessKeyLabel: "Access Key ID",
        secretKeyLabel: "Secret Access Key",
        bucketPlaceholder: "inspire-media",
        regionLabel: "Region",
        regionPlaceholder: "auto",
        publicBaseUrlExtra: "必填。填写当前 Bucket 已启用的 https://pub-xxx.r2.dev 或自定义域名；S3 API Endpoint 不能作为公开媒体地址。",
    },
};

export function AppConfigModal() {
    const { message, modal } = App.useApp();
    const screens = Grid.useBreakpoint();
    const isCompact = !screens.md;
    const user = useUserStore((state) => state.user);
    const config = useConfigStore((state) => state.config);
    const modelConfigs = useConfigStore((state) => state.modelConfigs);
    const objectStorages = useConfigStore((state) => state.objectStorages);
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const configDialogTab = useConfigStore((state) => state.configDialogTab);
    const setConfigDialogTab = useConfigStore((state) => state.setConfigDialogTab);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const refreshModelConfiguration = useConfigStore((state) => state.refreshModelConfiguration);
    const refreshObjectStorages = useConfigStore((state) => state.refreshObjectStorages);
    const [activeTab, setActiveTab] = useState<ConfigDialogTabKey>("models");
    const [draftsReady, setDraftsReady] = useState(false);
    const [savingTab, setSavingTab] = useState<ConfigDialogTabKey | "">("");
    const [refreshingObjectStorages, setRefreshingObjectStorages] = useState(false);
    const [testingObjectStorageId, setTestingObjectStorageId] = useState("");
    const [testedObjectStorageId, setTestedObjectStorageId] = useState("");
    const [objectStorageTestUrl, setObjectStorageTestUrl] = useState("");
    const [collapsedModelCapabilityTypes, setCollapsedModelCapabilityTypes] = useState<ModelCapability[]>([]);
    const [collapsedObjectStorageIds, setCollapsedObjectStorageIds] = useState<string[]>([]);
    const [modelConfigBaseline, setModelConfigBaseline] = useState<ServerModelConfig[]>([]);
    const [draftModelConfigs, setDraftModelConfigs] = useState<ServerModelConfig[]>([]);
    const [objectStorageBaseline, setObjectStorageBaseline] = useState<ObjectStorageConfig[]>([]);
    const [draftObjectStorages, setDraftObjectStorages] = useState<ObjectStorageConfig[]>([]);
    const [creditBaseline, setCreditBaseline] = useState(100);
    const [draftInitialCredits, setDraftInitialCredits] = useState(100);
    const [invitationRewardBaseline, setInvitationRewardBaseline] = useState(0);
    const [draftInvitationRewardCredits, setDraftInvitationRewardCredits] = useState(0);
    const [checkInBaseline, setCheckInBaseline] = useState(0);
    const [draftCheckInCredits, setDraftCheckInCredits] = useState(0);
    const [editingModelConfig, setEditingModelConfig] = useState<ServerModelConfig | null>(null);
    const [editingCustomBodyParameters, setEditingCustomBodyParameters] = useState("{}");
    const [collapsedEditingCapabilities, setCollapsedEditingCapabilities] = useState<string[]>([]);
    const initializedRef = useRef(false);
    const editingModelIsMedia = Boolean(editingModelConfig && (editingModelConfig.modelType === "image" || editingModelConfig.modelType === "video"));

    const resetModelConfigDraft = useCallback(() => {
        const configs = cloneModelConfigs(useConfigStore.getState().modelConfigs);
        setModelConfigBaseline(configs);
        setDraftModelConfigs(cloneModelConfigs(configs));
        setCollapsedModelCapabilityTypes(capabilityGroups.map((group) => group.capability));
    }, []);

    const resetObjectStorageDraft = useCallback(() => {
        const storages = cloneObjectStorages(useConfigStore.getState().objectStorages);
        setObjectStorageBaseline(storages);
        setDraftObjectStorages(cloneObjectStorages(storages));
        setCollapsedObjectStorageIds(storages.map((storage) => storage.id));
    }, []);

    const resetAllDrafts = useCallback(() => {
        resetModelConfigDraft();
        resetObjectStorageDraft();
        setTestedObjectStorageId("");
        setObjectStorageTestUrl("");
    }, [resetModelConfigDraft, resetObjectStorageDraft]);

    useEffect(() => {
        if (isConfigOpen) setActiveTab(configDialogTab);
    }, [configDialogTab, isConfigOpen]);

    useEffect(() => {
        if (!isConfigOpen) {
            initializedRef.current = false;
            setDraftsReady(false);
            return;
        }
        if (initializedRef.current) return;
        initializedRef.current = true;
        setDraftsReady(false);
        let active = true;
        void Promise.all([refreshModelConfiguration(), refreshObjectStorages(), getCreditSettings(), getInvitationRewardSettings(), getCheckInRewardSettings()])
            .then(([, , creditSettings, invitationRewardSettings, checkInSettings]) => {
                if (!active) return;
                resetAllDrafts();
                setCreditBaseline(creditSettings.initialCredits);
                setDraftInitialCredits(creditSettings.initialCredits);
                setInvitationRewardBaseline(invitationRewardSettings.invitationRewardCredits);
                setDraftInvitationRewardCredits(invitationRewardSettings.invitationRewardCredits);
                setCheckInBaseline(checkInSettings.checkInCredits);
                setDraftCheckInCredits(checkInSettings.checkInCredits);
                setDraftsReady(true);
            })
            .catch(() => {
                if (!active) return;
                message.error("加载配置失败");
                setDraftsReady(true);
            });
        return () => {
            active = false;
        };
    }, [isConfigOpen, message, refreshModelConfiguration, refreshObjectStorages, resetAllDrafts]);

    useEffect(() => {
        if (user?.role !== "admin" && isConfigOpen) setConfigDialogOpen(false);
    }, [isConfigOpen, setConfigDialogOpen, user?.role]);

    const draftConfig = useMemo(() => configFromModelConfigs(config.channels, draftModelConfigs, config), [config, draftModelConfigs]);
    const objectStoragesPage = usePaginatedList(draftObjectStorages, 10, String(isConfigOpen));
    const textModelsPage = usePaginatedList(draftConfig.textModels, 10, String(isConfigOpen));
    const imageModelsPage = usePaginatedList(draftConfig.imageModels, 10, String(isConfigOpen));
    const videoModelsPage = usePaginatedList(draftConfig.videoModels, 10, String(isConfigOpen));
    const audioModelsPage = usePaginatedList(draftConfig.audioModels, 10, String(isConfigOpen));
    const modelPages = { text: textModelsPage, image: imageModelsPage, video: videoModelsPage, audio: audioModelsPage };
    const modelOptions = useMemo(() => {
        const option = (model: string) => ({ label: modelOptionLabel(draftConfig, model), title: modelOptionLabel(draftConfig, model), value: model });
        // Use the saved capability catalog so deselected drafts can still be selected again.
        return { image: config.imageModels.map(option), video: config.videoModels.map(option), text: config.textModels.map(option), audio: config.audioModels.map(option) };
    }, [config, draftConfig]);
    const modelConfigsDirty = !sameValue(draftModelConfigs, modelConfigBaseline);
    const objectStoragesDirty = !sameValue(draftObjectStorages, objectStorageBaseline);
    const creditsDirty = draftInitialCredits !== creditBaseline;
    const invitationRewardDirty = draftInvitationRewardCredits !== invitationRewardBaseline;
    const checkInDirty = draftCheckInCredits !== checkInBaseline;
    const hasUnsavedChanges = modelConfigsDirty || objectStoragesDirty || creditsDirty || invitationRewardDirty || checkInDirty;
    const isSaving = Boolean(savingTab);

    const updateCapabilityModels = (group: ModelGroup, models: string[]) => {
        const values = uniqueModels(models.map((model) => normalizeModelOptionValue(model, config.channels)).filter(Boolean));
        if (values.some((value) => !modelOptions[group.capability].some((option) => option.value === value))) {
            message.warning(`请选择已接入的${group.optionsLabel}`);
            return;
        }
        modelPages[group.capability].resetPage();
        setDraftModelConfigs((configs) => {
            const existing = new Map(configs.filter((configItem) => configItem.modelType === group.capability).map((configItem) => [modelConfigValue(configItem), configItem]));
            const next = values.map((value) => {
                const [channelId, modelName] = value.split("::");
                return existing.get(value) || createDraftModelConfig(channelId, modelName, group.capability);
            });
            const added = next.filter((configItem) => !existing.has(modelConfigValue(configItem))).reverse();
            const retained = retainCapabilityModelDrafts(configs, group.capability, values, draftConfig.models);
            return [...configs.filter((configItem) => configItem.modelType !== group.capability), ...added, ...retained];
        });
    };

    const openModelConfigEditor = (configItem: ServerModelConfig) => {
        setEditingModelConfig(cloneModelConfig(configItem));
        setEditingCustomBodyParameters(JSON.stringify(configItem.customBodyParameters || {}, null, 2));
        setCollapsedEditingCapabilities([]);
    };

    const toggleEditingCapabilityCollapsed = (capability: string) => {
        setCollapsedEditingCapabilities((capabilities) => (capabilities.includes(capability) ? capabilities.filter((item) => item !== capability) : [...capabilities, capability]));
    };

    const updateEditingModelConfig = (patch: Partial<ServerModelConfig>) => {
        setEditingModelConfig((configItem) => (configItem ? { ...configItem, ...patch } : configItem));
    };

    const saveModelConfigEditor = () => {
        if (!editingModelConfig) return;
        const defaultResolution = editingModelConfig.videoBillingConfiguration?.defaultResolution;
        if (defaultResolution && !configuredVideoResolutions(editingModelConfig.videoBillingConfiguration, editingModelConfig.capabilities).includes(defaultResolution)) {
            message.error("请为默认分辨率配置价格，或重新选择默认分辨率");
            return;
        }
        let customBodyParameters: Record<string, unknown>;
        try {
            const parsed = JSON.parse(editingCustomBodyParameters.trim() || "{}");
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("模型自定义JSON必须是对象");
            customBodyParameters = parsed as Record<string, unknown>;
        } catch (error) {
            message.error(error instanceof Error ? error.message : "模型自定义JSON格式不正确");
            return;
        }
        const nextConfig = {
            ...editingModelConfig,
            customBodyParameters,
            displayName: editingModelConfig.displayName?.trim() === editingModelConfig.modelName ? null : editingModelConfig.displayName?.trim() || null,
        };
        setDraftModelConfigs((configs) => configs.map((configItem) => (configItem.id === nextConfig.id ? nextConfig : configItem)));
        setEditingModelConfig(null);
    };

    const formatEditingCustomBodyParameters = () => {
        try {
            const parsed = JSON.parse(editingCustomBodyParameters.trim() || "{}");
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("模型自定义JSON必须是对象");
            setEditingCustomBodyParameters(JSON.stringify(parsed, null, 2));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "模型自定义JSON格式不正确");
        }
    };

    const toggleModelCapabilityCollapsed = (modelType: ModelCapability) => {
        setCollapsedModelCapabilityTypes((types) => (types.includes(modelType) ? types.filter((type) => type !== modelType) : [...types, modelType]));
    };

    const setDefaultDraftModel = (modelType: ModelCapability, model: string) => {
        setDraftModelConfigs((configs) => configs.map((configItem) => (configItem.modelType === modelType ? { ...configItem, defaultModel: modelConfigValue(configItem) === model } : configItem)));
    };

    const saveModelConfigs = async () => {
        let nextDrafts = draftModelConfigs;
        setSavingTab("models");
        try {
            const currentChannels = new Map(useConfigStore.getState().config.channels.map((channel) => [channel.id, channel]));
            if (nextDrafts.some((configItem) => !currentChannels.get(configItem.channelId)?.models.includes(configItem.modelName))) {
                throw new Error("模型尚未接入，请先在 New API 渠道中心接入该模型");
            }
            nextDrafts = reconcileModelConfigDraftIds(nextDrafts, modelConfigBaseline);
            const baselineById = new Map(modelConfigBaseline.map((configItem) => [configItem.id, configItem]));
            const draftIds = new Set(nextDrafts.map((configItem) => configItem.id));
            const createdConfigIds = new Map<string, string>();
            for (const configItem of nextDrafts) {
                if (baselineById.has(configItem.id)) continue;
                const normalizedConfig = normalizeModelConfigForSave(configItem);
                const saved = await createModelConfig({
                    channelId: normalizedConfig.channelId,
                    modelName: normalizedConfig.modelName,
                    modelType: normalizedConfig.modelType,
                    capabilities: normalizedConfig.capabilities,
                    sortOrder: normalizedConfig.sortOrder,
                    creditCost: normalizedConfig.creditCost,
                    creditUnit: normalizedConfig.creditUnit,
                    thinkingEnabled: normalizedConfig.thinkingEnabled,
                    reasoningEffort: normalizedConfig.reasoningEffort,
                    requestConcurrency: normalizedConfig.requestConcurrency,
                    customBodyParameters: normalizedConfig.customBodyParameters,
                    videoBillingConfiguration: normalizedConfig.videoBillingConfiguration,
                    displayName: normalizedConfig.displayName,
                    modelIcon: normalizedConfig.modelIcon,
                    newModel: normalizedConfig.newModel,
                    isCustomModel: normalizedConfig.isCustomModel,
                    customModelConfig: normalizedConfig.customModelConfig,
                });
                createdConfigIds.set(configItem.id, saved.id);
            }
            if (createdConfigIds.size) {
                nextDrafts = nextDrafts.map((configItem) => {
                    const id = createdConfigIds.get(configItem.id);
                    return id ? { ...configItem, id } : configItem;
                });
                setDraftModelConfigs(nextDrafts);
            }
            for (const configItem of nextDrafts) {
                const baseline = baselineById.get(configItem.id);
                if (baseline && !sameModelConfigForUpdate(configItem, baseline)) {
                    const normalizedConfig = normalizeModelConfigForSave(configItem);
                    await updateModelConfig({
                        id: normalizedConfig.id,
                        modelType: normalizedConfig.modelType,
                        capabilities: normalizedConfig.capabilities,
                        sortOrder: normalizedConfig.sortOrder,
                        creditCost: normalizedConfig.creditCost,
                        creditUnit: normalizedConfig.creditUnit,
                        thinkingEnabled: normalizedConfig.thinkingEnabled,
                        reasoningEffort: normalizedConfig.reasoningEffort,
                        requestConcurrency: normalizedConfig.requestConcurrency,
                        customBodyParameters: normalizedConfig.customBodyParameters,
                        videoBillingConfiguration: normalizedConfig.videoBillingConfiguration,
                        displayName: normalizedConfig.displayName,
                        modelIcon: normalizedConfig.modelIcon,
                        newModel: normalizedConfig.newModel,
                        isCustomModel: normalizedConfig.isCustomModel,
                        customModelConfig: normalizedConfig.customModelConfig,
                    });
                }
            }
            for (const group of modelGroups) {
                const nextDefault = nextDrafts.find((configItem) => configItem.modelType === group.capability && configItem.defaultModel);
                const currentDefault = modelConfigBaseline.find((configItem) => configItem.modelType === group.capability && configItem.defaultModel);
                if (nextDefault && nextDefault.id !== currentDefault?.id) await setDefaultModel(nextDefault.id, group.capability);
            }
            for (const configItem of modelConfigBaseline) {
                if (!draftIds.has(configItem.id)) await deleteModelConfig(configItem.id);
            }
            await refreshModelConfiguration();
            resetModelConfigDraft();
            message.success("模型配置已保存");
        } catch (error) {
            await refreshModelConfiguration().catch(() => undefined);
            const refreshedModelConfigs = cloneModelConfigs(useConfigStore.getState().modelConfigs);
            setModelConfigBaseline(refreshedModelConfigs);
            setDraftModelConfigs(reconcileModelConfigDraftIds(nextDrafts, refreshedModelConfigs));
            message.error(error instanceof Error ? error.message : "保存模型配置失败");
        } finally {
            setSavingTab("");
        }
    };

    const saveCreditSettings = async () => {
        setSavingTab("credits");
        try {
            const settings = await updateCreditSettings(draftInitialCredits);
            setCreditBaseline(settings.initialCredits);
            setDraftInitialCredits(settings.initialCredits);
            message.success("积分设置已保存");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存积分设置失败");
        } finally {
            setSavingTab("");
        }
    };

    const saveInvitationRewardSettings = async () => {
        setSavingTab("invitationReward");
        try {
            const settings = await updateInvitationRewardSettings(draftInvitationRewardCredits);
            setInvitationRewardBaseline(settings.invitationRewardCredits);
            setDraftInvitationRewardCredits(settings.invitationRewardCredits);
            message.success("邀请奖励设置已保存");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存邀请奖励设置失败");
        } finally {
            setSavingTab("");
        }
    };

    const saveCheckInRewardSettings = async () => {
        setSavingTab("checkIn");
        try {
            const settings = await updateCheckInRewardSettings({ checkInCredits: draftCheckInCredits });
            setCheckInBaseline(settings.checkInCredits);
            setDraftCheckInCredits(settings.checkInCredits);
            message.success("签到积分设置已保存");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存签到积分设置失败");
        } finally {
            setSavingTab("");
        }
    };

    const updateDraftObjectStorage = (id: string, patch: Partial<ObjectStorageConfig>) => {
        setDraftObjectStorages((storages) => storages.map((storage) => (storage.id === id ? { ...storage, ...patch } : storage)));
    };

    const addObjectStorage = () => {
        const storage = createObjectStorageConfig({
            id: `draft-${nanoid()}`,
            name: `对象存储 ${draftObjectStorages.length + 1}`,
            defaultStorage: draftObjectStorages.length === 0 || isDefaultObjectStoragePlaceholder(draftObjectStorages[0]),
        });
        setDraftObjectStorages((storages) => (isDefaultObjectStoragePlaceholder(storages[0]) ? [storage] : [storage, ...storages]));
        objectStoragesPage.resetPage();
        setCollapsedObjectStorageIds((ids) => ids.filter((id) => id !== storage.id));
    };

    const setDraftDefaultObjectStorage = (id: string) => {
        setDraftObjectStorages((storages) => storages.map((storage) => ({ ...storage, defaultStorage: storage.id === id })));
    };

    const toggleObjectStorageCollapsed = (id: string) => {
        setCollapsedObjectStorageIds((ids) => (ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]));
    };

    const removeObjectStorage = (id: string) => {
        const storage = draftObjectStorages.find((item) => item.id === id);
        if (!storage) return;
        if (draftObjectStorages.length <= 1) {
            message.warning("至少保留一个对象存储");
            return;
        }
        if (storage.defaultStorage) {
            message.warning("默认对象存储不能删除，请先设置其他默认项");
            return;
        }
        modal.confirm({
            title: "确认删除",
            content: "该对象存储会在点击保存后从服务端删除。",
            okText: "删除",
            okType: "danger",
            cancelText: "取消",
            onOk: () => {
                setDraftObjectStorages((storages) => storages.filter((item) => item.id !== id));
                setCollapsedObjectStorageIds((ids) => ids.filter((item) => item !== id));
            },
        });
    };

    const refreshObjectStorageDrafts = async () => {
        setRefreshingObjectStorages(true);
        try {
            await refreshObjectStorages();
            resetObjectStorageDraft();
            message.success("对象存储配置已刷新");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "刷新对象存储失败");
        } finally {
            setRefreshingObjectStorages(false);
        }
    };

    const handleRefreshObjectStorages = () => {
        if (!objectStoragesDirty) {
            void refreshObjectStorageDrafts();
            return;
        }
        modal.confirm({
            title: "放弃未保存修改？",
            content: "刷新会丢弃对象存储 Tab 中的未保存修改。",
            okText: "放弃并刷新",
            okType: "danger",
            cancelText: "取消",
            onOk: refreshObjectStorageDrafts,
        });
    };

    const saveObjectStorages = async () => {
        const persistedStorageIds = new Set(objectStorageBaseline.filter((storage) => storage.id !== "default").map((storage) => storage.id));
        const baselineById = new Map(objectStorageBaseline.map((storage) => [storage.id, storage]));
        const draftIds = new Set(draftObjectStorages.map((storage) => storage.id));
        const selectedDefault = draftObjectStorages.find((storage) => storage.defaultStorage);
        if (!selectedDefault) {
            message.error("请设置默认对象存储");
            return;
        }
        const incompleteStorage = draftObjectStorages.find((storage) => !isObjectStorageReady(storage));
        if (incompleteStorage) {
            message.error(`${incompleteStorage.name}：${objectStorageReadyMessage(incompleteStorage)}`);
            return;
        }
        let nextDrafts = draftObjectStorages;
        setSavingTab("objectStorage");
        try {
            const savedStorageIds = new Map<string, string>();
            for (const storage of draftObjectStorages) {
                if (persistedStorageIds.has(storage.id)) continue;
                const saved = await createServerObjectStorage({ ...storage, id: storage.id === "default" ? "" : storage.id });
                savedStorageIds.set(storage.id, saved.id);
                nextDrafts = nextDrafts.map((item) => (item.id === storage.id ? saved : item));
            }
            if (savedStorageIds.size) setDraftObjectStorages(nextDrafts);
            for (const storage of nextDrafts) {
                const baseline = baselineById.get(storage.id);
                if (baseline && persistedStorageIds.has(storage.id) && !sameValue(storage, baseline)) {
                    await updateServerObjectStorage(storage);
                }
            }
            const nextDefault = nextDrafts.find((storage) => storage.defaultStorage);
            const currentDefault = objectStorageBaseline.find((storage) => storage.defaultStorage && persistedStorageIds.has(storage.id));
            if (nextDefault && nextDefault.id !== currentDefault?.id) await setServerDefaultObjectStorage(nextDefault.id);
            for (const storage of objectStorageBaseline) {
                if (persistedStorageIds.has(storage.id) && !draftIds.has(storage.id)) await deleteServerObjectStorage(storage.id);
            }
            await refreshObjectStorages();
            resetObjectStorageDraft();
            message.success("对象存储配置已保存");
        } catch (error) {
            await refreshObjectStorages().catch(() => undefined);
            setObjectStorageBaseline(cloneObjectStorages(useConfigStore.getState().objectStorages));
            setDraftObjectStorages(nextDrafts);
            message.error(error instanceof Error ? error.message : "保存对象存储失败");
        } finally {
            setSavingTab("");
        }
    };

    const testObjectStorage = async (storageId: string) => {
        if (objectStoragesDirty) {
            message.warning("请先保存对象存储配置，再执行测试上传");
            return;
        }
        const storage = draftObjectStorages.find((item) => item.id === storageId);
        if (!storage || !isObjectStorageReady(storage)) {
            message.error(objectStorageReadyMessage(storage));
            return;
        }
        setTestingObjectStorageId(storageId);
        setTestedObjectStorageId("");
        setObjectStorageTestUrl("");
        try {
            const result = await testObjectStorageUpload(storage);
            updateDraftObjectStorage(storageId, { lastTestedAt: result.uploadedAt });
            setTestedObjectStorageId(storageId);
            setObjectStorageTestUrl(result.url);
            message.success("对象存储测试上传成功，请点击保存记录测试时间");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "对象存储测试上传失败");
        } finally {
            setTestingObjectStorageId("");
        }
    };

    const changeActiveTab = (tabKey: string) => {
        const nextTab = tabKey as ConfigDialogTabKey;
        setActiveTab(nextTab);
        setConfigDialogTab(nextTab);
    };

    const closeConfigDialog = () => {
        if (!hasUnsavedChanges) {
            setConfigDialogOpen(false);
            return;
        }
        modal.confirm({
            title: "放弃未保存修改？",
            content: "关闭后会丢弃所有 Tab 中未保存的修改。",
            okText: "放弃修改",
            okType: "danger",
            cancelText: "继续编辑",
            onOk: () => setConfigDialogOpen(false),
        });
    };

    if (user?.role !== "admin") return null;

    return (
        <Modal
            title={<div className="min-w-0 break-words pr-6 text-lg font-semibold">配置与用户偏好</div>}
            open={isConfigOpen}
            width={980}
            centered
            onCancel={closeConfigDialog}
            footer={null}
            styles={{ body: { height: "72vh", minWidth: 0, overflowY: "auto", paddingRight: isCompact ? 0 : 12 } }}
        >
            {!draftsReady ? (
                <div className="flex h-40 items-center justify-center text-sm text-[var(--studio-muted)]">正在加载配置...</div>
            ) : (
                <Tabs
                    className="min-w-0 [&_.ant-tabs-content-holder]:min-w-0 [&_.ant-tabs-tabpane]:min-w-0"
                    activeKey={activeTab}
                    tabPlacement={isCompact ? "top" : "start"}
                    tabBarStyle={isCompact ? undefined : { width: 112 }}
                    onChange={changeActiveTab}
                    items={[
                        {
                            key: "models",
                            label: "我的模型",
                            children: (
                                <Form layout="vertical" requiredMark={false}>
                                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--studio-line)] bg-[var(--studio-surface-soft)] p-3">
                                        <div>
                                            <div className="text-sm font-semibold">默认模型和可选项</div>
                                            <div className="mt-1 text-xs leading-5 text-[var(--studio-muted)]">可选项决定各处下拉框展示哪些模型；在下方编辑模型别名，让名称更简洁。</div>
                                        </div>
                                        <Space wrap>
                                            <Button href="/admin/system?tab=newapi" disabled={hasUnsavedChanges || isSaving}>New API 渠道中心</Button>
                                            <Button type="primary" disabled={!modelConfigsDirty || isSaving} loading={savingTab === "models"} onClick={() => void saveModelConfigs()}>
                                                保存
                                            </Button>
                                        </Space>
                                    </div>
                                    <div className="grid gap-4 md:grid-cols-2">
                                        {modelGroups.map((group) => (
                                            <Form.Item key={group.modelsKey} label={group.optionsLabel} className="mb-0">
                                                <Select
                                                    mode="multiple"
                                                    aria-label={group.optionsLabel}
                                                    showSearch
                                                    optionFilterProp="label"
                                                    allowClear
                                                    maxTagCount="responsive"
                                                    placeholder={modelOptions[group.capability].length ? `请选择${group.optionsLabel}` : "请先在 New API 渠道中心接入对应类型的模型"}
                                                    value={draftConfig[group.modelsKey]}
                                                    options={modelOptions[group.capability]}
                                                    disabled={isSaving}
                                                    onChange={(models) => updateCapabilityModels(group, models)}
                                                />
                                            </Form.Item>
                                        ))}
                                    </div>
                                    <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                                        {modelGroups.map((group) => (
                                            <Form.Item key={group.modelKey} label={group.defaultLabel} className="mb-0">
                                                <div className={isSaving ? "pointer-events-none opacity-60" : ""}>
                                                    <ModelPicker config={draftConfig} value={draftConfig[group.modelKey]} onChange={(model) => setDefaultDraftModel(group.capability, model)} capability={group.capability} fullWidth showChannelName />
                                                </div>
                                            </Form.Item>
                                        ))}
                                    </div>
                                    <div className="mt-6 rounded-lg border border-[var(--studio-line)] bg-[var(--studio-surface-soft)] p-3">
                                        <div className="text-sm font-semibold">模型能力配置</div>
                                        <div className="mt-1 text-xs leading-5 text-[var(--studio-muted)]">点击模型后的编辑按钮设置别名、NEW 标记、积分及生成能力。别名会同步到所有模型选择器。</div>
                                        <div className="mt-3 space-y-4">
                                            {capabilityGroups.map((group) => {
                                                const models = draftConfig[group.modelsKey];
                                                const modelsPage = modelPages[group.capability];
                                                if (!models.length) return null;
                                                const collapsed = collapsedModelCapabilityTypes.includes(group.capability);
                                                return (
                                                    <div key={group.capability}>
                                                        <div className="mb-2 flex items-center justify-between gap-3">
                                                            <div className="text-xs font-medium text-[var(--studio-muted)]">{group.label}</div>
                                                            <Button size="small" icon={collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />} onClick={() => toggleModelCapabilityCollapsed(group.capability)}>
                                                                {collapsed ? "展开" : "收起"}
                                                            </Button>
                                                        </div>
                                                        {collapsed ? null : (
                                                            <div className="space-y-2">
                                                                {modelsPage.items.map((model) => {
                                                                    const modelConfig = draftModelConfigs.find((item) => item.modelType === group.capability && modelConfigValue(item) === model);
                                                                    if (!modelConfig) return null;
                                                                    return (
                                                                        <div key={model} className="flex items-center justify-between gap-3 rounded border border-[var(--studio-line)] bg-[var(--studio-panel)] px-3 py-2">
                                                                            <div className="min-w-0" title={modelOptionLabel(draftConfig, model)}>
                                                                                <span className="flex min-w-0 items-center gap-2 text-sm"><span className="truncate">{modelOptionLabel(draftConfig, model)}</span>{modelConfig.newModel ? <ModelNewBadge /> : null}</span>
                                                                                {modelConfig.displayName ? <div className="mt-1 truncate text-[11px] text-[var(--studio-muted)]">{modelConfig.modelName}</div> : null}
                                                                            </div>
                                                                            <div className="flex shrink-0 items-center gap-2">
                                                                                {modelConfig.defaultModel ? <span className="text-xs text-[var(--studio-muted)]">默认</span> : null}
                                                                                <Button size="small" icon={<Pencil className="size-3.5" />} disabled={isSaving} onClick={() => openModelConfigEditor(modelConfig)}>
                                                                                    编辑
                                                                                </Button>
                                                                            </div>
                                                                        </div>
                                                                    );
                                                                })}
                                                                <ListPagination current={modelsPage.page} pageSize={modelsPage.pageSize} total={modelsPage.total} onChange={modelsPage.onChange} disabled={isSaving} label={`${group.label}分页`} />
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                </Form>
                            ),
                        },
                        {
                            key: "credits",
                            label: "积分设置",
                            children: (
                                <Form layout="vertical" requiredMark={false}>
                                    <ModelPricingPanel
                                        models={draftModelConfigs}
                                        label={model => modelOptionLabel(draftConfig, modelConfigValue(model))}
                                        disabled={isSaving}
                                        dirty={modelConfigsDirty}
                                        saving={savingTab === "models"}
                                        onCost={(id, cost) => setDraftModelConfigs(models => models.map(model => model.id === id ? { ...model, creditCost: cost } : model))}
                                        onEdit={openModelConfigEditor}
                                        onSave={() => void saveModelConfigs()}
                                    />
                                    <div className="rounded-lg border border-[var(--studio-line)] bg-[var(--studio-surface-soft)] p-4">
                                        <div className="text-sm font-semibold">新用户初始积分</div>
                                        <div className="mt-1 text-xs leading-5 text-[var(--studio-muted)]">仅影响之后注册、后台创建或首次第三方登录的新用户，已有用户积分不会自动变更。</div>
                                        <div className="mt-5 flex flex-wrap items-end gap-3">
                                            <Form.Item label="初始积分" className="mb-0">
                                                <InputNumber min={0} precision={0} value={draftInitialCredits} disabled={isSaving} className="w-40" onChange={(value) => setDraftInitialCredits(Math.max(0, Number(value) || 0))} />
                                            </Form.Item>
                                            <Button type="primary" disabled={!creditsDirty || isSaving} loading={savingTab === "credits"} onClick={() => void saveCreditSettings()}>
                                                保存
                                            </Button>
                                        </div>
                                    </div>
                                </Form>
                            ),
                        },
                        {
                            key: "invitationReward",
                            label: "邀请奖励",
                            children: (
                                <Form layout="vertical" requiredMark={false} className="max-w-xl">
                                    <div className="rounded-lg border border-[var(--studio-line)] bg-[var(--studio-surface-soft)] p-4">
                                        <div className="text-sm font-semibold">邀请注册奖励积分</div>
                                        <div className="mt-1 text-xs leading-5 text-[var(--studio-muted)]">
                                            新用户通过有效邀请链接完成邮箱注册或首次第三方登录后，奖励发放给邀请人。设置为 0 表示暂停发放；只影响之后注册的用户，不追溯历史邀请。
                                        </div>
                                        <div className="mt-5 flex flex-wrap items-end gap-3">
                                            <Form.Item label="每名新用户奖励积分" className="mb-0">
                                                <InputNumber
                                                    min={0}
                                                    precision={0}
                                                    value={draftInvitationRewardCredits}
                                                    disabled={isSaving}
                                                    className="w-48"
                                                    onChange={(value) => setDraftInvitationRewardCredits(Math.max(0, Number(value) || 0))}
                                                />
                                            </Form.Item>
                                            <Button
                                                type="primary"
                                                disabled={!invitationRewardDirty || isSaving}
                                                loading={savingTab === "invitationReward"}
                                                onClick={() => void saveInvitationRewardSettings()}
                                            >
                                                保存
                                            </Button>
                                        </div>
                                    </div>
                                </Form>
                            ),
                        },
                        {
                            key: "checkIn",
                            label: "签到积分",
                            children: (
                                <Form layout="vertical" requiredMark={false} className="max-w-xl">
                                    <div className="rounded-lg border border-[var(--studio-line)] bg-[var(--studio-surface-soft)] p-4">
                                        <div className="text-sm font-semibold">每日签到积分</div>
                                        <div className="mt-1 text-xs leading-5 text-[var(--studio-muted)]">
                                            用户每天签到一次即可获得该积分；签到积分自签到起 24 小时内有效，到期未使用的部分自动作废。设置为 0 表示仍可签到但不发放积分。
                                        </div>
                                        <div className="mt-5 flex flex-wrap items-end gap-3">
                                            <Form.Item label="每日签到积分" className="mb-0">
                                                <InputNumber
                                                    min={0}
                                                    precision={0}
                                                    value={draftCheckInCredits}
                                                    disabled={isSaving}
                                                    className="w-40"
                                                    onChange={(value) => setDraftCheckInCredits(Math.max(0, Number(value) || 0))}
                                                />
                                            </Form.Item>
                                            <Button
                                                type="primary"
                                                disabled={!checkInDirty || isSaving}
                                                loading={savingTab === "checkIn"}
                                                onClick={() => void saveCheckInRewardSettings()}
                                            >
                                                保存
                                            </Button>
                                        </div>
                                    </div>
                                </Form>
                            ),
                        },
                        {
                            key: "objectStorage",
                            label: "对象存储",
                            children: (
                                <Form layout="vertical" requiredMark={false} className="min-w-0 [&_.ant-form-item]:min-w-0 [&_.ant-form-item-extra]:break-words">
                                    <div className="mb-4 flex min-w-0 flex-col items-start justify-between gap-3 rounded-lg border border-[var(--studio-line)] bg-[var(--studio-surface-soft)] p-3 md:flex-row md:flex-wrap">
                                        <div className="min-w-0 w-full flex-1 md:w-auto">
                                            <div className="flex items-center gap-2 text-sm font-semibold">
                                                <CloudUpload className="size-4" />
                                                云储存
                                            </div>
                                            <div className="mt-1 text-xs leading-5 text-[var(--studio-muted)]">密钥会加密保存到服务端，默认对象存储用于后端上传生成结果和素材文件。</div>
                                        </div>
                                        <div className="flex max-w-full flex-wrap gap-2 md:shrink-0">
                                            <Button icon={<RefreshCw className="size-4" />} disabled={isSaving} loading={refreshingObjectStorages} onClick={handleRefreshObjectStorages}>
                                                刷新
                                            </Button>
                                            <Button type="primary" disabled={!objectStoragesDirty || isSaving} loading={savingTab === "objectStorage"} onClick={() => void saveObjectStorages()}>
                                                保存
                                            </Button>
                                            <Button icon={<Plus className="size-4" />} disabled={isSaving} onClick={addObjectStorage}>
                                                新增
                                            </Button>
                                        </div>
                                    </div>
                                    <div className="space-y-3">
                                        {objectStoragesPage.items.map((storage) => {
                                            const collapsed = collapsedObjectStorageIds.includes(storage.id);
                                            const providerFields = objectStorageProviderFields[storage.provider];
                                            return (
                                                <section key={storage.id} className="min-w-0 rounded-lg border border-[var(--studio-line)] bg-[var(--studio-panel)] p-3">
                                                    <div className={`flex min-w-0 flex-col items-start justify-between gap-3 md:flex-row md:items-center ${collapsed ? "" : "mb-3"}`}>
                                                        <div className="min-w-0 w-full md:w-auto md:flex-1">
                                                            <div className="break-words text-sm font-semibold">{storage.name || "未命名对象存储"}</div>
                                                            <div className="mt-1 text-xs text-[var(--studio-muted)]">
                                                                {storage.defaultStorage ? "默认 · " : ""}
                                                                {storage.lastTestedAt ? `上次测试 ${formatTimestamp(storage.lastTestedAt)}` : "尚未测试"}
                                                            </div>
                                                        </div>
                                                        <div className="flex max-w-full flex-wrap gap-2 md:shrink-0">
                                                            <Button size="small" icon={collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />} onClick={() => toggleObjectStorageCollapsed(storage.id)}>
                                                                {collapsed ? "展开" : "收起"}
                                                            </Button>
                                                            <Button size="small" disabled={storage.defaultStorage || isSaving} onClick={() => setDraftDefaultObjectStorage(storage.id)}>
                                                                设为默认
                                                            </Button>
                                                            <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={isSaving} onClick={() => removeObjectStorage(storage.id)} />
                                                        </div>
                                                    </div>
                                                    {collapsed ? null : (
                                                        <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
                                                            <Form.Item label="配置名称" className="mb-0">
                                                                <Input value={storage.name} disabled={isSaving} onChange={(event) => updateDraftObjectStorage(storage.id, { name: event.target.value })} />
                                                            </Form.Item>
                                                            <Form.Item label="服务商" className="mb-0">
                                                                <Select
                                                                    value={storage.provider}
                                                                    options={objectStorageProviderOptions}
                                                                    disabled={isSaving}
                                                                    onChange={(provider) =>
                                                                        updateDraftObjectStorage(storage.id, {
                                                                            provider: provider as ObjectStorageProvider,
                                                                            accessKey: "",
                                                                            secretKey: "",
                                                                            bucket: "",
                                                                            region: provider === "cloudflareR2" ? "auto" : "",
                                                                            endpoint: "",
                                                                            publicBaseUrl: "",
                                                                            lastTestedAt: "",
                                                                        })
                                                                    }
                                                                />
                                                            </Form.Item>
                                                            <Form.Item label="存储目录" extra="上传 Key 规则：目录/images 或 videos/日期/文件名。" className="mb-0">
                                                                <Input value={storage.directory} placeholder="inspire-studio" disabled={isSaving} onChange={(event) => updateDraftObjectStorage(storage.id, { directory: event.target.value })} />
                                                            </Form.Item>
                                                            <Form.Item label={providerFields.accessKeyLabel} className="mb-0">
                                                                <Input value={storage.accessKey} autoComplete="off" disabled={isSaving} onChange={(event) => updateDraftObjectStorage(storage.id, { accessKey: event.target.value })} />
                                                            </Form.Item>
                                                            <Form.Item label={providerFields.secretKeyLabel} className="mb-0">
                                                                <Input.Password value={storage.secretKey} autoComplete="new-password" disabled={isSaving} onChange={(event) => updateDraftObjectStorage(storage.id, { secretKey: event.target.value })} />
                                                            </Form.Item>
                                                            <Form.Item label="Bucket" className="mb-0">
                                                                <Input value={storage.bucket} placeholder={providerFields.bucketPlaceholder} disabled={isSaving} onChange={(event) => updateDraftObjectStorage(storage.id, { bucket: event.target.value })} />
                                                            </Form.Item>
                                                            <Form.Item label={providerFields.regionLabel} extra={storage.provider === "cloudflareR2" ? "R2 使用固定值 auto。" : undefined} className="mb-0">
                                                                {storage.provider === "qiniuKodo" ? (
                                                                    <Select
                                                                        value={storage.region || undefined}
                                                                        options={qiniuRegionOptions}
                                                                        placeholder={providerFields.regionPlaceholder}
                                                                        disabled={isSaving}
                                                                        onChange={(region) => updateDraftObjectStorage(storage.id, { region })}
                                                                    />
                                                                ) : (
                                                                    <Input
                                                                        value={storage.region}
                                                                        placeholder={providerFields.regionPlaceholder}
                                                                        disabled={isSaving || storage.provider === "cloudflareR2"}
                                                                        onChange={(event) => updateDraftObjectStorage(storage.id, { region: event.target.value })}
                                                                    />
                                                                )}
                                                            </Form.Item>
                                                            {storage.provider === "aliyunOss" ? (
                                                                <Form.Item label="Endpoint" extra="必须填写包含 http:// 或 https:// 的 OSS Endpoint。" className="mb-0 md:col-span-2">
                                                                    <Input
                                                                        value={storage.endpoint}
                                                                        placeholder="https://oss-cn-hangzhou.aliyuncs.com"
                                                                        disabled={isSaving}
                                                                        onChange={(event) => updateDraftObjectStorage(storage.id, { endpoint: event.target.value })}
                                                                    />
                                                                </Form.Item>
                                                            ) : null}
                                                            {storage.provider === "cloudflareR2" ? (
                                                                <Form.Item label="S3 API Endpoint" required extra="从 Cloudflare R2 控制台复制账户级 S3 API 地址，不要附加 Bucket 名称。" className="mb-0 md:col-span-2">
                                                                    <Input
                                                                        value={storage.endpoint}
                                                                        placeholder="https://<ACCOUNT_ID>.r2.cloudflarestorage.com"
                                                                        disabled={isSaving}
                                                                        onChange={(event) => updateDraftObjectStorage(storage.id, { endpoint: event.target.value })}
                                                                    />
                                                                </Form.Item>
                                                            ) : null}
                                                            <Form.Item
                                                                label={storage.provider === "cloudflareR2" ? "公开访问域名" : "公开访问地址"}
                                                                required={storage.provider === "qiniuKodo" || storage.provider === "cloudflareR2"}
                                                                extra={providerFields.publicBaseUrlExtra}
                                                                className="mb-0 md:col-span-2"
                                                            >
                                                                <Input
                                                                    value={storage.publicBaseUrl}
                                                                    placeholder="https://cdn.example.com"
                                                                    disabled={isSaving}
                                                                    onChange={(event) => updateDraftObjectStorage(storage.id, { publicBaseUrl: event.target.value })}
                                                                />
                                                            </Form.Item>
                                                            {storage.provider === "cloudflareR2" ? (
                                                                <div className="text-xs leading-5 text-[var(--studio-muted)] md:col-span-2">使用具备当前 Bucket 对象读写权限的 R2 API 凭据。文件由后端上传，无需为前端上传配置 Bucket CORS。</div>
                                                            ) : null}
                                                        </div>
                                                    )}
                                                    <div className="mt-4 flex flex-wrap items-center gap-2">
                                                        <Button icon={<Wifi className="size-4" />} disabled={!isObjectStorageReady(storage) || isSaving} loading={testingObjectStorageId === storage.id} onClick={() => void testObjectStorage(storage.id)}>
                                                            测试上传
                                                        </Button>
                                                        {objectStorageTestUrl && testedObjectStorageId === storage.id ? (
                                                            <Button type="link" className="h-auto p-0 text-xs" href={objectStorageTestUrl} target="_blank" rel="noreferrer">
                                                                打开测试文件
                                                            </Button>
                                                        ) : null}
                                                    </div>
                                                </section>
                                            );
                                        })}
                                    </div>
                                    <ListPagination current={objectStoragesPage.page} pageSize={objectStoragesPage.pageSize} total={objectStoragesPage.total} onChange={objectStoragesPage.onChange} disabled={isSaving} label="对象存储分页" />
                                </Form>
                            ),
                        },
                    ]}
                />
            )}
            <Modal
                title={
                    editingModelConfig ? (
                        <div className="flex items-center gap-3">
                            {editingModelConfig.modelType === "video" ? (
                                <span className="flex size-10 items-center justify-center rounded-lg bg-violet-500/15 text-violet-500">
                                    <Video className="size-5" />
                                </span>
                            ) : null}
                            <div>
                                <div className="text-lg font-semibold">{modelOptionLabel(draftConfig, modelConfigValue(editingModelConfig))} 配置</div>
                                {editingModelConfig.modelType === "video" ? <div className="mt-0.5 text-xs font-normal text-[var(--studio-muted)]">配置模型的计费方式、分辨率价格及功能支持</div> : null}
                            </div>
                        </div>
                    ) : (
                        "模型配置"
                    )
                }
                open={Boolean(editingModelConfig)}
                centered
                width={editingModelConfig?.modelType === "video" ? 980 : 760}
                destroyOnHidden
                okText="确认"
                cancelText="取消"
                onCancel={() => setEditingModelConfig(null)}
                onOk={saveModelConfigEditor}
            >
                {editingModelConfig?.modelType === "video" && editingModelIsMedia ? (
                    <div className="space-y-5">
                        <section className="rounded-lg border border-[var(--studio-line)] bg-[var(--studio-surface-soft)] p-4">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <div className="flex items-center gap-1.5 text-sm font-semibold">
                                        自定义模型 <Info className="size-4 text-[var(--studio-muted)]" />
                                    </div>
                                    <p className="mt-1 text-xs text-[var(--studio-muted)]">启用后按下方各模式配置的请求/响应示例调用任意 API，替换默认渠道调用。</p>
                                </div>
                                <Switch checked={Boolean(editingModelConfig.isCustomModel)} onChange={(checked) => updateEditingModelConfig({ isCustomModel: checked })} />
                            </div>
                        </section>

                        <section className="rounded-lg border border-[var(--studio-line)] bg-[var(--studio-surface-soft)] p-4">
                            <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                                <label htmlFor="model-alias">模型别名</label>
                            </div>
                            <Input
                                id="model-alias"
                                allowClear
                                maxLength={255}
                                placeholder="例如：MiniMax H3、Veo 3.1 Fast"
                                value={editingModelConfig.displayName || ""}
                                onChange={(event) => updateEditingModelConfig({ displayName: event.target.value })}
                            />
                            <p className="mt-2 text-xs text-[var(--studio-muted)]">设置后，下拉列表与已选模型显示此别名；留空恢复原名。</p>
                            <p className="mt-1 break-all text-xs text-[var(--studio-muted)]">模型 ID：<span className="select-all font-mono">{editingModelConfig.modelName}</span></p>
                        </section>

                        <section className="rounded-lg border border-[var(--studio-line)] bg-[var(--studio-surface-soft)] p-4">
                            <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                                模型标记 <Info className="size-4 text-[var(--studio-muted)]" />
                            </div>
                            <ModelAppearancePreview model={editingModelConfig} onChange={(newModel) => updateEditingModelConfig({ newModel })} />
                        </section>

                        <section className="grid gap-4 rounded-lg border border-[var(--studio-line)] bg-[var(--studio-surface-soft)] p-4 md:grid-cols-2">
                            <div>
                                <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                                    计费方式 <Info className="size-4 text-[var(--studio-muted)]" />
                                </div>
                                <Select
                                    value={editingModelConfig.videoBillingConfiguration?.billingUnit || "generation"}
                                    options={[
                                        { value: "generation", label: "按次" },
                                        { value: "second", label: "按秒" },
                                    ]}
                                    className="w-full"
                                    onChange={(billingUnit: ServerModelConfig["creditUnit"]) =>
                                        updateEditingModelConfig({
                                            creditUnit: billingUnit,
                                            videoBillingConfiguration: {
                                                ...(editingModelConfig.videoBillingConfiguration || createVideoBillingConfiguration()),
                                                billingUnit,
                                            },
                                        })
                                    }
                                />
                            </div>
                            <div>
                                <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                                    最短生成时长（秒） <Info className="size-4 text-[var(--studio-muted)]" />
                                </div>
                                <Space.Compact className="w-full">
                                    <InputNumber
                                        min={1}
                                        precision={0}
                                        value={editingModelConfig.videoBillingConfiguration?.minimumDurationSeconds || 3}
                                        disabled={Boolean(editingModelConfig.videoBillingConfiguration?.supportedDurationsSeconds?.length)}
                                        style={{ width: "100%" }}
                                        onChange={(value) =>
                                            updateEditingModelConfig({
                                                videoBillingConfiguration: {
                                                    ...(editingModelConfig.videoBillingConfiguration || createVideoBillingConfiguration()),
                                                    minimumDurationSeconds: Math.max(1, Math.floor(Number(value) || 1)),
                                                },
                                            })
                                        }
                                    />
                                    <Button disabled className="pointer-events-none">秒</Button>
                                </Space.Compact>
                            </div>
                            <VideoDurationEditor key={editingModelConfig.id} value={editingModelConfig.videoBillingConfiguration || createVideoBillingConfiguration()} onChange={videoBillingConfiguration => updateEditingModelConfig({ videoBillingConfiguration })} />
                            <div className="md:col-span-2">
                                <label htmlFor="video-model-default-resolution" className="mb-2 block text-sm font-semibold">默认分辨率</label>
                                <Select
                                    id="video-model-default-resolution"
                                    aria-label="默认分辨率"
                                    className="w-full"
                                    value={editingModelConfig.videoBillingConfiguration?.defaultResolution || ""}
                                    options={[
                                        { value: "", label: "自动选择（优先 720P）" },
                                        ...VIDEO_RESOLUTION_OPTIONS.filter(option => configuredVideoResolutions(editingModelConfig.videoBillingConfiguration, editingModelConfig.capabilities).includes(option.value)),
                                    ]}
                                    onChange={(value: VideoResolution | "") => updateEditingModelConfig({
                                        videoBillingConfiguration: {
                                            ...(editingModelConfig.videoBillingConfiguration || createVideoBillingConfiguration()),
                                            defaultResolution: value || null,
                                        },
                                    })}
                                />
                                <p className="mt-2 text-xs text-[var(--studio-muted)]">新建视频和切换模型时使用。可选项来自下方已配置价格的分辨率，用户仍可手动调整。</p>
                            </div>
                        </section>

                        <section className="rounded-lg border border-[var(--studio-line)] bg-[var(--studio-surface-soft)] p-4">
                            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                                <div>
                                    <div className="flex items-center gap-1.5 text-base font-semibold">
                                        功能类型与分辨率价格 <Info className="size-4 text-[var(--studio-muted)]" />
                                    </div>
                                    <p className="mt-1 text-xs text-[var(--studio-muted)]">设置模型支持的功能类型及各分辨率的积分消耗价格</p>
                                </div>
                                <span className="rounded-md border border-[var(--studio-line)] px-2.5 py-1 text-xs text-[var(--studio-muted)]">
                                    价格说明：{editingModelConfig.videoBillingConfiguration?.billingUnit === "second" ? "积分/秒" : "积分/次"}
                                </span>
                            </div>
                            <div className="space-y-4">
                                <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--studio-line)] p-4">
                                    <div><div className="font-medium">支持音频输入</div><p className="text-xs text-[var(--studio-muted)]">开启后允许该视频模型接收音频参考素材，需同时启用全能参考模式</p></div>
                                    <Switch aria-label="支持音频输入" checked={editingModelConfig.capabilities.includes("audio-input")} disabled={isSaving || !editingModelConfig.capabilities.includes("audio-input") && !editingModelConfig.capabilities.includes("reference-to-video")} onChange={(checked) => setEditingModelConfig({ ...editingModelConfig, capabilities: checked ? uniqueModels([...editingModelConfig.capabilities, "audio-input"]) : editingModelConfig.capabilities.filter((value) => value !== "audio-input") })} />
                                </div>
                                {VIDEO_GENERATION_CAPABILITY_OPTIONS.map((mode, index) => {
                                    const prices = editingModelConfig.videoBillingConfiguration?.modePrices?.[mode.value] || {};
                                    const modeEnabled = editingModelConfig.capabilities.includes(mode.value);
                                    const modeCollapsed = collapsedEditingCapabilities.includes(`video:${mode.value}`);
                                    const modeIcon = index === 0 ? <TextCursorInput className="size-5" /> : index === 1 ? <Image className="size-5" /> : <Sparkles className="size-5" />;
                                    const modeColor = index === 0 ? "border-violet-500/50 bg-violet-500/5" : index === 1 ? "border-blue-500/50 bg-blue-500/5" : "border-emerald-500/50 bg-emerald-500/5";
                                    const iconColor = index === 0 ? "bg-violet-500/15 text-violet-500" : index === 1 ? "bg-blue-500/15 text-blue-500" : "bg-emerald-500/15 text-emerald-500";
                                    const description = index === 0 ? "根据文本描述生成视频" : index === 1 ? "根据图片生成视频" : "支持文本、图片及多模态参考生成视频";
                                    return (
                                        <div key={mode.value} className={`rounded-lg border p-4 transition-colors ${modeEnabled ? modeColor : "border-[var(--studio-line)] opacity-70"}`}>
                                            <div className={modeCollapsed ? "flex items-start justify-between gap-4" : "flex items-start justify-between gap-4 border-b border-[var(--studio-line)] pb-3"}>
                                                <div className="flex min-w-0 items-center gap-3">
                                                    <span className={`flex size-10 shrink-0 items-center justify-center rounded-md ${iconColor}`}>{modeIcon}</span>
                                                    <div>
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <span className="font-semibold">{mode.label}</span>
                                                            {modeEnabled ? (
                                                                <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">已启用</span>
                                                            ) : (
                                                                <span className="rounded bg-[var(--studio-panel)] px-2 py-0.5 text-xs text-[var(--studio-muted)]">未启用</span>
                                                            )}
                                                        </div>
                                                        <p className="mt-1 text-xs text-[var(--studio-muted)]">{description}</p>
                                                    </div>
                                                </div>
                                                <div className="flex shrink-0 items-center gap-2">
                                                    <Button
                                                        type="text"
                                                        size="small"
                                                        aria-label={`${mode.label}${modeCollapsed ? "展开" : "收起"}`}
                                                        aria-expanded={!modeCollapsed}
                                                        title={`${modeCollapsed ? "展开" : "收起"}${mode.label}配置`}
                                                        icon={modeCollapsed ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
                                                        onClick={() => toggleEditingCapabilityCollapsed(`video:${mode.value}`)}
                                                    />
                                                    <Switch
                                                        checked={modeEnabled}
                                                        onChange={(checked) =>
                                                            updateEditingModelConfig({
                                                                capabilities: checked ? uniqueModels([...editingModelConfig.capabilities, mode.value]) : editingModelConfig.capabilities.filter((value) => value !== mode.value),
                                                                ...(!checked ? { videoBillingConfiguration: clearVideoModePrices(editingModelConfig.videoBillingConfiguration || createVideoBillingConfiguration(), mode.value) } : {}),
                                                            })
                                                        }
                                                    />
                                                </div>
                                            </div>
                                            {modeCollapsed ? null : <div className="pt-3">
                                                <div className="mb-2 text-xs font-medium text-[var(--studio-muted)]">分辨率价格（{editingModelConfig.videoBillingConfiguration?.billingUnit === "second" ? "积分/秒" : "积分/次"}）</div>
                                                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                                                    {VIDEO_RESOLUTION_OPTIONS.filter((resolution) => resolution.value !== "auto").map((resolution) => (
                                                        <label key={resolution.value} className="flex min-w-0 items-center gap-2 rounded-md border border-[var(--studio-line)] bg-[var(--studio-panel)] px-2.5 py-2">
                                                            <span
                                                                className={`flex size-7 shrink-0 items-center justify-center rounded text-[10px] font-semibold ${resolution.value === "480p" ? "bg-violet-500/15 text-violet-500" : resolution.value === "720p" ? "bg-blue-500/15 text-blue-500" : resolution.value === "1080p" ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : resolution.value === "2k" ? "bg-rose-500/15 text-rose-500" : resolution.value === "4k" ? "bg-purple-500/15 text-purple-500" : "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400"}`}
                                                            >
                                                                <Monitor className="size-3.5" />
                                                            </span>
                                                            <span className="min-w-0 flex-1">
                                                                <span className="block text-xs font-medium">{resolution.label}</span>
                                                                <InputNumber
                                                                    min={0}
                                                                    precision={0}
                                                                    placeholder="未配置"
                                                                    value={prices[resolution.value]}
                                                                    className="mt-0.5 w-full"
                                                                    disabled={!modeEnabled}
                                                                    controls={false}
                                                                    onChange={(value) =>
                                                                        updateEditingModelConfig({
                                                                            videoBillingConfiguration: updateVideoResolutionPrice(editingModelConfig.videoBillingConfiguration || createVideoBillingConfiguration(), mode.value, resolution.value, value),
                                                                        })
                                                                    }
                                                                />
                                                            </span>
                                                        </label>
                                                    ))}
                                                </div>
                                            </div>}
                                            {modeCollapsed ? null : editingModelConfig.isCustomModel ? (
                                                <CustomModelGroupEditor
                                                    label={mode.label}
                                                    group={editingModelConfig.customModelConfig?.[mode.value]}
                                                    isVideo
                                                    onChange={(group) =>
                                                        updateEditingModelConfig({
                                                            customModelConfig: { ...(editingModelConfig.customModelConfig || {}), [mode.value]: group },
                                                        })
                                                    }
                                                />
                                            ) : null}
                                        </div>
                                    );
                                })}
                            </div>
                        </section>

                        <div className="grid gap-5 md:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
                            <section>
                                <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                                    同时并发数 <Info className="size-4 text-[var(--studio-muted)]" />
                                </div>
                                <div className="flex items-center gap-2">
                                    <InputNumber min={1} precision={0} value={editingModelConfig.requestConcurrency} className="w-52" onChange={(value) => updateEditingModelConfig({ requestConcurrency: Math.max(1, Math.floor(Number(value) || 1)) })} />
                                    <span className="text-sm text-[var(--studio-muted)]">个任务</span>
                                </div>
                            </section>
                            <section>
                                <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold">模型能力</div>
                                <div className="flex flex-wrap gap-2">
                                    {MODEL_CAPABILITY_OPTIONS.video.filter((option) => editingModelConfig.capabilities.includes(option.value)).map((option) => (
                                        <span key={option.value} className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-600 dark:text-emerald-400">
                                            <CheckCircle2 className="size-3.5" />
                                            {option.label}
                                        </span>
                                    ))}
                                    {!editingModelConfig.capabilities.length ? <span className="text-xs text-[var(--studio-muted)]">尚未启用视频生成能力</span> : null}
                                </div>
                            </section>
                        </div>

                        <section className="rounded-lg border border-[var(--studio-line)] bg-[var(--studio-surface-soft)] p-4">
                            <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
                                <div className="flex items-center gap-1.5 text-sm font-semibold">
                                    自定义 JSON（可选） <Info className="size-4 text-[var(--studio-muted)]" />
                                </div>
                                <Button size="small" icon={<Braces className="size-3.5" />} onClick={formatEditingCustomBodyParameters}>
                                    格式化
                                </Button>
                            </div>
                            <Input.TextArea value={editingCustomBodyParameters} autoSize={{ minRows: 5, maxRows: 12 }} spellCheck={false} className="font-mono text-xs" onChange={(event) => setEditingCustomBodyParameters(event.target.value)} />
                            <p className="mt-2 text-xs text-[var(--studio-muted)]">仅在 JSON 格式的 POST 请求中合并；同名字段覆盖系统参数。</p>
                        </section>
                    </div>
                ) : editingModelConfig ? (
                    <Form layout="vertical" requiredMark={false}>
                        {editingModelConfig.modelType !== "text" ? (
                            <Form.Item label="自定义模型" extra="启用后按下方各能力配置的请求/响应示例调用任意 API，替换默认渠道调用。">
                                <Switch checked={Boolean(editingModelConfig.isCustomModel)} onChange={(checked) => updateEditingModelConfig({ isCustomModel: checked })} />
                            </Form.Item>
                        ) : null}
                        <Form.Item label="模型别名" htmlFor="model-alias" extra={<><div>设置后，下拉列表与已选模型显示此别名；留空恢复原名。</div><div className="mt-1 break-all">模型 ID：<span className="select-all font-mono">{editingModelConfig.modelName}</span></div></>}>
                            <Input
                                id="model-alias"
                                allowClear
                                maxLength={255}
                                placeholder="输入简短易读的模型名称"
                                value={editingModelConfig.displayName || ""}
                                onChange={(event) => updateEditingModelConfig({ displayName: event.target.value })}
                            />
                        </Form.Item>
                        <Form.Item label="模型标记">
                            <ModelAppearancePreview model={editingModelConfig} onChange={(newModel) => updateEditingModelConfig({ newModel })} />
                        </Form.Item>
                        {editingModelConfig.modelType === "image" ? (
                            <Form.Item label="每张积分">
                                <InputNumber min={0} precision={0} value={editingModelConfig.creditCost} className="w-full" onChange={(value) => updateEditingModelConfig({ creditCost: Math.max(0, Number(value) || 0) })} />
                            </Form.Item>
                        ) : null}
                        {editingModelConfig.modelType === "image" ? (
                            <Form.Item label="同时并发数">
                                <InputNumber min={1} precision={0} value={editingModelConfig.requestConcurrency} className="w-full" onChange={(value) => updateEditingModelConfig({ requestConcurrency: Math.max(1, Math.floor(Number(value) || 1)) })} />
                            </Form.Item>
                        ) : null}
                        {editingModelConfig.modelType === "text" ? <p className="mb-4 text-xs text-[var(--studio-muted)]">文本模型按实际 Token 计费，请在“积分设置”中选择官方价格并设置倍率。</p> : null}
                        <Form.Item label="模型能力">
                            {editingModelConfig.modelType === "image" && editingModelConfig.isCustomModel ? (
                                <div className="space-y-3">
                                    {MODEL_CAPABILITY_OPTIONS.image.map((option) => (
                                        <div key={option.value} className="rounded-md border border-[var(--studio-line)] bg-[var(--studio-panel)] p-3">
                                            <div className="flex items-center justify-between gap-3">
                                                <Checkbox
                                                    checked={editingModelConfig.capabilities.includes(option.value)}
                                                    onChange={(event) =>
                                                        updateEditingModelConfig({
                                                            capabilities: event.target.checked ? uniqueModels([...editingModelConfig.capabilities, option.value]) : editingModelConfig.capabilities.filter((value) => value !== option.value),
                                                        })
                                                    }
                                                >
                                                    {option.label}
                                                </Checkbox>
                                                <Button
                                                    type="text"
                                                    size="small"
                                                    aria-label={`${option.label}${collapsedEditingCapabilities.includes(`image:${option.value}`) ? "展开" : "收起"}`}
                                                    aria-expanded={!collapsedEditingCapabilities.includes(`image:${option.value}`)}
                                                    title={`${collapsedEditingCapabilities.includes(`image:${option.value}`) ? "展开" : "收起"}${option.label}配置`}
                                                    icon={collapsedEditingCapabilities.includes(`image:${option.value}`) ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
                                                    onClick={() => toggleEditingCapabilityCollapsed(`image:${option.value}`)}
                                                />
                                            </div>
                                            {editingModelConfig.capabilities.includes(option.value) && !collapsedEditingCapabilities.includes(`image:${option.value}`) ? (
                                                <CustomModelGroupEditor
                                                    label={option.label}
                                                    group={editingModelConfig.customModelConfig?.[option.value]}
                                                    isVideo={false}
                                                    onChange={(group) =>
                                                        updateEditingModelConfig({
                                                            customModelConfig: { ...(editingModelConfig.customModelConfig || {}), [option.value]: group },
                                                        })
                                                    }
                                                />
                                            ) : null}
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="flex flex-wrap gap-x-4 gap-y-2">
                                    {MODEL_CAPABILITY_OPTIONS[editingModelConfig.modelType].map((option) => (
                                        <Checkbox
                                            key={option.value}
                                            checked={editingModelConfig.capabilities.includes(option.value)}
                                            onChange={(event) =>
                                                updateEditingModelConfig({
                                                    capabilities: event.target.checked ? uniqueModels([...editingModelConfig.capabilities, option.value]) : editingModelConfig.capabilities.filter((value) => value !== option.value),
                                                })
                                            }
                                        >
                                            {option.label}
                                        </Checkbox>
                                    ))}
                                </div>
                            )}
                        </Form.Item>
                        {editingModelConfig.modelType === "text" && isOpenAiTextModel(editingModelConfig, config.channels) ? (
                            <>
                                <Form.Item label="开启思考模式">
                                    <Switch checked={editingModelConfig.thinkingEnabled} onChange={(thinkingEnabled) => updateEditingModelConfig({ thinkingEnabled })} />
                                </Form.Item>
                                <Form.Item label="思考强度">
                                    <Select
                                        value={editingModelConfig.reasoningEffort}
                                        disabled={isReasoningEffortDisabled(false, editingModelConfig.thinkingEnabled)}
                                        options={reasoningEffortOptions}
                                        onChange={(reasoningEffort: "high" | "max") => updateEditingModelConfig({ reasoningEffort })}
                                    />
                                </Form.Item>
                            </>
                        ) : null}
                        <Form.Item label="自定义 JSON" extra="仅在 JSON 格式的 POST 请求中合并；同名字段覆盖系统参数。">
                            <Input.TextArea value={editingCustomBodyParameters} autoSize={{ minRows: 5, maxRows: 12 }} spellCheck={false} onChange={(event) => setEditingCustomBodyParameters(event.target.value)} />
                        </Form.Item>
                    </Form>
                ) : null}
            </Modal>
        </Modal>
    );
}

function cloneModelConfigs(configs: ServerModelConfig[]) {
    return configs.map(cloneModelConfig);
}

function cloneModelConfig(config: ServerModelConfig): ServerModelConfig {
    return {
        ...config,
        capabilities: [...config.capabilities],
        customBodyParameters: { ...(config.customBodyParameters || {}) },
        customModelConfig: cloneCustomModelConfig(config.customModelConfig),
        videoBillingConfiguration: config.modelType === "video" ? cloneVideoBillingConfiguration(config.videoBillingConfiguration || createVideoBillingConfiguration()) : null,
    };
}

function cloneCustomModelConfig(config: ServerModelConfig["customModelConfig"] | null | undefined): ServerModelConfig["customModelConfig"] {
    return Object.fromEntries(Object.entries(config || {}).map(([key, group]) => [key, { ...group }]));
}

function normalizeModelConfigForSave(config: ServerModelConfig): ServerModelConfig {
    const supportedCapabilities = new Set(MODEL_CAPABILITY_OPTIONS[config.modelType].map((option) => option.value));
    const capabilities = config.capabilities.filter((capability) => supportedCapabilities.has(capability));
    const videoBillingConfiguration = config.modelType === "video" && config.videoBillingConfiguration
        ? {
              ...config.videoBillingConfiguration,
              modePrices: Object.fromEntries(
                  Object.entries(config.videoBillingConfiguration.modePrices || {}).filter(([mode]) => mode !== "audio-input" && supportedCapabilities.has(mode) && capabilities.includes(mode)),
              ) as VideoBillingConfiguration["modePrices"],
          }
        : config.videoBillingConfiguration;
    // 自定义模型配置只保留已勾选能力的键，避免残留未启用能力的模板。
    const customModelConfig = config.isCustomModel
        ? Object.fromEntries(Object.entries(config.customModelConfig || {}).filter(([mode]) => mode !== "audio-input" && supportedCapabilities.has(mode) && capabilities.includes(mode)))
        : {};
    return {
        ...config,
        capabilities,
        videoBillingConfiguration,
        isCustomModel: config.isCustomModel && config.modelType !== "text",
        customModelConfig,
    };
}

function cloneObjectStorages(storages: ObjectStorageConfig[]) {
    return storages.map((storage) => ({ ...storage }));
}

function createDraftModelConfig(channelId: string, modelName: string, modelType: ModelCapability): ServerModelConfig {
    return {
        id: `draft-${nanoid()}`,
        channelId,
        modelName,
        modelType,
        capabilities: [],
        defaultModel: false,
        sortOrder: 0,
        creditCost: 0,
        creditUnit: "generation",
        thinkingEnabled: true,
        reasoningEffort: "high",
        requestConcurrency: 1,
        customBodyParameters: {},
        videoBillingConfiguration: modelType === "video" ? createVideoBillingConfiguration() : null,
        displayName: null,
        modelIcon: null,
        newModel: true,
        isCustomModel: false,
        customModelConfig: {},
    };
}

function ModelAppearancePreview({ model, onChange }: { model: ServerModelConfig; onChange: (value: boolean) => void }) {
    return (
        <div className="mt-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
                <div><div className="text-xs font-medium">显示 NEW 标记</div><p className="mt-1 text-[11px] text-[var(--studio-muted)]">新增模型默认开启，可随时关闭。</p></div>
                <Switch aria-label="显示 NEW 标记" size="small" checked={Boolean(model.newModel)} onChange={onChange} />
            </div>
            <div className="flex min-w-0 items-center gap-2 rounded-lg border border-[var(--studio-line)] bg-[var(--studio-panel)] px-3 py-2.5" aria-label="模型展示预览">
                <span className="mr-1 shrink-0 text-[10px] text-[var(--studio-muted)]">预览</span>
                <span className="min-w-0 truncate text-xs">{model.displayName || model.modelName}</span>
                {model.newModel ? <ModelNewBadge /> : null}
            </div>
        </div>
    );
}

function sameValue(first: unknown, second: unknown) {
    return JSON.stringify(first) === JSON.stringify(second);
}

function sameModelConfigForUpdate(first: ServerModelConfig, second: ServerModelConfig) {
    return (
        first.modelType === second.modelType &&
        first.sortOrder === second.sortOrder &&
        first.creditCost === second.creditCost &&
        first.creditUnit === second.creditUnit &&
        first.requestConcurrency === second.requestConcurrency &&
        first.thinkingEnabled === second.thinkingEnabled &&
        first.reasoningEffort === second.reasoningEffort &&
        (first.displayName || null) === (second.displayName || null) &&
        (first.modelIcon || null) === (second.modelIcon || null) &&
        Boolean(first.newModel) === Boolean(second.newModel) &&
        first.isCustomModel === second.isCustomModel &&
        sameValue(first.capabilities, second.capabilities) &&
        sameValue(first.customBodyParameters, second.customBodyParameters) &&
        sameValue(first.customModelConfig, second.customModelConfig) &&
        sameValue(first.videoBillingConfiguration, second.videoBillingConfiguration)
    );
}

function cloneVideoBillingConfiguration(configuration: VideoBillingConfiguration): VideoBillingConfiguration {
    return {
        ...configuration,
        modePrices: Object.fromEntries(Object.entries(configuration.modePrices || {}).map(([mode, prices]) => [mode, { ...prices }])) as VideoBillingConfiguration["modePrices"],
    };
}

function updateVideoResolutionPrice(configuration: VideoBillingConfiguration, mode: VideoGenerationMode, resolution: VideoResolution, value: number | null) {
    const modePrices = { ...(configuration.modePrices || {}) };
    const prices = { ...(modePrices[mode] || {}) };
    if (value === null) delete prices[resolution];
    else prices[resolution] = Math.max(0, Math.floor(Number(value) || 0));
    modePrices[mode] = prices;
    return { ...configuration, modePrices };
}

function clearVideoModePrices(configuration: VideoBillingConfiguration, mode: VideoGenerationMode): VideoBillingConfiguration {
    return {
        ...configuration,
        modePrices: { ...configuration.modePrices, [mode]: {} },
    };
}

function modelConfigValue(config: Pick<ServerModelConfig, "channelId" | "modelName">) {
    return `${config.channelId}::${config.modelName}`;
}

function uniqueModels(models: string[]) {
    return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)));
}

/** 空的自定义模型分组配置。 */
function emptyCustomModelGroup(): CustomModelGroupConfig {
    return {
        requestPath: "",
        requestMethod: "POST",
        requestModelName: "",
        requestTemplate: "",
        aiRequestPrompt: "",
        responseExample: "",
        resultPath: "",
        queryPath: "",
        queryMethod: "POST",
        queryRequestTemplate: "",
        aiQueryPrompt: "",
        queryResponseExample: "",
        queryResultPath: "",
    };
}

const customRequestMethodOptions = [
    { value: "POST", label: "POST" },
    { value: "GET", label: "GET" },
];

/** 自定义模型请求模板可插入的系统占位符。 */
const customTemplatePlaceholderOptions = [
    { label: "{{prompt}}", value: "{{prompt}}" },
    { label: "{{model}}", value: "{{model}}" },
    { label: "{{references}}", value: "{{references}}" },
    { label: "{{videoReferences}}", value: "{{videoReferences}}" },
    { label: "{{audioReferences}}", value: "{{audioReferences}}" },
    { label: "{{size}}", value: "{{size}}" },
    { label: "{{resolution}}", value: "{{resolution}}" },
    { label: "{{seconds}}", value: "{{seconds}}" },
    { label: "{{count}}", value: "{{count}}" },
    { label: "{{taskId}}", value: "{{taskId}}" },
];

/** 自定义模型单个能力/模式分组的调用配置编辑器。 */
function CustomModelGroupEditor({
    label,
    group,
    isVideo,
    onChange,
}: {
    label: string;
    group: CustomModelGroupConfig | undefined;
    isVideo: boolean;
    onChange: (group: CustomModelGroupConfig) => void;
}) {
    const requestTemplateRef = useRef<TextAreaRef | null>(null);
    const queryRequestTemplateRef = useRef<TextAreaRef | null>(null);
    const current = { ...emptyCustomModelGroup(), ...(group || {}) };
    const update = (patch: Partial<CustomModelGroupConfig>) => onChange({ ...current, ...patch });
    const requestIsPost = current.requestMethod !== "GET";
    const queryIsPost = current.queryMethod !== "GET";
    const insertPlaceholder = (placeholder: string, ref: React.RefObject<TextAreaRef | null>, field: "requestTemplate" | "queryRequestTemplate") => {
        const textArea = ref.current?.resizableTextArea?.textArea;
        const latest = textArea?.value ?? current[field];
        const start = textArea?.selectionStart ?? latest.length;
        const end = textArea?.selectionEnd ?? latest.length;
        const next = latest.slice(0, start) + placeholder + latest.slice(end);
        update({ [field]: next } as Partial<CustomModelGroupConfig>);
        requestAnimationFrame(() => {
            textArea?.setSelectionRange(start + placeholder.length, start + placeholder.length);
            textArea?.focus();
        });
    };
    return (
        <div className="mt-3 space-y-3 rounded-md border border-[var(--studio-line)] bg-[var(--studio-panel)] p-3">
            <div className="text-xs font-semibold text-[var(--studio-muted)]">自定义调用配置（{label}）</div>
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_112px]">
                <div>
                    <div className="mb-1 text-xs text-[var(--studio-muted)]">请求路径</div>
                    <Input value={current.requestPath} placeholder="/api/v1/... 必填，与 Base URL 拼接" onChange={(event) => update({ requestPath: event.target.value })} />
                </div>
                <div>
                    <div className="mb-1 text-xs text-[var(--studio-muted)]">请求方法</div>
                    <Select value={current.requestMethod} options={customRequestMethodOptions} className="w-full" onChange={(value: "GET" | "POST") => update({ requestMethod: value })} />
                </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
                <div>
                    <div className="mb-1 text-xs text-[var(--studio-muted)]">请求模型名称</div>
                    <Input value={current.requestModelName} placeholder="填入请求体{{model}}占位符使用的模型名" onChange={(event) => update({ requestModelName: event.target.value })} />
                </div>
                <div>
                    <div className="mb-1 text-xs text-[var(--studio-muted)]">结果路径</div>
                    <Input value={current.resultPath} placeholder="如 data.image.url" onChange={(event) => update({ resultPath: event.target.value })} />
                </div>
            </div>
            {requestIsPost ? (
                <div className="space-y-2">
                    <div className="rounded-md border border-[var(--studio-line)] bg-[var(--studio-surface-soft)] p-2.5">
                        <div className="mb-1 text-xs text-[var(--studio-muted)]">AI 构造提示词（可选，配置后由 AI 生成请求体）</div>
                        <Input.TextArea
                            value={current.aiRequestPrompt}
                            autoSize={{ minRows: 2, maxRows: 5 }}
                            placeholder="如：根据提示词、分辨率和时长构造 comfyui workflow 请求体，包含 prompt、duration、resolution 字段"
                            onChange={(event) => update({ aiRequestPrompt: event.target.value })}
                        />
                        <p className="mt-1 text-xs text-[var(--studio-muted)]">填写后每次请求由 AI 按提示词和本次实际参数生成请求体（替代模板拼接）；留空则使用下方模板。</p>
                    </div>
                    <div>
                        <div className="mb-1 text-xs text-[var(--studio-muted)]">请求示例（JSON 模板，未填 AI 构造提示词时必填）</div>
                        <div className="mb-1 flex flex-wrap items-center gap-1">
                            <span className="text-xs text-[var(--studio-muted)]">插入占位符：</span>
                            {customTemplatePlaceholderOptions.map((option) => (
                                <Button key={option.value} size="small" className="!px-1.5 font-mono text-[11px]" onClick={() => insertPlaceholder(option.value, requestTemplateRef, "requestTemplate")}>
                                    {option.label}
                                </Button>
                            ))}
                        </div>
                        <p className="mb-1 text-xs text-[var(--studio-muted)]">请用占位符引用实际参数（如{"{{prompt}}"}），未引用占位符的字段将原样发送，可能导致接口报错。</p>
                        <Input.TextArea
                            ref={requestTemplateRef}
                            value={current.requestTemplate}
                            autoSize={{ minRows: 3, maxRows: 8 }}
                            spellCheck={false}
                            className="font-mono text-xs"
                            placeholder='{"model":"{{model}}","prompt":"{{prompt}}","image":{{references}}}'
                            onChange={(event) => update({ requestTemplate: event.target.value })}
                        />
                    </div>
                </div>
            ) : null}
            <div>
                <div className="mb-1 text-xs text-[var(--studio-muted)]">响应示例（JSON，展示接口返回结构）</div>
                <Input.TextArea
                    value={current.responseExample}
                    autoSize={{ minRows: 2, maxRows: 6 }}
                    spellCheck={false}
                    className="font-mono text-xs"
                    placeholder='{"data":{"image":{"url":"https://..."}}}'
                    onChange={(event) => update({ responseExample: event.target.value })}
                />
            </div>
            {isVideo ? (
                <>
                    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_112px]">
                        <div>
                            <div className="mb-1 text-xs text-[var(--studio-muted)]">查询路径（异步轮询，支持{"{{taskId}}"}占位符）</div>
                            <Input value={current.queryPath} placeholder="/api/v1/.../result/{{taskId}}" onChange={(event) => update({ queryPath: event.target.value })} />
                        </div>
                        <div>
                            <div className="mb-1 text-xs text-[var(--studio-muted)]">查询方法</div>
                            <Select value={current.queryMethod} options={customRequestMethodOptions} className="w-full" onChange={(value: "GET" | "POST") => update({ queryMethod: value })} />
                        </div>
                    </div>
                    {queryIsPost ? (
                        <div className="space-y-2">
                            <div className="rounded-md border border-[var(--studio-line)] bg-[var(--studio-surface-soft)] p-2.5">
                                <div className="mb-1 text-xs text-[var(--studio-muted)]">AI 构造提示词（可选，配置后由 AI 生成查询请求体）</div>
                                <Input.TextArea
                                    value={current.aiQueryPrompt}
                                    autoSize={{ minRows: 2, maxRows: 4 }}
                                    placeholder="如：根据任务 ID 构造查询请求体，包含 task_id 字段"
                                    onChange={(event) => update({ aiQueryPrompt: event.target.value })}
                                />
                                <p className="mt-1 text-xs text-[var(--studio-muted)]">填写后由 AI 按提示词和本次任务 ID 生成查询请求体；留空则使用下方模板。</p>
                            </div>
                            <div>
                                <div className="mb-1 text-xs text-[var(--studio-muted)]">查询请求示例（JSON 模板，未填 AI 构造提示词时必填）</div>
                                <div className="mb-1 flex flex-wrap items-center gap-1">
                                    <span className="text-xs text-[var(--studio-muted)]">插入占位符：</span>
                                    {customTemplatePlaceholderOptions.map((option) => (
                                        <Button key={option.value} size="small" className="!px-1.5 font-mono text-[11px]" onClick={() => insertPlaceholder(option.value, queryRequestTemplateRef, "queryRequestTemplate")}>
                                            {option.label}
                                        </Button>
                                    ))}
                                </div>
                                <p className="mb-1 text-xs text-[var(--studio-muted)]">用{"{{taskId}}"}引用轮询任务 ID，未引用占位符的字段将原样发送。</p>
                                <Input.TextArea
                                    ref={queryRequestTemplateRef}
                                    value={current.queryRequestTemplate}
                                    autoSize={{ minRows: 2, maxRows: 6 }}
                                    spellCheck={false}
                                    className="font-mono text-xs"
                                    placeholder='{"task_id":"{{taskId}}"}'
                                    onChange={(event) => update({ queryRequestTemplate: event.target.value })}
                                />
                            </div>
                        </div>
                    ) : null}
                    <div>
                        <div className="mb-1 text-xs text-[var(--studio-muted)]">查询响应示例（JSON）</div>
                        <Input.TextArea
                            value={current.queryResponseExample}
                            autoSize={{ minRows: 2, maxRows: 6 }}
                            spellCheck={false}
                            className="font-mono text-xs"
                            onChange={(event) => update({ queryResponseExample: event.target.value })}
                        />
                    </div>
                    <div>
                        <div className="mb-1 text-xs text-[var(--studio-muted)]">查询结果路径（配置查询路径后必填）</div>
                        <Input value={current.queryResultPath} placeholder="如 data.video.url" onChange={(event) => update({ queryResultPath: event.target.value })} />
                    </div>
                </>
            ) : null}
        </div>
    );
}

function formatTimestamp(value: string) {
    return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function isDefaultObjectStoragePlaceholder(storage: ObjectStorageConfig | undefined) {
    return storage?.id === "default" && storage.name === "默认对象存储" && storage.directory === "inspire-studio" && !storage.accessKey && !storage.secretKey && !storage.bucket && !storage.region && !storage.endpoint && !storage.publicBaseUrl;
}
