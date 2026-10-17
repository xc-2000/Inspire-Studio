"use client";

import { useEffect, useMemo, useState } from "react";
import dayjs, { type Dayjs } from "dayjs";
import { Alert, App, Button, DatePicker, Empty, Input, Table, Tag, type TableProps } from "antd";
import { CheckCircle2, Search, Ticket, History, Sparkles, RefreshCw, KeyRound } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { useUserStore } from "@/features/auth/stores/use-user-store";
import { ListPagination } from "@/shared/components/list-pagination";
import { clampPage } from "@/shared/lib/pagination";
import { IconLabel } from "@/shared/components/icon-label";
import { PageShell } from "@/shared/components/page-shell";
import { CreditNavigation } from "../components/credit-navigation";
import { listRedemptionRecords, redeemCredits, type ServerRedemptionRecord } from "@/services/api/server";
import { isCreditCardCode, normalizeCreditCardCode } from "../credit-card-utils";

const REDEMPTION_PAGE_SIZE = 20;

const REDEMPTION_COLUMNS: TableProps<ServerRedemptionRecord>["columns"] = [
    {
        title: "卡密",
        dataIndex: "cardCode",
        render: (value: string) => <span className="font-mono text-xs text-[var(--studio-text)]">{value}</span>,
    },
    {
        title: "兑换积分",
        dataIndex: "credits",
        width: 130,
        render: (value: number) => <span className="font-semibold tabular-nums text-[var(--studio-ink)]">+{value.toLocaleString("zh-CN")}</span>,
    },
    {
        title: "兑换后余额",
        dataIndex: "balanceAfter",
        width: 140,
        render: (value: number) => <span className="tabular-nums text-[var(--studio-text)]">{value.toLocaleString("zh-CN")}</span>,
    },
    {
        title: "兑换时间",
        dataIndex: "redeemedAt",
        width: 190,
        render: (value: string) => <span className="tabular-nums text-[var(--studio-muted)]">{value ? new Date(value).toLocaleString("zh-CN") : "-"}</span>,
    },
];

/**
 * 渲染积分兑换页。
 *
 * @returns 卡密兑换与本人记录页面
 */
