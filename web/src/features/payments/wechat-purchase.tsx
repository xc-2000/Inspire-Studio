"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Modal, QRCode, Result, Skeleton } from "antd";
import Link from "next/link";
import { ArrowUpRight, ShieldCheck, Sparkle, Ticket } from "lucide-react";
import { createPaymentOrder, getPaymentCatalog, getPaymentOrder, getCurrentUserInfo, type CreditPaymentPackage, type CreditPaymentOrder } from "@/services/api/server";
import { useUserStore } from "@/features/auth/stores/use-user-store";
import { PaymentOrders, paymentPrice } from "./payment-orders";
import { PackageCard } from "./package-card";
import { entryPackage } from "./package-pricing";
import "./payment-appearance.css";

function RedeemCard({ compact = false }: { compact?: boolean }) {
    return <aside className={`credit-redeem-card ${compact ? "credit-redeem-card--compact" : ""}`} aria-label="卡密兑换">
        <div className="credit-redeem-art" aria-hidden="true"><Ticket strokeWidth={1.2} /><Sparkle className="credit-redeem-spark" fill="currentColor" strokeWidth={0} /></div>
        <div className="credit-redeem-copy">
            <p className="credit-section-eyebrow">另一种充值方式</p>
            <h2>已有卡密？直接兑换</h2>
            <p className="credit-redeem-description">输入兑换码，将积分充值到当前账号。</p>
            <Link href="/credits/redeem" className="credit-redeem-link">兑换积分 <ArrowUpRight size={15} aria-hidden="true" /></Link>
        </div>
    </aside>;
}

