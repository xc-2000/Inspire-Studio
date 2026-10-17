"use client";

import { useEffect, useState } from "react";
import { Alert, App, Button, Form, Input, InputNumber, Modal, Switch, Table, Tag } from "antd";
import { Package, Pencil, Plus, Power, RefreshCw, Sparkles } from "lucide-react";
import { IconLabel } from "@/shared/components/icon-label";
import { getPaymentPackages, savePaymentPackages, type ManagedPaymentPackage, type PaymentPackageSettings } from "@/services/api/server";
import { ListPagination } from "@/shared/components/list-pagination";
import { PaymentSettings } from "./payment-settings";
import { PaymentOrders, paymentPrice } from "./payment-orders";
import { packageUnitPrice } from "./package-pricing";

type PackageForm = { name: string; price: string; credits: number; enabled: boolean; sortOrder: number; subtitle: string; recommended: boolean; featuresText: string };
export function PaymentManagement() {
    const [refresh, setRefresh] = useState(0);
    return <><PaymentSettings refreshVersion={refresh} /><PackageManagement onSaved={() => setRefresh(v => v + 1)} /><PaymentOrders admin /></>;
}

function PackageManagement({ onSaved }: { onSaved: () => void }) {
    const { message } = App.useApp();
    const [settings, setSettings] = useState<PaymentPackageSettings>();
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [editing, setEditing] = useState<ManagedPaymentPackage | "new" | null>(null);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [reload, setReload] = useState(0);
    const [form] = Form.useForm<PackageForm>();
    useEffect(() => {
        let active = true; setLoading(true); setError("");
        getPaymentPackages().then(data => { if (active) setSettings(data); }).catch(e => { if (active) setError(e instanceof Error ? e.message : "套餐加载失败"); }).finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [reload]);
    const persist = async (items: ManagedPaymentPackage[]) => {
        if (!settings || saving) return false;
        setSaving(true); setError("");
        try {
            setSettings(await savePaymentPackages({ version: settings.version, items }));
            onSaved(); void message.success("套餐已保存，立即生效"); return true;
        } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); return false; }
        finally { setSaving(false); }
    };
    const edit = (item: ManagedPaymentPackage | "new") => {
        setEditing(item);
        form.setFieldsValue(item === "new" ? { name: "", price: "", credits: undefined, enabled: false, sortOrder: 0, subtitle: "", recommended: false, featuresText: "支持图片与视频生成\n可用于画布与电商创作\n微信支付，积分自动到账" } : { name: item.name, price: (item.amountFen / 100).toFixed(2), credits: item.credits, enabled: item.enabled, sortOrder: item.sortOrder, subtitle: item.subtitle || "", recommended: !!item.recommended, featuresText: item.features?.join("\n") || "" });
    };
    const submit = async () => {
        if (!settings || !editing) return;
        let values: PackageForm;
        try { values = await form.validateFields(); } catch { return; }
        const [whole, fraction = ""] = String(values.price).split(".");
        const amountFen = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
        const updated: ManagedPaymentPackage = { id: editing === "new" ? crypto.randomUUID() : editing.id, name: values.name.trim(), amountFen, credits: values.credits, enabled: values.enabled, sortOrder: values.sortOrder, subtitle: values.subtitle?.trim() || "", recommended: !!values.recommended, features: (values.featuresText || "").split("\n").map(line => line.trim()).filter(Boolean) };
        const nextItems = editing === "new" ? [...settings.items, updated] : settings.items.map(p => p.id === updated.id ? updated : p);
        const items = updated.recommended && updated.enabled ? nextItems.map(p => p.id === updated.id ? p : { ...p, recommended: false }) : nextItems;
        if (await persist(items)) setEditing(null);
    };
    const items = settings?.items ?? [];
    return <section className="studio-panel-solid mb-6 min-w-0 space-y-4 p-4 sm:p-5" aria-label="充值套餐管理">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="studio-section-heading"><IconLabel icon={<Package />}>充值套餐</IconLabel></h2><p className="mt-1 text-xs text-[var(--studio-muted)]">价格单位为元，排序值越小越靠前。修改不影响已创建订单，最多 20 档。</p></div><div className="flex flex-wrap gap-2"><Button icon={<RefreshCw size={15} />} disabled={saving} onClick={() => setReload(v => v + 1)}>刷新套餐</Button><Button type="primary" icon={<Plus size={15} />} disabled={!settings || loading || saving || items.length >= 20} onClick={() => edit("new")}>新增套餐</Button></div></div>
        {error && <Alert type="error" title={error} />}
        <Table rowKey="id" size="small" loading={loading} pagination={false} scroll={{ x: 650 }} dataSource={items.slice((page - 1) * pageSize, page * pageSize)} columns={[
            { title: "套餐名称", dataIndex: "name", width: 220, render: (_: string, item: ManagedPaymentPackage) => <div><span className="font-medium">{item.name}</span>{item.recommended && <Tag className="ml-2" color="blue" icon={<Sparkles size={12} />}>推荐</Tag>}{item.subtitle && <p className="mt-1 text-xs text-[var(--studio-muted)]">{item.subtitle}</p>}</div> },
            { title: "价格 / 单价", dataIndex: "amountFen", render: (_: number, item: ManagedPaymentPackage) => <div>{paymentPrice(item.amountFen)}<p className="mt-1 text-xs text-[var(--studio-muted)]">{packageUnitPrice(item)} / 积分</p></div>, width: 160 },
            { title: "积分", dataIndex: "credits", width: 100 },
            { title: "排序", dataIndex: "sortOrder", width: 80 },
            { title: "状态", dataIndex: "enabled", width: 100, render: (enabled: boolean) => <Tag color={enabled ? "green" : "default"}>{enabled ? "已上架" : "已下架"}</Tag> },
            { title: "操作", width: 190, render: (_: unknown, item: ManagedPaymentPackage) => <div className="flex gap-1"><Button type="link" icon={<Pencil size={14} />} disabled={saving || loading} onClick={() => edit(item)}>编辑</Button><Button type="link" icon={<Power size={14} />} disabled={saving || loading} onClick={() => void persist(items.map(p => p.id === item.id ? { ...p, enabled: !p.enabled } : p))}>{item.enabled ? "下架" : "上架"}</Button></div> },
        ]} />
        <ListPagination label="充值套餐分页" current={page} pageSize={pageSize} total={items.length} pageSizeOptions={[5, 10, 20]} onChange={(next, size) => { setPage(size === pageSize ? next : 1); setPageSize(size); }} />
        <Modal title={editing === "new" ? "新增充值套餐" : "编辑充值套餐"} width={600} centered styles={{ body: { maxHeight: "calc(100dvh - 180px)", overflowY: "auto", paddingRight: 6 } }} open={!!editing} confirmLoading={saving} okText="保存套餐" cancelText="取消" onOk={() => void submit()} onCancel={() => { if (!saving) setEditing(null); }} closable={!saving} maskClosable={!saving} cancelButtonProps={{ disabled: saving }}>
            {error && <Alert className="mb-4" type="error" title={error} />}
            <Form form={form} layout="vertical" disabled={saving}>
                <Form.Item name="name" label="套餐名称" rules={[{ required: true, whitespace: true, message: "请输入套餐名称" }, { max: 40, message: "最多40字" }]}><Input maxLength={40} placeholder="例如：基础套餐" /></Form.Item>
                <Form.Item name="subtitle" label="套餐简介" rules={[{ max: 80, message: "最多80字" }]}><Input maxLength={80} placeholder="例如：适合日常创作与灵感探索" /></Form.Item>
                <div className="grid gap-x-4 sm:grid-cols-2">
                <Form.Item name="price" label="价格（元）" rules={[{ required: true, message: "请输入价格" }, { validator: (_, value) => /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(String(value)) && Number(value) >= 0.01 && Number(value) <= 10000 ? Promise.resolve() : Promise.reject(new Error("请输入0.01至10000元，最多两位小数")) }]}><InputNumber stringMode min="0.01" max="10000" step="0.01" style={{ width: "100%" }} /></Form.Item>
                <Form.Item name="credits" label="到账积分" rules={[{ required: true, type: "integer", min: 1, max: 10000000, message: "请输入1至10000000的整数" }]}><InputNumber min={1} max={10000000} precision={0} style={{ width: "100%" }} /></Form.Item>
                </div>
                <Form.Item name="featuresText" label="套餐说明" extra="每行一条，最多6条，每条最多60字。展示真实可用的功能。" rules={[{ validator: (_, value: string) => { const lines = (value || "").split("\n").map(line => line.trim()).filter(Boolean); return lines.length <= 6 && lines.every(line => line.length <= 60) ? Promise.resolve() : Promise.reject(new Error("最多6条说明，每条最多60字")); } }]}><Input.TextArea rows={3} placeholder="支持图片与视频生成" /></Form.Item>
                <div className="grid gap-x-4 sm:grid-cols-3">
                <Form.Item name="sortOrder" label="排序" rules={[{ required: true, type: "integer", min: 0, max: 9999, message: "请输入0至9999的整数" }]}><InputNumber min={0} max={9999} precision={0} style={{ width: "100%" }} /></Form.Item>
                <Form.Item name="recommended" label="推荐套餐" valuePropName="checked" extra="上架后替换原推荐"><Switch checkedChildren="推荐" unCheckedChildren="普通" /></Form.Item>
                <Form.Item name="enabled" label="上架状态" valuePropName="checked"><Switch checkedChildren="上架" unCheckedChildren="下架" /></Form.Item>
                </div>
            </Form>
        </Modal>
    </section>;
}