export default function CreditRedeemPage() {
    const { message } = App.useApp();
    const user = useUserStore((state) => state.user);
    const setCreditBalance = useUserStore((state) => state.setCreditBalance);
    const [cardCode, setCardCode] = useState("");
    const [searchCardCodeInput, setSearchCardCodeInput] = useState("");
    const [searchCardCode, setSearchCardCode] = useState("");
    const [dateRange, setDateRange] = useState<[Dayjs, Dayjs]>(() => [dayjs().subtract(29, "day").startOf("day"), dayjs().endOf("day")]);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(REDEMPTION_PAGE_SIZE);
    const [redeeming, setRedeeming] = useState(false);
    const [redeemResult, setRedeemResult] = useState<{ credits: number; balance: number } | null>(null);

    const filters = useMemo(
        () => ({
            startDate: dateRange[0].format("YYYY-MM-DD"),
            endDate: dateRange[1].format("YYYY-MM-DD"),
            cardCode: searchCardCode.trim() || undefined,
        }),
        [dateRange, searchCardCode],
    );
    const recordsQuery = useQuery({
        queryKey: ["credit-redemption-records", filters.startDate, filters.endDate, filters.cardCode, page, pageSize],
        queryFn: () => listRedemptionRecords({ ...filters, page, pageSize }),
    });

    useEffect(() => {
        const total = recordsQuery.data?.total;
        if (total !== undefined) setPage((current) => clampPage(current, total, pageSize));
    }, [recordsQuery.data, pageSize]);

    const submitRedeem = async () => {
        const normalized = normalizeCreditCardCode(cardCode);
        if (!isCreditCardCode(normalized)) {
            message.warning("请输入20位积分卡密");
            return;
        }
        setRedeeming(true);
        try {
            const result = await redeemCredits(normalized);
            setCreditBalance(result.creditBalance);
            setRedeemResult({ credits: result.credits, balance: result.creditBalance });
            setCardCode("");
            message.success(`兑换成功，已到账 ${result.credits.toLocaleString("zh-CN")} 积分`);
            setPage(1);
            await recordsQuery.refetch();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "兑换失败");
        } finally {
            setRedeeming(false);
        }
    };

    return (
        <PageShell icon={<Ticket />} eyebrow="账户" title="兑换积分" description="输入购买获得的卡密，积分会立即到账。" width="wide"
            toolbar={<CreditNavigation active="/credits/redeem" />}
        >

            <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
                <section className="studio-account-panel" aria-labelledby="redeem-card-title">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h2 id="redeem-card-title" className="studio-section-heading"><IconLabel icon={<KeyRound />}> 输入卡密</IconLabel></h2>
                            <p className="mt-1 text-sm text-[var(--studio-muted)]">卡密只能兑换一次，请确认账号无误</p>
                        </div>
                        {redeemResult ? (
                            <Tag color="green" icon={<CheckCircle2 className="size-3.5" />}>
                                已到账 {redeemResult.credits.toLocaleString("zh-CN")} 积分
                            </Tag>
                        ) : null}
                    </div>
                    <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                        <Input
                            prefix={<KeyRound className="size-4" />}
                            value={cardCode}
                            maxLength={24}
                            onChange={(event) => setCardCode(event.target.value)}
                            onPressEnter={() => void submitRedeem()}
                            placeholder="输入20位卡密"
                            className="h-11 font-mono uppercase"
                            autoComplete="off"
                            aria-label="20位积分卡密"
                        />
                        <Button type="primary" icon={<Ticket className="size-4" />} loading={redeeming} onClick={() => void submitRedeem()} className="h-11 sm:w-32">
                            立即兑换
                        </Button>
                    </div>
                </section>

                <aside className="rounded-2xl border border-[var(--studio-line)] bg-[var(--studio-surface)] p-6" aria-label="账户余额与兑换说明">
                    <p className="text-sm text-[var(--studio-muted)]"><IconLabel icon={<Sparkles />}>当前余额</IconLabel></p>
                    <p className="studio-redeem-balance mt-3 text-3xl font-semibold tabular-nums text-[var(--studio-ink)]">
                        {(user?.creditBalance || 0).toLocaleString("zh-CN")}
                        <span className="ml-2 text-sm font-normal text-[var(--studio-muted)]">积分</span>
                    </p>
                    <p className="mt-4 border-t border-[var(--studio-line)] pt-4 text-xs leading-6 text-[var(--studio-muted)]">兑换成功后积分立即到账。如兑换失败，请检查卡密或联系客服。</p>
                </aside>
            </div>

            <section aria-labelledby="redemption-records-title">
                <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <h2 id="redemption-records-title" className="studio-section-heading"><IconLabel icon={<History />}> 兑换记录</IconLabel></h2>
                        <p className="mt-1 text-sm text-[var(--studio-muted)]">仅展示当前账号的卡密兑换流水</p>
                    </div>
                    <div className="flex flex-col gap-3 sm:flex-row">
                        <DatePicker.RangePicker
                            value={dateRange}
                            allowClear={false}
                            disabledDate={(date) => date.isAfter(dayjs(), "day")}
                            onChange={(next) => {
                                if (!next?.[0] || !next[1]) return;
                                setDateRange([next[0], next[1]]);
                                setPage(1);
                            }}
                        />
                        <Input.Search
                            value={searchCardCodeInput}
                            onChange={(event) => {
                                const value = event.target.value;
                                setSearchCardCodeInput(value);
                                if (!value) {
                                    setSearchCardCode("");
                                    setPage(1);
                                }
                            }}
                            onSearch={() => {
                                setSearchCardCode(searchCardCodeInput);
                                setPage(1);
                            }}
                            allowClear
                            placeholder="完整卡密或末四位"
                            prefix={<Search className="size-3.5 text-[var(--studio-faint)]" />}
                            className="sm:w-56"
                        />
                    </div>
                </div>
                {recordsQuery.isError ? (
                    <Alert
                        type="error"
                        showIcon
                        message="兑换记录加载失败"
                        action={
                            <Button size="small" icon={<RefreshCw className="size-3.5" />} onClick={() => void recordsQuery.refetch()}>
                                重新加载
                            </Button>
                        }
                    />
                ) : null}
                <div className="studio-data-table">
                    <div className="overflow-x-auto">
                        <Table<ServerRedemptionRecord>
                            rowKey="id"
                            columns={REDEMPTION_COLUMNS}
                            dataSource={recordsQuery.data?.records || []}
                            loading={recordsQuery.isLoading}
                            pagination={false}
                            scroll={{ x: 680 }}
                            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="所选范围暂无兑换记录" /> }}
                        />
                    </div>
                </div>
                <ListPagination
                    className="mt-6"
                    current={page}
                    pageSize={pageSize}
                    total={recordsQuery.data?.total || 0}
                    disabled={recordsQuery.isFetching}
                    label="兑换记录"
                    onChange={(nextPage, nextPageSize) => {
                        setPage(nextPageSize === pageSize ? nextPage : 1);
                        setPageSize(nextPageSize);
                    }}
                />
            </section>
        </PageShell>
    );
}
