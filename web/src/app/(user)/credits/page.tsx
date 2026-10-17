"use client";

import { Sparkles, ChartNoAxesCombined, ReceiptText, TrendingUp, RefreshCw, ImageIcon, Film, Layers3 } from "lucide-react";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import dayjs, { type Dayjs } from "dayjs";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, DatePicker, Empty, Segmented, Select, Skeleton, Table, type TableProps } from "antd";
import { CreditNavigation } from "./components/credit-navigation";

import { useUserStore } from "@/features/auth/stores/use-user-store";
import { ListPagination } from "@/shared/components/list-pagination";
import { clampPage } from "@/shared/lib/pagination";
import { IconLabel } from "@/shared/components/icon-label";
import { PageShell } from "@/shared/components/page-shell";
import { getCreditOverview, listCreditTransactions, type ServerCreditDirection, type ServerCreditSource, type ServerUserCreditTransaction } from "@/services/api/server";

import {
    CREDIT_DIRECTION_OPTIONS,
    CREDIT_SOURCE_OPTIONS,
    CREDIT_TRANSACTION_PAGE_SIZE,
    creditTransactionDetail,
    creditTransactionIcon,
    creditTransactionTypeLabel,
    formatCreditChange,
    formatCredits,
    formatCreditTime,
    normalizeGenerationDistribution,
    normalizeModelDistribution,
} from "./credit-page-utils";

const CreditChart = dynamic(() => import("./components/credit-chart").then((module) => module.CreditChart), {
    ssr: false,
    loading: () => <Skeleton active className="px-5 py-6" paragraph={{ rows: 7 }} />,
});

type GenerationTypeFilter = "all" | "image" | "video";
type TrendUnit = "day" | "month";

const CREDIT_TRANSACTION_COLUMNS: TableProps<ServerUserCreditTransaction>["columns"] = [
    {
        title: "类型",
        dataIndex: "transactionType",
        width: 132,
        render: (transactionType: ServerUserCreditTransaction["transactionType"], record) => {
            const Icon = creditTransactionIcon(record);
            return (
                <span className="inline-flex items-center gap-2 text-[var(--studio-text)]">
                    <Icon className="size-4 text-[var(--studio-primary)]" />
                    {creditTransactionTypeLabel(transactionType)}
                </span>
            );
        },
    },
    {
        title: "详情",
        dataIndex: "reason",
        ellipsis: true,
        render: (_, record) => <span className="text-[var(--studio-muted)]">{creditTransactionDetail(record.transactionType, record.generationType, record.model, record.reason)}</span>,
    },
    {
        title: "积分变动",
        dataIndex: "changeAmount",
        width: 128,
        align: "right",
        render: (changeAmount: number) => <span className={`font-medium tabular-nums ${changeAmount > 0 ? "text-[var(--studio-primary)]" : "text-[var(--studio-ink)]"}`}>{formatCreditChange(changeAmount)}</span>,
    },
    {
        title: "余额快照",
        dataIndex: "balanceAfter",
        width: 128,
        align: "right",
        render: (balanceAfter: number) => <span className="tabular-nums text-[var(--studio-muted)]">{formatCredits(balanceAfter)}</span>,
    },
    {
        title: "时间",
        dataIndex: "createdAt",
        width: 176,
        render: (createdAt: string) => <span className="tabular-nums text-[var(--studio-muted)]">{formatCreditTime(createdAt)}</span>,
    },
];

/**
 * 渲染用户积分消耗统计页面。
 *
 * @return 积分统计页面
 */
