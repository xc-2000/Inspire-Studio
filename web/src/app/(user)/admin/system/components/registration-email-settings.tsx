"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Checkbox, Input, Modal, Switch, Tag } from "antd";
import { Mail, Plus, RefreshCw, Search, Settings2, ShieldCheck, X } from "lucide-react";
import {
    getRegistrationEmailSettings, updateRegistrationEmailSettings,
    type RegistrationEmailSettings as Settings,
} from "@/services/api/server";
import { EMAIL_PROVIDER_GROUPS, normalizeEmailDomain } from "@/features/auth/lib/registration-email";

const PRESET_DOMAINS = new Set<string>(EMAIL_PROVIDER_GROUPS.flatMap(group => group.items.map(([, domain]) => domain)));

export function RegistrationEmailSettings() {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const query = useQuery({ queryKey: ["admin-registration-email"], queryFn: getRegistrationEmailSettings });
    const [draft, setDraft] = useState<Settings | null>(null);
    const [search, setSearch] = useState("");
    const [custom, setCustom] = useState("");
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState("");
    const selected = new Set(draft?.allowedDomains ?? []);
    const matches = (label: string, domain: string) => (label + " " + domain).toLowerCase().includes(search.trim().toLowerCase());
    const customDomains = draft?.allowedDomains.filter(domain => !PRESET_DOMAINS.has(domain)) ?? [];
    const visibleDomains = [
        ...EMAIL_PROVIDER_GROUPS.flatMap(group => group.items.filter(([label, domain]) => matches(label, domain)).map(([, domain]) => domain)),
        ...customDomains.filter(domain => matches("", domain)),
    ];

    const setDomains = (domains: string[]) => {
        const unique = [...new Set(domains)];
        if (unique.length > 100) { message.warning("最多开放 100 个邮箱后缀"); return; }
        setDraft(value => value ? { ...value, allowedDomains: unique } : value);
    };
    const toggleDomain = (domain: string, checked: boolean) =>
        setDomains(checked ? [...selected, domain] : [...selected].filter(item => item !== domain));

    const open = () => {
        if (!query.data) return;
        setDraft({ ...query.data, allowedDomains: [...query.data.allowedDomains] });
        setSearch(""); setCustom(""); setSaveError("");
    };
    const addCustom = () => {
        const tokens = custom.split(/[\s,，;；]+/).filter(Boolean);
        const domains = tokens.map(normalizeEmailDomain);
        if (!domains.length || domains.some(domain => !domain)) {
            message.warning("请输入有效邮箱后缀，例如 company.com；多个用逗号分隔");
            return;
        }
        const next = [...new Set([...selected, ...domains as string[]])];
        if (next.length > 100) { message.warning("最多开放 100 个邮箱后缀"); return; }
        setDomains(next); setCustom("");
    };
    const save = async () => {
        if (!draft) return;
        if (custom.trim()) { message.warning("请先添加自定义后缀，或清空输入后保存"); return; }
        setSaving(true); setSaveError("");
        try {
            const result = await updateRegistrationEmailSettings(draft);
            queryClient.setQueryData(["admin-registration-email"], result);
            await queryClient.invalidateQueries({ queryKey: ["registration-email-policy"] });
            setDraft(null);
            message.success("注册邮箱设置已生效");
        } catch (error) {
            setSaveError(error instanceof Error ? error.message : "保存失败，请重试");
        } finally { setSaving(false); }
    };
    const domainCheckbox = (label: string, domain: string) => (
        <Checkbox key={domain} checked={selected.has(domain)} onChange={event => toggleDomain(domain, event.target.checked)}
            className={"!m-0 !flex min-w-0 !items-center rounded-xl border !px-3 !py-2.5 transition-colors [&_.ant-checkbox-label]:min-w-0 [&_.ant-checkbox-label]:flex-1 [&_.ant-checkbox-label]:pr-0 " +
            (selected.has(domain) ? "border-[var(--studio-accent)] bg-[var(--studio-accent-soft)]" : "border-[var(--studio-line)] bg-[var(--studio-surface-soft)]")}>
            <span className="min-w-0"><span className="block truncate text-sm text-[var(--studio-ink)]">{label}</span><span className="block truncate text-xs text-[var(--studio-muted)]">{domain}</span></span>
        </Checkbox>
    );

    return (
        <>
            <section className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--studio-line)] bg-[var(--studio-surface-soft)] p-4" aria-label="注册邮箱限制">
                <div className="flex min-w-0 items-center gap-3">
                    <span className="rounded-xl border border-[var(--studio-line)] p-2.5 text-[var(--studio-accent)]"><ShieldCheck className="size-5" /></span>
                    <div>
                        <div className="flex flex-wrap items-center gap-2"><h3 className="font-medium text-[var(--studio-ink)]">注册邮箱</h3>
                            {query.data && <Tag>{!query.data.enabled ? "全部开放" : query.data.allowedDomains.length ? "已开放 " + query.data.allowedDomains.length + " 个后缀" : "等待开放"}</Tag>}
                        </div>
                        <p className="mt-1 text-xs text-[var(--studio-muted)]">{query.isError ? "注册设置加载失败，请重试" : "按邮箱后缀控制新用户注册，已有账号登录不受影响。"}</p>
                    </div>
                </div>
                {query.isError
                    ? <Button icon={<RefreshCw className="size-4" />} onClick={() => void query.refetch()}>重试</Button>
                    : <Button icon={<Settings2 className="size-4" />} loading={query.isPending} disabled={!query.data} onClick={open}>配置邮箱</Button>}
            </section>
            <Modal title={<span className="flex items-center gap-2"><Mail className="size-5 text-[var(--studio-accent)]" />注册邮箱管理</span>}
                open={!!draft} onCancel={() => !saving && setDraft(null)} width={760} destroyOnHidden
                style={{ top: 24 }} styles={{ body: { maxHeight: "calc(100dvh - 200px)", overflowY: "auto" } }}
                footer={<div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-xs text-[var(--studio-muted)]">{draft?.enabled ? "已选 " + selected.size + " 个后缀，保存后生效" : "允许任意格式正确的邮箱注册"}</span>
                    <div className="flex gap-2"><Button disabled={saving} onClick={() => setDraft(null)}>取消</Button><Button type="primary" loading={saving} onClick={() => void save()}>保存设置</Button></div>
                </div>}>
                {draft && <div className="space-y-4 pt-3">
                    <div className="flex items-center justify-between gap-4 rounded-xl bg-[var(--studio-surface-soft)] p-3">
                        <div><label htmlFor="registration-email-limit" className="font-medium">限制注册邮箱</label><p className="mt-1 text-xs text-[var(--studio-muted)]">开启后仅允许勾选的后缀；未勾选时暂停新注册。</p></div>
                        <Switch id="registration-email-limit" checked={draft.enabled} disabled={saving} onChange={enabled => setDraft({ ...draft, enabled })} />
                    </div>
                    {!draft.enabled && <Alert type="info" showIcon title="当前为全部开放，勾选名单将在开启限制后生效。" />}
                    {saveError && <Alert type="error" showIcon title={saveError} action={<Button size="small" onClick={async () => {
                        const result = await query.refetch();
                        if (result.data) { setDraft({ ...result.data, allowedDomains: [...result.data.allowedDomains] }); setSaveError(""); }
                    }}>重新加载</Button>} />}
                    <div className="flex flex-wrap items-center gap-2">
                        <Input className="!w-full sm:!w-64" prefix={<Search className="size-4 text-[var(--studio-muted)]" />} placeholder="搜索邮箱名称或后缀" value={search} onChange={e => setSearch(e.target.value)} allowClear />
                        <Button size="small" type="text" disabled={saving} onClick={() => setDomains([...selected, ...visibleDomains])}>全选{search ? "搜索结果" : "列表"}</Button>
                        <Button size="small" type="text" disabled={saving} onClick={() => setDomains([...selected].filter(domain => !visibleDomains.includes(domain)))}>取消选择{search ? "结果" : ""}</Button>
                    </div>
                    <fieldset disabled={saving} className="min-w-0 space-y-4 pr-1">
                        {EMAIL_PROVIDER_GROUPS.map(group => {
                            const items = group.items.filter(([label, domain]) => matches(label, domain));
                            return items.length > 0 && <div key={group.name}><h4 className="mb-2 text-xs font-medium text-[var(--studio-muted)]">{group.name}</h4>
                                <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 sm:grid-cols-3">{items.map(([label, domain]) => domainCheckbox(label, domain))}</div>
                            </div>;
                        })}
                        {customDomains.length > 0 && <div><h4 className="mb-2 text-xs font-medium text-[var(--studio-muted)]">自定义邮箱</h4><div className="flex flex-wrap gap-2">
                            {customDomains.filter(domain => matches("", domain)).map(domain => <span key={domain} className="flex items-center gap-1 rounded-lg border border-[var(--studio-line)] px-2 py-1 text-sm">{domain}<Button type="text" size="small" aria-label={"移除 " + domain} icon={<X className="size-3.5" />} onClick={() => toggleDomain(domain, false)} /></span>)}
                        </div></div>}
                        {visibleDomains.length === 0 && <p className="py-6 text-center text-sm text-[var(--studio-muted)]">没有匹配的邮箱，可在下方添加自定义后缀。</p>}
                    </fieldset>
                    <div className="border-t border-[var(--studio-line)] pt-3">
                        <label htmlFor="custom-email-domain" className="mb-2 block text-sm font-medium">企业 / 自定义邮箱后缀</label>
                        <div className="flex gap-2"><Input id="custom-email-domain" value={custom} disabled={saving} onChange={e => setCustom(e.target.value)} placeholder="company.com，school.edu.cn" onPressEnter={addCustom} /><Button icon={<Plus className="size-4" />} disabled={saving} onClick={addCustom}>添加</Button></div>
                        <p className="mt-2 text-xs text-[var(--studio-muted)]">精确匹配后缀，子域名需单独添加；不支持通配符。最多 100 个。</p>
                    </div>
                </div>}
            </Modal>
        </>
    );
}

