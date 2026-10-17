"use client";

import NextImage from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
    App,
    Button,
    Card,
    Checkbox,
    Empty,
    Input,
    Modal,
    Popconfirm,
    Segmented,
    Select,
    Space,
    Spin,
    Switch,
    Table,
    Tabs,
    Tooltip,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { CheckCircle2,
    CircleAlert,
    Clock3,
    ImageIcon,
    KeyRound,
    Plus,
    QrCode,
    RadioTower,
    RefreshCw,
    Send,
    Settings2,
    Trash2,
    Video, Newspaper, Pencil, UsersRound, History, Hash, Type, FileText, FolderOpen, Eye, Globe, Music2, BookOpen } from "lucide-react";

import { useAssetStore, type Asset } from "@/features/assets/stores/use-asset-store";
import { ListPagination } from "@/shared/components/list-pagination";
import { IconLabel } from "@/shared/components/icon-label";
import { PageShell } from "@/shared/components/page-shell";
import { usePublishTaskHistory } from "@/features/publishing/use-publish-task-history";
import { isPublishing } from "@/features/publishing/task-status-sync";
import {
    cancelPublishQrLogin,
    checkPublishAccount,
    createPublishTask,
    deletePublishAccount,
    getPublishQrLoginStatus,
    sendPublishQrAction,
    listPublishAccounts,
    savePublishAccount,
    startPublishQrLogin,
    type CreatePublishTaskInput,
    type PublishAccount,
    type PublishMediaType,
    type PublishMode,
    type PublishQrLogin,
    type PublishingPlatform,
    type PublishTask,
    type PublishTaskStatus,
} from "@/services/api/server";

const PLATFORM_META: Record<PublishingPlatform, { label: string; short: string; accent: string }> = {
    douyin: { label: "抖音", short: "抖", accent: "#171717" },
    xiaohongshu: { label: "小红书", short: "红", accent: "#ef3340" },
    wechat_channels: { label: "微信视频号", short: "视", accent: "#07c160" },
    toutiao: { label: "今日头条", short: "头", accent: "#f04142" },
};

const STATUS_META: Record<PublishTaskStatus, { label: string; color: string }> = {
    queued: { label: "等待发布", color: "var(--studio-muted)" },
    running: { label: "发布中", color: "var(--studio-primary)" },
    success: { label: "已完成", color: "var(--studio-success)" },
    failed: { label: "发布失败", color: "var(--studio-danger)" },
};

type AccountDraft = { id?: number; platform: PublishingPlatform; displayName: string; enabled: boolean };

const EMPTY_ACCOUNT: AccountDraft = { platform: "douyin", displayName: "", enabled: true };