export default function CreditsPage() {
    const user = useUserStore((state) => state.user);
    const [dateRange, setDateRange] = useState<[Dayjs, Dayjs]>(() => [dayjs().subtract(29, "day").startOf("day"), dayjs().endOf("day")]);
    const [generationType, setGenerationType] = useState<GenerationTypeFilter>("all");
    const [trendUnit, setTrendUnit] = useState<TrendUnit>("day");
    const [detailDateRange, setDetailDateRange] = useState<[Dayjs, Dayjs]>(() => [dayjs().subtract(29, "day").startOf("day"), dayjs().endOf("day")]);
    const [detailDirection, setDetailDirection] = useState<"all" | ServerCreditDirection>("all");
    const [detailSource, setDetailSource] = useState<"all" | ServerCreditSource>("all");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(CREDIT_TRANSACTION_PAGE_SIZE);

    const filters = useMemo(
        () => ({
            startDate: dateRange[0].format("YYYY-MM-DD"),
            endDate: dateRange[1].format("YYYY-MM-DD"),
            generationType: generationType === "all" ? undefined : generationType,
        }),
        [dateRange, generationType],
    );

    const detailFilters = useMemo(
        () => ({
            startDate: detailDateRange[0].format("YYYY-MM-DD"),
            endDate: detailDateRange[1].format("YYYY-MM-DD"),
            direction: detailDirection === "all" ? undefined : detailDirection,
            source: detailSource === "all" ? undefined : detailSource,
        }),
        [detailDateRange, detailDirection, detailSource],
    );

    const overviewQuery = useQuery({
        queryKey: ["credit-overview", filters.startDate, filters.endDate, filters.generationType, trendUnit],
        queryFn: () => getCreditOverview({ ...filters, trendUnit }),
    });
    const transactionsQuery = useQuery({
        queryKey: ["credit-transactions", detailFilters.startDate, detailFilters.endDate, detailFilters.direction, detailFilters.source, page, pageSize],
        queryFn: () => listCreditTransactions({ ...detailFilters, page, pageSize }),
    });

    useEffect(() => {
        const total = transactionsQuery.data?.total;
        if (total !== undefined) setPage((current) => clampPage(current, total, pageSize));
    }, [transactionsQuery.data, pageSize]);

    const overview = overviewQuery.data;
    const transactions = transactionsQuery.data;
    const generationDistribution = useMemo(() => normalizeGenerationDistribution(overview?.generationTypeDistribution || []), [overview?.generationTypeDistribution]);
    const modelDistribution = useMemo(() => normalizeModelDistribution(overview?.modelDistribution || []), [overview?.modelDistribution]);
    const trend = useMemo(() => (overview?.trend || []).map((item) => ({ name: item.period, value: item.consumedCredits })), [overview?.trend]);
    const totalConsumed = trend.reduce((total, item) => total + item.value, 0);
    const hasOverviewError = overviewQuery.isError || transactionsQuery.isError;

    return (
        <PageShell icon={<Sparkles />} eyebrow="账户" title="积分" description="查看账户余额、创作消耗与积分收支记录。" width="wide"
            toolbar={<CreditNavigation active="/credits" />}
        >

            <section className="grid gap-4 sm:grid-cols-2" aria-label="积分概览">
                <div className="rounded-2xl border border-[var(--studio-primary-line)] bg-[var(--studio-primary-soft)] p-5 sm:p-6">
                    <p className="text-sm text-[var(--studio-muted)]"><IconLabel icon={<Sparkles />}> 可用积分</IconLabel></p>
                    <p className="mt-3 text-4xl font-semibold tracking-tight tabular-nums text-[var(--studio-ink)]">{formatCredits(user?.creditBalance || 0)}</p>
                    <p className="mt-3 text-xs text-[var(--studio-muted)]">用于图片、视频与画布创作</p>
                </div>
                <div className="rounded-2xl border border-[var(--studio-line)] bg-[var(--studio-surface)] p-5 sm:p-6">
                    <p className="text-sm text-[var(--studio-muted)]"><IconLabel icon={<TrendingUp />}> 所选期间消耗</IconLabel></p>
                    <p className="mt-3 text-4xl font-semibold tracking-tight tabular-nums text-[var(--studio-ink)]">{formatCredits(totalConsumed)}</p>
                    <p className="mt-3 text-xs tabular-nums text-[var(--studio-muted)]">
                        {dateRange[0].format("YYYY.MM.DD")} — {dateRange[1].format("YYYY.MM.DD")}
                    </p>
                </div>
            </section>
            {hasOverviewError ? (
                <Alert
                    type="error"
                    showIcon
                    message="积分数据加载失败"
                    action={
                        <Button
                            icon={<RefreshCw className="size-3.5" />}
                            size="small"
                            onClick={() => {
                                void overviewQuery.refetch();
                                void transactionsQuery.refetch();
                            }}
                        >
                            重新加载
                        </Button>
                    }
                />
            ) : null}

            <section aria-labelledby="credit-statistics-title">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h2 id="credit-statistics-title" className="studio-section-heading"><IconLabel icon={<ChartNoAxesCombined />}> 消耗统计</IconLabel></h2>
                        <p className="mt-1 text-sm text-[var(--studio-muted)]">本期共消耗 {formatCredits(totalConsumed)} 积分</p>
                    </div>
                </div>
                <div className="mb-5 grid gap-3 rounded-2xl border border-[var(--studio-line)] bg-[var(--studio-surface)] p-4 sm:grid-cols-[minmax(0,1fr)_minmax(280px,auto)]">
                    <DatePicker.RangePicker
                        className="w-full"
                        value={dateRange}
                        allowClear={false}
                        disabledDate={(date) => date.isAfter(dayjs(), "day")}
                        presets={[
                            { label: "今日", value: [dayjs().startOf("day"), dayjs().endOf("day")] },
                            { label: "近7天", value: [dayjs().subtract(6, "day"), dayjs()] },
                            { label: "近30天", value: [dayjs().subtract(29, "day"), dayjs()] },
                            { label: "本月", value: [dayjs().startOf("month"), dayjs()] },
                        ]}
                        onChange={(nextDateRange) => {
                            if (!nextDateRange?.[0] || !nextDateRange[1]) return;
                            setDateRange([nextDateRange[0], nextDateRange[1]]);
                            setPage(1);
                        }}
                    />
                    <Segmented
                        block
                        value={generationType}
                        options={[
                            { label: <IconLabel icon={<Layers3 />}> 全部</IconLabel>, value: "all" },
                            { label: <IconLabel icon={<ImageIcon />}> 生图</IconLabel>, value: "image" },
                            { label: <IconLabel icon={<Film />}> 生视频</IconLabel>, value: "video" },
                        ]}
                        onChange={(value) => {
                            setGenerationType(value as GenerationTypeFilter);
                            setPage(1);
                        }}
                    />
                </div>
                <div className="grid gap-5 lg:grid-cols-2">
                    <ChartPanel title="生图与生视频消耗分布" loading={overviewQuery.isLoading} empty={!generationDistribution.length}>
                        <CreditChart type="pie" data={generationDistribution} ariaLabel="生图与生视频积分消耗分布图" />
                    </ChartPanel>
                    <ChartPanel title="模型消耗分布" loading={overviewQuery.isLoading} empty={!modelDistribution.length}>
                        <CreditChart type="pie" data={modelDistribution} ariaLabel="模型积分消耗分布图" />
                    </ChartPanel>
                    <ChartPanel
                        className="lg:col-span-2"
                        title="积分消耗趋势"
                        loading={overviewQuery.isLoading}
                        empty={!trend.some((item) => item.value > 0)}
                        extra={
                            <Segmented
                                value={trendUnit}
                                size="small"
                                options={[
                                    { label: "按日", value: "day" },
                                    { label: "按月", value: "month" },
                                ]}
                                onChange={(value) => setTrendUnit(value as TrendUnit)}
                            />
                        }
                    >
                        <CreditChart type="bar" data={trend} ariaLabel="积分消耗趋势柱状图" />
                    </ChartPanel>
                </div>
            </section>

            <section aria-labelledby="credit-transactions-title">
                <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                    <div>
                        <h2 id="credit-transactions-title" className="studio-section-heading"><IconLabel icon={<ReceiptText />}> 积分明细</IconLabel></h2>
                        <p className="mt-1 text-sm text-[var(--studio-muted)]">包含积分增加与消耗记录，明细筛选独立于上方消耗统计</p>
                    </div>
                    <span className="text-sm tabular-nums text-[var(--studio-muted)]">{transactions?.total || 0} 条记录</span>
                </div>

                <div className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-[var(--studio-line)] bg-[var(--studio-surface)] p-4">
                    <DatePicker.RangePicker
                        value={detailDateRange}
                        allowClear={false}
                        disabledDate={(date) => date.isAfter(dayjs(), "day")}
                        onChange={(nextDateRange) => {
                            if (!nextDateRange?.[0] || !nextDateRange[1]) return;
                            setDetailDateRange([nextDateRange[0], nextDateRange[1]]);
                            setPage(1);
                        }}
                    />
                    <Segmented
                        value={detailDirection}
                        options={CREDIT_DIRECTION_OPTIONS}
                        onChange={(value) => {
                            setDetailDirection(value as "all" | ServerCreditDirection);
                            setPage(1);
                        }}
                    />
                    <Select
                        value={detailSource}
                        options={CREDIT_SOURCE_OPTIONS}
                        className="w-40"
                        onChange={(value) => {
                            setDetailSource(value as "all" | ServerCreditSource);
                            setPage(1);
                        }}
                    />
                </div>

                <div className="overflow-hidden rounded-[20px] border border-[var(--studio-line)] bg-[var(--studio-glass)] backdrop-blur-[20px]">
                    <div className="hidden md:block">
                        <Table<ServerUserCreditTransaction>
                            rowKey="id"
                            columns={CREDIT_TRANSACTION_COLUMNS}
                            dataSource={transactions?.transactions || []}
                            loading={transactionsQuery.isLoading}
                            pagination={false}
                            scroll={{ x: 760 }}
                            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="所选范围没有积分记录" /> }}
                        />
                    </div>
                    <div className="px-5 md:hidden">
                        {transactionsQuery.isLoading ? <Skeleton active paragraph={{ rows: 8 }} /> : null}
                        {!transactionsQuery.isLoading && !transactions?.transactions.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="所选范围没有积分记录" /> : null}
                        {transactions?.transactions.map((transaction) => {
                            const Icon = creditTransactionIcon(transaction);
                            return (
                                <article key={transaction.id} className="border-b border-[var(--studio-line)] py-4 last:border-b-0">
                                    <div className="flex items-start justify-between gap-3">
                                        <span className="inline-flex min-w-0 items-center gap-2 text-sm font-medium text-[var(--studio-ink)]">
                                            <Icon className="size-4 shrink-0 text-[var(--studio-primary)]" />
                                            {creditTransactionTypeLabel(transaction.transactionType)}
                                        </span>
                                        <span className={`shrink-0 text-sm font-semibold tabular-nums ${transaction.changeAmount > 0 ? "text-[var(--studio-primary)]" : "text-[var(--studio-ink)]"}`}>{formatCreditChange(transaction.changeAmount)}</span>
                                    </div>
                                    <div className="mt-2 grid gap-1 text-xs text-[var(--studio-muted)]">
                                        <span className="truncate">{creditTransactionDetail(transaction.transactionType, transaction.generationType, transaction.model, transaction.reason)}</span>
                                        <span className="tabular-nums">
                                            余额 {formatCredits(transaction.balanceAfter)} · {formatCreditTime(transaction.createdAt)}
                                        </span>
                                    </div>
                                </article>
                            );
                        })}
                    </div>
                </div>
                <ListPagination
                    className="mt-6"
                    current={page}
                    pageSize={pageSize}
                    total={transactionsQuery.data?.total || 0}
                    disabled={transactionsQuery.isFetching}
                    label="积分记录"
                    onChange={(nextPage, nextPageSize) => {
                        setPage(nextPageSize === pageSize ? nextPage : 1);
                        setPageSize(nextPageSize);
                    }}
                />
            </section>
        </PageShell>
    );
}

/**
 * 渲染单个积分图表面板。
 *
 * @param props 标题、加载、空状态和图表内容
 * @return 图表面板
 */
function ChartPanel({ title, loading, empty, extra, className, children }: { title: string; loading: boolean; empty: boolean; extra?: ReactNode; className?: string; children: ReactNode }) {
    return (
        <section className={`min-w-0 rounded-2xl border border-[var(--studio-line)] bg-[var(--studio-surface)] p-5 ${className || ""}`}>
            <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium text-[var(--studio-ink)]"><IconLabel icon={<ChartNoAxesCombined />}>{title}</IconLabel></h3>
                {extra}
            </div>
            <div className="mt-2">
                {loading ? <Skeleton active className="py-5" paragraph={{ rows: 6 }} /> : null}
                {!loading && empty ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="所选范围暂无消耗数据" className="py-9" /> : null}
                {!loading && !empty ? children : null}
            </div>
        </section>
    );
}
