"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Checkbox, Collapse, Empty, Form, Input, InputNumber, Modal, Segmented, Select, Space, Switch, Table, Tag, Tooltip } from "antd";
import { ArrowDownToLine, ArrowRight, AudioLines, CheckCircle2, CircleHelp, Film, ImageIcon, Layers3, MessageSquareText, Network, Pencil, Plus, RefreshCw, Settings2, ShieldCheck, Trash2, Waypoints, FolderInput } from "lucide-react";
import { IconLabel } from "@/shared/components/icon-label";
import { ListPagination } from "@/shared/components/list-pagination";
import { MODEL_CAPABILITY_OPTIONS, useConfigStore } from "@/features/settings/stores/use-config-store";
import { CHANNEL_TYPES, gatewayApi, type ChannelDraft, type GatewayChannel, type GatewayModel, type ImportableChannel, type ModelRoute, type SyncModels } from "./api";
import styles from "./newapi-management.module.css";

const labels: Record<string, string> = { text: "文本", image: "图片", video: "视频", audio: "语音" };
const categories = [
    { value: "text", label: "文本模型", icon: MessageSquareText },
    { value: "image", label: "图片模型", icon: ImageIcon },
    { value: "video", label: "视频模型", icon: Film },
    { value: "audio", label: "语音模型", icon: AudioLines },
    { value: "other", label: "未分类", icon: Layers3 },
];
const errorText = (e: unknown) => e instanceof Error ? e.message : "操作失败，请重试";