export default function PublishPage() {
    const { message } = App.useApp();
    const assets = useAssetStore((state) => state.assets);
    const hydrateAssets = useAssetStore((state) => state.hydrateAssets);
    const [activeTab, setActiveTab] = useState("compose");
    const [accounts, setAccounts] = useState<PublishAccount[]>([]);
    const [accountsLoading, setAccountsLoading] = useState(true);
    const taskHistory = usePublishTaskHistory(activeTab === "history");
    const { tasks, loading: tasksLoading } = taskHistory;
    const activeTaskCount = tasks.filter(isPublishing).length;
    const [accountModalOpen, setAccountModalOpen] = useState(false);
    const [accountDraft, setAccountDraft] = useState<AccountDraft>(EMPTY_ACCOUNT);
    const [savingAccount, setSavingAccount] = useState(false);
    const [qrLogin, setQrLogin] = useState<PublishQrLogin | null>(null);
    const [qrStarting, setQrStarting] = useState(false);
    const qrLoginGenerationRef = useRef(0);
    const [checkingAccountId, setCheckingAccountId] = useState<number | null>(null);
    const [platform, setPlatform] = useState<PublishingPlatform>("douyin");
    const [accountId, setAccountId] = useState<number>();
    const [mediaType, setMediaType] = useState<PublishMediaType>("video");
    const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
    const [coverAssetId, setCoverAssetId] = useState<string>();
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [topics, setTopics] = useState<string[]>([]);
    const [publishMode, setPublishMode] = useState<Exclude<PublishMode, "dry_run">>("publish");
    const [visibility, setVisibility] = useState<CreatePublishTaskInput["visibility"]>("public");
    const [allowDownload, setAllowDownload] = useState(false);
    const [transcode, setTranscode] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    const loadAccounts = useCallback(async () => {
        setAccountsLoading(true);
        try {
            const result = await listPublishAccounts();
            setAccounts(result);
        } catch (error) {
            message.error(readError(error));
        } finally {
            setAccountsLoading(false);
        }
    }, [message]);

    useEffect(() => {
        void hydrateAssets();
        void loadAccounts();
    }, [hydrateAssets, loadAccounts]);

    useEffect(() => {
        const resume = new URLSearchParams(window.location.search).get("resumeLogin");
        if (!resume) return;
        let disposed = false;
        void getPublishQrLoginStatus(resume).then((result) => {
            if (disposed) return;
            setAccountDraft({ ...EMPTY_ACCOUNT, platform: result.platform, displayName: PLATFORM_META[result.platform].label });
            setQrLogin(result);
            setAccountModalOpen(true);
        }).catch((error) => { if (!disposed) message.error(readError(error)); });
        return () => { disposed = true; };
    }, [message]);

    useEffect(() => {
        const sessionId = qrLogin?.sessionId;
        if (!sessionId || !["waiting", "scanned", "verification"].includes(qrLogin.status)) return;
        const generation = qrLoginGenerationRef.current;
        let disposed = false;
        let polling = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let refreshPending = false;
        const poll = async () => {
            if (disposed) return;
            if (polling) { refreshPending = true; return; }
            if (timer) clearTimeout(timer);
            polling = true;
            try {
                const result = await getPublishQrLoginStatus(sessionId);
                if (disposed || generation !== qrLoginGenerationRef.current) return;
                setQrLogin(result);
                if (result.status === "confirmed") {
                    message.success("扫码登录成功，账号已保存");
                    setPlatform(result.platform);
                    if (result.account) setAccountId(result.account.id);
                    setAccountModalOpen(false);
                    setQrLogin(null);
                    await loadAccounts();
                }
            } catch (error) {
                if (!disposed && generation === qrLoginGenerationRef.current) {
                    const errorMessage = readError(error);
                    setQrLogin((current) => current?.sessionId === sessionId
                        ? isGenericSuccessMessage(errorMessage)
                            ? { ...current, status: "waiting", message: "正在同步扫码状态" }
                            : { ...current, status: "failed", message: errorMessage }
                        : current);
                }
            } finally {
                polling = false;
                if (!disposed) {
                    timer = setTimeout(() => void poll(), refreshPending ? 0 : qrLogin.status === "verification" ? 250 : 1500);
                    refreshPending = false;
                }
            }
        };
        const onInteraction = () => { void poll(); };
        window.addEventListener("publishing-verification-input", onInteraction);
        void poll();
        return () => {
            disposed = true;
            if (timer) clearTimeout(timer);
            window.removeEventListener("publishing-verification-input", onInteraction);
        };
    }, [loadAccounts, message, qrLogin?.sessionId, qrLogin?.status]);

    const selectedPlatformAccounts = useMemo(() => accounts.filter((account) => account.platform === platform), [accounts, platform]);
    const platformAccounts = useMemo(() => selectedPlatformAccounts.filter((account) => account.enabled), [selectedPlatformAccounts]);
    useEffect(() => {
        if (!platformAccounts.some((account) => account.id === accountId)) setAccountId(platformAccounts[0]?.id);
    }, [accountId, platformAccounts]);

    useEffect(() => {
        setSelectedAssetIds([]);
        setCoverAssetId(undefined);
    }, [mediaType]);

    useEffect(() => {
        if (!["wechat_channels", "toutiao"].includes(platform) && publishMode === "draft") setPublishMode("publish");
        if (["wechat_channels", "toutiao"].includes(platform) && visibility !== "public") setVisibility("public");
    }, [platform, publishMode, visibility]);

    const publishableAssets = useMemo(
        () => assets.filter((asset) => !asset.metadata?.deletedAt && asset.kind === (mediaType === "video" ? "video" : "image")),
        [assets, mediaType],
    );
    const imageAssets = useMemo(() => assets.filter((asset) => asset.kind === "image" && !asset.metadata?.deletedAt), [assets]);

    const mediaOptions = publishableAssets.map((asset) => {
        const url = assetUrl(asset);
        return { value: asset.id, label: asset.title, disabled: !isRemoteUrl(url), title: isRemoteUrl(url) ? undefined : "请先等待素材上传到对象存储" };
    });
    const coverOptions = imageAssets.map((asset) => {
        const url = assetUrl(asset);
        return { value: asset.id, label: asset.title, disabled: !isRemoteUrl(url) };
    });

    const openCreateAccount = (preferredPlatform: PublishingPlatform = platform) => {
        setAccountDraft({ ...EMPTY_ACCOUNT, platform: preferredPlatform });
        setQrLogin(null);
        setAccountModalOpen(true);
    };

    const openEditAccount = (account: PublishAccount) => {
        setAccountDraft({ id: account.id, platform: account.platform, displayName: account.displayName, enabled: account.enabled });
        setQrLogin(null);
        setAccountModalOpen(true);
    };

    const submitAccount = async () => {
        if (!accountDraft.displayName.trim()) return void message.warning("请填写账号名称");
        if (!accountDraft.id) return void message.warning("新账号请使用扫码登录");
        setSavingAccount(true);
        try {
            await savePublishAccount({ ...accountDraft, displayName: accountDraft.displayName.trim() });
            message.success("账号配置已更新");
            setAccountModalOpen(false);
            await loadAccounts();
        } catch (error) {
            message.error(readError(error));
        } finally {
            setSavingAccount(false);
        }
    };

    const startAccountQrLogin = async () => {
        if (!accountDraft.displayName.trim()) return void message.warning("请填写账号名称");
        qrLoginGenerationRef.current += 1;
        if (qrLogin?.sessionId) await cancelPublishQrLogin(qrLogin.sessionId).catch(() => undefined);
        setQrStarting(true);
        try {
            const result = await startPublishQrLogin({
                platform: accountDraft.platform,
                accountId: accountDraft.id,
                displayName: accountDraft.displayName.trim(),
                enabled: accountDraft.enabled,
            });
            setQrLogin(result);
        } catch (error) {
            message.error(readError(error));
        } finally {
            setQrStarting(false);
        }
    };

    const closeAccountModal = () => {
        qrLoginGenerationRef.current += 1;
        const sessionId = qrLogin?.sessionId;
        if (sessionId && !["confirmed", "failed", "expired", "cancelled"].includes(qrLogin.status)) {
            void cancelPublishQrLogin(sessionId).catch(() => undefined);
        }
        setQrLogin(null);
        setAccountModalOpen(false);
    };

    const checkAccount = async (id: number) => {
        setCheckingAccountId(id);
        try {
            const account = await checkPublishAccount(id);
            if (account.lastCheckStatus === "valid") message.success("登录态检查通过");
            else message.warning(publishErrorMessage(account.lastCheckMessage || "登录检查未完成，请重试"));
        } catch (error) {
            message.error(readError(error));
        } finally {
            setCheckingAccountId(null);
            await loadAccounts();
        }
    };

    const removeAccount = async (id: number) => {
        try {
            await deletePublishAccount(id);
            message.success("账号已删除");
            await loadAccounts();
        } catch (error) {
            message.error(readError(error));
        }
    };

    const submitTask = async () => {
        if (!accountId) return void message.warning("请先添加并选择发布账号");
        if (!selectedAssetIds.length) return void message.warning("请选择要发布的素材");
        if (mediaType === "video" && selectedAssetIds.length > 1) return void message.warning("视频发布一次只能选择一个视频");
        if (platform === "toutiao") {
            const titleLength = Array.from(title.trim()).length;
            if (titleLength < 5 || titleLength > 30) return void message.warning("头条标题需填写5至30个字");
            if (topics.length > 5) return void message.warning("头条最多支持5个话题");
            if (mediaType === "video" && Array.from(description.trim()).length > 200) return void message.warning("头条视频简介最多200字");
        }
        if (platform === "xiaohongshu" && !title.trim()) return void message.warning("小红书发布需要标题");
        if (platform === "wechat_channels" && mediaType === "video" && !coverAssetId) return void message.warning("视频号视频需要封面");
        const selectedAssets = selectedAssetIds.map((id) => assets.find((asset) => asset.id === id)).filter(Boolean) as Asset[];
        const mediaUrls = selectedAssets.map(assetUrl);
        if (mediaUrls.some((url) => !isRemoteUrl(url))) return void message.warning("素材还未上传到对象存储，请稍后再试");
        const coverUrl = platform !== "toutiao" && coverAssetId ? assetUrl(imageAssets.find((asset) => asset.id === coverAssetId)) : undefined;
        setSubmitting(true);
        try {
            const submittedTask = await createPublishTask({ accountId, mediaType, title: title.trim(), description: description.trim(), mediaUrls, coverUrl, topics, publishMode, visibility, allowDownload, transcode });
            taskHistory.addSubmittedTask(submittedTask);
            message.success(publishMode === "publish" ? "发布任务已提交" : "草稿任务已提交");
            setSelectedAssetIds([]);
            setCoverAssetId(undefined);
            setTitle("");
            setDescription("");
            setTopics([]);
            setActiveTab("history");
        } catch (error) {
            message.error(readError(error));
        } finally {
            setSubmitting(false);
        }
    };

    const columns: ColumnsType<PublishTask> = [
        {
            title: "发布内容",
            key: "content",
            width: "32%",
            render: (_, task) => <PublishTaskSummary task={task} />,
        },
        {
            title: "发布平台",
            dataIndex: "platform",
            width: "15%",
            render: (value: PublishingPlatform) => <HistoryPlatform platform={value} />,
        },
        {
            title: "状态",
            dataIndex: "status",
            width: "13%",
            render: (value: PublishTaskStatus) => <PublishStatusBadge status={value} />,
        },
        {
            title: "提交时间",
            dataIndex: "createdAt",
            width: "16%",
            render: (value: string) => <span className="text-xs tabular-nums text-[var(--studio-muted)]">{formatTime(value)}</span>,
        },
        {
            title: "结果",
            key: "result",
            width: "24%",
            render: (_, task) => <PublishTaskResult task={task} />,
        },
    ];

    const qrLoginEnded = Boolean(qrLogin && ["failed", "expired", "cancelled"].includes(qrLogin.status));
    const qrNeedsVerification = qrLogin?.status === "verification";
    const qrLoginMessage = qrLogin ? readableQrLoginMessage(qrLogin.status, qrLogin.message) : "";

    return (
        <PageShell icon={<Send />}
            eyebrow="多平台分发"
            title="内容发布"
            description="统一管理抖音、小红书、微信视频号和今日头条账号，将资产库中的成片与图片直接分发到各平台。"
            width="wide"
            bodyScroll={false}
            actions={<Button icon={<Settings2 className="size-4" />} onClick={() => setActiveTab("accounts")}>账号配置</Button>}
        >
            <section className="studio-tab-workspace overflow-hidden rounded-[22px] border border-[var(--studio-line)] bg-[var(--studio-surface)] shadow-[0_16px_50px_rgba(15,23,42,0.05)]">
                <Tabs
                    activeKey={activeTab}
                    onChange={setActiveTab}
                    className="studio-page-tabs publishing-tabs [&_.ant-tabs-nav]:!mb-0 [&_.ant-tabs-nav]:!px-5 [&_.ant-tabs-body-holder]:border-t [&_.ant-tabs-body-holder]:border-[var(--studio-line)]"
                    items={[
                        { key: "compose", label: <TabLabel icon={<Send className="size-4" />} text="创建发布" />, children: (
                            <div className="grid min-h-[560px] xl:grid-cols-[minmax(0,1fr)_300px] 2xl:grid-cols-[minmax(0,1fr)_340px]">
                                <div className="min-w-0 space-y-5 p-5 sm:p-6">
                                    <Field icon={<Globe />} label="发布平台" hint="选择平台后会自动切换可用账号和发布方式。">
                                        <Segmented
                                            block
                                            value={platform}
                                            onChange={(value) => setPlatform(value as PublishingPlatform)}
                                            options={(Object.keys(PLATFORM_META) as PublishingPlatform[]).map((value) => ({ value, label: <IconLabel icon={value === "douyin" ? <Music2 /> : value === "xiaohongshu" ? <BookOpen /> : value === "toutiao" ? <Newspaper /> : <Video />}>{PLATFORM_META[value].label}</IconLabel> }))}
                                        />
                                    </Field>
                                    <div className="grid gap-5 md:grid-cols-2">
                                        <Field icon={<UsersRound />} label="发布账号">
                                            <Space.Compact className="w-full">
                                                <Select
                                                    className="min-w-0 flex-1"
                                                    value={accountId}
                                                    placeholder="选择已配置账号"
                                                    options={platformAccounts.map((account) => ({ value: account.id, label: account.displayName }))}
                                                    onChange={setAccountId}
                                                    loading={accountsLoading}
                                                    notFoundContent="暂无可用账号"
                                                />
                                                <Button icon={<Plus className="size-4" />} onClick={() => openCreateAccount(platform)}>添加</Button>
                                            </Space.Compact>
                                        </Field>
                                        <Field icon={<FolderOpen />} label="内容类型">
                                            <Segmented
                                                block
                                                value={mediaType}
                                                onChange={(value) => setMediaType(value as PublishMediaType)}
                                                options={[
                                                    { value: "video", label: <span className="inline-flex items-center gap-2"><Video className="size-4" />视频</span> },
                                                    { value: "images", label: <span className="inline-flex items-center gap-2"><ImageIcon className="size-4" />图文</span> },
                                                ]}
                                            />
                                        </Field>
                                    </div>
                                    <Field icon={mediaType === "video" ? <Video /> : <ImageIcon />} label={mediaType === "video" ? "选择视频" : "选择图片"} hint="素材从“我的资产”读取，需已上传至对象存储。">
                                        <Select
                                            className="w-full"
                                            mode={mediaType === "images" ? "multiple" : undefined}
                                            allowClear
                                            showSearch
                                            optionFilterProp="label"
                                            value={mediaType === "images" ? selectedAssetIds : selectedAssetIds[0]}
                                            options={mediaOptions}
                                            placeholder={publishableAssets.length ? "选择资产" : "资产库中暂无对应素材"}
                                            onChange={(value) => setSelectedAssetIds(Array.isArray(value) ? value.slice(0, 20) : value ? [value] : [])}
                                            optionRender={(option) => <span title={String(option.data.title || "")}>{option.data.label}</span>}
                                        />
                                    </Field>
                                    {platform === "wechat_channels" && mediaType === "video" ? (
                                        <Field icon={<ImageIcon />} label="视频封面" hint="视频号视频必须设置封面。">
                                            <Select className="w-full" allowClear showSearch optionFilterProp="label" value={coverAssetId} options={coverOptions} placeholder="从图片资产中选择封面" onChange={setCoverAssetId} />
                                        </Field>
                                    ) : null}
                                    <div className="grid gap-5 md:grid-cols-2">
                                        <Field icon={<Type />} label="标题" hint={platform === "toutiao" ? "必填，5–30字" : platform === "xiaohongshu" ? "小红书必填" : "可选，建议简洁明确"}>
                                            <Input value={title} maxLength={platform === "toutiao" ? 30 : 200} showCount placeholder="输入作品标题" onChange={(event) => setTitle(event.target.value)} />
                                        </Field>
                                        <Field icon={<Hash />} label="话题">
                                            <Select className="w-full" mode="tags" value={topics} maxCount={platform === "toutiao" ? 5 : 20} tokenSeparators={[",", "，", " "]} placeholder="输入话题后回车" onChange={setTopics} />
                                        </Field>
                                    </div>
                                    <Field icon={<FileText />} label={platform === "toutiao" && mediaType === "images" ? "图文正文" : "发布文案"} hint={platform === "toutiao" ? mediaType === "video" ? "简介最多200字，视频封面由头条自动提取。" : "正文与所选图片组成图文文章，首张图片用作封面。" : undefined}>
                                        <Input.TextArea value={description} maxLength={platform === "toutiao" && mediaType === "video" ? 200 : 5000} showCount autoSize={{ minRows: 5, maxRows: 10 }} placeholder="填写正文、卖点或作品说明" onChange={(event) => setDescription(event.target.value)} />
                                    </Field>
                                </div>
                                <aside className="border-t border-[var(--studio-line)] bg-[var(--studio-surface-soft)] p-5 sm:p-7 xl:border-l xl:border-t-0">
                                    <div className="sticky top-0 space-y-6">
                                        <div>
                                            <p className="text-xs font-medium uppercase tracking-[0.16em] text-[var(--studio-faint)]">发布设置</p>
                                            <h2 className="studio-section-heading"><IconLabel icon={<Settings2 />}> 确认投放方式</IconLabel></h2>
                                        </div>
                                        <Field icon={<Send />} label="执行方式">
                                            <Select
                                                className="w-full"
                                                value={publishMode}
                                                onChange={setPublishMode}
                                                options={[
                                                    ...(["wechat_channels", "toutiao"].includes(platform) ? [{ value: "draft", label: "保存草稿" }] : []),
                                                    { value: "publish", label: "正式发布" },
                                                ]}
                                            />
                                        </Field>
                                        <Field icon={<Eye />} label="可见范围">
                                            <Select
                                                className="w-full"
                                                value={visibility}
                                                onChange={setVisibility}
                                                options={[
                                                    { value: "public", label: "公开" },
                                                    ...(!["wechat_channels", "toutiao"].includes(platform) ? [{ value: "private", label: "仅自己可见" }] : []),
                                                    ...(platform === "douyin" ? [{ value: "fans", label: "仅粉丝可见" }] : []),
                                                ]}
                                            />
                                        </Field>
                                        {platform === "douyin" && mediaType === "video" ? <Checkbox checked={allowDownload} onChange={(event) => setAllowDownload(event.target.checked)}>允许他人下载</Checkbox> : null}
                                        {platform === "xiaohongshu" && mediaType === "video" ? <Checkbox checked={transcode} onChange={(event) => setTranscode(event.target.checked)}>上传后强制转码</Checkbox> : null}
                                        <div className="rounded-2xl border border-[var(--studio-line)] bg-[var(--studio-surface)] p-4">
                                            <div className="flex items-center gap-3">
                                                <PlatformIcon platform={platform} />
                                                <div>
                                                    <p className="font-medium text-[var(--studio-ink)]">{PLATFORM_META[platform].label}</p>
                                                    <p className="text-xs text-[var(--studio-muted)]">{selectedAssetIds.length || 0} 个素材 · {modeLabel(publishMode)}</p>
                                                </div>
                                            </div>
                                            <div className="mt-4 h-px bg-[var(--studio-line)]" />
                                            <p className="mt-4 text-xs leading-5 text-[var(--studio-muted)]">
                                                {publishMode === "publish" ? "提交后将使用所选账号向平台发起正式发布。" : "内容上传后保存在所选平台的草稿箱。"}
                                            </p>
                                        </div>
                                        <Button type="primary" size="large" block icon={<RadioTower className="size-4" />} loading={submitting} onClick={() => void submitTask()}>
                                            {publishMode === "publish" ? "提交发布" : "保存草稿"}
                                        </Button>
                                    </div>
                                </aside>
                            </div>
                        ) },
                        { key: "accounts", label: <TabLabel icon={<KeyRound className="size-4" />} text="账号管理" />, children: (
                            <div className="p-5 sm:p-7">
                                <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                                    <div><h2 className="studio-section-heading"><IconLabel icon={<UsersRound />}>{PLATFORM_META[platform].label}账号</IconLabel></h2><p className="mt-1 text-sm text-[var(--studio-muted)]">按平台管理账号，使用对应平台 App 扫码登录。</p></div>
                                    <Button type="primary" icon={<QrCode className="size-4" />} onClick={() => openCreateAccount()}>扫码添加账号</Button>
                                </div>
                                <div className="mb-5 overflow-x-auto">
                                    <Segmented
                                        aria-label="账号平台"
                                        value={platform}
                                        onChange={(value) => setPlatform(value as PublishingPlatform)}
                                        options={(Object.keys(PLATFORM_META) as PublishingPlatform[]).map((value) => ({
                                            value,
                                            label: <span className="inline-flex items-center gap-2"><PlatformBadge platform={value} /><span className="text-xs text-[var(--studio-muted)]">{accounts.filter((account) => account.platform === value).length}</span></span>,
                                        }))}
                                    />
                                </div>
                                <Spin spinning={accountsLoading}>
                                    {selectedPlatformAccounts.length ? (
                                        <div className="studio-card-grid">
                                            {selectedPlatformAccounts.map((account) => (
                                                <Card key={account.id} className="overflow-hidden !rounded-2xl !border-[var(--studio-line)]" styles={{ body: { padding: 20 } }}>
                                                    <div className="flex items-start justify-between gap-3">
                                                        <div className="flex min-w-0 items-center gap-3"><PlatformIcon platform={account.platform} /><div className="min-w-0"><p className="truncate font-semibold text-[var(--studio-ink)]">{account.displayName}</p><p className="text-xs text-[var(--studio-muted)]">{PLATFORM_META[account.platform].label}</p></div></div>
                                                        <Switch size="small" checked={account.enabled} onChange={(enabled) => void savePublishAccount({ id: account.id, platform: account.platform, displayName: account.displayName, enabled }).then(loadAccounts).catch((error) => message.error(readError(error)))} />
                                                    </div>
                                                    <div className="mt-5 flex items-start gap-2 rounded-xl bg-[var(--studio-surface-soft)] px-3 py-2.5 text-xs">
                                                        {account.lastCheckStatus === "valid" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" /> : account.lastCheckStatus === "invalid" ? <CircleAlert className="mt-0.5 size-4 shrink-0 text-red-500" /> : <Clock3 className={`mt-0.5 size-4 shrink-0 ${account.lastCheckStatus === "error" ? "text-amber-500" : "text-[var(--studio-faint)]"}`} />}
                                                        <div className="min-w-0 space-y-1">
                                                            <p className="font-medium text-[var(--studio-ink)]">{account.lastCheckStatus === "valid" ? "登录正常" : account.lastCheckStatus === "invalid" ? "需要重新登录" : account.lastCheckStatus === "error" ? "检查未完成" : "尚未检查"}</p>
                                                            <p className="break-words leading-5 text-[var(--studio-muted)]">{publishErrorMessage(account.lastCheckMessage || "点击检查登录，确认账号是否可用。")}</p>
                                                            {account.lastCheckedAt && <p className="text-[10px] text-[var(--studio-faint)]">最近检查 · {formatTime(account.lastCheckedAt)}</p>}
                                                        </div>
                                                    </div>
                                                    <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                                                        <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={checkingAccountId === account.id} onClick={() => void checkAccount(account.id)}>检查登录</Button>
                                                        <Space size={4}>
                                                            <Button type="text" size="small" icon={<QrCode className="size-3.5" />} onClick={() => openEditAccount(account)}>重新扫码</Button>
                                                            <Button type="text" size="small" icon={<Pencil className="size-3.5" />} onClick={() => openEditAccount(account)}>编辑</Button>
                                                            <Popconfirm title="删除这个发布账号？" description="历史发布记录会保留。" okText="删除" cancelText="取消" onConfirm={() => void removeAccount(account.id)}>
                                                                <Button aria-label={`删除账号 ${account.displayName}`} type="text" danger size="small" icon={<Trash2 className="size-3.5" />} />
                                                            </Popconfirm>
                                                        </Space>
                                                    </div>
                                                </Card>
                                            ))}
                                        </div>
                                    ) : <Empty description={`还没有${PLATFORM_META[platform].label}账号`}><Button type="primary" icon={<QrCode className="size-4" />} onClick={() => openCreateAccount()}>扫码添加{PLATFORM_META[platform].label}账号</Button></Empty>}
                                </Spin>
                            </div>
                        ) },
                        { key: "history", label: <TabLabel icon={<Clock3 className="size-4" />} text="发布记录" />, children: (
                            <div className="p-4 sm:p-6">
                                <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
                                    <div className="flex items-center gap-3">
                                        <span className="grid size-10 place-items-center rounded-xl border border-[var(--studio-line)] bg-[var(--studio-surface-soft)] text-[var(--studio-primary)]"><History className="size-[18px]" /></span>
                                        <div><div className="flex items-center gap-2.5"><h2 className="text-base font-semibold text-[var(--studio-ink)]">发布记录</h2><span className="rounded-md bg-[var(--studio-surface-soft)] px-2 py-0.5 text-xs tabular-nums text-[var(--studio-muted)]">{taskHistory.total}</span></div><p className="mt-1 text-xs text-[var(--studio-muted)]">发布结果自动更新，无需刷新页面</p></div>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        {activeTaskCount > 0 && <span className="inline-flex items-center gap-1.5 text-xs text-[var(--studio-primary)]"><span className="size-1.5 rounded-full bg-current" />本页 {activeTaskCount} 项进行中</span>}
                                        <Button type="text" size="small" icon={<RefreshCw className="size-3.5" />} loading={tasksLoading} onClick={() => void taskHistory.reload()}>同步记录</Button>
                                    </div>
                                </div>
                                {(taskHistory.error || taskHistory.syncError) && <div role="status" className="mb-4 flex items-center gap-2 rounded-lg border border-[var(--studio-line)] bg-[var(--studio-surface-soft)] px-3 py-2 text-xs text-[var(--studio-warning)]"><CircleAlert className="size-4 shrink-0" />{taskHistory.error ? publishErrorMessage(taskHistory.error) : "状态同步暂时中断，正在重试，不影响后台发布。"}</div>}
                                <div className="hidden overflow-hidden rounded-xl border border-[var(--studio-line)] md:block [&_.ant-table-cell]:!px-5 [&_.ant-table-tbody_.ant-table-cell]:!py-4 [&_.ant-table-thead_.ant-table-cell]:!py-3 [&_.ant-table-thead_.ant-table-cell]:!text-xs [&_.ant-table-thead_.ant-table-cell]:!font-medium [&_.ant-table-thead_.ant-table-cell]:!text-[var(--studio-muted)]">
                                    <Table rowKey="id" tableLayout="fixed" columns={columns} dataSource={tasks} loading={tasksLoading} pagination={false} scroll={{ x: 900 }} locale={{ emptyText: <Empty description="暂无发布记录"><Button type="primary" icon={<Plus className="size-4" />} onClick={() => setActiveTab("compose")}>创建发布</Button></Empty> }} />
                                </div>
                                <div className="md:hidden"><Spin spinning={tasksLoading}><div className="space-y-3">
                                    {tasks.map((task) => <article key={task.id} className="space-y-3 rounded-xl border border-[var(--studio-line)] p-4">
                                        <div className="flex items-center justify-between gap-2"><HistoryPlatform platform={task.platform} /><PublishStatusBadge status={task.status} /></div>
                                        <PublishTaskSummary task={task} />
                                        <div className="border-t border-[var(--studio-line)] pt-3"><PublishTaskResult task={task} /><p className="mt-2 text-[11px] tabular-nums text-[var(--studio-faint)]">{formatTime(task.createdAt)}</p></div>
                                    </article>)}
                                    {!tasks.length && !tasksLoading && <Empty description="暂无发布记录" />}
                                </div></Spin></div>
                                <ListPagination current={taskHistory.page} pageSize={taskHistory.pageSize} total={taskHistory.total} label="发布任务" onChange={taskHistory.changePage} />
                            </div>
                        ) },
                    ]}
                />
            </section>

            <Modal
                title={accountDraft.id ? "账号设置与重新登录" : "扫码添加发布账号"}
                open={accountModalOpen}
                onCancel={closeAccountModal}
                destroyOnHidden
                width={qrNeedsVerification ? 1160 : 560}
                style={{ top: 24 }}
                styles={{ body: { maxHeight: "calc(100dvh - 160px)", overflowY: "auto" } }}
                footer={[
                    <Button key="cancel" onClick={closeAccountModal}>取消</Button>,
                    ...(accountDraft.id && !qrLogin ? [<Button key="save" loading={savingAccount} onClick={() => void submitAccount()}>保存信息</Button>] : []),
                    <Button key="qr" type="primary" icon={<QrCode className="size-4" />} loading={qrStarting} onClick={() => void startAccountQrLogin()}>
                        {qrNeedsVerification ? "放弃验证，重新登录" : qrLoginEnded ? "重新生成二维码" : qrLogin ? "刷新二维码" : accountDraft.id ? "重新扫码登录" : "生成登录二维码"}
                    </Button>,
                ]}
            >
                <div className="space-y-5 py-3">
                    {!qrLogin ? <>
                    <Field label="平台">
                        <Select disabled={Boolean(accountDraft.id || qrLogin)} className="w-full" value={accountDraft.platform} options={(Object.keys(PLATFORM_META) as PublishingPlatform[]).map((value) => ({ value, label: <IconLabel icon={value === "douyin" ? <Music2 /> : value === "xiaohongshu" ? <BookOpen /> : value === "toutiao" ? <Newspaper /> : <Video />}>{PLATFORM_META[value].label}</IconLabel> }))} onChange={(value) => setAccountDraft((draft) => ({ ...draft, platform: value }))} />
                    </Field>
                    <Field label="账号名称" hint="用于在发布页面识别账号，不会同步到平台。">
                        <Input disabled={Boolean(qrLogin)} value={accountDraft.displayName} maxLength={80} placeholder="例如：品牌主账号" onChange={(event) => setAccountDraft((draft) => ({ ...draft, displayName: event.target.value }))} />
                    </Field>
                    <div className="flex items-center justify-between rounded-xl bg-[var(--studio-surface-soft)] px-4 py-3"><div><p className="text-sm font-medium text-[var(--studio-ink)]">启用账号</p><p className="text-xs text-[var(--studio-muted)]">停用后不能创建新发布任务</p></div><Switch disabled={Boolean(qrLogin)} checked={accountDraft.enabled} onChange={(enabled) => setAccountDraft((draft) => ({ ...draft, enabled }))} /></div>
                    </> : (
                        <div className="flex items-center justify-between gap-3 rounded-xl bg-[var(--studio-surface-soft)] px-4 py-3">
                            <div className="min-w-0"><p className="text-xs text-[var(--studio-muted)]">发布账号</p><p className="mt-1 truncate text-sm font-medium text-[var(--studio-ink)]">{accountDraft.displayName}</p></div>
                            <span className="shrink-0 text-xs text-[var(--studio-muted)]">{accountDraft.enabled ? "登录后启用" : "登录后停用"}</span>
                        </div>
                    )}
                    {qrLogin ? (
                        <div className="overflow-hidden rounded-2xl border border-[var(--studio-line)] bg-[var(--studio-surface-soft)]">
                            <div className="flex items-center justify-between gap-3 border-b border-[var(--studio-line)] px-4 py-3">
                                <div className="flex items-start gap-2 text-sm font-medium leading-5 text-[var(--studio-ink)]">
                                    <span className={`mt-1.5 size-2 shrink-0 rounded-full ${qrStarting ? "animate-pulse bg-blue-500" : qrLoginEnded || qrNeedsVerification ? "bg-amber-500" : "animate-pulse bg-emerald-500"}`} />
                                    {qrStarting ? "正在生成新的登录二维码" : qrLoginMessage}
                                </div>
                                <span className="rounded-full bg-[var(--studio-surface)] px-2.5 py-1 text-xs text-[var(--studio-muted)]">{PLATFORM_META[accountDraft.platform].label}</span>
                            </div>
                            <div className="flex min-h-[300px] items-center justify-center bg-white p-4">
                                {qrStarting ? (
                                    <Spin tip="正在生成二维码" />
                                ) : qrNeedsVerification ? (
                                    <OfficialVerification session={qrLogin} />
                                ) : qrLogin.qrCodeDataUrl && !qrLoginEnded && !qrNeedsVerification ? (
                                    <div className="w-full space-y-3">
                                        <NextImage unoptimized src={qrLogin.qrCodeDataUrl} alt={`${PLATFORM_META[accountDraft.platform].label}登录二维码`} width={360} height={360} className="mx-auto max-h-[280px] w-full max-w-[280px] object-contain" />
                                        {qrLogin.status === "scanned" ? (
                                            <div role="status" className="flex items-center justify-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                                                <CheckCircle2 className="size-4 shrink-0" />
                                                已扫码，等待手机确认
                                            </div>
                                        ) : null}
                                    </div>
                                ) : qrLogin.status === "scanned" ? (
                                    <div className="max-w-sm text-center" role="status">
                                        <CheckCircle2 className="mx-auto size-10 text-emerald-500" />
                                        <p className="mt-4 text-sm font-semibold text-slate-900">等待手机确认登录</p>
                                        <p className="mt-2 text-xs leading-5 text-slate-500">如果手机没有出现确认页面，请点击下方“刷新二维码”重试。</p>
                                    </div>
                                ) : qrLoginEnded || qrNeedsVerification ? (
                                    <div className="mx-auto max-w-sm text-center">
                                        <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-amber-50 text-amber-600"><CircleAlert className="size-6" /></span>
                                        <p className="mt-4 text-sm font-semibold text-slate-900">{qrNeedsVerification ? "需要完成抖音安全验证" : "当前二维码不可用"}</p>
                                        <p className="mt-2 text-xs leading-5 text-slate-500">{qrLoginMessage}</p>
                                        <Button className="mt-5" type="primary" icon={<RefreshCw className="size-4" />} onClick={() => void startAccountQrLogin()}>{qrNeedsVerification ? "验证完成，重新登录" : "重新生成二维码"}</Button>
                                    </div>
                                ) : (
                                    <Spin tip="正在生成二维码" />
                                )}
                            </div>
                            <p className="px-4 py-3 text-center text-xs leading-5 text-[var(--studio-muted)]">{qrNeedsVerification ? "上方是当前会话的抖音官方页面，可直接点击和拖动。验证完成后自动检查登录结果。" : qrLoginEnded ? "请重新生成二维码。" : qrLogin.status === "scanned" ? "请在手机上确认登录；若未出现确认页面，可刷新二维码重试。" : `请打开 ${accountDraft.platform === "wechat_channels" ? "微信" : PLATFORM_META[accountDraft.platform].label} App 扫描上方二维码，并在手机上确认登录。`}</p>
                        </div>
                    ) : (
                        <div className="flex gap-3 rounded-2xl border border-dashed border-[var(--studio-line-strong)] bg-[var(--studio-surface-soft)] p-4">
                            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--studio-surface)] text-[var(--studio-ink)]"><QrCode className="size-5" /></div>
                            <div><p className="text-sm font-medium text-[var(--studio-ink)]">无需填写 Cookie</p><p className="mt-1 text-xs leading-5 text-[var(--studio-muted)]">点击下方按钮后使用对应平台 App 扫码，系统会自动读取并加密保存登录状态。</p></div>
                        </div>
                    )}
                </div>
            </Modal>
        </PageShell>
    );
}

