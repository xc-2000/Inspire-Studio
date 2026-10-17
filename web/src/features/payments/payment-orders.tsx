"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Table } from "antd";
import { ArrowUpRight, Check, Clock3, ReceiptText, RefreshCw, Sparkle, X } from "lucide-react";
import { listPaymentOrders, type CreditPaymentOrder } from "@/services/api/server";
import { ListPagination } from "@/shared/components/list-pagination";
import "./payment-appearance.css";

export const paymentPrice = (fen: number) => `¥${(fen / 100).toFixed(2)}`;
export function PaymentOrders({ admin = false, revision = 0, onOpen }: { admin?: boolean; revision?: number; onOpen?: (order: CreditPaymentOrder) => void }) {
    const [page, setPage] = useState(1);
    const [size, setSize] = useState(20);
    const [data, setData] = useState<{ items: CreditPaymentOrder[]; total: number }>({ items: [], total: 0 });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [reload, setReload] = useState(0);
    useEffect(() => {
        let active = true;
        let timer: ReturnType<typeof setTimeout>;
        const load = async (initial = false) => {
            if (initial) { setLoading(true); setError(""); }
            let pollAgain = false;
            try {
                const result = await listPaymentOrders(page, size, admin);
                if (!active) return;
                setData(result); setError("");
                pollAgain = result.items.some(item => item.status === "PENDING");
            } catch (e) {
                if (active) setError(e instanceof Error ? e.message : "订单加载失败");
                pollAgain = true;
            } finally {
                if (active) {
                    setLoading(false);
                    if (pollAgain) timer = setTimeout(() => void load(), 3000);
                }
            }
        };
        void load(true);
        return () => { active = false; clearTimeout(timer); };
    }, [page, size, admin, revision, reload]);
    return <section className="credit-orders min-w-0" aria-label="微信支付订单">
        <div className="credit-orders-heading"><div className="flex min-w-0 items-center gap-3"><span className="credit-section-icon"><ReceiptText size={18} aria-hidden="true" /></span><div><h2>微信支付订单 <span className="credit-order-count">{data.total}</span></h2><p>查看充值记录与到账状态</p></div></div><Button icon={<RefreshCw size={14} aria-hidden="true" />} onClick={() => setReload(v => v + 1)} loading={loading}>刷新订单</Button></div>
        {error && <Alert type="error" title={error} />}
        <Table className="credit-orders-table" rowKey="orderNo" size="small" loading={loading} dataSource={data.items} pagination={false} scroll={{ x: 960 }} columns={[
            { title: "订单号", dataIndex: "orderNo", width: 280, render: (value: string) => <span className="credit-order-number">{value}</span> },
            ...(admin ? [{ title: "用户 ID", dataIndex: "userId", width: 90 }] : []),
            { title: "套餐", dataIndex: "description", width: 200, render: (value: string) => <span className="credit-order-description">{value}</span> },
            { title: "金额", dataIndex: "amountFen", render: (value: number) => <span className="font-semibold tabular-nums text-[var(--studio-ink)]">{paymentPrice(value)}</span>, width: 90 },
            { title: "积分", dataIndex: "credits", width: 100, render: (value: number) => <span className="inline-flex items-center gap-1.5 tabular-nums"><Sparkle size={12} className="text-[var(--studio-action)]" fill="currentColor" strokeWidth={0} aria-hidden="true" />{value.toLocaleString("zh-CN")}</span> },
            { title: "状态", dataIndex: "status", width: 110, render: (status: string, row: CreditPaymentOrder) => {
                const Icon = status === "PAID" ? Check : status === "PENDING" ? Clock3 : X;
                return <span className="credit-order-status" data-status={status}><Icon size={12} aria-hidden="true" />{status === "PAID" ? "已到账" : status === "CLOSED" ? "已取消" : Date.parse(row.expiresAt) <= Date.now() ? "取消确认中" : "待支付"}</span>;
            } },
            { title: "创建时间", dataIndex: "createdAt", width: 180, render: (value: string) => new Date(value).toLocaleString("zh-CN") },
            ...(!admin && onOpen ? [{ title: "操作", width: 116, render: (_: unknown, row: CreditPaymentOrder) => <Button type="link" className="credit-order-open" onClick={() => onOpen(row)}>查看订单 <ArrowUpRight size={13} aria-hidden="true" /></Button> }] : []),
        ]} />
        <ListPagination className="credit-orders-pagination" label="微信订单分页" current={page} pageSize={size} total={data.total} onChange={(next, nextSize) => { setPage(nextSize === size ? next : 1); setSize(nextSize); }} />
    </section>;
}