export function NewApiManagement() {
    const { message, modal } = App.useApp();
    const cache = useQueryClient();
    const [view, setView] = useState("channels");
    const [keyword, setKeyword] = useState("");
    const [category, setCategory] = useState("video");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [editing, setEditing] = useState<GatewayChannel | "new" | null>(null);
    const [syncOpen, setSyncOpen] = useState(false);
    const [selected, setSelected] = useState<string[]>([]);
    const [busy, setBusy] = useState("");
    const [help, setHelp] = useState(false);
    const refreshConfig = useConfigStore(s => s.refreshModelConfiguration);
    const openConfig = useConfigStore(s => s.openConfigDialog);
    const status = useQuery({ queryKey: ["newapi", "status"], queryFn: gatewayApi.status, retry: false });
    const connected = status.data?.connected === true;
    const channels = useQuery({
        queryKey: ["newapi", "channels", page, pageSize, keyword],
        queryFn: () => gatewayApi.channels(page, pageSize, keyword), enabled: connected && view === "channels",
    });
    const models = useQuery({ queryKey: ["newapi", "models"], queryFn: gatewayApi.models, enabled: connected && view === "models" });
    const routes = useQuery({ queryKey: ["newapi", "routes"], queryFn: gatewayApi.routes, enabled: connected && (view === "routes" || view === "models") });
    const importable = useQuery({ queryKey: ["newapi", "importable"], queryFn: gatewayApi.importable, enabled: connected && view === "import" });
    const modelTypes = useMemo(() => new Map((routes.data ?? []).map(row => [row.model, row.modelTypes ?? ["other"]])), [routes.data]);
    const categorizedModels = useMemo(() => (models.data ?? []).map(model => ({ ...model,
        modelTypes: model.connectedTypes.length ? model.connectedTypes : modelTypes.get(model.id) ?? ["other"],
    })), [models.data, modelTypes]);
    const categoryCounts = useMemo(() => {
        const source = view === "models" ? categorizedModels : routes.data ?? [];
        return Object.fromEntries(categories.map(({ value }) => [value, source.filter(row => (row.modelTypes ?? ["other"]).includes(value)).length]));
    }, [view, categorizedModels, routes.data]);
    const filteredModels = useMemo(() => categorizedModels.filter(m => m.modelTypes.includes(category) && m.id.toLowerCase().includes(keyword.toLowerCase())), [categorizedModels, category, keyword]);
    const filteredImports = useMemo(() => (importable.data ?? [])
        .filter(c => (c.name + c.apiFormat).toLowerCase().includes(keyword.toLowerCase()))
        .sort((a, b) => Number(b.migrated) - Number(a.migrated) || Number(b.supported) - Number(a.supported)), [importable.data, keyword]);
    const filteredRoutes = useMemo(() => (routes.data ?? []).filter(row => (row.modelTypes ?? ["other"]).includes(category)
        && (row.model + " " + row.channels.map(c => c.channelName).join(" ")).toLowerCase().includes(keyword.toLowerCase())), [routes.data, keyword, category]);
    const rows = view === "models" ? filteredModels : view === "routes" ? filteredRoutes : filteredImports;
    const total = view === "channels" ? channels.data?.total ?? 0 : rows.length;
    const safePage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
    const pageItems = rows.slice((safePage - 1) * pageSize, safePage * pageSize);
    const loadError = status.error || (view === "channels" ? channels.error : view === "models" ? models.error || routes.error : view === "routes" ? routes.error : importable.error);
    const categoryLabel = categories.find(item => item.value === category)?.label ?? "模型";

    async function refresh() {
        await cache.invalidateQueries({ queryKey: ["newapi"] });
    }
    async function act(key: string, action: () => Promise<unknown>, success: string, updateConfig = false) {
        if (busy) return;
        setBusy(key);
        try {
            await action();
            message.success(success);
            await refresh();
            if (updateConfig) await refreshConfig();
        } catch (e) { message.error({ content: errorText(e), duration: 8 }); }
        finally { setBusy(""); }
    }
    function changeView(next: string) { setView(next); setPage(1); setKeyword(""); setSelected([]); }
    function confirmMigration(row: ImportableChannel) {
        modal.confirm({
            title: row.migrated ? "恢复此渠道直连？" : "迁入并交给 New API 管理？",
            content: row.migrated ? "恢复原服务地址和密钥，保留当前模型及积分配置。New API 中的渠道会保留。"
                : "原模型、默认项与积分保持不变，后续请求通过 New API 转发。有运行中的任务时会阻止切换。",
            okText: row.migrated ? "恢复直连" : "迁入并接管", cancelText: "取消",
            onOk: () => act(row.id, () => row.migrated ? gatewayApi.restore(row.id) : gatewayApi.migrate(row.id),
                row.migrated ? "已恢复直连" : "已迁入 New API，模型配置已保留", true),
        });
    }

    return <div className={styles.root}>
        <header className={styles.header}>
            <div className={styles.heading}>
                <span className={styles.symbol}><Network size={22} strokeWidth={1.6} /></span>
                <div><h2>New API <span>渠道中心</span></h2><p>统一管理上游渠道，让模型接入更简单。</p></div>
            </div>
            <div className={styles.headerActions}>
                <span className={styles.connection} data-online={connected}>
                    <i />{status.isFetching ? "检查连接中" : connected ? "服务已连接" : "服务未连接"}
                </span>
                <Tooltip title="使用说明"><Button aria-label="New API 使用说明" type="text" icon={<CircleHelp size={17} />} onClick={() => setHelp(true)} /></Tooltip>
                <Button icon={<RefreshCw size={14} />} onClick={() => void refresh()} loading={status.isFetching}>刷新</Button>
            </div>
        </header>

        <div className={styles.flow} aria-label="模型接入流程">
            <span><Network size={14} /> 配置渠道</span><ArrowRight size={13} /><span><Layers3 size={14} /> 选择模型与能力</span><ArrowRight size={13} /><span><CheckCircle2 size={14} /> 在创作中使用</span>
            <small><ShieldCheck size={13} /> 仅管理员可管理</small>
        </div>
        {loadError ? <Alert showIcon type="error" title={errorText(loadError)} action={<Button icon={<RefreshCw className="size-4" />} onClick={() => void refresh()}>重试</Button>} /> : null}
        {!connected && !status.isPending ? <Alert showIcon type="warning" title={status.data?.message || "暂时无法连接 New API"} description="确认 New API 服务已启动，并运行 scripts/setup-newapi.mjs 完成初始化，再重建后端容器。" /> : null}

        <div className={styles.toolbar}>
            <Segmented aria-label="New API 管理视图" value={view} onChange={changeView} options={[
                { value: "channels", label: <IconLabel icon={<Network />}> 上游渠道</IconLabel> }, { value: "models", label: <IconLabel icon={<Layers3 />}> 可用模型</IconLabel> }, { value: "routes", label: <IconLabel icon={<Waypoints />}> 主用 / 备用</IconLabel> }, { value: "import", label: <IconLabel icon={<FolderInput />}> 迁入现有渠道</IconLabel> },
            ]} />
            <div className={styles.actions}>
                <Input.Search key={view + category} aria-label="搜索渠道或模型" placeholder={view === "models" ? "搜索当前分类模型" : view === "routes" ? "搜索当前分类模型或渠道" : "搜索渠道"} allowClear
                    onSearch={value => { setKeyword(value.trim()); setPage(1); }} className={styles.search} />
                {view === "channels" ? <Button type="primary" icon={<Plus size={15} />} disabled={!connected} onClick={() => setEditing("new")}>新增渠道</Button>
                    : view === "models" ? <Button type="primary" icon={<ArrowDownToLine size={15} />} disabled={!selected.length || !!busy} onClick={() => setSyncOpen(true)}>接入创作{selected.length ? " · " + selected.length : ""}</Button>
                    : null}
            </div>
        </div>

        {view === "routes" || view === "models" ? <div className={styles.categories}>
            <Segmented aria-label="模型类型" value={category} onChange={value => { setCategory(value); setPage(1); setKeyword(""); setSelected([]); }}
                options={categories.filter(item => item.value !== "other" || categoryCounts.other > 0 || category === "other").map(({ value, label, icon: Icon }) => ({ value,
                    label: <span className={styles.categoryLabel}><Icon size={15} aria-hidden="true" /><span>{label}</span><span className={styles.categoryCount}>{categoryCounts[value] ?? 0}</span></span>,
                }))} />
            <span className={styles.categoryHint}>按模型类型管理渠道</span>
        </div> : null}

        {view === "channels" ? <div className={styles.subnote}><span><ShieldCheck size={14} className="mr-1 inline-block" />渠道可随时启用或停用，配置与历史记录保留；启用时已有主用的同名模型保留为备用。</span></div> : null}
        {view === "channels" ? <Table<GatewayChannel> rowKey="id" pagination={false} loading={channels.isFetching || status.isPending}
            dataSource={channels.data?.items ?? []} scroll={{ x: 900 }} size="middle"
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有上游渠道，可新增或从现有配置迁入" /> }}
            columns={[
                { title: "渠道", dataIndex: "name", width: 220, render: (name, row) => <div className={styles.channelName}><span className={styles.channelIcon}><Network size={16} /></span><div><strong>{name}</strong><small>{CHANNEL_TYPES.find(t => t.value === row.type)?.label || "类型 " + row.type}</small></div></div> },
                { title: "服务地址", dataIndex: "baseUrl", ellipsis: true, render: v => <span className={styles.url}>{v || "厂商默认地址"}</span> },
                { title: "模型", width: 100, render: (_, row) => <Tooltip title={row.models.join("、")}><span>{row.models.length} 个模型</span></Tooltip> },
                { title: "优先级", dataIndex: "priority", width: 90 },
                { title: "状态", width: 100, render: (_, row) => <Tooltip title={row.status === 3 ? "上游异常，已自动停用" : row.status === 1 ? "已启用" : "已停用"}>
                    <Switch aria-label={row.name + "启用状态"} size="small" checked={row.status === 1} loading={busy === String(row.id)} disabled={!!busy}
                        onChange={enabled => void act(String(row.id), () => gatewayApi.enable(row.id, enabled), enabled ? "渠道已启用，同名主用保持不变" : "渠道已停用，配置已保留", true)} /></Tooltip> },
                { title: "操作", width: 116, align: "right", render: (_, row) => <Space size={4}>
                    <Tooltip title="编辑渠道"><Button aria-label={"编辑" + row.name} type="text" disabled={!!busy} icon={<Pencil size={15} />} onClick={() => setEditing(row)} /></Tooltip>
                    <Tooltip title="删除渠道"><Button aria-label={"删除" + row.name} type="text" danger disabled={!!busy} icon={<Trash2 size={15} />} onClick={() => modal.confirm({
                        title: "删除渠道「" + row.name + "」？", content: "删除前会检查未完成的生成任务。失去主用渠道的模型会从创作列表隐藏，备用渠道不会自动接管；模型配置、积分与历史记录保留。",
                        okText: "删除渠道", cancelText: "取消", okType: "danger",
                        onOk: () => act(String(row.id), () => gatewayApi.remove(row.id), "渠道已删除", true),
                    })} /></Tooltip>
                </Space> },
            ]} /> : view === "models" ? <>
                <div className={styles.subnote}><span>模型来自已启用渠道；接入时选择实际支持的能力，已有定价会保留。</span>
                    <Button type="link" size="small" icon={<Settings2 size={13} />} onClick={() => openConfig(false, "credits")}>模型积分设置</Button></div>
                <Table<GatewayModel> rowKey="id" pagination={false} loading={models.isFetching || routes.isFetching} dataSource={pageItems as GatewayModel[]}
                    rowSelection={{ selectedRowKeys: selected, preserveSelectedRowKeys: true, onChange: keys => setSelected(keys.map(String)), getCheckboxProps: row => ({ disabled: !connected }) }}
                    locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={keyword ? "当前分类下没有匹配的模型" : "暂无可用的" + categoryLabel} /> }}
                    columns={[
                        { title: "模型 ID", dataIndex: "id", render: id => <span className={styles.modelName}>{id}</span> },
                        { title: "接入情况", width: 220, render: (_, row) => row.connectedTypes.length ? <Space>{row.connectedTypes.map(t => <Tag key={t}>{labels[t] || t}已接入</Tag>)}</Space> : <span className={styles.muted}>待接入</span> },
                    ]} />
            </> : view === "routes" ? <>
                <div className={styles.subnote}>同名模型保留所有渠道，每次只使用一个。备用渠道不参与请求，需手动切换。</div>
                <Table<ModelRoute> rowKey="model" pagination={false} loading={routes.isFetching} dataSource={pageItems as ModelRoute[]}
                    locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={keyword ? "当前分类下没有匹配的模型或渠道" : "暂无可用的" + categoryLabel} /> }}
                    expandable={{ expandedRowRender: row => <Space orientation="vertical" className="w-full" size={12}>
                        {row.channels.map(channel => <div key={channel.channelId} className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border)] px-4 py-3">
                            <Space><span>{channel.channelName}</span><Tag color={channel.active ? "green" : undefined}>{channel.active ? "主用" : "备用"}</Tag>
                                {channel.channelStatus !== 1 ? <span className={styles.muted}>渠道已停用</span> : null}</Space>
                            <Button size="small" disabled={!!busy || channel.active || channel.channelStatus !== 1}
                                loading={busy === row.model + ":" + channel.channelId}
                                onClick={() => void act(row.model + ":" + channel.channelId, () => gatewayApi.selectRoute(row.model, channel.channelId), "已切换主用渠道，其他渠道保留备用", true)}>设为主用</Button>
                        </div>)}
                    </Space> }}
                    columns={[
                        { title: "模型", dataIndex: "model", render: value => <span className={styles.modelName}>{value}</span> },
                        { title: "当前主用", render: (_, row) => row.channels.filter(c => c.active).map(c => c.channelName).join("、") || <span className={styles.muted}>暂无主用渠道</span> },
                        { title: "备用渠道", width: 120, render: (_, row) => <span className={styles.muted}>{row.channels.filter(c => !c.active).length} 个</span> },
                    ]} />
            </> : <>
        <div className={styles.subnote}>迁入后，模型默认项、积分和历史记录继续沿用。视频协议由 New API 插件统一适配。</div>
                <Table<ImportableChannel> rowKey="id" pagination={false} loading={importable.isFetching} dataSource={pageItems as ImportableChannel[]} scroll={{ x: 680 }}
                    columns={[
                        { title: "现有渠道", dataIndex: "name", render: (name, row) => <div className={styles.channelName}><div><strong>{name}</strong><small>{row.apiFormat} · {row.modelCount} 个模型</small></div></div> },
                        { title: "迁入说明", dataIndex: "reason", render: (v, row) => <span className={row.migrated ? styles.connectedText : styles.muted}>{v}</span> },
                        { title: "操作", width: 140, render: (_, row) => <Button size="small" disabled={!!busy || (!row.supported && !row.migrated)} loading={busy === row.id}
                            onClick={() => confirmMigration(row)}>{row.migrated ? "恢复直连" : "迁入并接管"}</Button> },
                    ]} />
            </>}
        <ListPagination current={safePage} pageSize={pageSize} total={total} onChange={(p, size) => { setPage(p); setPageSize(size); }} label="New API 列表分页" />
        <footer className={styles.footer}>Powered by <a href="https://github.com/QuantumNous/new-api" target="_blank" rel="noreferrer">New API</a><span>密钥仅保存在服务端</span></footer>

        {editing !== null ? <ChannelEditor channel={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await refresh(); await refreshConfig(); }} /> : null}
        {syncOpen ? <SyncDialog models={selected} initialType={category === "text" || category === "video" || category === "audio" ? category : "image"} onClose={() => setSyncOpen(false)} onSaved={async () => { setSyncOpen(false); setSelected([]); await refresh(); await refreshConfig(); }} /> : null}
        <Modal title="New API 渠道中心" open={help} onCancel={() => setHelp(false)} footer={<Button onClick={() => setHelp(false)}>知道了</Button>}>
            <div className={styles.help}>
                <p><b>1. 配置渠道</b><br />填写服务地址和密钥，拉取或手动添加模型。兼容 OpenAI 的服务选择“OpenAI 兼容”。</p>
                <p><b>2. 接入创作</b><br />在“可用模型”勾选模型，设置类型、能力和积分。文本按 Token 计价，接入后可在积分设置中选择官方价格。</p>
                <p><b>3. 主用与备用</b><br />同名模型的渠道全部保留。在“主用 / 备用”展开模型，点击“设为主用”手动切换。备用渠道不参与请求，也不会在失败时自动切换。存在生成任务时暂不切换。</p>
                <p><b>4. 保留固定模型名</b><br />更换上游时保留项目使用的对外模型名，通过“模型映射”对应新上游。先新增并验证替代渠道，再移除旧渠道，无需修改或重启项目。</p>
                <p><b>启用与停用</b><br />可随时切换渠道状态，包括最后一个可用渠道或存在生成任务时。停用后停止分配新请求，模型配置与历史记录保留；重新启用时，已有其他主用的同名模型保留为备用，不会自动抢占。已提交的上游任务不会因此被取消，尚未提交的请求可能失败，可重新启用后重试。</p>
                <p><b>模型下架</b><br />可直接从渠道移除模型，无需先删除“我的模型”配置。失去主用渠道的模型会从创作下拉框隐藏，重新添加后恢复；历史记录、别名和积分配置保留，备用渠道不会自动接管。</p>
                <p><b>删除与修改保护</b><br />删除渠道、修改地址、密钥或映射时仍会检查未完成任务；直接更换已接入模型的协议仍会被拦截。仅增删模型列表不影响已提交任务的查询。</p>
                <p className={styles.muted}>保护适用于本项目渠道中心。直接操作完整 New API 控制台、上游故障或额度不足仍可能影响生成；替代渠道需先验证实际能力。</p>
                <p><b>迁入已有渠道</b><br />保留原模型 ID 与业务设置，自动切换为网关转发。可恢复原直连配置。</p>
                <p className={styles.muted}>视频渠道选择“视频协议插件”并绑定对应插件，提交、查询和下载均由 New API 统一处理。已内置 MiniMax、OpenAI、Muse、AutoDL、Dola 和 Seedance 协议；后续渠道地址、密钥和协议适配在 New API 侧维护。</p>
            </div>
        </Modal>
    </div>;
}

