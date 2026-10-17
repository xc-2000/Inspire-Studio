"use client";

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Checkbox, Empty, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Copy, Edit, FileText, Image as ImageIcon, Plus, Power, RefreshCw, Search, Sparkles, Trash2, Video } from "lucide-react";

import { deleteAdminCommerceSkill, listAdminCommerceSkills, saveAdminCommerceSkill, updateAdminCommerceSkillStatus, type CommerceSkill } from "@/features/ecommerce/api/skills";
import { commerceOutputs, commercePlatforms } from "@/features/ecommerce/lib/catalog";
import { ListPagination } from "@/shared/components/list-pagination";
import { useAdminPagination, useClampAdminPage } from "./admin-list-pagination";
import "./ecommerce-skill-management.css";

type SkillFormValues = Pick<CommerceSkill, "name" | "description" | "type" | "platforms" | "outputTypes" | "systemPrompt" | "status" | "sortOrder">;

const TYPE_OPTIONS = [
    { value: "text", label: "文案技能" },
    { value: "image", label: "图片技能" },
    { value: "video", label: "视频技能" },
];
const TYPE_ICONS = { text: FileText, image: ImageIcon, video: Video };
const QUERY_KEY = ["admin-ecommerce-skills"];

function initialValues(): SkillFormValues {
    return { name: "", description: "", type: "text", platforms: commercePlatforms.map((platform) => platform.id), outputTypes: ["copy"], systemPrompt: "", status: 1, sortOrder: 1000 };
}

function valuesFromSkill(skill: CommerceSkill): SkillFormValues {
    return { name: skill.name, description: skill.description || "", type: skill.type, platforms: [...skill.platforms], outputTypes: [...skill.outputTypes], systemPrompt: skill.systemPrompt, status: skill.status, sortOrder: skill.sortOrder };
}