function OfficialVerification({ session }: { session: PublishQrLogin }) {
    const { message } = App.useApp();
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const [lastFrame, setLastFrame] = useState(Date.now());
    const [now, setNow] = useState(Date.now());
    useEffect(() => { setLastFrame(Date.now()); }, [session]);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    const stale = now - lastFrame > 4000;
    const pointer = useRef<{ x: number; y: number } | null>(null);
    const send = async (action: Record<string, unknown>) => {
        if (busy || stale) return;
        setBusy(true);
        try {
            await sendPublishQrAction(session.sessionId, action);
            window.dispatchEvent(new Event("publishing-verification-input"));
        }
        catch (error) { message.error(readError(error)); }
        finally { setBusy(false); }
    };
    return <div className="w-full space-y-3">
        <div className="flex flex-wrap gap-2">
            <Button type="primary" loading={busy} disabled={stale} onClick={() => void send({kind: "method", method: "sms"})}>接收短信验证码</Button>
            <Button disabled={busy || stale} onClick={() => void send({kind: "method", method: "password"})}>验证登录密码</Button>
            <Button disabled={busy || stale} onClick={() => void send({kind: "method", method: "other"})}>选择其他验证方式</Button>
        </div>
        <div className="flex items-center justify-between text-xs text-slate-500" role="status">
            <span className={stale ? "text-amber-600" : "text-emerald-600"}>{stale ? "画面连接延迟，暂不可操作" : "● 实时连接"}</span>
            <span>{busy ? "正在同步操作…" : "点击与输入后自动同步画面"}</span>
        </div>
        {session.qrCodeDataUrl ? <NextImage unoptimized src={session.qrCodeDataUrl} alt="抖音官方验证页面" width={1100} height={760}
            draggable={false} className="h-auto w-full cursor-pointer touch-none rounded-lg border border-slate-200"
            onPointerDown={(event) => {
                if (busy || stale) return;
                const box = event.currentTarget.getBoundingClientRect();
                pointer.current = { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height };
                event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerCancel={() => { pointer.current = null; }}
            onPointerUp={(event) => {
                const start = pointer.current;
                pointer.current = null;
                if (!start) return;
                const box = event.currentTarget.getBoundingClientRect();
                void send({ kind: "pointer", ...start, endX: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), endY: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)) });
            }} /> : <div className="p-12 text-center"><Spin /><p className="mt-3">正在读取官方验证页面</p></div>}
        <div className="flex flex-wrap gap-2">
            <Input.Password className="!w-64" value={text} onChange={(event) => setText(event.target.value)} placeholder="点击上方输入框后，在这里输入" autoComplete="off" />
            <Button loading={busy} disabled={!text} onClick={() => { void send({kind: "text", text}); setText(""); }}>输入到官方页面</Button>
            <Button disabled={busy} onClick={() => void send({kind: "key", text: "Backspace"})}>退格</Button>
            <Button disabled={busy} onClick={() => void send({kind: "key", text: "Enter"})}>回车</Button>
        </div>
    </div>;
}