function ChannelEditor({ channel, onClose, onSaved }: { channel?: GatewayChannel; onClose: () => void; onSaved: () => Promise<void> }) {
    const { message } = App.useApp();
    const [form] = Form.useForm<ChannelDraft>();
    const [saving, setSaving] = useState(false);
    const [fetching, setFetching] = useState(false);
    const [options, setOptions] = useState<string[]>(channel?.models ?? []);
    const [error, setError] = useState("");
    const channelType = Form.useWatch("type", form) ?? channel?.type ?? 1;
    const plugins = useQuery({ queryKey: ["newapi", "plugins"], queryFn: gatewayApi.plugins, enabled: channelType === 61 });
    async function fetchModels() {
        setFetching(true); setError("");
        try {
            const draft = form.getFieldsValue();
            const unchanged = channel && !draft.apiKey && draft.baseUrl === channel.baseUrl && draft.type === channel.type;
            const ids = await gatewayApi.fetchModels(draft.type === 61 ? { type: 61, pluginKey: draft.pluginKey }
                : unchanged ? { id: channel.id } : { type: draft.type, baseUrl: draft.baseUrl, apiKey: draft.apiKey });
            setOptions(ids);
            if (!form.getFieldValue("models")?.length) form.setFieldValue("models", ids);
            message.success("已拉取 " + ids.length + " 个模型，可搜索选择");
        } catch (e) { setError(errorText(e)); } finally { setFetching(false); }
    }
    async function save() {
        try { await form.validateFields(); } catch { return; }
        setSaving(true); setError("");
        try {
            const draft = form.getFieldsValue(true);
            await gatewayApi.save({ ...draft, id: channel?.id });
            message.success(channel ? "渠道已更新" : "渠道已添加");
            await onSaved();
        } catch (e) { setError(errorText(e)); } finally { setSaving(false); }
    }
    return <Modal title={channel ? "编辑渠道" : "新增上游渠道"} open width={640} onCancel={onClose} maskClosable={!saving}
        closable={!saving} okText="保存渠道" cancelText="取消" confirmLoading={saving} cancelButtonProps={{ disabled: saving }} onOk={() => void save()}>
        <Form form={form} layout="vertical" requiredMark={false} disabled={saving} className={styles.form}
            initialValues={channel ? { ...channel, apiKey: "", weight: Math.max(1, channel.weight), modelMapping: channel.modelMapping || "{}" }
                : { name: "", type: 1, baseUrl: "", apiKey: "", models: [], priority: 0, weight: 1, modelMapping: "{}" }}>
            <div className={styles.formGrid}>
                <Form.Item name="name" label="渠道名称" rules={[{ required: true, whitespace: true, message: "请填写渠道名称" }]}><Input placeholder="例如：主力图片渠道" maxLength={100} /></Form.Item>
                <Form.Item name="type" label="渠道类型" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={CHANNEL_TYPES} /></Form.Item>
            </div>
            {channelType === 61 ? <Form.Item name="pluginKey" label="视频协议" rules={[{ required: true, message: "请选择视频协议" }]}>
                <Select loading={plugins.isFetching} showSearch optionFilterProp="label" placeholder="选择已安装的 New API 插件"
                    options={(plugins.data ?? []).map(p => ({ value: p.key, label: p.name }))} />
            </Form.Item> : null}
            {channelType === 61 && plugins.error ? <Alert type="error" title={errorText(plugins.error)} /> : null}
            <Form.Item name="baseUrl" label="服务地址" rules={[{ required: true, message: "请填写服务地址" }]}>
                <Input placeholder="https://api.example.com（末尾 /v1 会自动处理）" autoComplete="off" />
            </Form.Item>
            <Form.Item name="apiKey" label={channel ? "API Key（留空保留原密钥）" : "API Key"} rules={channel ? [] : [{ required: true, whitespace: true, message: "请填写 API Key" }]}>
                <Input.Password autoComplete="new-password" placeholder={channel ? "已配置，填写新密钥可替换" : "填写上游服务密钥"} />
            </Form.Item>
            <Form.Item label={<span className={styles.modelLabel}>模型列表<Button type="link" size="small" loading={fetching} disabled={saving} icon={<RefreshCw size={12} />} onClick={() => void fetchModels()}>拉取模型</Button></span>}
                name="models" rules={[{ required: true, type: "array", min: 1, message: "请至少添加一个模型" }]}>
                <Select mode="tags" tokenSeparators={[",", "，", "\n"]} maxTagCount={6} placeholder="搜索选择，或输入模型 ID 后回车" options={options.map(id => ({ value: id, label: id }))} />
            </Form.Item>
            <Collapse ghost size="small" items={[{ key: "advanced", label: "调度与模型映射", forceRender: true, children: <>
                <div className={styles.formGrid}>
                    <Form.Item name="priority" label="优先级（数值越大越优先）"><InputNumber min={0} max={1000} precision={0} className="w-full" /></Form.Item>
                    <Form.Item name="weight" label="同优先级分配权重"><InputNumber min={1} max={1000} precision={0} className="w-full" /></Form.Item>
                </div>
                <Form.Item name="modelMapping" label="模型映射（对外名称 → 上游名称）" extra="保留项目使用的对外模型名，只修改上游名称；替换前请验证新渠道的能力。"><Input.TextArea rows={3} spellCheck={false} placeholder='{"我的模型": "upstream-model-id"}' /></Form.Item>
            </> }]} />
            {error ? <Alert showIcon type="error" title={error} /> : null}
        </Form>
    </Modal>;
}