export function EcommerceSkillManagement() {
    const { message, modal } = App.useApp();
    const queryClient = useQueryClient();
    const [form] = Form.useForm<SkillFormValues>();
    const { page, setPage, pageSize, onPaginationChange } = useAdminPagination(20);
    const [keywordInput, setKeywordInput] = useState("");
    const [keyword, setKeyword] = useState("");
    const [typeFilter, setTypeFilter] = useState<CommerceSkill["type"]>();
    const [statusFilter, setStatusFilter] = useState<0 | 1>();
    const [open, setOpen] = useState(false);
    const [editing, setEditing] = useState<CommerceSkill | null>(null);
    const [copying, setCopying] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState("");
    const [busyId, setBusyId] = useState<string | null>(null);
    const mutationLock = useRef(false);
    const editorDirty = useRef(false);
    const formType = Form.useWatch("type", form) || "text";
    const outputOptions = commerceOutputs.filter((output) => output.taskType === formType).map((output) => ({ value: output.id, label: output.name }));
    const skillsQuery = useQuery({
        queryKey: [...QUERY_KEY, keyword, typeFilter, statusFilter, page, pageSize],
        queryFn: () => listAdminCommerceSkills({ keyword: keyword || undefined, type: typeFilter, status: statusFilter, page, pageSize }),
    });
    useClampAdminPage(page, pageSize, skillsQuery.data?.total, setPage);

    const refreshSkills = async () => {
        window.dispatchEvent(new Event("ecommerce-skills-updated"));
        await Promise.all([queryClient.invalidateQueries({ queryKey: QUERY_KEY }), queryClient.invalidateQueries({ queryKey: ["ecommerce-skills"] })]);
    };

    const openEditor = (skill?: CommerceSkill, duplicate = false) => {
        setEditing(duplicate ? null : skill || null);
        setCopying(duplicate);
        setSaveError("");
        editorDirty.current = false;
        form.resetFields();
        const values = skill ? valuesFromSkill(skill) : initialValues();
        if (duplicate) {
            values.name = `${values.name.slice(0, 95)}（副本）`;
            values.status = 0;
        }
        form.setFieldsValue(values);
        setOpen(true);
    };

    const closeEditor = () => {
        if (saving) return;
        if (editorDirty.current) {
            modal.confirm({
                title: "放弃未保存的修改？",
                content: "关闭后，这次填写的内容不会保存。",
                okText: "放弃修改",
                cancelText: "继续编辑",
                okButtonProps: { danger: true },
                onOk: () => setOpen(false),
            });
        } else setOpen(false);
    };

    const saveSkill = async () => {
        if (mutationLock.current) return;
        let values: SkillFormValues;
        try {
            values = await form.validateFields();
        } catch {
            return;
        }
        if (mutationLock.current) return;
        mutationLock.current = true;
        setSaving(true);
        setSaveError("");
        try {
            await saveAdminCommerceSkill({
                ...values,
                name: values.name.trim(),
                description: (values.description || "").trim(),
                systemPrompt: values.systemPrompt.trim(),
                ...(editing ? { id: editing.id, revision: editing.revision } : {}),
            });
            message.success(editing ? "电商技能已更新" : "电商技能已创建");
            setOpen(false);
            if (!editing) setPage(1);
            await refreshSkills();
        } catch (error) {
            const detail = error instanceof Error ? error.message : "保存失败，请稍后重试";
            setSaveError(`${detail}。本次编辑内容已保留。`);
        } finally {
            mutationLock.current = false;
            setSaving(false);
        }
    };

    const changeStatus = (skill: CommerceSkill) => {
        const nextStatus = skill.status === 1 ? 0 : 1;
        modal.confirm({
            title: `${nextStatus === 1 ? "启用" : "停用"}“${skill.name}”？`,
            content: nextStatus === 1 ? "启用后，用户可以在适用平台和创作内容中选择该技能。" : "停用后不再接受使用该技能的新创作，已经提交的任务和结果会保留。",
            okText: nextStatus === 1 ? "启用" : "停用",
            cancelText: "取消",
            onOk: async () => {
                if (mutationLock.current) return Promise.reject(new Error("请等待当前操作完成"));
                mutationLock.current = true;
                setBusyId(skill.id);
                try {
                    await updateAdminCommerceSkillStatus({ id: skill.id, revision: skill.revision, status: nextStatus });
                    message.success("技能状态已更新");
                    await refreshSkills();
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "更新技能状态失败");
                    await refreshSkills();
                    throw error;
                } finally {
                    mutationLock.current = false;
                    setBusyId(null);
                }
            },
        });
    };

    const deleteSkill = (skill: CommerceSkill) => {
        modal.confirm({
            title: `删除“${skill.name}”？`,
            content: "删除后该技能将从技能库和创作选择中移除，历史创作记录和结果会保留。",
            okText: "删除技能",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: async () => {
                if (mutationLock.current) return Promise.reject(new Error("请等待当前操作完成"));
                mutationLock.current = true;
                setBusyId(skill.id);
                try {
                    await deleteAdminCommerceSkill({ id: skill.id, revision: skill.revision });
                    message.success("电商技能已删除");
                    await refreshSkills();
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "删除技能失败");
                    await refreshSkills();
                    throw error;
                } finally {
                    mutationLock.current = false;
                    setBusyId(null);
                }
            },
        });
    };

    const columns: ColumnsType<CommerceSkill> = [
        {
            title: "技能",
            key: "skill",
            width: 280,
            render: (_, skill) => {
                const Icon = TYPE_ICONS[skill.type];
                return (
                    <div className="commerce-admin-skill-identity">
                        <span className="commerce-admin-skill-icon">
                            <Icon size={17} />
                        </span>
                        <div className="min-w-0">
                            <strong title={skill.name}>{skill.name}</strong>
                            <p title={skill.description}>{skill.description || "暂无简介"}</p>
                        </div>
                    </div>
                );
            },
        },
        { title: "类型", dataIndex: "type", width: 95, render: (value: CommerceSkill["type"]) => <Tag>{TYPE_OPTIONS.find((item) => item.value === value)?.label}</Tag> },
        {
            title: "适用平台",
            key: "platforms",
            width: 185,
            render: (_, skill) => (
                <div className="commerce-admin-skill-tags">
                    {commercePlatforms
                        .filter((platform) => skill.platforms.includes(platform.id))
                        .map((platform) => (
                            <span key={platform.id}>{platform.name}</span>
                        ))}
                </div>
            ),
        },
        {
            title: "创作内容",
            key: "outputs",
            width: 190,
            render: (_, skill) => (
                <div className="commerce-admin-skill-tags">
                    {commerceOutputs
                        .filter((output) => skill.outputTypes.includes(output.id))
                        .map((output) => (
                            <span key={output.id}>{output.name}</span>
                        ))}
                </div>
            ),
        },
        {
            title: "状态",
            dataIndex: "status",
            width: 82,
            render: (value: number) => (
                <span className={`commerce-admin-skill-status ${value === 1 ? "is-enabled" : ""}`}>
                    <i />
                    {value === 1 ? "启用" : "停用"}
                </span>
            ),
        },
        { title: "排序", dataIndex: "sortOrder", width: 65, render: (value: number) => <span className="tabular-nums text-[var(--studio-muted)]">{value}</span> },
        {
            title: "操作",
            key: "actions",
            width: 148,
            fixed: "right",
            render: (_, skill) => (
                <Space size={0}>
                    <Tooltip title="编辑">
                        <Button type="text" size="small" icon={<Edit size={15} />} disabled={!!busyId} aria-label={`编辑电商技能${skill.name}`} onClick={() => openEditor(skill)} />
                    </Tooltip>
                    <Tooltip title="复制">
                        <Button type="text" size="small" icon={<Copy size={15} />} disabled={!!busyId} aria-label={`复制电商技能${skill.name}`} onClick={() => openEditor(skill, true)} />
                    </Tooltip>
                    <Tooltip title={skill.status === 1 ? "停用" : "启用"}>
                        <Button type="text" size="small" icon={<Power size={15} />} loading={busyId === skill.id} disabled={!!busyId} aria-label={`${skill.status === 1 ? "停用" : "启用"}电商技能${skill.name}`} onClick={() => changeStatus(skill)} />
                    </Tooltip>
                    <Tooltip title="删除">
                        <Button danger type="text" size="small" icon={<Trash2 size={15} />} disabled={!!busyId} aria-label={`删除电商技能${skill.name}`} onClick={() => deleteSkill(skill)} />
                    </Tooltip>
                </Space>
            ),
        },
    ];

    return (
        <section className="commerce-admin-skills" aria-label="电商技能管理">
            <header className="commerce-admin-skills-heading">
                <div>
                    <h2>
                        <Sparkles size={17} />
                        电商创作技能
                    </h2>
                    <p>按平台和创作内容配置技能，统一维护商品文案、图片与视频的创作规则。</p>
                </div>
                <Button type="primary" icon={<Plus size={16} />} onClick={() => openEditor()}>
                    新建电商技能
                </Button>
            </header>
            <div className="commerce-admin-skills-toolbar">
                <Input.Search
                    aria-label="搜索电商技能"
                    placeholder="搜索技能名称或简介"
                    prefix={<Search size={15} className="text-[var(--studio-muted)]" />}
                    value={keywordInput}
                    allowClear
                    onChange={(event) => {
                        setKeywordInput(event.target.value);
                        if (!event.target.value) {
                            setKeyword("");
                            setPage(1);
                        }
                    }}
                    onSearch={(value) => {
                        setKeyword(value.trim());
                        setPage(1);
                    }}
                />
                <Select
                    aria-label="技能类型筛选"
                    allowClear
                    placeholder="全部类型"
                    value={typeFilter}
                    options={TYPE_OPTIONS}
                    onChange={(value) => {
                        setTypeFilter(value);
                        setPage(1);
                    }}
                />
                <Select
                    aria-label="技能状态筛选"
                    allowClear
                    placeholder="全部状态"
                    value={statusFilter}
                    options={[
                        { value: 1, label: "启用" },
                        { value: 0, label: "停用" },
                    ]}
                    onChange={(value) => {
                        setStatusFilter(value);
                        setPage(1);
                    }}
                />
                <Button icon={<RefreshCw size={14} />} loading={skillsQuery.isFetching} onClick={() => void skillsQuery.refetch()}>
                    刷新
                </Button>
            </div>
            {skillsQuery.error ? <Alert className="mb-4" type="error" showIcon title="电商技能加载失败" description={skillsQuery.error instanceof Error ? skillsQuery.error.message : "请刷新后重试"} /> : null}
            <Table<CommerceSkill>
                rowKey="id"
                columns={columns}
                dataSource={skillsQuery.data?.items || []}
                pagination={false}
                loading={skillsQuery.isFetching}
                scroll={{ x: 1060 }}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={keyword || typeFilter || statusFilter !== undefined ? "没有匹配的电商技能，请调整筛选条件" : "还没有电商技能，点击上方新建开始配置"} /> }}
            />
            <ListPagination current={page} pageSize={pageSize} total={skillsQuery.data?.total || 0} disabled={skillsQuery.isFetching} onChange={onPaginationChange} label="电商技能分页" />
            <Modal
                title={editing ? "编辑电商技能" : copying ? "复制电商技能" : "新建电商技能"}
                open={open}
                width={780}
                className="commerce-admin-skill-modal"
                onCancel={closeEditor}
                onOk={() => void saveSkill()}
                okText="保存技能"
                cancelText="取消"
                confirmLoading={saving}
                cancelButtonProps={{ disabled: saving }}
                closable={!saving}
                maskClosable={!saving}
                keyboard={!saving}
                forceRender
            >
                <Form
                    form={form}
                    layout="vertical"
                    disabled={saving}
                    requiredMark="optional"
                    onValuesChange={() => {
                        editorDirty.current = true;
                        setSaveError("");
                    }}
                >
                    {saveError ? <Alert className="mb-4" type="error" showIcon title="未能保存技能" description={saveError} /> : null}
                    {copying ? <p className="commerce-admin-skill-notice">已复制技能配置，副本默认停用。修改后保存为独立技能。</p> : null}
                    <div className="commerce-admin-skill-form-row">
                        <Form.Item
                            name="name"
                            label="技能名称"
                            rules={[
                                { required: true, whitespace: true, message: "请输入技能名称" },
                                { max: 100, message: "技能名称不能超过 100 字" },
                            ]}
                        >
                            <Input placeholder="例如：小红书生活感商品摄影" maxLength={100} showCount />
                        </Form.Item>
                        <Form.Item name="type" label="技能类型" rules={[{ required: true, message: "请选择技能类型" }]}>
                            <Select
                                options={TYPE_OPTIONS}
                                onChange={(nextType) => {
                                    const allowed = new Set(commerceOutputs.filter((output) => output.taskType === nextType).map((output) => output.id));
                                    form.setFieldValue(
                                        "outputTypes",
                                        (form.getFieldValue("outputTypes") || []).filter((output: string) => allowed.has(output)),
                                    );
                                }}
                            />
                        </Form.Item>
                    </div>
                    <Form.Item name="description" label="技能简介" rules={[{ max: 600, message: "简介不能超过 600 字" }]}>
                        <Input.TextArea rows={2} maxLength={600} showCount placeholder="说明技能擅长的内容，帮助用户选择" />
                    </Form.Item>
                    <div className="commerce-admin-skill-scope">
                        <Form.Item name="platforms" label="适用平台" rules={[{ type: "array", required: true, min: 1, message: "至少选择一个适用平台" }]}>
                            <Checkbox.Group options={commercePlatforms.map((platform) => ({ value: platform.id, label: platform.name }))} />
                        </Form.Item>
                        <Form.Item
                            name="outputTypes"
                            label="适用创作内容"
                            dependencies={["type"]}
                            extra="仅在选定平台和创作内容中显示该技能。"
                            rules={[
                                { type: "array", required: true, min: 1, message: "至少选择一种创作内容" },
                                ({ getFieldValue }) => ({
                                    validator: (_, values: string[] | undefined) => {
                                        const allowed = new Set(commerceOutputs.filter((output) => output.taskType === getFieldValue("type")).map((output) => output.id));
                                        return values?.some((value) => !allowed.has(value)) ? Promise.reject(new Error("创作内容与技能类型不匹配，请重新选择")) : Promise.resolve();
                                    },
                                }),
                            ]}
                        >
                            <Checkbox.Group options={outputOptions} />
                        </Form.Item>
                    </div>
                    <Form.Item
                        name="systemPrompt"
                        label="技能提示词"
                        extra={formType === "video" ? "视频技能建议精简，给商品信息和创作要求保留空间。描述镜头、节奏、外观一致性和输出要求即可。" : "描述生成目标、执行步骤、内容要求与输出格式；商品资料和平台要求会随创作自动传入。"}
                        rules={[
                            { required: true, whitespace: true, message: "请输入技能提示词" },
                            { max: 12000, message: "技能提示词不能超过 12000 字" },
                        ]}
                    >
                        <Input.TextArea rows={10} maxLength={12000} showCount placeholder="例如：根据商品参考图分析外观与材质，保留品牌和包装细节；结合平台特点构建自然生活场景，按所选类型直接交付文案、图片或视频，保持商品真实外观一致。" />
                    </Form.Item>
                    <div className="commerce-admin-skill-form-row is-settings">
                        <Form.Item name="status" label="状态" rules={[{ required: true, message: "请选择状态" }]}>
                            <Select
                                options={[
                                    { value: 1, label: "启用 · 用户可选" },
                                    { value: 0, label: "停用 · 暂不展示" },
                                ]}
                            />
                        </Form.Item>
                        <Form.Item
                            name="sortOrder"
                            label="排序"
                            extra="数字越小，排列越靠前。"
                            rules={[
                                { required: true, message: "请输入排序值" },
                                { type: "integer", min: 0, max: 100000, message: "排序值需为 0 到 100000 的整数" },
                            ]}
                        >
                            <InputNumber min={0} max={100000} precision={0} className="!w-full" />
                        </Form.Item>
                    </div>
                </Form>
            </Modal>
        </section>
    );
}
