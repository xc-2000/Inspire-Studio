"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Skeleton, Switch, Tag } from "antd";
import { CreditCard, RefreshCw } from "lucide-react";
import { IconLabel } from "@/shared/components/icon-label";
import { getPaymentSettings, savePaymentSettings, type PaymentCollectionSettings } from "@/services/api/server";

export function PaymentSettings({ refreshVersion = 0 }: { refreshVersion?: number }) {
    const [settings, setSettings] = useState<PaymentCollectionSettings>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [revision, setRevision] = useState(0);
    useEffect(() => {
        let active = true;
        setError("");
        getPaymentSettings().then(data => { if (active) setSettings(data); }).catch(e => { if (active) setError(e instanceof Error ? e.message : "设置读取失败"); });
        return () => { active = false; };
    }, [revision, refreshVersion]);
    const toggle = async (enabled: boolean) => {
        setBusy(true); setError("");
        try { setSettings(await savePaymentSettings(enabled)); }
        catch (e) { setError(e instanceof Error ? e.message : "设置保存失败，请重试"); }
        finally { setBusy(false); }
    };
    return <section className="studio-panel-solid mb-6 space-y-4 p-5" aria-label="微信收款设置">
        <div className="flex items-center justify-between gap-4">
            <div><h2 id="wechat-collection-label" className="studio-section-heading"><IconLabel icon={<CreditCard />}>微信收款</IconLabel></h2><p className="mt-1 text-xs leading-5 text-[var(--studio-muted)]">修改后自动保存，即时生效。关闭后停止新下单，已有订单继续确认与到账。</p></div>
            <Switch aria-labelledby="wechat-collection-label" checked={settings?.enabled ?? false} disabled={!settings || busy} loading={busy} checkedChildren="开启" unCheckedChildren="关闭" onChange={enabled => void toggle(enabled)} />
        </div>
        {!settings && !error && <Skeleton active paragraph={{ rows: 1 }} title={false} />}
        {error && <Alert type="error" title={error} action={<Button size="small" icon={<RefreshCw size={14} />} onClick={() => setRevision(v => v + 1)}>重新读取</Button>} />}
        {settings && <div className="flex flex-wrap gap-2">
            <Tag color={settings.acceptingPayments ? "green" : "default"}>{settings.acceptingPayments ? "当前可收款" : "当前未开放收款"}</Tag>
            <Tag color={settings.merchantConfigured ? "green" : "orange"}>{settings.merchantConfigured ? "商户已配置" : "商户配置不完整"}</Tag>
            <Tag color={settings.packagesConfigured ? "green" : "orange"}>{settings.packagesConfigured ? "套餐已配置" : "尚未配置套餐"}</Tag>
        </div>}
        {settings?.enabled && !settings.acceptingPayments && <Alert type="info" title="开关已开启，补齐商户配置和套餐后才会开放购买。" />}
    </section>;
}