function defaultCapability(type: SyncModels["modelType"]) {
    return type === "text" ? "chat" : type === "video" ? "text-to-video" : type === "audio" ? "text-to-speech" : "text-to-image";
}

function SyncDialog({ models, initialType, onClose, onSaved }: { models: string[]; initialType: SyncModels["modelType"]; onClose: () => void; onSaved: () => Promise<void> }) {
    const { message } = App.useApp();
    const [form] = Form.useForm<SyncModels>();
    const kind = Form.useWatch("modelType", form) || initialType;
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    async function save() {
        try { await form.validateFields(); } catch { return; }
        setSaving(true); setError("");
        try {
            const result = await gatewayApi.sync({ ...form.getFieldsValue(true), models, creditCost: kind === "text" ? 0 : form.getFieldValue("creditCost") });
            message.success("已接入 " + result.added + " 个，保留已有配置 " + result.retained + " 个");
            await onSaved();
        } catch (e) { setError(errorText(e)); } finally { setSaving(false); }
    }
    return <Modal title={"接入 " + models.length + " 个模型"} open onCancel={onClose} closable={!saving} maskClosable={!saving}
        okText="确认接入" cancelText="取消" confirmLoading={saving} cancelButtonProps={{ disabled: saving }} onOk={() => void save()}>
        <Form form={form} layout="vertical" requiredMark={false} disabled={saving} className={styles.form}
            initialValues={{ modelType: initialType, capabilities: [defaultCapability(initialType)], setDefault: false, resolutions: ["720P"] }}>
            <div className={styles.selectedModels}>{models.map(m => <Tag key={m}>{m}</Tag>)}</div>
            <Form.Item name="modelType" label="模型用途"><Segmented block options={[{ value: "text", label: "文本" }, { value: "image", label: "图片" }, { value: "video", label: "视频" }, { value: "audio", label: "语音" }]}
                onChange={v => form.setFieldValue("capabilities", [defaultCapability(v as SyncModels["modelType"])])} /></Form.Item>
            <Form.Item name="capabilities" label="已确认支持的能力" rules={[{ required: true, type: "array", min: 1, message: "请选择模型能力" }]}>
                <Checkbox.Group options={MODEL_CAPABILITY_OPTIONS[kind as keyof typeof MODEL_CAPABILITY_OPTIONS].filter(o => o.value !== "audio-input")} />
            </Form.Item>
            {kind === "text" ? <Alert type="info" showIcon title="文本按 Token 计费" description="已有模型价格保持不变。新模型接入后在“模型积分设置”选择官方价格和倍率；未设置时免费。" /> :
                <Form.Item name="creditCost" label={kind === "video" ? "初始单价（积分 / 秒）" : kind === "audio" ? "初始单价（积分 / 段）" : "初始单价（积分 / 张）"} rules={[{ required: true, message: "请填写积分价格，免费填 0" }]}><InputNumber min={0} max={2147483647} precision={0} placeholder="免费请填写 0" className="!w-full" /></Form.Item>}
            {kind === "video" ? <Form.Item name="resolutions" label="模型支持的分辨率" rules={[{ required: true, type: "array", min: 1 }]}><Checkbox.Group options={["480P", "720P", "768P", "1080P", "2K", "4K"]} /></Form.Item> : null}
            {models.length === 1 ? <Form.Item name="setDefault" valuePropName="checked"><Checkbox>设为该类型的默认模型</Checkbox></Form.Item> : null}
            {kind === "audio" ? <Alert type="info" showIcon title="语音模型用于配音和旁白" description="上游需提供 OpenAI 兼容的 /v1/audio/speech 接口（如 grok2api 的 grok-voice 系列）。还没有默认语音模型时，接入的第一个会自动设为默认。" /> : null}
            <p className={styles.muted}>接入会保留已有模型价格与默认设置。视频需要上游渠道支持 New API 视频协议；请按模型实际能力选择。</p>
            {error ? <Alert showIcon type="error" title={error} /> : null}
        </Form>
    </Modal>;
}