function Field({ label, hint, icon, children }: { label: string; hint?: string; icon?: ReactNode; children: ReactNode }) {
    return <label className="block min-w-0"><span className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs font-medium text-[var(--studio-ink)]"><IconLabel icon={icon}>{label}</IconLabel>{hint ? <span className="text-[11px] font-normal leading-5 text-[var(--studio-faint)]">{hint}</span> : null}</span>{children}</label>;
}

function TabLabel({ icon, text }: { icon: ReactNode; text: string }) {
    return <span className="inline-flex items-center gap-2 py-1">{icon}{text}</span>;
}

function PublishStatusBadge({ status }: { status: PublishTaskStatus }) {
    const meta = STATUS_META[status];
    const StatusIcon = status === "success" ? CheckCircle2 : status === "failed" ? CircleAlert : Clock3;
    return <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium" style={{ color: meta.color, background: `color-mix(in srgb, ${meta.color} 8%, transparent)`, borderColor: `color-mix(in srgb, ${meta.color} 16%, transparent)` }}><StatusIcon className="size-3.5" />{meta.label}</span>;
}

function HistoryPlatform({ platform }: { platform: PublishingPlatform }) {
    const PlatformGlyph = platform === "douyin" ? Music2 : platform === "xiaohongshu" ? BookOpen : platform === "toutiao" ? Newspaper : RadioTower;
    return <span className="inline-flex items-center gap-2 text-xs font-medium text-[var(--studio-ink)]"><span className="grid size-7 shrink-0 place-items-center rounded-lg border border-[var(--studio-line)] bg-[var(--studio-surface-soft)]"><PlatformGlyph className="size-3.5" /></span>{PLATFORM_META[platform].label}</span>;
}