export function WechatPurchase() {
    const { message } = App.useApp();
    const [catalog, setCatalog] = useState<{ enabled: boolean; packages: CreditPaymentPackage[] }>();
    const [error, setError] = useState("");
    const [loadingId, setLoadingId] = useState("");
    const [order, setOrder] = useState<CreditPaymentOrder | null>(null);
    const [revision, setRevision] = useState(0);
    const [now, setNow] = useState(Date.now());
    const request = useRef<{ packageId: string; id: string } | null>(null);
    const busy = useRef(false);
    const [catalogRevision, setCatalogRevision] = useState(0);
    useEffect(() => {
        let active = true; setError("");
        getPaymentCatalog().then(data => { if (active) setCatalog(data); }).catch(e => { if (active) setError(e.message); });
        return () => { active = false; };
    }, [catalogRevision]);
    useEffect(() => {
        if (!order || order.status !== "PENDING") return;
        setNow(Date.now());
        const tick = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(tick);
    }, [order?.orderNo, order?.status]);
    useEffect(() => {
        if (!order || order.status !== "PENDING") return;
        let active = true;
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                const next = await getPaymentOrder(order.orderNo);
                if (!active) return;
                setOrder(next); setError(""); setNow(Date.now());
                if (next.status === "PAID") {
                    setRevision(v => v + 1); request.current = null;
                    void getCurrentUserInfo().then(user => useUserStore.getState().setUser(user)).catch(() => {});
                    return;
                }
                if (next.status === "CLOSED") { request.current = null; setRevision(v => v + 1); return; }
            } catch { if (active) setError("暂时无法查询支付结果，正在重试。请勿重复付款。"); }
            const remaining = Date.parse(order.expiresAt) - Date.now();
            if (active) timer = setTimeout(poll, remaining > 0 ? Math.min(5000, remaining + 50) : 3000);
        };
        void poll();
        return () => { active = false; clearTimeout(timer); };
    }, [order?.orderNo, order?.status, order?.expiresAt]);
    const buy = async (pack: CreditPaymentPackage) => {
        if (busy.current) return;
        busy.current = true; setLoadingId(pack.id); setError("");
        if (request.current?.packageId !== pack.id) request.current = { packageId: pack.id, id: crypto.randomUUID() };
        try {
            const result = await createPaymentOrder(pack.id, request.current.id);
            setOrder(result); setNow(Date.now()); setRevision(v => v + 1);
        } catch (e) { setError(e instanceof Error ? e.message : "下单失败"); setRevision(v => v + 1); }
        finally { busy.current = false; setLoadingId(""); }
    };
    const open = async (item: CreditPaymentOrder) => {
        try {
            const next = await getPaymentOrder(item.orderNo);
            setOrder(next); setNow(Date.now());
            if (next.status === "PAID") {
                setRevision(v => v + 1);
                void getCurrentUserInfo().then(user => useUserStore.getState().setUser(user)).catch(() => {});
            }
        }
        catch (e) { void message.error(e instanceof Error ? e.message : "查询失败"); }
    };
    const expired = !!order && now >= Date.parse(order.expiresAt);
    const remainingSeconds = order ? Math.max(0, Math.ceil((Date.parse(order.expiresAt) - now) / 1000)) : 0;
    const baseline = entryPackage(catalog?.packages || []);
    return <div className="credit-purchase space-y-7">
        {error && <Alert type="warning" title={error} action={!catalog ? <Button onClick={() => setCatalogRevision(v => v + 1)}>重试</Button> : undefined} />}
        {!catalog && !error ? <Skeleton active /> : catalog?.enabled ? <section aria-label="微信充值套餐" className="credit-package-section">
            <div className="credit-section-heading">
                <div className="flex items-center gap-2.5"><span className="credit-section-icon"><Sparkle size={17} aria-hidden="true" /></span><h2>选择积分套餐</h2></div>
                <span className="credit-payment-note"><ShieldCheck size={14} aria-hidden="true" /> 微信支付 · 自动到账</span>
            </div>
            <div className="credit-plan-grid">
                {catalog.packages.map(pack => <PackageCard key={pack.id} pack={pack} baseline={baseline} loading={loadingId === pack.id} disabled={!!loadingId} onBuy={() => void buy(pack)} />)}
            </div>
            {baseline && catalog.packages.length > 1 && <p className="credit-plan-comparison">优惠比例按「{baseline.name}」的单积分价格计算。实际生成消耗以所选模型报价为准。</p>}
        </section> : catalog && <Alert type="info" title="微信支付暂未开放" description="充值套餐开放后，可在这里微信扫码支付，积分自动到账。已有卡密仍可前往兑换。" />}
        {catalog && <RedeemCard compact />}
        <PaymentOrders revision={revision} onOpen={item => void open(item)} />
        <Modal title="微信扫码支付" open={!!order} onCancel={() => { if (order && (order.status !== "PENDING" || Date.parse(order.expiresAt) <= Date.now())) request.current = null; setOrder(null); setError(""); setRevision(v => v + 1); }} footer={null} destroyOnHidden>
            {order?.status === "PAID" ? <Result status="success" title="支付成功，积分已到账" subTitle={`本次充值 ${order.credits} 积分`} /> : order && <div className="flex flex-col items-center gap-4 py-5">
                <p className="text-3xl font-semibold">{paymentPrice(order.amountFen)}</p><p>{order.credits} 积分 · {order.description}</p>
                {order.status === "CLOSED" ? <Alert type="info" title="订单已取消" description="订单已关闭，无法继续付款。需要充值请关闭此窗口后重新购买。" /> : expired ? <Alert type="info" title="支付时间已到，正在确认取消" description="正在核实支付结果并关闭未付款订单，页面会自动更新。若刚刚付款，请等待确认。" /> : order.codeUrl ? <><QRCode value={order.codeUrl} size={220} bgColor="#ffffff" color="#111111" /><p className="text-sm text-[var(--studio-muted)]">请使用另一台设备的微信扫一扫</p><p className="text-sm tabular-nums text-[var(--studio-action)]">请在 {remainingSeconds} 秒内完成支付</p><p className="text-xs text-[var(--studio-muted)]">订单创建 1 分钟内未付款将自动取消</p></> : <Alert type="info" title="支付二维码暂不可用，请稍后查询订单" />}
                <p className="break-all text-xs text-[var(--studio-muted)]">订单号：{order.orderNo}</p>
                {order.status === "PENDING" && <Button onClick={() => void open(order)}>我已支付，查询结果</Button>}
                {error && <Alert type="warning" title={error} />}
            </div>}
        </Modal>
    </div>;
}
