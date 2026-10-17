"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { App, Button, Input, InputNumber, Modal, Select, Table, Tag, type TableProps } from "antd";
import { Copy, Eye, EyeOff, KeyRound, Layers3, Plus, RefreshCw, Ticket } from "lucide-react";
import { IconLabel } from "@/shared/components/icon-label";

import { useCopyText } from "@/shared/hooks/use-copy-text";
import { generateCreditCards, listCreditCardBatches, listCreditCards, type ServerCreditCard, type ServerCreditCardBatch } from "@/services/api/server";
import { ListPagination } from "@/shared/components/list-pagination";
import { useAdminPagination, useClampAdminPage } from "./admin-list-pagination";
import { creditCardBatchText } from "@/app/(user)/credits/credit-card-utils";

const PAGE_SIZE = 20;

/**
 * 渲染管理员卡密批次与库存管理。
 *
 * @returns 卡密管理页面内容
 */
export function CreditCardManagement() {
    const { message } = App.useApp();
    const copyText = useCopyText();
    const [quantity, setQuantity] = useState<number | null>(100);
    const [creditsPerCard, setCreditsPerCard] = useState<number | null>(null);
    const [generated, setGenerated] = useState<{ batchId: number; cardCodes: string[] } | null>(null);
    const { page: batchPage, setPage: setBatchPage, pageSize: batchPageSize, onPaginationChange: changeBatchPage } = useAdminPagination(PAGE_SIZE);
    const { page: cardPage, setPage: setCardPage, pageSize: cardPageSize, onPaginationChange: changeCardPage } = useAdminPagination(PAGE_SIZE);
    const [batchFilter, setBatchFilter] = useState<number | undefined>();
    const [statusFilter, setStatusFilter] = useState<"available" | "redeemed" | undefined>();
    const [cardKeywordInput, setCardKeywordInput] = useState("");
    const [cardKeyword, setCardKeyword] = useState("");
    const [userKeywordInput, setUserKeywordInput] = useState("");
    const [userKeyword, setUserKeyword] = useState("");
    const [includeCode, setIncludeCode] = useState(false);

    const batchesQuery = useQuery({
        queryKey: ["admin-credit-card-batches", batchPage, batchPageSize],
        queryFn: () => listCreditCardBatches({ page: batchPage, pageSize: batchPageSize }),
    });
    const cardsQuery = useQuery({
        queryKey: ["admin-credit-cards", batchFilter, statusFilter, cardKeyword, userKeyword, includeCode, cardPage, cardPageSize],
        queryFn: () => listCreditCards({ batchId: batchFilter, status: statusFilter, cardCode: cardKeyword, redeemedUserKeyword: userKeyword, includeCode, page: cardPage, pageSize: cardPageSize }),
    });

    useClampAdminPage(batchPage, batchPageSize, batchesQuery.data?.total, setBatchPage);
    useClampAdminPage(cardPage, cardPageSize, cardsQuery.data?.total, setCardPage);
    const batchOptions = (batchesQuery.data?.batches || []).map((batch) => ({ value: batch.id, label: `批次 #${batch.id}` }));
    if (batchFilter !== undefined && !batchOptions.some((option) => option.value === batchFilter)) {
        batchOptions.unshift({ value: batchFilter, label: `批次 #${batchFilter}` });
    }

    const handleGenerate = async () => {
        if (!creditsPerCard || creditsPerCard < 1) {
            message.warning("请输入正整数单卡积分");
            return;
        }
        if (quantity === null || !Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
            message.warning("生成数量必须在1到1000之间");
            return;
        }
        try {
            const result = await generateCreditCards({ quantity, creditsPerCard });
            setGenerated({ batchId: result.batchId, cardCodes: result.cardCodes });
            setBatchPage(1);
            setCardPage(1);
            message.success(`已生成 ${result.quantity} 张卡密`);
            await batchesQuery.refetch();
            await cardsQuery.refetch();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "生成卡密失败");
        }
    };

    const batchColumns: TableProps<ServerCreditCardBatch>["columns"] = [
        { title: "批次", dataIndex: "id", width: 90, render: (value: number) => <span className="font-mono tabular-nums">#{value}</span> },
        { title: "单卡积分", dataIndex: "creditsPerCard", width: 110, render: (value: number) => <span className="font-semibold tabular-nums">{value.toLocaleString("zh-CN")}</span> },
        {
            title: "库存",
            dataIndex: "quantity",
            width: 180,
            render: (_: number, record) => (
                <span className="tabular-nums">
                    {record.availableCount} 可用 · {record.redeemedCount} 已兑
                </span>
            ),
        },
        {
            title: "创建管理员",
            dataIndex: "createdByName",
            render: (_: string, record) => (
                <div>
                    <div className="text-[var(--studio-ink)]">{record.createdByName}</div>
                    <div className="text-xs text-[var(--studio-muted)]">{record.createdByEmail}</div>
                </div>
            ),
        },
        { title: "创建时间", dataIndex: "createdAt", width: 180, render: (value: string) => (value ? new Date(value).toLocaleString("zh-CN") : "-") },
    ];

    const cardColumns: TableProps<ServerCreditCard>["columns"] = [
        { title: "卡密", dataIndex: "codeMasked", width: 240, render: (_: string, record) => <span className="font-mono text-xs">{record.code || record.codeMasked}</span> },
        { title: "批次", dataIndex: "batchId", width: 80, render: (value: number) => <span className="font-mono">#{value}</span> },
        { title: "积分", dataIndex: "credits", width: 100, render: (value: number) => <span className="font-semibold tabular-nums">{value.toLocaleString("zh-CN")}</span> },
        { title: "状态", dataIndex: "status", width: 100, render: (value: ServerCreditCard["status"]) => (value === "redeemed" ? <Tag color="green">已兑换</Tag> : <Tag color="blue">未兑换</Tag>) },
        {
            title: "兑换用户",
            dataIndex: "redeemedByEmail",
            width: 220,
            render: (_: string | null, record) =>
                record.redeemedByEmail ? (
                    <div>
                        <div className="truncate text-[var(--studio-ink)]">{record.redeemedByNickname || record.redeemedByUsername || record.redeemedByEmail}</div>
                        <div className="truncate text-xs text-[var(--studio-muted)]">{record.redeemedByEmail}</div>
                    </div>
                ) : (
                    <span className="text-[var(--studio-faint)]">-</span>
                ),
        },
        { title: "兑换时间", dataIndex: "redeemedAt", width: 180, render: (value: string) => (value ? new Date(value).toLocaleString("zh-CN") : "-") },
        {
            title: "积分流水",
            dataIndex: "transactionId",
            width: 150,
            render: (_: number | null, record) =>
                record.transactionId ? (
                    <span className="font-mono text-xs">
                        #{record.transactionId} · 余额 {record.balanceAfter}
                    </span>
                ) : (
                    "-"
                ),
        },
    ];

    return (
        <div>
            <section className="rounded-2xl border border-[var(--studio-line)] bg-[var(--studio-surface)] p-4 sm:p-5">
                <div className="flex flex-wrap items-end justify-between gap-4">
                    <div>
                        <h2 className="flex items-center gap-2 text-base font-semibold text-[var(--studio-ink)]">
                            <KeyRound className="size-4 text-[var(--studio-primary)]" />
                            生成卡密
                        </h2>
                        <p className="mt-1 text-sm text-[var(--studio-muted)]">生成后逐行复制到 LDXP 店铺库存。</p>
                    </div>
                    <div className="studio-credit-card-inputs">
                        <InputNumber min={1} max={1000} precision={0} value={quantity} onChange={setQuantity} addonBefore="数量" />
                        <InputNumber min={1} precision={0} value={creditsPerCard} onChange={(value) => setCreditsPerCard(value)} addonBefore="单卡积分" />
                        <Button type="primary" icon={<Plus className="size-4" />} onClick={() => void handleGenerate()}>
                            生成
                        </Button>
                    </div>
                </div>
            </section>

            <section className="mt-6" aria-labelledby="credit-card-batches-title">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h2 id="credit-card-batches-title" className="studio-section-heading">
                            <IconLabel icon={<Layers3 />}>生成批次</IconLabel>
                        </h2>
                        <p className="mt-1 text-sm text-[var(--studio-muted)]">按批次查看库存和兑换进度</p>
                    </div>
                    <Button icon={<RefreshCw className="size-4" />} onClick={() => void batchesQuery.refetch()}>
                        刷新
                    </Button>
                </div>
                <Table<ServerCreditCardBatch> rowKey="id" columns={batchColumns} dataSource={batchesQuery.data?.batches || []} loading={batchesQuery.isLoading} pagination={false} scroll={{ x: 760 }} />
                <ListPagination className="mt-4" current={batchPage} pageSize={batchPageSize} total={batchesQuery.data?.total || 0} disabled={batchesQuery.isFetching} onChange={changeBatchPage} label="卡密批次分页" />
            </section>

            <section className="mt-8 border-t border-[var(--studio-line)] pt-6" aria-labelledby="credit-card-inventory-title">
                <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                    <div>
                        <h2 id="credit-card-inventory-title" className="studio-section-heading">
                            <IconLabel icon={<Ticket />}>卡密库存</IconLabel>
                        </h2>
                        <p className="mt-1 text-sm text-[var(--studio-muted)]">默认显示脱敏卡密，查看明文前请确认当前操作环境安全</p>
                    </div>
                    <Button icon={includeCode ? <EyeOff className="size-4" /> : <Eye className="size-4" />} onClick={() => setIncludeCode((value) => !value)}>
                        {includeCode ? "隐藏完整卡密" : "查看完整卡密"}
                    </Button>
                </div>
                <div className="mb-4 flex flex-wrap gap-3">
                    <Select<number>
                        allowClear
                        placeholder="全部批次"
                        value={batchFilter}
                        onChange={(value) => {
                            setBatchFilter(value);
                            setCardPage(1);
                        }}
                        className="w-36"
                        options={batchOptions}
                    />
                    <Select<"available" | "redeemed">
                        allowClear
                        placeholder="全部状态"
                        value={statusFilter}
                        onChange={(value) => {
                            setStatusFilter(value);
                            setCardPage(1);
                        }}
                        className="w-36"
                        options={[
                            { value: "available", label: "未兑换" },
                            { value: "redeemed", label: "已兑换" },
                        ]}
                    />
                    <Input.Search
                        allowClear
                        value={cardKeywordInput}
                        onChange={(event) => {
                            const value = event.target.value;
                            setCardKeywordInput(value);
                            if (!value) {
                                setCardKeyword("");
                                setCardPage(1);
                            }
                        }}
                        onSearch={() => {
                            setCardKeyword(cardKeywordInput);
                            setCardPage(1);
                        }}
                        placeholder="完整卡密或末四位"
                        className="w-60"
                    />
                    <Input.Search
                        allowClear
                        value={userKeywordInput}
                        onChange={(event) => {
                            const value = event.target.value;
                            setUserKeywordInput(value);
                            if (!value) {
                                setUserKeyword("");
                                setCardPage(1);
                            }
                        }}
                        onSearch={() => {
                            setUserKeyword(userKeywordInput);
                            setCardPage(1);
                        }}
                        placeholder="兑换用户/邮箱"
                        className="w-52"
                    />
                </div>
                <Table<ServerCreditCard> rowKey="id" columns={cardColumns} dataSource={cardsQuery.data?.cards || []} loading={cardsQuery.isLoading} pagination={false} scroll={{ x: 1_200 }} />
                <ListPagination className="mt-4" current={cardPage} pageSize={cardPageSize} total={cardsQuery.data?.total || 0} disabled={cardsQuery.isFetching} onChange={changeCardPage} label="卡密库存分页" />
            </section>

            <Modal
                title={`批次 #${generated?.batchId || ""} 卡密`}
                open={Boolean(generated)}
                onCancel={() => setGenerated(null)}
                footer={
                    <Button type="primary" icon={<Copy className="size-4" />} onClick={() => generated && copyText(creditCardBatchText(generated.cardCodes), "卡密已复制")}>
                        一键复制全部卡密
                    </Button>
                }
                width={640}
            >
                <Input.TextArea value={generated ? creditCardBatchText(generated.cardCodes) : ""} readOnly rows={14} className="font-mono text-xs" />
            </Modal>
        </div>
    );
}