function PublishTaskSummary({ task }: { task: PublishTask }) {
    const [failedCover, setFailedCover] = useState<string>();
    const cover = task.coverUrl || (task.mediaType === "images" ? task.mediaUrls[0] : "");
    return <div className="flex min-w-0 items-center gap-3">
        <div className="relative grid size-12 shrink-0 place-items-center overflow-hidden rounded-lg border border-[var(--studio-line)] bg-[var(--studio-surface-soft)] text-[var(--studio-muted)]">
            {cover && cover !== failedCover ? <NextImage src={cover} alt="发布素材封面" fill unoptimized sizes="48px" className="object-cover" onError={() => setFailedCover(cover)} /> : task.mediaType === "video" ? <Video className="size-5" /> : <ImageIcon className="size-5" />}
        </div>
        <div className="min-w-0"><p className="line-clamp-2 text-sm font-medium leading-5 text-[var(--studio-ink)]">{task.title || task.description || (task.mediaType === "video" ? "未命名视频" : "未命名图文")}</p><p className="mt-1.5 text-[11px] text-[var(--studio-muted)]">{task.mediaType === "video" ? "视频" : "图文"}<span className="mx-1.5 text-[var(--studio-faint)]">·</span>{task.mediaUrls.length} 个素材<span className="mx-1.5 text-[var(--studio-faint)]">·</span>{modeLabel(task.publishMode)}</p></div>
    </div>;
}

function PublishTaskResult({ task }: { task: PublishTask }) {
    const text = task.errorMessage ? publishErrorMessage(task.errorMessage) : task.status === "failed" ? "发布未完成，请检查账号与素材后重新提交" : task.status === "success" ? resultMessage(task) || "平台处理完成" : task.status === "running" ? "正在发布，完成后自动更新" : "任务已提交，等待发布";
    return <Tooltip title={text}><p className={`line-clamp-2 text-xs leading-5 ${isPublishing(task) ? "text-[var(--studio-faint)]" : "text-[var(--studio-muted)]"}`}>{text}</p></Tooltip>;
}

function PlatformIcon({ platform }: { platform: PublishingPlatform }) {
    const meta = PLATFORM_META[platform];
    return <span className="grid size-10 shrink-0 place-items-center rounded-xl text-sm font-semibold text-white shadow-sm" style={{ background: meta.accent }}>{meta.short}</span>;
}

function PlatformBadge({ platform }: { platform: PublishingPlatform }) {
    return <span className="inline-flex items-center gap-2"><span className="size-2 rounded-full" style={{ background: PLATFORM_META[platform].accent }} />{PLATFORM_META[platform].label}</span>;
}

function assetUrl(asset?: Asset) {
    if (!asset) return "";
    return asset.kind === "image" ? asset.data.dataUrl : asset.kind === "video" ? asset.data.url : "";
}

function isRemoteUrl(value: string) {
    return /^https?:\/\//i.test(value);
}

function modeLabel(mode: PublishMode) {
    return mode === "publish" ? "正式发布" : mode === "draft" ? "保存草稿" : "试运行";
}

function publishErrorMessage(raw: string): string {
    let text = raw;
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.detail === "string") text = parsed.detail;
    } catch { /* Older records may already contain plain text. */ }
    if (text.includes("HTTP 403") && text.includes("aweme/create")) return "视频已上传，但抖音拒绝创建作品（HTTP 403）。请检查创作者中心的账号状态及平台提示。";
    const reason = text.match(/status_msg="([^"\n]+)"/);
    if (reason) return `平台拒绝发布：${reason[1]}`;
    const lines = text.split("\n").filter((line) => /^(错误[:：]|Error:|ERROR)/.test(line));
    if (lines.length) return lines[lines.length - 1].slice(0, 500);
    if (/已加载.*cookie/i.test(text)) return "平台执行失败，请检查账号状态和素材要求。";
    return text.slice(0, 500);
}

function resultMessage(task: PublishTask) {
    const message = task.resultData?.message;
    return typeof message === "string" ? message : "";
}

function formatTime(value?: string | null) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function readError(error: unknown) {
    return error instanceof Error ? publishErrorMessage(error.message) : "操作失败，请稍后重试";
}

function isGenericSuccessMessage(value: string) {
    return /^(success|成功)$/i.test(value.trim());
}

function readableQrLoginMessage(status: PublishQrLogin["status"], message: string) {
    if (!isGenericSuccessMessage(message)) return message;
    if (status === "waiting") return "等待扫码";
    if (status === "scanned") return "已扫码，请在手机上确认登录";
    if (status === "confirmed") return "扫码登录成功";
    if (status === "expired") return "二维码已过期，请重新获取";
    if (status === "cancelled") return "扫码登录已取消";
    return "扫码状态异常，请重新生成二维码";
}
