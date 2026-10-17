"use client";

import { PaymentManagement } from "@/features/payments/payment-management";
import { NewApiManagement } from "@/features/newapi/newapi-management";

import { type Key, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import dayjs, { type Dayjs } from "dayjs";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Checkbox, DatePicker, Empty, Form, Grid, Input, InputNumber, Modal, Segmented, Select, Skeleton, Space, Table, Tabs, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Edit, Image as ImageIcon, Plus, Power, Search, Send, Sparkles, Trash2, Upload, Video, Settings2, UsersRound, UserPlus, CalendarPlus, ReceiptText, CreditCard, Ticket, Bell, BookOpenText, Palette, WandSparkles, PanelsTopLeft, Network, RefreshCw, LockKeyholeOpen, SlidersHorizontal, ShoppingBag, ChartNoAxesCombined } from "lucide-react";

import {
    adjustServerUserCredits,
    getServerUserStatistics,
    unlockServerUserPassword,
    listServerUsers,
    updateServerUserRole,
    updateServerUserStatus,
    deleteServerUser,
    adminCreateUser,
    listAdminNotifications,
    createAdminNotification,
    publishAdminNotification,
    updateAdminNotification,
    deleteAdminNotification,
    listAdminPrompts,
    createAdminPrompt,
    updateAdminPrompt,
    updateAdminPromptStatus,
    deleteAdminPrompts,
    listAdminGenerationStyles,
    createAdminGenerationStyle,
    updateAdminGenerationStyle,
    updateAdminGenerationStyleStatus,
    deleteAdminGenerationStyles,
    listAdminSkills,
    createAdminSkill,
    updateAdminSkill,
    updateAdminSkillStatus,
    deleteAdminSkills,
    listAdminHomepageShowcases,
    createAdminHomepageShowcase,
    updateAdminHomepageShowcase,
    updateAdminHomepageShowcaseStatus,
    deleteAdminHomepageShowcases,
    getAdminCreditOverview,
    listAdminCreditTransactions,
    type HomepageShowcase,
    type ServerAdminCreditTransaction,
    type ServerPrompt,
    type ServerGenerationStyle,
    type ServerSkill,
    type SystemNotification,
} from "@/services/api/server";
import { useUserStore, type ServerUserProfile, type ServerUserRole } from "@/features/auth/stores/use-user-store";
import { useNotificationStore } from "@/features/notification/stores/use-notification-store";
import { getHomepageTargetPath } from "@/features/homepage/api/homepage-showcases";
import { adminCreditFilterKey, adminCreditUserLabel } from "./admin-credit-utils";
import { CreditCardManagement } from "./components/credit-card-management";
import { RegistrationEmailSettings } from "./components/registration-email-settings";
import { EcommerceSkillManagement } from "./components/ecommerce-skill-management";
import { GenerationStyleCover } from "@/features/generation/components/generation-style-picker";
import { uploadImage } from "@/features/storage/services/image-storage";
import { IconLabel } from "@/shared/components/icon-label";
import { PageShell } from "@/shared/components/page-shell";
import { ListPagination } from "@/shared/components/list-pagination";
import { clampPage, paginateItems } from "@/shared/lib/pagination";
import { AdminSelectionSummary, useAdminPagination, useClampAdminPage } from "./components/admin-list-pagination";
import {
    CREDIT_TRANSACTION_PAGE_SIZE,
    creditTransactionDetail,
    creditTransactionIcon,
    creditTransactionTypeLabel,
    formatCreditChange,
    formatCredits,
    formatCreditTime,
    normalizeGenerationDistribution,
    normalizeModelDistribution,
} from "@/app/(user)/credits/credit-page-utils";

const PAGE_SIZE = 20;

const CreditChart = dynamic(() => import("@/app/(user)/credits/components/credit-chart").then((module) => module.CreditChart), {
    ssr: false,
    loading: () => <Skeleton active className="px-5 py-6" paragraph={{ rows: 7 }} />,
});

type GenerationTypeFilter = "all" | "image" | "video";
type TrendUnit = "day" | "month";

export default function AdminSystemPage() {
    const currentUser = useUserStore((state) => state.user);
    const isAdmin = currentUser?.role === "admin";
    const [activeTab, setActiveTab] = useState("users");

    useEffect(() => {
        const syncTab = () => {
            const url = new URL(window.location.href);
            const tab = url.searchParams.get("tab");
            if (tab && ["users", "credits", "payments", "creditCards", "notifications", "prompts", "styles", "skills", "homepage", "newapi"].includes(tab)) {
                setActiveTab(tab);
            } else {
                setActiveTab("users");
                if (tab) {
                    url.searchParams.set("tab", "users");
                    window.history.replaceState(window.history.state, "", url);
                }
            }
        };
        syncTab();
        window.addEventListener("popstate", syncTab);
        return () => window.removeEventListener("popstate", syncTab);
    }, []);

    const changeTab = (tab: string) => {
        setActiveTab(tab);
        const url = new URL(window.location.href);
        url.searchParams.set("tab", tab);
        window.history.replaceState(window.history.state, "", url);
    };

    if (!isAdmin) {
        return (
            <main className="studio-page flex h-full items-center justify-center overflow-auto px-6">
                <div className="rounded-[24px] border border-dashed border-[var(--studio-line-strong)] px-10 py-16 text-center">
                    <h1 className="text-2xl font-semibold text-[var(--studio-ink)]">需要管理员权限</h1>
                    <p className="mt-3 text-sm text-[var(--studio-muted)]">当前账号无法访问系统管理。</p>
                </div>
            </main>
        );
    }

    const tabs = [
        { key: "newapi", label: <IconLabel icon={<Network />}> New API</IconLabel>, children: <NewApiManagement /> },
        { key: "users", label: <IconLabel icon={<UsersRound />}> 用户管理</IconLabel>, children: <UserManagement /> },
        { key: "credits", label: <IconLabel icon={<ReceiptText />}> 积分明细</IconLabel>, children: <CreditConsumptionManagement /> },
        { key: "payments", label: <IconLabel icon={<CreditCard />}> 微信支付</IconLabel>, children: <PaymentManagement /> },
        { key: "creditCards", label: <IconLabel icon={<Ticket />}> 卡密管理</IconLabel>, children: <CreditCardManagement /> },
        { key: "notifications", label: <IconLabel icon={<Bell />}> 消息管理</IconLabel>, children: <NotificationManagement /> },
        { key: "prompts", label: <IconLabel icon={<BookOpenText />}> 提示词库</IconLabel>, children: <PromptManagement /> },
        { key: "styles", label: <IconLabel icon={<Palette />}> 风格管理</IconLabel>, children: <GenerationStyleManagement /> },
        { key: "skills", label: <IconLabel icon={<WandSparkles />}> 技能管理</IconLabel>, children: <SkillManagementTabs /> },
        { key: "homepage", label: <IconLabel icon={<PanelsTopLeft />}> 首页展示</IconLabel>, children: <HomepageShowcaseManagement /> },
    ];

    return (
        <PageShell icon={<Settings2 />} eyebrow="运营控制台" title="系统管理" description="集中管理用户与积分，维护创作内容、消息和运营记录。" width="wide" bodyScroll={false}>
            <section className="studio-tab-workspace min-w-0 rounded-2xl border border-[var(--studio-line)] bg-[var(--studio-surface)] px-4 pb-5 sm:px-6 sm:pb-6" aria-label="管理模块">
                <Tabs activeKey={activeTab} onChange={changeTab} items={tabs} tabBarGutter={18} className="studio-page-tabs studio-admin-tabs" />
            </section>
        </PageShell>
    );
}

const ADMIN_CREDIT_COLUMNS: ColumnsType<ServerAdminCreditTransaction> = [
    {
        title: "用户",
        width: 220,
        render: (_, transaction) => (
            <div className="min-w-0">
                <div className="truncate font-medium text-[var(--studio-ink)]">{adminCreditUserLabel(transaction)}</div>
                <div className="mt-0.5 truncate text-xs text-[var(--studio-muted)]">{transaction.email}</div>
            </div>
        ),
    },
    {
        title: "类型",
        dataIndex: "transactionType",
        width: 132,
        render: (transactionType: ServerAdminCreditTransaction["transactionType"], record) => {
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
 * 渲染管理员积分统计与明细。
 *
 * @return 积分明细管理内容
 */
function CreditConsumptionManagement() {
    const [dateRange, setDateRange] = useState<[Dayjs, Dayjs]>(() => [dayjs().subtract(29, "day").startOf("day"), dayjs().endOf("day")]);
    const [generationType, setGenerationType] = useState<GenerationTypeFilter>("all");
    const [trendUnit, setTrendUnit] = useState<TrendUnit>("day");
    const [selectedUser, setSelectedUser] = useState<ServerUserProfile | null>(null);
    const [userKeyword, setUserKeyword] = useState("");
    const { page, setPage, pageSize, onPaginationChange } = useAdminPagination(CREDIT_TRANSACTION_PAGE_SIZE);

    const userQuery = useInfiniteQuery({
        queryKey: ["admin-credit-users", userKeyword, PAGE_SIZE],
        initialPageParam: 1,
        queryFn: ({ pageParam }) => listServerUsers({ page: pageParam, pageSize: PAGE_SIZE, keyword: userKeyword || undefined }),
        getNextPageParam: (lastPage, pages) => (lastPage.users.length > 0 && pages.reduce((count, result) => count + result.users.length, 0) < lastPage.total ? pages.length + 1 : undefined),
    });
    const userOptions = useMemo(() => {
        const users = userQuery.data?.pages.flatMap((result) => result.users) || [];
        return selectedUser && !users.some((user) => user.id === selectedUser.id) ? [selectedUser, ...users] : users;
    }, [selectedUser, userQuery.data?.pages]);
    const filters = useMemo(
        () => ({
            userId: selectedUser?.id,
            startDate: dateRange[0].format("YYYY-MM-DD"),
            endDate: dateRange[1].format("YYYY-MM-DD"),
            generationType: generationType === "all" ? undefined : generationType,
        }),
        [dateRange, generationType, selectedUser?.id],
    );
    const filterKey = adminCreditFilterKey(filters);
    const overviewQuery = useQuery({
        queryKey: ["admin-credit-overview", ...filterKey, trendUnit],
        queryFn: () => getAdminCreditOverview({ ...filters, trendUnit }),
    });
    const transactionsQuery = useQuery({
        queryKey: ["admin-credit-transactions", ...filterKey, page, pageSize],
        queryFn: () => listAdminCreditTransactions({ ...filters, page, pageSize }),
    });

    const overview = overviewQuery.data;
    const transactions = transactionsQuery.data;
    useClampAdminPage(page, pageSize, transactions?.total, setPage);
    const generationDistribution = useMemo(() => normalizeGenerationDistribution(overview?.generationTypeDistribution || []), [overview?.generationTypeDistribution]);
    const modelDistribution = useMemo(() => normalizeModelDistribution(overview?.modelDistribution || []), [overview?.modelDistribution]);
    const trend = useMemo(() => (overview?.trend || []).map((item) => ({ name: item.period, value: item.consumedCredits })), [overview?.trend]);
    const totalConsumed = trend.reduce((total, item) => total + item.value, 0);
    const hasError = overviewQuery.isError || transactionsQuery.isError;

    const resetPage = () => setPage(1);

    return (
        <div>
            <div className="flex flex-wrap items-center gap-3">
                <Select
                    className="w-72 max-w-full"
                    value={selectedUser?.id}
                    options={userOptions.map((user) => ({ value: user.id, label: adminCreditUserLabel(user) }))}
                    showSearch
                    allowClear
                    filterOption={false}
                    placeholder="全部用户（搜索昵称、用户名或邮箱）"
                    notFoundContent={userQuery.isFetching ? <Skeleton active paragraph={false} title={{ width: "70%" }} /> : "没有匹配用户"}
                    onSearch={setUserKeyword}
                    onPopupScroll={(event) => {
                        const target = event.currentTarget;
                        if (target.scrollHeight - target.scrollTop - target.clientHeight < 40 && userQuery.hasNextPage && !userQuery.isFetchingNextPage) void userQuery.fetchNextPage();
                    }}
                    popupRender={(menu) => (
                        <>
                            {menu}
                            {userQuery.hasNextPage ? (
                                <div className="border-t border-[var(--studio-line)] p-2">
                                    <Button block size="small" loading={userQuery.isFetchingNextPage} onMouseDown={(event) => event.preventDefault()} onClick={() => void userQuery.fetchNextPage()}>
                                        加载更多用户
                                    </Button>
                                </div>
                            ) : null}
                        </>
                    )}
                    onChange={(userId) => {
                        setSelectedUser(userOptions.find((user) => user.id === userId) || null);
                        resetPage();
                    }}
                    onClear={() => {
                        setSelectedUser(null);
                        resetPage();
                    }}
                />
                <DatePicker.RangePicker
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
                        resetPage();
                    }}
                />
                <Segmented
                    value={generationType}
                    options={[
                        { label: "全部", value: "all" },
                        { label: "生图", value: "image" },
                        { label: "生视频", value: "video" },
                    ]}
                    onChange={(value) => {
                        setGenerationType(value as GenerationTypeFilter);
                        resetPage();
                    }}
                />
            </div>

            {hasError ? (
                <Alert
                    className="mt-5"
                    type="error"
                    showIcon
                    message="积分数据加载失败"
                    action={
                        <Button
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

            <section className="mt-6" aria-labelledby="admin-credit-statistics-title">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h2 id="admin-credit-statistics-title" className="studio-section-heading"><IconLabel icon={<ChartNoAxesCombined />}> 消耗统计</IconLabel></h2>
                        <p className="mt-1 text-sm text-[var(--studio-muted)]">
                            {selectedUser ? `${adminCreditUserLabel(selectedUser)}本期` : "全部用户本期"}共消耗 {formatCredits(totalConsumed)} 积分
                        </p>
                    </div>
                </div>
                <div className="grid gap-4 lg:grid-cols-2">
                    <CreditChartPanel title="生图与生视频消耗分布" loading={overviewQuery.isLoading} empty={!generationDistribution.length}>
                        <CreditChart type="pie" data={generationDistribution} ariaLabel="管理员生图与生视频积分消耗分布图" />
                    </CreditChartPanel>
                    <CreditChartPanel title="模型消耗分布" loading={overviewQuery.isLoading} empty={!modelDistribution.length}>
                        <CreditChart type="pie" data={modelDistribution} ariaLabel="管理员模型积分消耗分布图" />
                    </CreditChartPanel>
                    <CreditChartPanel
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
                        <CreditChart type="bar" data={trend} ariaLabel="管理员积分消耗趋势柱状图" />
                    </CreditChartPanel>
                </div>
            </section>

            <section className="mt-8 border-t border-[var(--studio-line)] pt-6" aria-labelledby="admin-credit-transactions-title">
                <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                    <div>
                        <h2 id="admin-credit-transactions-title" className="studio-section-heading"><IconLabel icon={<ReceiptText />}> 积分明细</IconLabel></h2>
                        <p className="mt-1 text-sm text-[var(--studio-muted)]">{selectedUser ? `${adminCreditUserLabel(selectedUser)}的积分记录` : "所有用户的积分记录"}，包含消耗、退款、充值、签到等全部积分变动</p>
                    </div>
                    <span className="text-sm tabular-nums text-[var(--studio-muted)]">{transactions?.total || 0} 条记录</span>
                </div>
                <Table<ServerAdminCreditTransaction>
                    rowKey="id"
                    columns={ADMIN_CREDIT_COLUMNS}
                    dataSource={transactions?.transactions || []}
                    loading={transactionsQuery.isLoading}
                    pagination={false}
                    scroll={{ x: 1_100 }}
                    locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="所选范围没有积分记录" /> }}
                />
                <ListPagination className="mt-5" current={page} pageSize={pageSize} total={transactions?.total || 0} disabled={transactionsQuery.isFetching} onChange={onPaginationChange} label="积分明细分页" />
            </section>
        </div>
    );
}

/**
 * 渲染管理员积分图表面板。
 *
 * @param props 标题、加载、空状态和图表内容
 * @return 图表面板
 */
function CreditChartPanel({ title, loading, empty, extra, className, children }: { title: string; loading: boolean; empty: boolean; extra?: ReactNode; className?: string; children: ReactNode }) {
    return (
        <section className={`min-w-0 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-4 md:p-5 ${className || ""}`}>
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

function UserManagement() {
    const { message, modal } = App.useApp();
    const screens = Grid.useBreakpoint();
    const [users, setUsers] = useState<ServerUserProfile[]>([]);
    const currentUserId = useUserStore((state) => Number(state.user?.id));
    const [deletingUserId, setDeletingUserId] = useState<number | null>(null);
    const [total, setTotal] = useState(0);
    const { page, setPage, pageSize, onPaginationChange } = useAdminPagination(PAGE_SIZE);
    const [loading, setLoading] = useState(false);
    const [searchKeyword, setSearchKeyword] = useState("");
    const [userIdKeyword, setUserIdKeyword] = useState("");
    const [filterRole, setFilterRole] = useState<string | undefined>();
    const [filterStatus, setFilterStatus] = useState<number | undefined>();
    const [filterCreatedAfter, setFilterCreatedAfter] = useState<string | undefined>();
    const [filterCreatedBefore, setFilterCreatedBefore] = useState<string | undefined>();
    const [createUserOpen, setCreateUserOpen] = useState(false);
    const [newUserEmail, setNewUserEmail] = useState("");
    const [newUserPassword, setNewUserPassword] = useState("");
    const [newUserNickname, setNewUserNickname] = useState("");
    const [newUserRole, setNewUserRole] = useState<string>("user");
    const [creditUser, setCreditUser] = useState<ServerUserProfile | null>(null);
    const [creditChangeAmount, setCreditChangeAmount] = useState<number | null>(null);
    const [creditReason, setCreditReason] = useState("");
    const [creditSaving, setCreditSaving] = useState(false);
    const statisticsQuery = useQuery({
        queryKey: ["admin-user-statistics"],
        queryFn: getServerUserStatistics,
    });

    const loadRequest = useRef(0);
    const loadUsers = useCallback(
        async (nextPage = page) => {
            const requestId = ++loadRequest.current;
            const normalizedUserId = userIdKeyword.trim();
            if (normalizedUserId && !/^[1-9]\d*$/.test(normalizedUserId)) {
                message.warning("请输入正整数用户ID");
                setLoading(false);
                return;
            }
            setLoading(true);
            try {
                const result = await listServerUsers({
                    page: nextPage,
                    pageSize,
                    keyword: searchKeyword || undefined,
                    userId: normalizedUserId || undefined,
                    role: filterRole,
                    status: filterStatus,
                    createdAfter: filterCreatedAfter,
                    createdBefore: filterCreatedBefore,
                });
                if (requestId !== loadRequest.current) return;
                setPage(clampPage(nextPage, result.total, pageSize));
                setUsers(result.users);
                setTotal(result.total);
            } catch (error) {
                if (requestId !== loadRequest.current) return;
                message.error(error instanceof Error ? error.message : "查询用户失败");
            } finally {
                if (requestId === loadRequest.current) setLoading(false);
            }
        },
        [message, page, pageSize, searchKeyword, userIdKeyword, filterRole, filterStatus, filterCreatedAfter, filterCreatedBefore],
    );

    useEffect(() => {
        void loadUsers(page);
    }, [loadUsers, page]);

    const handleSearch = () => {
        setPage(1);
        void loadUsers(1);
    };

    const handleCreateUser = async () => {
        if (!newUserEmail.trim() || !newUserPassword.trim()) {
            message.warning("请填写邮箱和密码");
            return;
        }
        try {
            await adminCreateUser({ email: newUserEmail.trim(), password: newUserPassword, nickname: newUserNickname.trim() || undefined, role: newUserRole });
            message.success("用户已创建");
            setCreateUserOpen(false);
            setNewUserEmail("");
            setNewUserPassword("");
            setNewUserNickname("");
            setNewUserRole("user");
            setPage(1);
            await Promise.all([loadUsers(1), statisticsQuery.refetch()]);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "创建用户失败");
        }
    };

    const updateStatus = async (user: ServerUserProfile, status: number) => {
        try {
            await updateServerUserStatus(user.id, status);
            message.success("用户状态已更新");
            await loadUsers(page);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "更新用户状态失败");
        }
    };

    const updateRole = async (user: ServerUserProfile, role: ServerUserRole) => {
        try {
            await updateServerUserRole(user.id, role);
            message.success("用户角色已更新");
            await loadUsers(page);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "更新用户角色失败");
        }
    };

    const openCreditAdjustment = (user: ServerUserProfile) => {
        setCreditUser(user);
        setCreditChangeAmount(null);
        setCreditReason("");
    };

    const saveCreditAdjustment = async () => {
        if (!creditUser || !creditChangeAmount || !creditReason.trim()) {
            message.warning("请填写非零积分变动值和调整原因");
            return;
        }
        setCreditSaving(true);
        try {
            await adjustServerUserCredits({ userId: creditUser.id, changeAmount: creditChangeAmount, reason: creditReason.trim() });
            message.success("用户积分已调整");
            setCreditUser(null);
            await loadUsers(page);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "调整用户积分失败");
        } finally {
            setCreditSaving(false);
        }
    };

    const unlockPassword = (user: ServerUserProfile) => {
        modal.confirm({
            title: "解除密码锁定",
            content: `确认解除“${user.nickname || user.email}”的密码锁定吗？`,
            okText: "解除锁定",
            cancelText: "取消",
            onOk: async () => {
                try {
                    await unlockServerUserPassword(user.id);
                    message.success("密码锁定已解除");
                    await loadUsers(page);
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "解除密码锁定失败");
                }
            },
        });
    };

    const handleDeleteUser = (user: ServerUserProfile) => {
        modal.confirm({
            title: "删除账号",
            content: (
                <div className="space-y-2">
                    <p>确定删除账号“{user.email || user.username}”（ID：{user.id}）？</p>
                    <p>删除后账号无法登录，邮箱可重新注册，无法通过启用恢复。订单和积分流水保留供查询。</p>
                </div>
            ),
            okText: "确认删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                setDeletingUserId(user.id);
                try {
                    await deleteServerUser(user.id);
                    ++loadRequest.current;
                    setUsers((items) => items.filter((item) => item.id !== user.id));
                    setTotal((value) => Math.max(0, value - 1));
                    message.success("账号已删除");
                    await Promise.all([loadUsers(clampPage(page, total - 1, pageSize)), statisticsQuery.refetch()]);
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "删除账号失败，请重试");
                    throw error;
                } finally {
                    setDeletingUserId(null);
                }
            },
        });
    };

    const columns: ColumnsType<ServerUserProfile> = [
        {
            title: "ID",
            dataIndex: "id",
            width: 120,
            render: (value: number) => <span className="tabular-nums">{value}</span>,
        },
        {
            title: "用户",
            dataIndex: "email",
            width: 240,
            render: (_, user) => (
                <div className="min-w-0 break-words">
                    <div className="studio-title font-medium">{user.nickname || user.username || user.email}</div>
                    <div className="studio-caption mt-1 text-xs">{user.email}</div>
                </div>
            ),
        },
        {
            title: "角色",
            dataIndex: "role",
            width: 160,
            render: (_, user) => (
                <Select<ServerUserRole>
                    value={user.role}
                    options={[
                        { label: "普通用户", value: "user" },
                        { label: "管理员", value: "admin" },
                    ]}
                    onChange={(role) => void updateRole(user, role)}
                    className="w-28"
                />
            ),
        },
        {
            title: "状态",
            dataIndex: "status",
            width: 130,
            render: (status: number) => (status === 1 ? <Tag color="green">正常</Tag> : <Tag color="red">禁用</Tag>),
        },
        {
            title: "可用积分",
            dataIndex: "creditBalance",
            width: 120,
            render: (value: number) => <span className="font-medium tabular-nums">{value.toLocaleString()}</span>,
        },
        {
            title: "密码锁定",
            dataIndex: "passwordLockedUntil",
            width: 200,
            render: (value: string | null) => {
                const lockedUntil = value ? new Date(value) : null;
                if (!lockedUntil || Number.isNaN(lockedUntil.getTime()) || lockedUntil.getTime() <= Date.now()) {
                    return <Tag>未锁定</Tag>;
                }
                return <Tag color="orange">锁定至 {lockedUntil.toLocaleString()}</Tag>;
            },
        },
        {
            title: "创建时间",
            dataIndex: "createdAt",
            width: 180,
            render: (value: string) => (value ? new Date(value).toLocaleString() : "-"),
        },
        {
            title: "操作",
            width: 370,
            fixed: screens.md ? "right" : undefined,
            render: (_, user) => (
                <Space size="small">
                    <Button size="small" icon={<SlidersHorizontal className="size-3.5" />} onClick={() => openCreditAdjustment(user)}>调整积分</Button>
                    {user.passwordLockedUntil && new Date(user.passwordLockedUntil).getTime() > Date.now() ? <Button size="small" icon={<LockKeyholeOpen className="size-3.5" />} onClick={() => unlockPassword(user)}>解除锁定</Button> : null}
                    {user.status === 1 ? (
                        <Button size="small" danger icon={<Power className="size-3.5" />} onClick={() => void updateStatus(user, 0)}>
                            禁用
                        </Button>
                    ) : (
                        <Button size="small" icon={<Power className="size-3.5" />} onClick={() => void updateStatus(user, 1)}>启用</Button>
                    )}
                    <Tooltip title={user.id === currentUserId ? "不能删除当前登录账号" : user.role === "admin" ? "管理员账号需先调整为普通用户" : undefined}>
                        <span>
                            <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={user.id === currentUserId || user.role === "admin" || deletingUserId !== null} loading={deletingUserId === user.id} onClick={() => handleDeleteUser(user)}>删除</Button>
                        </span>
                    </Tooltip>
                </Space>
            ),
        },
    ];

    return (
        <div>
            <section className="studio-user-stats mb-6 grid grid-cols-3 overflow-hidden rounded-xl border border-[var(--studio-line)] bg-[var(--studio-surface-soft)]" aria-label="用户统计">
                {[
                    { label: "总用户数", icon: UsersRound, value: statisticsQuery.data?.totalUsers },
                    { label: "本月新增", icon: CalendarPlus, value: statisticsQuery.data?.monthlyNewUsers },
                    { label: "今日新增", icon: UserPlus, value: statisticsQuery.data?.dailyNewUsers },
                ].map((item, index) => (
                    <div key={item.label} className={`min-w-0 px-3 py-4 sm:px-5 ${index > 0 ? "border-l border-[var(--studio-line)]" : ""}`}>
                        <div className="text-xs text-[var(--studio-muted)]"><IconLabel icon={<item.icon />}>{item.label}</IconLabel></div>
                        {statisticsQuery.isLoading ? <Skeleton.Input active size="small" className="mt-2 !h-8 !w-24" /> : <div className="mt-2 text-2xl font-semibold tabular-nums text-[var(--studio-ink)]">{item.value?.toLocaleString() ?? "--"}</div>}
                    </div>
                ))}
            </section>
            <RegistrationEmailSettings />
            {statisticsQuery.isError ? (
                <Alert
                    className="mb-4"
                    type="error"
                    showIcon
                    message="用户统计加载失败"
                    action={
                        <Button size="small" icon={<RefreshCw className="size-3.5" />} onClick={() => void statisticsQuery.refetch()}>
                            重新加载
                        </Button>
                    }
                />
            ) : null}
            <div className="studio-user-filters">
                <div className="studio-user-filter-fields">
                    <Input.Search
                        placeholder="搜索昵称、用户名或邮箱"
                        value={searchKeyword}
                        onChange={(e) => {
                            setSearchKeyword(e.target.value);
                            setPage(1);
                        }}
                        onSearch={handleSearch}
                        className="max-w-64"
                        prefix={<Search className="size-3.5 text-[var(--studio-faint)]" />}
                        allowClear
                    />
                    <Input.Search
                        placeholder="用户ID"
                        value={userIdKeyword}
                        onChange={(e) => {
                            setUserIdKeyword(e.target.value);
                            setPage(1);
                        }}
                        onSearch={handleSearch}
                        className="w-32"
                        inputMode="numeric"
                        prefix={<Search className="size-3.5 text-[var(--studio-faint)]" />}
                        allowClear
                    />
                    <Select<string>
                        placeholder="角色"
                        value={filterRole}
                        onChange={(value) => {
                            setFilterRole(value);
                            setPage(1);
                        }}
                        onClear={() => {
                            setFilterRole(undefined);
                            setPage(1);
                        }}
                        allowClear
                        className="w-28"
                        options={[
                            { label: "普通用户", value: "user" },
                            { label: "管理员", value: "admin" },
                        ]}
                    />
                    <Select<number>
                        placeholder="状态"
                        value={filterStatus}
                        onChange={(value) => {
                            setFilterStatus(value);
                            setPage(1);
                        }}
                        onClear={() => {
                            setFilterStatus(undefined);
                            setPage(1);
                        }}
                        allowClear
                        className="w-24"
                        options={[
                            { label: "正常", value: 1 },
                            { label: "禁用", value: 0 },
                        ]}
                    />
                    <DatePicker.RangePicker
                        onChange={(dates) => {
                            setFilterCreatedAfter(dates?.[0]?.toISOString());
                            setFilterCreatedBefore(dates?.[1]?.toISOString());
                            setPage(1);
                        }}
                        className="w-60"
                    />
                </div>
                <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setCreateUserOpen(true)}>
                    新增用户
                </Button>
            </div>
            <div className="studio-data-table"><Table rowKey="id" columns={columns} dataSource={users} loading={loading} pagination={false} scroll={{ x: 1440 }} /></div>
            <div className="mt-4">
                <ListPagination current={page} pageSize={pageSize} total={total} disabled={loading} onChange={onPaginationChange} label="用户列表分页" />
            </div>

            <Modal title="新增用户" open={createUserOpen} onOk={handleCreateUser} onCancel={() => setCreateUserOpen(false)} okText="创建" cancelText="取消">
                <div className="flex flex-col gap-4">
                    <Input value={newUserEmail} onChange={(e) => setNewUserEmail(e.target.value)} placeholder="邮箱" type="email" />
                    <Input.Password value={newUserPassword} onChange={(e) => setNewUserPassword(e.target.value)} placeholder="密码（至少8位）" />
                    <Input value={newUserNickname} onChange={(e) => setNewUserNickname(e.target.value)} placeholder="昵称（可选）" />
                    <Select<string>
                        value={newUserRole}
                        onChange={setNewUserRole}
                        options={[
                            { label: "普通用户", value: "user" },
                            { label: "管理员", value: "admin" },
                        ]}
                    />
                </div>
            </Modal>

            <Modal
                title={`调整积分${creditUser ? `：${creditUser.nickname || creditUser.email}` : ""}`}
                open={Boolean(creditUser)}
                confirmLoading={creditSaving}
                onOk={() => void saveCreditAdjustment()}
                onCancel={() => setCreditUser(null)}
                okText="确认调整"
                cancelText="取消"
            >
                <div className="flex flex-col gap-4">
                    <div className="text-sm text-[var(--studio-muted)]">
                        当前可用积分：<span className="font-medium tabular-nums text-[var(--studio-ink)]">{creditUser?.creditBalance.toLocaleString() ?? 0}</span>
                    </div>
                    <InputNumber value={creditChangeAmount} precision={0} className="w-full" placeholder="正数增加，负数扣减" onChange={(value) => setCreditChangeAmount(value === null ? null : Number(value))} />
                    <div className="pb-5">
                        <Input.TextArea value={creditReason} maxLength={200} showCount placeholder="填写调整原因" autoSize={{ minRows: 3, maxRows: 5 }} onChange={(event) => setCreditReason(event.target.value)} />
                    </div>
                </div>
            </Modal>
        </div>
    );
}

function NotificationManagement() {
    const { message, modal } = App.useApp();
    const [notifications, setNotifications] = useState<SystemNotification[]>([]);
    const { page, setPage, pageSize, onPaginationChange } = useAdminPagination(PAGE_SIZE);
    const notificationPage = paginateItems(notifications, page, pageSize);
    useClampAdminPage(page, pageSize, notifications.length, setPage);
    const [loading, setLoading] = useState(false);
    const [createOpen, setCreateOpen] = useState(false);
    const [newTitle, setNewTitle] = useState("");
    const [newContent, setNewContent] = useState("");
    const [editOpen, setEditOpen] = useState(false);
    const [editId, setEditId] = useState<number | null>(null);
    const [editTitle, setEditTitle] = useState("");
    const [editContent, setEditContent] = useState("");
    const [deletingId, setDeletingId] = useState<number | null>(null);

    const loadNotifications = useCallback(async () => {
        setLoading(true);
        try {
            const result = await listAdminNotifications();
            setNotifications(result.notifications || []);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "查询公告失败");
        } finally {
            setLoading(false);
        }
    }, [message]);

    useEffect(() => {
        void loadNotifications();
    }, [loadNotifications]);

    const handleCreate = async () => {
        if (!newTitle.trim()) {
            message.warning("请输入公告标题");
            return;
        }
        try {
            await createAdminNotification({ title: newTitle.trim(), content: newContent.trim() });
            message.success("公告已创建");
            setCreateOpen(false);
            setNewTitle("");
            setNewContent("");
            setPage(1);
            await loadNotifications();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "创建公告失败");
        }
    };

    const handleEdit = (record: SystemNotification) => {
        setEditId(record.id);
        setEditTitle(record.title);
        setEditContent(record.content || "");
        setEditOpen(true);
    };

    const handleEditSave = async () => {
        if (!editTitle.trim() || editId === null) return;
        try {
            await updateAdminNotification({ id: editId, title: editTitle.trim(), content: editContent.trim() });
            message.success("公告已更新");
            setEditOpen(false);
            setEditId(null);
            await loadNotifications();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "更新公告失败");
        }
    };

    const handlePublish = (id: number) => {
        modal.confirm({
            title: "发布确认",
            content: "发布后所有用户将看到此公告，确定发布？",
            okText: "发布",
            cancelText: "取消",
            onOk: async () => {
                try {
                    await publishAdminNotification(id);
                    message.success("公告已发布");
                    await loadNotifications();
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "发布公告失败");
                }
            },
        });
    };

    const handleDelete = (record: SystemNotification) => {
        modal.confirm({
            title: "删除公告",
            content: `确定删除“${record.title}”？删除后将从公告栏和消息列表移除，无法恢复。`,
            okText: "确认删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                setDeletingId(record.id);
                try {
                    await deleteAdminNotification(record.id);
                    setNotifications((items) => items.filter((item) => item.id !== record.id));
                    useNotificationStore.getState().removeNotification(record.id);
                    message.success("公告已删除");
                    await useNotificationStore.getState().loadNotifications();
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "删除公告失败，请重试");
                    throw error;
                } finally {
                    setDeletingId(null);
                }
            },
        });
    };

    const columns: ColumnsType<SystemNotification> = [
        { title: "标题", dataIndex: "title", ellipsis: true },
        { title: "内容", dataIndex: "content", ellipsis: true, render: (text: string) => text || "-" },
        {
            title: "优先级",
            dataIndex: "priority",
            width: 100,
            render: (priority: string) => (priority === "high" ? <Tag color="red">高</Tag> : <Tag>普通</Tag>),
        },
        {
            title: "状态",
            dataIndex: "status",
            width: 100,
            render: (status: number) => (status === 1 ? <Tag color="green">已发布</Tag> : <Tag>草稿</Tag>),
        },
        {
            title: "发布时间",
            dataIndex: "publishedAt",
            width: 180,
            render: (value: string) => (value ? new Date(value).toLocaleString() : "-"),
        },
        {
            title: "创建时间",
            dataIndex: "createdAt",
            width: 180,
            render: (value: string) => (value ? new Date(value).toLocaleString() : "-"),
        },
        {
            title: "操作",
            width: 240,
            render: (_, record) => (
                <span className="inline-flex gap-2">
                    <Button size="small" icon={<Edit className="size-3.5" />} disabled={deletingId === record.id} onClick={() => handleEdit(record)}>
                        编辑
                    </Button>
                    {record.status === 0 ? (
                        <Button size="small" icon={<Send className="size-3.5" />} disabled={deletingId === record.id} onClick={() => handlePublish(record.id)}>
                            发布
                        </Button>
                    ) : null}
                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} loading={deletingId === record.id} disabled={deletingId !== null} onClick={() => handleDelete(record)}>
                        删除
                    </Button>
                </span>
            ),
        },
    ];

    return (
        <div>
            <div className="mb-4 flex justify-end">
                <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>
                    新建公告
                </Button>
            </div>
            <Table rowKey="id" columns={columns} dataSource={notificationPage.items} loading={loading} pagination={false} scroll={{ x: 860 }} />
            <ListPagination className="mt-4" current={notificationPage.page} pageSize={pageSize} total={notifications.length} disabled={loading} onChange={onPaginationChange} label="消息分页" />

            <Modal title="新建公告" open={createOpen} onOk={handleCreate} onCancel={() => setCreateOpen(false)} okText="创建" cancelText="取消">
                <div className="flex flex-col gap-4">
                    <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="公告标题" />
                    <Input.TextArea value={newContent} onChange={(e) => setNewContent(e.target.value)} rows={4} placeholder="公告内容（可选）" />
                </div>
            </Modal>

            <Modal title="编辑公告" open={editOpen} onOk={handleEditSave} onCancel={() => setEditOpen(false)} okText="保存" cancelText="取消">
                <div className="flex flex-col gap-4">
                    <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} placeholder="公告标题" />
                    <Input.TextArea value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={4} placeholder="公告内容（可选）" />
                </div>
            </Modal>
        </div>
    );
}

type PromptFormValues = {
    title: string;
    prompt: string;
    category: string;
    tagsText?: string;
    coverUrl?: string;
    preview?: string;
    githubUrl?: string;
    sortOrder?: number;
    status?: number;
};

function PromptManagement() {
    const { message, modal } = App.useApp();
    const [form] = Form.useForm<PromptFormValues>();
    const [prompts, setPrompts] = useState<ServerPrompt[]>([]);
    const [total, setTotal] = useState(0);
    const { page, setPage, pageSize, onPaginationChange } = useAdminPagination(PAGE_SIZE);
    const [loading, setLoading] = useState(false);
    const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
    const [keyword, setKeyword] = useState("");
    const [category, setCategory] = useState<string | undefined>();
    const [status, setStatus] = useState<number | undefined>();
    const [editOpen, setEditOpen] = useState(false);
    const [editingPrompt, setEditingPrompt] = useState<ServerPrompt | null>(null);
    const [categoryOptions, setCategoryOptions] = useState<string[]>([]);
    const [coverMode, setCoverMode] = useState<"upload" | "url">("upload");
    const [coverFile, setCoverFile] = useState<File | null>(null);
    const [coverPreview, setCoverPreview] = useState("");
    const [saving, setSaving] = useState(false);
    const coverInputRef = useRef<HTMLInputElement>(null);

    const selectCoverFile = (file: File | undefined) => {
        if (!file) return;
        if (!file.type.startsWith("image/")) {
            message.error("请选择图片文件");
            return;
        }
        if (coverPreview.startsWith("blob:")) URL.revokeObjectURL(coverPreview);
        setCoverFile(file);
        setCoverPreview(URL.createObjectURL(file));
    };

    const previewCoverUrl = () => {
        const url = String(form.getFieldValue("coverUrl") || "").trim();
        if (!/^https?:\/\//i.test(url)) {
            message.error("请输入有效的图片 URL");
            return;
        }
        if (coverPreview.startsWith("blob:")) URL.revokeObjectURL(coverPreview);
        setCoverFile(null);
        setCoverPreview(url);
    };

    const closeEdit = () => {
        if (coverPreview.startsWith("blob:")) URL.revokeObjectURL(coverPreview);
        setCoverPreview("");
        setCoverFile(null);
        setEditOpen(false);
    };

    const loadRequest = useRef(0);
    const loadPrompts = useCallback(
        async (nextPage = page) => {
            const requestId = ++loadRequest.current;
            setLoading(true);
            try {
                const result = await listAdminPrompts({
                    page: nextPage,
                    pageSize,
                    keyword: keyword || undefined,
                    category,
                    status,
                });
                if (requestId !== loadRequest.current) return;
                setPage(clampPage(nextPage, result.total, pageSize));
                setPrompts(result.items);
                setTotal(result.total);
                setCategoryOptions(result.categories || []);
            } catch (error) {
                if (requestId !== loadRequest.current) return;
                message.error(error instanceof Error ? error.message : "查询提示词失败");
            } finally {
                if (requestId === loadRequest.current) setLoading(false);
            }
        },
        [category, keyword, message, page, pageSize, status],
    );

    useEffect(() => {
        void loadPrompts(page);
    }, [loadPrompts, page]);

    const openCreate = () => {
        setEditingPrompt(null);
        setCoverMode("upload");
        setCoverFile(null);
        setCoverPreview("");
        form.setFieldsValue({ status: 1, sortOrder: 1000, title: "", prompt: "", category: "", tagsText: "", coverUrl: "", preview: "", githubUrl: "" });
        setEditOpen(true);
    };

    const openEdit = (prompt: ServerPrompt) => {
        setEditingPrompt(prompt);
        setCoverMode(prompt.coverUrl ? "url" : "upload");
        setCoverFile(null);
        setCoverPreview(prompt.coverUrl || "");
        form.setFieldsValue({
            title: prompt.title,
            prompt: prompt.prompt,
            category: prompt.category,
            tagsText: prompt.tags.join("，"),
            coverUrl: prompt.coverUrl,
            preview: prompt.preview,
            githubUrl: prompt.githubUrl,
            sortOrder: prompt.sortOrder ?? 1000,
            status: prompt.status ?? 1,
        });
        setEditOpen(true);
    };

    const savePrompt = async () => {
        let values: PromptFormValues;
        try {
            values = await form.validateFields();
        } catch {
            return;
        }
        setSaving(true);
        try {
            let coverUrlValue = values.coverUrl?.trim() || "";
            if (coverFile) {
                const uploaded = await uploadImage(coverFile);
                coverUrlValue = uploaded.url;
            }
            const input = {
                title: values.title.trim(),
                prompt: values.prompt.trim(),
                category: values.category.trim(),
                tags: splitTags(values.tagsText),
                coverUrl: coverUrlValue,
                preview: values.preview?.trim() || "",
                sourceUrl: values.githubUrl?.trim() || "",
                status: values.status ?? 1,
                sortOrder: values.sortOrder ?? 1000,
            };
            if (editingPrompt) {
                await updateAdminPrompt({ id: editingPrompt.id, ...input });
                message.success("提示词已更新");
            } else {
                await createAdminPrompt(input);
                message.success("提示词已创建");
            }
            closeEdit();
            await loadPrompts(editingPrompt ? page : 1);
            if (!editingPrompt) setPage(1);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存提示词失败");
        } finally {
            setSaving(false);
        }
    };

    const handleStatusChange = (prompt: ServerPrompt) => {
        const nextStatus = prompt.status === 1 ? 0 : 1;
        modal.confirm({
            title: nextStatus === 1 ? "启用提示词" : "停用提示词",
            content: nextStatus === 1 ? "启用后用户侧提示词库将展示该提示词。" : "停用后用户侧提示词库将不再展示该提示词。",
            okText: nextStatus === 1 ? "启用" : "停用",
            cancelText: "取消",
            onOk: async () => {
                try {
                    await updateAdminPromptStatus(prompt.id, nextStatus);
                    message.success("提示词状态已更新");
                    await loadPrompts(page);
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "更新提示词状态失败");
                }
            },
        });
    };

    const handleDelete = (ids: number[]) => {
        modal.confirm({
            title: "删除提示词",
            content: "删除后用户侧和管理端列表都不会再展示这些提示词，确定删除？",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                try {
                    await deleteAdminPrompts(ids);
                    message.success("提示词已删除");
                    setSelectedRowKeys((keys) => keys.filter((key) => !ids.includes(Number(key))));
                    await loadPrompts(page);
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "删除提示词失败");
                }
            },
        });
    };

    const handleSearch = () => {
        setPage(1);
        void loadPrompts(1);
    };

    const toggleSelectedPrompt = (promptId: number, checked: boolean) => {
        setSelectedRowKeys((keys) => (checked ? Array.from(new Set([...keys, promptId])) : keys.filter((key) => key !== promptId)));
    };

    return (
        <div>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                    <Input.Search
                        placeholder="搜索标题、内容或分类"
                        value={keyword}
                        onChange={(event) => {
                            setKeyword(event.target.value);
                            setPage(1);
                        }}
                        onSearch={handleSearch}
                        className="w-64"
                        prefix={<Search className="size-3.5 text-[var(--studio-faint)]" />}
                        allowClear
                    />
                    <Select<string>
                        placeholder="分类"
                        value={category}
                        onChange={(value) => {
                            setCategory(value);
                            setPage(1);
                        }}
                        onClear={() => {
                            setCategory(undefined);
                            setPage(1);
                        }}
                        allowClear
                        showSearch
                        className="w-44"
                        options={categoryOptions.map((item) => ({ label: item, value: item }))}
                    />
                    <Select<number>
                        placeholder="状态"
                        value={status}
                        onChange={(value) => {
                            setStatus(value);
                            setPage(1);
                        }}
                        onClear={() => {
                            setStatus(undefined);
                            setPage(1);
                        }}
                        allowClear
                        className="w-28"
                        options={[
                            { label: "启用", value: 1 },
                            { label: "停用", value: 0 },
                        ]}
                    />
                    <Button danger disabled={!selectedRowKeys.length} icon={<Trash2 className="size-4" />} onClick={() => handleDelete(selectedRowKeys.map(Number))}>
                        批量删除
                    </Button>
                </div>
                <Button type="primary" icon={<Plus className="size-4" />} onClick={openCreate}>
                    新增提示词
                </Button>
            </div>
            <AdminSelectionSummary selectedKeys={selectedRowKeys} visibleKeys={prompts.map((item) => item.id)} onClear={() => setSelectedRowKeys([])} />
            {loading ? (
                <div className="studio-empty flex min-h-60 items-center justify-center">
                    <span className="text-sm">加载中...</span>
                </div>
            ) : prompts.length ? (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    {prompts.map((prompt) => {
                        const selected = selectedRowKeys.includes(prompt.id);
                        return (
                            <article key={prompt.id} className="studio-panel-solid group flex min-h-[360px] flex-col overflow-hidden transition hover:-translate-y-0.5 hover:border-[var(--studio-primary-line)]">
                                <div className="relative aspect-[4/3] overflow-hidden bg-[var(--studio-media)]">
                                    {prompt.coverUrl ? (
                                        <img src={prompt.coverUrl} alt={prompt.title} className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]" />
                                    ) : (
                                        <div className="studio-empty flex h-full w-full items-center justify-center text-xs">暂无封面</div>
                                    )}
                                    <label className="absolute left-3 top-3 inline-flex cursor-pointer items-center rounded-md border border-[var(--studio-line)] bg-[var(--studio-glass-strong)] px-2 py-1 text-xs backdrop-blur">
                                        <input type="checkbox" className="mr-1.5" checked={selected} onChange={(event) => toggleSelectedPrompt(prompt.id, event.target.checked)} />
                                        选择
                                    </label>
                                    <Tag color={prompt.status === 1 ? "green" : "red"} className="absolute right-3 top-3 m-0">
                                        {prompt.status === 1 ? "启用" : "停用"}
                                    </Tag>
                                </div>
                                <div className="flex min-h-0 flex-1 flex-col p-4">
                                    <div className="flex items-start justify-between gap-3">
                                        <h3 className="studio-title line-clamp-2 text-sm font-semibold leading-5">{prompt.title}</h3>
                                        <span className="studio-caption shrink-0 text-xs">#{prompt.sortOrder ?? 1000}</span>
                                    </div>
                                    <p className="studio-subtitle mt-2 line-clamp-4 text-xs leading-5">{prompt.prompt}</p>
                                    <div className="mt-3 flex flex-wrap gap-1.5">
                                        <Tag className="m-0 text-[11px]">{prompt.category}</Tag>
                                        {prompt.tags.slice(0, 3).map((tag) => (
                                            <Tag key={tag} className="m-0 text-[11px]">
                                                {tag}
                                            </Tag>
                                        ))}
                                        {prompt.tags.length > 3 ? <Tag className="m-0 text-[11px]">+{prompt.tags.length - 3}</Tag> : null}
                                    </div>
                                    <div className="mt-auto pt-4">
                                        <div className="studio-caption mb-3 text-xs">更新于 {prompt.updatedAt ? new Date(prompt.updatedAt).toLocaleString() : "-"}</div>
                                        <div className="grid grid-cols-3 gap-2">
                                            <Button size="small" icon={<Edit className="size-3.5" />} onClick={() => openEdit(prompt)}>
                                                编辑
                                            </Button>
                                            <Button size="small" icon={<Power className="size-3.5" />} onClick={() => handleStatusChange(prompt)}>
                                                {prompt.status === 1 ? "停用" : "启用"}
                                            </Button>
                                            <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => handleDelete([prompt.id])}>
                                                删除
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                            </article>
                        );
                    })}
                </div>
            ) : (
                <div className="studio-empty flex min-h-60 items-center justify-center text-sm">暂无提示词</div>
            )}
            <div className="mt-4">
                <ListPagination current={page} pageSize={pageSize} total={total} disabled={loading} onChange={onPaginationChange} label="提示词分页" />
            </div>

            <Modal title={editingPrompt ? "编辑提示词" : "新增提示词"} open={editOpen} onOk={savePrompt} onCancel={closeEdit} okText="保存" cancelText="取消" confirmLoading={saving} width={880}>
                <Form form={form} layout="vertical" className="mt-2">
                    <div className="flex h-[560px] gap-5">
                        <div className="flex w-60 shrink-0 flex-col gap-3">
                            <div className="studio-empty flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-[var(--studio-line)] bg-[var(--studio-media)]">
                                {coverPreview ? <img src={coverPreview} alt="封面预览" className="h-full w-full object-contain" /> : <span className="text-xs">暂无封面</span>}
                            </div>
                            <Segmented
                                block
                                value={coverMode}
                                onChange={(value) => setCoverMode(value as "upload" | "url")}
                                options={[
                                    { label: "上传图片", value: "upload" },
                                    { label: "上传 URL", value: "url" },
                                ]}
                            />
                            <input
                                ref={coverInputRef}
                                type="file"
                                accept="image/*"
                                hidden
                                onChange={(event) => {
                                    selectCoverFile(event.target.files?.[0]);
                                    event.target.value = "";
                                }}
                            />
                            {coverMode === "upload" ? (
                                <>
                                    <Form.Item name="coverUrl" hidden className="mb-0">
                                        <Input />
                                    </Form.Item>
                                    <Button icon={<Upload className="size-3.5" />} onClick={() => coverInputRef.current?.click()}>
                                        选择图片并预览
                                    </Button>
                                    {coverFile ? <div className="studio-caption truncate text-xs">{coverFile.name}</div> : null}
                                </>
                            ) : (
                                <>
                                    <Form.Item name="coverUrl" className="mb-0">
                                        <Input placeholder="https://..." allowClear onPressEnter={previewCoverUrl} />
                                    </Form.Item>
                                    <Button icon={<Upload className="size-3.5" />} onClick={previewCoverUrl}>
                                        上传并预览
                                    </Button>
                                </>
                            )}
                        </div>
                        <div className="min-w-0 flex-1 overflow-y-auto pr-1">
                            <Form.Item name="title" label="标题" rules={[{ required: true, message: "请输入标题" }]}>
                                <Input placeholder="请输入提示词标题" />
                            </Form.Item>
                            <Form.Item name="prompt" label="提示词内容" rules={[{ required: true, message: "请输入提示词内容" }]}>
                                <Input.TextArea rows={6} placeholder="请输入提示词内容" />
                            </Form.Item>
                            <div className="grid gap-4 sm:grid-cols-2">
                                <Form.Item name="category" label="分类" rules={[{ required: true, message: "请输入分类" }]}>
                                    <Input placeholder="例如：摄影、海报、角色" />
                                </Form.Item>
                                <Form.Item name="tagsText" label="标签">
                                    <Input placeholder="多个标签用逗号分隔" />
                                </Form.Item>
                            </div>
                            <Form.Item name="preview" label="预览内容">
                                <Input.TextArea rows={3} placeholder="可填写 Markdown 图片预览内容" />
                            </Form.Item>
                            <Form.Item name="githubUrl" label="来源 URL">
                                <Input placeholder="https://..." />
                            </Form.Item>
                            <div className="grid gap-4 sm:grid-cols-2">
                                <Form.Item name="sortOrder" label="排序">
                                    <InputNumber className="w-full" min={0} precision={0} />
                                </Form.Item>
                                <Form.Item name="status" label="状态">
                                    <Select<number>
                                        options={[
                                            { label: "启用", value: 1 },
                                            { label: "停用", value: 0 },
                                        ]}
                                    />
                                </Form.Item>
                            </div>
                        </div>
                    </div>
                </Form>
            </Modal>
        </div>
    );
}

type GenerationStyleFormValues = {
    generationType: "image" | "video";
    name: string;
    stylePrompt: string;
    coverUrl: string;
    category: string;
    sortOrder?: number;
    status?: number;
};

/**
 * 管理员维护图片和视频生成风格。
 *
 * @return 风格管理内容
 */
function GenerationStyleManagement() {
    const { message, modal } = App.useApp();
    const [form] = Form.useForm<GenerationStyleFormValues>();
    const [styles, setStyles] = useState<ServerGenerationStyle[]>([]);
    const [total, setTotal] = useState(0);
    const { page, setPage, pageSize, onPaginationChange } = useAdminPagination(PAGE_SIZE);
    const [keyword, setKeyword] = useState("");
    const [generationType, setGenerationType] = useState<"all" | "image" | "video">("all");
    const [status, setStatus] = useState<number | undefined>();
    const [loading, setLoading] = useState(false);
    const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
    const [editOpen, setEditOpen] = useState(false);
    const [editingStyle, setEditingStyle] = useState<ServerGenerationStyle | null>(null);
    const [coverUploading, setCoverUploading] = useState(false);
    const coverInputRef = useRef<HTMLInputElement>(null);
    const coverUrl = Form.useWatch("coverUrl", form) || "";
    const coverName = Form.useWatch("name", form) || "风格封面";
    const loadRequest = useRef(0);
    const loadStyles = useCallback(
        async (nextPage = page) => {
            const requestId = ++loadRequest.current;
            setLoading(true);
            try {
                const result = await listAdminGenerationStyles({
                    page: nextPage,
                    pageSize,
                    keyword: keyword || undefined,
                    generationType,
                    status,
                });
                if (requestId !== loadRequest.current) return;
                setPage(clampPage(nextPage, result.total, pageSize));
                setStyles(result.styles);
                setTotal(result.total);
            } catch (error) {
                if (requestId !== loadRequest.current) return;
                message.error(error instanceof Error ? error.message : "查询风格失败");
            } finally {
                if (requestId === loadRequest.current) setLoading(false);
            }
        },
        [generationType, keyword, message, page, pageSize, status],
    );

    useEffect(() => {
        void loadStyles(page);
    }, [loadStyles, page]);

    const openCreate = () => {
        setEditingStyle(null);
        form.setFieldsValue({ generationType: "image", name: "", stylePrompt: "", coverUrl: "", category: "", sortOrder: 1000, status: 1 });
        setEditOpen(true);
    };

    const openEdit = (style: ServerGenerationStyle) => {
        setEditingStyle(style);
        form.setFieldsValue({
            generationType: style.generationType,
            name: style.name,
            stylePrompt: style.stylePrompt,
            coverUrl: style.coverUrl || "",
            category: style.category || "",
            sortOrder: style.sortOrder ?? 1000,
            status: style.status ?? 1,
        });
        setEditOpen(true);
    };

    const saveStyle = async () => {
        try {
            const values = await form.validateFields();
            const input = {
                generationType: values.generationType,
                name: values.name.trim(),
                stylePrompt: values.stylePrompt.trim(),
                coverUrl: values.coverUrl.trim(),
                category: values.category.trim(),
                sortOrder: values.sortOrder ?? 1000,
                status: values.status ?? 1,
            };
            if (editingStyle) {
                await updateAdminGenerationStyle({ id: editingStyle.id, ...input });
                message.success("风格已更新");
            } else {
                await createAdminGenerationStyle(input);
                message.success("风格已创建");
            }
            setEditOpen(false);
            await loadStyles(editingStyle ? page : 1);
            if (!editingStyle) setPage(1);
        } catch (error) {
            if (error instanceof Error) message.error(error.message);
        }
    };

    const changeStatus = (style: ServerGenerationStyle) => {
        const nextStatus = style.status === 1 ? 0 : 1;
        modal.confirm({
            title: nextStatus === 1 ? "启用风格" : "停用风格",
            content: nextStatus === 1 ? "启用后用户可以在图片或视频对话框中选择该风格。" : "停用后新生成不能选择该风格，历史快照不受影响。",
            okText: nextStatus === 1 ? "启用" : "停用",
            cancelText: "取消",
            onOk: async () => {
                try {
                    await updateAdminGenerationStyleStatus(style.id, nextStatus);
                    message.success("风格状态已更新");
                    await loadStyles(page);
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "更新风格状态失败");
                }
            },
        });
    };

    const deleteStyles = (ids: number[]) => {
        modal.confirm({
            title: "删除风格",
            content: "删除后新生成不会再展示这些风格，历史快照不受影响，确定删除？",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                try {
                    await deleteAdminGenerationStyles(ids);
                    message.success("风格已删除");
                    setSelectedRowKeys((keys) => keys.filter((key) => !ids.includes(Number(key))));
                    await loadStyles(page);
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "删除风格失败");
                }
            },
        });
    };

    const uploadCover = async (file: File | undefined) => {
        if (!file) return;
        if (!file.type.startsWith("image/")) {
            message.error("请选择图片文件");
            return;
        }
        setCoverUploading(true);
        try {
            const uploaded = await uploadImage(file);
            form.setFieldValue("coverUrl", uploaded.url);
            message.success("封面已上传");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "封面上传失败");
        } finally {
            setCoverUploading(false);
        }
    };

    return (
        <div>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <Space wrap>
                    <Input.Search
                        value={keyword}
                        allowClear
                        placeholder="搜索名称、分类或提示词"
                        onChange={(event) => {
                            setKeyword(event.target.value);
                            setPage(1);
                        }}
                        onSearch={() => {
                            setPage(1);
                        }}
                    />
                    <Select
                        value={generationType}
                        options={[
                            { label: "全部类型", value: "all" },
                            { label: "图片", value: "image" },
                            { label: "视频", value: "video" },
                        ]}
                        onChange={(value) => {
                            setGenerationType(value);
                            setPage(1);
                        }}
                    />
                    <Select
                        allowClear
                        placeholder="全部状态"
                        value={status}
                        options={[
                            { label: "启用", value: 1 },
                            { label: "停用", value: 0 },
                        ]}
                        onChange={(value) => {
                            setStatus(value);
                            setPage(1);
                        }}
                    />
                </Space>
                <Space>
                    {selectedRowKeys.length ? (
                        <Button danger icon={<Trash2 className="size-3.5" />} onClick={() => deleteStyles(selectedRowKeys.map(Number))}>
                            批量删除
                        </Button>
                    ) : null}
                    <Button type="primary" icon={<Plus className="size-4" />} onClick={openCreate}>
                        新增风格
                    </Button>
                </Space>
            </div>
            <AdminSelectionSummary selectedKeys={selectedRowKeys} visibleKeys={styles.map((item) => item.id)} onClear={() => setSelectedRowKeys([])} />
            {loading ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                    {Array.from({ length: 10 }, (_, index) => (
                        <Skeleton.Image key={index} active className="!h-auto !w-full [&_.ant-skeleton-image]:aspect-[3/4] [&_.ant-skeleton-image]:h-auto [&_.ant-skeleton-image]:w-full" />
                    ))}
                </div>
            ) : styles.length ? (
                <>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                        {styles.map((style) => {
                            const selected = selectedRowKeys.includes(style.id);
                            return (
                                <article
                                    key={style.id}
                                    className={`group relative overflow-hidden rounded-md border bg-[var(--studio-surface)] transition ${selected ? "border-[var(--studio-action)] ring-1 ring-[var(--studio-action)]" : "border-[var(--studio-line)] hover:border-[var(--studio-line-strong)]"}`}
                                >
                                    <div className="relative aspect-[3/4] overflow-hidden bg-[var(--studio-surface-raised)]">
                                        <GenerationStyleCover key={style.coverUrl} style={style} className="size-full transition duration-200 group-hover:scale-[1.02] motion-reduce:transform-none" />
                                        <span className="absolute left-2 top-2">
                                            <Checkbox
                                                checked={selected}
                                                aria-label={`选择风格${style.name}`}
                                                onChange={(event) => setSelectedRowKeys((current) => (event.target.checked ? [...new Set([...current, style.id])] : current.filter((id) => id !== style.id)))}
                                            />
                                        </span>
                                        <span
                                            className={`absolute right-2 top-2 rounded-sm border px-1.5 py-0.5 text-[11px] ${style.status === 1 ? "border-[var(--studio-success)] text-[var(--studio-success)]" : "border-[var(--studio-line-strong)] text-[var(--studio-muted)]"}`}
                                        >
                                            {style.status === 1 ? "启用" : "停用"}
                                        </span>
                                        <span className="absolute bottom-2 left-2 rounded-sm bg-[var(--studio-surface)] px-1.5 py-0.5 text-[11px] text-[var(--studio-muted)]">{style.generationType === "video" ? "视频" : "图片"}</span>
                                    </div>
                                    <div className="min-w-0 border-t border-[var(--studio-line)] p-2.5">
                                        <div className="flex min-w-0 items-center justify-between gap-2">
                                            <span className="truncate text-sm font-medium text-[var(--studio-ink)]" title={style.name}>
                                                {style.name}
                                            </span>
                                            <span className="shrink-0 text-[11px] text-[var(--studio-muted)]">#{style.sortOrder}</span>
                                        </div>
                                        <p className="mt-1 truncate text-xs text-[var(--studio-muted)]">{style.category || "未分类"}</p>
                                        <div className="mt-2 flex items-center justify-end gap-1">
                                            <Tooltip title="编辑">
                                                <Button type="text" size="small" shape="circle" icon={<Edit className="size-3.5" />} onClick={() => openEdit(style)} aria-label={`编辑风格${style.name}`} />
                                            </Tooltip>
                                            <Tooltip title={style.status === 1 ? "停用" : "启用"}>
                                                <Button type="text" size="small" shape="circle" icon={<Power className="size-3.5" />} onClick={() => changeStatus(style)} aria-label={`${style.status === 1 ? "停用" : "启用"}风格${style.name}`} />
                                            </Tooltip>
                                        </div>
                                    </div>
                                </article>
                            );
                        })}
                    </div>
                </>
            ) : (
                <Empty description="暂无风格" className="border border-dashed border-[var(--studio-line)] py-12" />
            )}
            <ListPagination className="mt-5" current={page} pageSize={pageSize} total={total} disabled={loading} onChange={onPaginationChange} label="风格分页" />
            <Modal title={editingStyle ? "编辑风格" : "新增风格"} open={editOpen} onOk={saveStyle} onCancel={() => setEditOpen(false)} okText="保存" cancelText="取消" confirmLoading={coverUploading}>
                <Form form={form} layout="vertical">
                    <Form.Item name="name" label="风格名称" rules={[{ required: true, message: "请输入风格名称" }]}>
                        <Input placeholder="例如：电影感" />
                    </Form.Item>
                    <Form.Item name="category" label="分类" rules={[{ required: true, message: "请输入风格分类" }]}>
                        <Input placeholder="例如：人像、国风、电影" maxLength={100} />
                    </Form.Item>
                    <Form.Item name="coverUrl" label="封面" rules={[{ required: true, message: "请上传或填写风格封面" }]}>
                        <Input placeholder="https://..." />
                    </Form.Item>
                    <div className="mb-4 flex items-start gap-3">
                        <div className="h-28 w-[84px] shrink-0 overflow-hidden rounded-md border border-[var(--studio-line)] bg-[var(--studio-surface-raised)]">
                            <GenerationStyleCover key={coverUrl} style={{ name: coverName, coverUrl }} className="size-full" />
                        </div>
                        <div className="min-w-0">
                            <input
                                ref={coverInputRef}
                                hidden
                                type="file"
                                accept="image/*"
                                onChange={(event) => {
                                    void uploadCover(event.target.files?.[0]);
                                    event.target.value = "";
                                }}
                            />
                            <Button icon={<Upload className="size-3.5" />} loading={coverUploading} onClick={() => coverInputRef.current?.click()}>
                                上传封面
                            </Button>
                            <p className="mt-2 text-xs text-[var(--studio-muted)]">上传后会保存对象存储公开地址。</p>
                        </div>
                    </div>
                    <Form.Item name="stylePrompt" label="风格提示词" rules={[{ required: true, message: "请输入风格提示词" }]}>
                        <Input.TextArea rows={6} placeholder="描述需要注入生成提示词的风格特征" />
                    </Form.Item>
                    <div className="grid gap-3 sm:grid-cols-3">
                        <Form.Item name="generationType" label="类型" rules={[{ required: true, message: "请选择类型" }]}>
                            <Select
                                options={[
                                    { label: "图片", value: "image" },
                                    { label: "视频", value: "video" },
                                ]}
                            />
                        </Form.Item>
                        <Form.Item name="sortOrder" label="排序">
                            <InputNumber className="w-full" min={0} />
                        </Form.Item>
                        <Form.Item name="status" label="状态">
                            <Select
                                options={[
                                    { label: "启用", value: 1 },
                                    { label: "停用", value: 0 },
                                ]}
                            />
                        </Form.Item>
                    </div>
                </Form>
            </Modal>
        </div>
    );
}

function splitTags(value?: string) {
    if (!value) return [];
    return value
        .split(/[,，]/)
        .map((item) => item.trim())
        .filter(Boolean);
}

type SkillFormValues = {
    name: string;
    targetType: "image" | "video" | "canvasSettingGraph";
    description?: string;
    systemPrompt: string;
    aspectRatio?: string;
    coverUrl?: string;
    sortOrder?: number;
    status?: number;
};

function SkillManagementTabs() {
    const [scope, setScope] = useState("general");
    useEffect(() => {
        const syncScope = () => setScope(new URLSearchParams(window.location.search).get("skillScope") === "ecommerce" ? "ecommerce" : "general");
        syncScope();
        window.addEventListener("popstate", syncScope);
        return () => window.removeEventListener("popstate", syncScope);
    }, []);
    return (
        <div>
            <Segmented
                className="mb-5"
                value={scope}
                aria-label="技能范围"
                options={[
                    { value: "general", label: <IconLabel icon={<WandSparkles />}> 通用技能</IconLabel> },
                    { value: "ecommerce", label: <IconLabel icon={<ShoppingBag />}> 电商技能</IconLabel> },
                ]}
                onChange={(value) => {
                    setScope(value);
                    const url = new URL(window.location.href);
                    url.searchParams.set("tab", "skills");
                    url.searchParams.set("skillScope", value);
                    window.history.replaceState(window.history.state, "", url);
                }}
            />
            {scope === "ecommerce" ? <EcommerceSkillManagement /> : <SkillManagement />}
        </div>
    );
}

function SkillManagement() {
    const { message, modal } = App.useApp();
    const [form] = Form.useForm<SkillFormValues>();
    const [skills, setSkills] = useState<ServerSkill[]>([]);
    const [total, setTotal] = useState(0);
    const { page, setPage, pageSize, onPaginationChange } = useAdminPagination(PAGE_SIZE);
    const [keyword, setKeyword] = useState("");
    const [targetType, setTargetType] = useState<"all" | "image" | "video" | "canvasSettingGraph">("all");
    const [status, setStatus] = useState<number | undefined>();
    const [loading, setLoading] = useState(false);
    const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
    const [editOpen, setEditOpen] = useState(false);
    const [editingSkill, setEditingSkill] = useState<ServerSkill | null>(null);
    const [coverUploading, setCoverUploading] = useState(false);
    const coverInputRef = useRef<HTMLInputElement>(null);
    const coverUrl = Form.useWatch("coverUrl", form) || "";
    const coverName = Form.useWatch("name", form) || "技能封面";

    const loadRequest = useRef(0);
    const loadSkills = useCallback(
        async (nextPage = page) => {
            const requestId = ++loadRequest.current;
            setLoading(true);
            try {
                const result = await listAdminSkills({
                    page: nextPage,
                    pageSize,
                    keyword: keyword || undefined,
                    targetType,
                    status,
                });
                if (requestId !== loadRequest.current) return;
                setPage(clampPage(nextPage, result.total, pageSize));
                setSkills(result.skills);
                setTotal(result.total);
            } catch (error) {
                if (requestId !== loadRequest.current) return;
                message.error(error instanceof Error ? error.message : "查询技能失败");
            } finally {
                if (requestId === loadRequest.current) setLoading(false);
            }
        },
        [keyword, message, page, pageSize, status, targetType],
    );

    useEffect(() => {
        void loadSkills(page);
    }, [loadSkills, page]);

    const openCreate = () => {
        setEditingSkill(null);
        form.setFieldsValue({ name: "", targetType: "image", description: "", systemPrompt: "", aspectRatio: "16:9", coverUrl: "", sortOrder: 1000, status: 1 });
        setEditOpen(true);
    };

    const openEdit = (skill: ServerSkill) => {
        setEditingSkill(skill);
        form.setFieldsValue({
            name: skill.name,
            targetType: skill.targetType,
            description: skill.description || "",
            systemPrompt: skill.systemPrompt,
            aspectRatio: skill.aspectRatio || "16:9",
            coverUrl: skill.coverUrl || "",
            sortOrder: skill.sortOrder ?? 1000,
            status: skill.status ?? 1,
        });
        setEditOpen(true);
    };

    const saveSkill = async () => {
        try {
            const values = await form.validateFields();
            const input = {
                name: values.name.trim(),
                targetType: values.targetType,
                description: (values.description || "").trim(),
                systemPrompt: values.systemPrompt.trim(),
                aspectRatio: values.aspectRatio || "16:9",
                coverUrl: (values.coverUrl || "").trim(),
                sortOrder: values.sortOrder ?? 1000,
                status: values.status ?? 1,
            };
            if (editingSkill) {
                await updateAdminSkill({ id: editingSkill.id, ...input });
                message.success("技能已更新");
            } else {
                await createAdminSkill(input);
                message.success("技能已创建");
            }
            setEditOpen(false);
            await loadSkills(editingSkill ? page : 1);
            if (!editingSkill) setPage(1);
        } catch (error) {
            if (error instanceof Error) message.error(error.message);
        }
    };

    const uploadCover = async (file: File | undefined) => {
        if (!file) return;
        if (!file.type.startsWith("image/")) {
            message.error("请选择图片文件");
            return;
        }
        setCoverUploading(true);
        try {
            const uploaded = await uploadImage(file);
            form.setFieldValue("coverUrl", uploaded.url);
            message.success("封面已上传");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "封面上传失败");
        } finally {
            setCoverUploading(false);
        }
    };

    const changeStatus = (skill: ServerSkill) => {
        const nextStatus = skill.status === 1 ? 0 : 1;
        modal.confirm({
            title: nextStatus === 1 ? "启用技能" : "停用技能",
            content: nextStatus === 1 ? "启用后用户可以在图片或视频对话框中选择该技能。" : "停用后用户不能继续选择该技能。",
            okText: nextStatus === 1 ? "启用" : "停用",
            cancelText: "取消",
            onOk: async () => {
                try {
                    await updateAdminSkillStatus(skill.id, nextStatus);
                    message.success("技能状态已更新");
                    await loadSkills(page);
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "更新技能状态失败");
                }
            },
        });
    };

    const deleteSkills = (ids: number[]) => {
        modal.confirm({
            title: "删除技能",
            content: "删除后用户不能继续选择这些技能，确定删除？",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                try {
                    await deleteAdminSkills(ids);
                    message.success("技能已删除");
                    setSelectedRowKeys((keys) => keys.filter((key) => !ids.includes(Number(key))));
                    await loadSkills(page);
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "删除技能失败");
                }
            },
        });
    };

    const columns: ColumnsType<ServerSkill> = [
        {
            title: "技能名称",
            dataIndex: "name",
            render: (name: string, skill) => (
                <div className="flex min-w-0 items-center gap-2">
                    <Sparkles className="size-3.5 shrink-0 text-[var(--studio-action)]" />
                    <span className="truncate font-medium text-[var(--studio-ink)]" title={name}>
                        {name}
                    </span>
                </div>
            ),
        },
        {
            title: "类型",
            dataIndex: "targetType",
            width: 110,
            render: (value: string) => <Tag>{value === "video" ? "视频" : "图片"}</Tag>,
        },
        {
            title: "简介",
            dataIndex: "description",
            ellipsis: true,
            render: (description: string) => (description ? <span className="text-[var(--studio-muted)]">{description}</span> : <span className="text-[var(--studio-faint)]">—</span>),
        },
        {
            title: "默认比例",
            dataIndex: "aspectRatio",
            width: 100,
            render: (value: string) => <span className="tabular-nums text-[var(--studio-muted)]">{value || "16:9"}</span>,
        },
        {
            title: "状态",
            dataIndex: "status",
            width: 80,
            render: (value: number) => (value === 1 ? <span className="text-[var(--studio-success)]">启用</span> : <span className="text-[var(--studio-muted)]">停用</span>),
        },
        {
            title: "排序",
            dataIndex: "sortOrder",
            width: 80,
            render: (value: number) => <span className="tabular-nums text-[var(--studio-muted)]">{value}</span>,
        },
        {
            title: "操作",
            key: "actions",
            width: 110,
            render: (_, skill) => (
                <Space size={0}>
                    <Tooltip title="编辑">
                        <Button type="text" size="small" shape="circle" icon={<Edit className="size-3.5" />} onClick={() => openEdit(skill)} aria-label={`编辑技能${skill.name}`} />
                    </Tooltip>
                    <Tooltip title={skill.status === 1 ? "停用" : "启用"}>
                        <Button type="text" size="small" shape="circle" icon={<Power className="size-3.5" />} onClick={() => changeStatus(skill)} aria-label={`${skill.status === 1 ? "停用" : "启用"}技能${skill.name}`} />
                    </Tooltip>
                </Space>
            ),
        },
    ];

    return (
        <div>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <Space wrap>
                    <Input.Search
                        value={keyword}
                        allowClear
                        placeholder="搜索技能名称或简介"
                        onChange={(event) => {
                            setKeyword(event.target.value);
                            setPage(1);
                        }}
                        onSearch={() => {
                            setPage(1);
                        }}
                    />
                    <Select
                        value={targetType}
                        options={[
                            { label: "全部类型", value: "all" },
                            { label: "图片", value: "image" },
                            { label: "视频", value: "video" },
                            { label: "画布设定图", value: "canvasSettingGraph" },
                        ]}
                        onChange={(value) => {
                            setTargetType(value);
                            setPage(1);
                        }}
                    />
                    <Select
                        allowClear
                        placeholder="全部状态"
                        value={status}
                        options={[
                            { label: "启用", value: 1 },
                            { label: "停用", value: 0 },
                        ]}
                        onChange={(value) => {
                            setStatus(value);
                            setPage(1);
                        }}
                    />
                </Space>
                <Space>
                    {selectedRowKeys.length ? (
                        <Button danger icon={<Trash2 className="size-3.5" />} onClick={() => deleteSkills(selectedRowKeys.map(Number))}>
                            批量删除
                        </Button>
                    ) : null}
                    <Button type="primary" icon={<Plus className="size-4" />} onClick={openCreate}>
                        新增技能
                    </Button>
                </Space>
            </div>
            <AdminSelectionSummary selectedKeys={selectedRowKeys} visibleKeys={skills.map((item) => item.id)} onClear={() => setSelectedRowKeys([])} />
            <Table<ServerSkill>
                scroll={{ x: 960 }}
                rowKey="id"
                columns={columns}
                dataSource={skills}
                loading={loading}
                pagination={false}
                rowSelection={{
                    selectedRowKeys,
                    preserveSelectedRowKeys: true,
                    onChange: setSelectedRowKeys,
                }}
                locale={{ emptyText: <Empty description="暂无技能" /> }}
            />
            <ListPagination className="mt-4" current={page} pageSize={pageSize} total={total} disabled={loading} onChange={onPaginationChange} label="技能分页" />
            <Modal title={editingSkill ? "编辑技能" : "新增技能"} open={editOpen} onOk={saveSkill} onCancel={() => setEditOpen(false)} okText="保存" cancelText="取消" width={640} confirmLoading={coverUploading}>
                <Form form={form} layout="vertical">
                    <div className="grid gap-3 sm:grid-cols-3">
                        <Form.Item name="name" label="技能名称" rules={[{ required: true, message: "请输入技能名称" }]} className="sm:col-span-2">
                            <Input placeholder="例如：电商商品图片制作" maxLength={100} />
                        </Form.Item>
                        <Form.Item name="targetType" label="适用类型" rules={[{ required: true, message: "请选择类型" }]}>
                            <Select
                                options={[
                                    { label: "图片", value: "image" },
                                    { label: "视频", value: "video" },
                                    { label: "画布设定图", value: "canvasSettingGraph" },
                                ]}
                            />
                        </Form.Item>
                    </div>
                    <Form.Item name="description" label="技能简介">
                        <Input.TextArea rows={2} maxLength={500} placeholder="展示在用户侧技能选择面板的简介" />
                    </Form.Item>
                    <Form.Item name="coverUrl" label="封面">
                        <Input placeholder="https://...，可留空" />
                    </Form.Item>
                    <Form.Item name="aspectRatio" label="默认比例" rules={[{ required: true, message: "请选择默认比例" }]}>
                        <Select
                            options={[
                                { label: "16:9（横屏）", value: "16:9" },
                                { label: "9:16（竖屏）", value: "9:16" },
                                { label: "1:1（方形）", value: "1:1" },
                                { label: "4:3", value: "4:3" },
                                { label: "3:4", value: "3:4" },
                            ]}
                        />
                    </Form.Item>
                    <div className="mb-4 flex items-start gap-3">
                        <div className="h-28 w-[84px] shrink-0 overflow-hidden rounded-md border border-[var(--studio-line)] bg-[var(--studio-surface-raised)]">
                            <GenerationStyleCover key={coverUrl} style={{ name: coverName, coverUrl }} className="size-full" />
                        </div>
                        <div className="min-w-0">
                            <input
                                ref={coverInputRef}
                                hidden
                                type="file"
                                accept="image/*"
                                onChange={(event) => {
                                    void uploadCover(event.target.files?.[0]);
                                    event.target.value = "";
                                }}
                            />
                            <Button icon={<Upload className="size-3.5" />} loading={coverUploading} onClick={() => coverInputRef.current?.click()}>
                                上传封面
                            </Button>
                            <p className="mt-2 text-xs text-[var(--studio-muted)]">上传后会保存对象存储公开地址，展示在用户侧技能选择面板。</p>
                        </div>
                    </div>
                    <Form.Item name="systemPrompt" label="流程提示词" rules={[{ required: true, message: "请输入流程提示词" }]}>
                        <Input.TextArea rows={12} placeholder="技能内置的生成详情与提示词，驱动主 Agent 按步骤引导用户，例如：步骤1 索要商品信息；步骤2 通过 choices 提供风格选项；最后一步组装完整提示词并让用户确认生成…" />
                    </Form.Item>
                    <div className="grid gap-3 sm:grid-cols-3">
                        <Form.Item name="sortOrder" label="排序">
                            <InputNumber className="w-full" min={0} />
                        </Form.Item>
                        <Form.Item name="status" label="状态">
                            <Select
                                options={[
                                    { label: "启用", value: 1 },
                                    { label: "停用", value: 0 },
                                ]}
                            />
                        </Form.Item>
                    </div>
                </Form>
            </Modal>
        </div>
    );
}

function HomepageShowcaseManagement() {
    const { message, modal } = App.useApp();
    const [items, setItems] = useState<HomepageShowcase[]>([]);
    const { page, setPage, pageSize, onPaginationChange } = useAdminPagination(PAGE_SIZE);
    const showcasePage = paginateItems(items, page, pageSize);
    useClampAdminPage(page, pageSize, items.length, setPage);
    const [loading, setLoading] = useState(false);
    const [editing, setEditing] = useState<HomepageShowcase | null>(null);
    const [open, setOpen] = useState(false);
    const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
    const [form] = Form.useForm();
    const previewMediaType = Form.useWatch("mediaType", form);
    const previewMediaUrl = Form.useWatch("mediaUrl", form);
    const previewThumbnailUrl = Form.useWatch("thumbnailUrl", form);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const result = await listAdminHomepageShowcases();
            setItems(result.items || []);
            setSelectedRowKeys((current) => current.filter((key) => result.items.some((item) => item.id === Number(key))));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "查询首页展示失败");
        } finally {
            setLoading(false);
        }
    }, [message]);

    useEffect(() => {
        void load();
    }, [load]);

    const openCreate = () => {
        setEditing(null);
        form.resetFields();
        form.setFieldsValue({ category: "视觉海报", creatorName: "Inspire Studio", mediaType: "image", targetType: "image", status: 1, sortOrder: 1000 });
        setOpen(true);
    };

    const openEdit = (item: HomepageShowcase) => {
        setEditing(item);
        form.setFieldsValue(item);
        setOpen(true);
    };

    const save = async () => {
        try {
            const values = await form.validateFields();
            const input = {
                title: values.title.trim(),
                description: values.description?.trim() || "",
                category: values.category.trim(),
                creatorName: values.creatorName.trim(),
                mediaType: values.mediaType,
                mediaUrl: values.mediaUrl.trim(),
                thumbnailUrl: values.thumbnailUrl?.trim() || "",
                targetType: values.targetType,
                targetPath: values.targetPath?.trim() || getHomepageTargetPath(values.targetType),
                promptContent: values.promptContent?.trim() || "",
                sortOrder: values.sortOrder ?? 1000,
                status: values.status ?? 1,
            };
            if (editing) {
                await updateAdminHomepageShowcase({ id: editing.id, ...input });
                message.success("首页展示已更新");
            } else {
                await createAdminHomepageShowcase(input);
                message.success("首页展示已创建");
            }
            setOpen(false);
            if (!editing) setPage(1);
            await load();
        } catch (error) {
            if (error instanceof Error) message.error(error.message);
        }
    };

    const toggleStatus = (item: HomepageShowcase) => {
        const nextStatus = item.status === 1 ? 0 : 1;
        modal.confirm({
            title: nextStatus === 1 ? "启用首页展示" : "停用首页展示",
            content: nextStatus === 1 ? "启用后该内容会出现在首页精选作品墙。" : "停用后该内容不会出现在首页。",
            okText: nextStatus === 1 ? "启用" : "停用",
            cancelText: "取消",
            onOk: async () => {
                await updateAdminHomepageShowcaseStatus(item.id, nextStatus);
                await load();
                message.success("首页展示状态已更新");
            },
        });
    };

    const remove = (ids: number[]) => {
        modal.confirm({
            title: "删除首页展示",
            content: "删除后首页不会再展示这些内容，确定继续？",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                await deleteAdminHomepageShowcases(ids);
                setSelectedRowKeys((keys) => keys.filter((key) => !ids.includes(Number(key))));
                await load();
                message.success("首页展示已删除");
            },
        });
    };

    const columns: ColumnsType<HomepageShowcase> = [
        {
            title: "预览",
            width: 100,
            render: (_, item) =>
                item.mediaType === "video" ? <video src={item.mediaUrl} poster={item.thumbnailUrl || undefined} muted className="h-14 w-20 object-cover" /> : <img src={item.mediaUrl} alt={item.title} className="h-14 w-20 object-cover" />,
        },
        {
            title: "标题",
            dataIndex: "title",
            render: (value: string, item) => (
                <div>
                    <div className="studio-title font-medium">{value}</div>
                    <div className="studio-caption mt-1 text-xs">{item.description || "无描述"}</div>
                </div>
            ),
        },
        { title: "分类", dataIndex: "category", width: 110, render: (value: string) => <Tag>{value}</Tag> },
        { title: "创作者", dataIndex: "creatorName", width: 140, ellipsis: true },
        { title: "媒体", dataIndex: "mediaType", width: 100, render: (value: HomepageShowcase["mediaType"]) => <Tag icon={value === "video" ? <Video className="size-3" /> : <ImageIcon className="size-3" />}>{value === "video" ? "视频" : "图片"}</Tag> },
        { title: "入口", dataIndex: "targetType", width: 100, render: (value: string) => (value === "canvas" ? "画布" : value === "asset" ? "资产" : value === "video" ? "视频" : "图片") },
        { title: "排序", dataIndex: "sortOrder", width: 80 },
        { title: "状态", dataIndex: "status", width: 90, render: (value: number) => <Tag color={value === 1 ? "green" : "default"}>{value === 1 ? "启用" : "停用"}</Tag> },
        { title: "更新时间", dataIndex: "updatedAt", width: 180, render: (value: string) => (value ? new Date(value).toLocaleString("zh-CN") : "-") },
        {
            title: "操作",
            key: "actions",
            width: 190,
            render: (_, item) => (
                <Space>
                    <Button size="small" icon={<Edit className="size-3.5" />} onClick={() => openEdit(item)}>
                        编辑
                    </Button>
                    <Button size="small" icon={<Power className="size-3.5" />} onClick={() => toggleStatus(item)}>
                        {item.status === 1 ? "停用" : "启用"}
                    </Button>
                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => remove([item.id])}>
                        删除
                    </Button>
                </Space>
            ),
        },
    ];

    return (
        <div>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <span className="studio-subtitle text-sm">管理首页精选作品，空列表时首页使用内置示例。</span>
                <Space>
                    <Button danger disabled={!selectedRowKeys.length} icon={<Trash2 className="size-4" />} onClick={() => remove(selectedRowKeys.map(Number))}>
                        批量删除
                    </Button>
                    <Button type="primary" icon={<Plus className="size-4" />} onClick={openCreate}>
                        新增展示
                    </Button>
                </Space>
            </div>
            <AdminSelectionSummary selectedKeys={selectedRowKeys} visibleKeys={showcasePage.items.map((item) => item.id)} onClear={() => setSelectedRowKeys([])} />
            <Table
                scroll={{ x: 1280 }}
                rowKey="id"
                rowSelection={{ selectedRowKeys, preserveSelectedRowKeys: true, onChange: setSelectedRowKeys }}
                loading={loading}
                columns={columns}
                dataSource={showcasePage.items}
                pagination={false}
                locale={{ emptyText: "暂无首页展示内容" }}
            />
            <ListPagination className="mt-4" current={showcasePage.page} pageSize={pageSize} total={items.length} disabled={loading} onChange={onPaginationChange} label="首页展示分页" />
            <Modal title={editing ? "编辑首页展示" : "新增首页展示"} open={open} onOk={() => void save()} onCancel={() => setOpen(false)} okText="保存" cancelText="取消" width={720} destroyOnHidden>
                <Form form={form} layout="vertical" className="mt-3">
                    <div className="grid gap-4 sm:grid-cols-2">
                        <Form.Item name="title" label="标题" rules={[{ required: true, message: "请输入标题" }]}>
                            <Input placeholder="例如：夜色中的建筑构成" />
                        </Form.Item>
                        <Form.Item name="description" label="描述">
                            <Input placeholder="首页作品墙中的简短描述" />
                        </Form.Item>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <Form.Item name="category" label="分类" rules={[{ required: true, message: "请输入作品分类" }]}>
                            <Input placeholder="例如：视觉海报" maxLength={50} />
                        </Form.Item>
                        <Form.Item name="creatorName" label="创作者" rules={[{ required: true, message: "请输入创作者名称" }]}>
                            <Input placeholder="例如：Inspire Studio" maxLength={100} />
                        </Form.Item>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <Form.Item name="mediaType" label="媒体类型" rules={[{ required: true }]}>
                            <Select
                                options={[
                                    { label: "图片", value: "image" },
                                    { label: "视频", value: "video" },
                                ]}
                            />
                        </Form.Item>
                        <Form.Item name="targetType" label="目标入口" rules={[{ required: true }]}>
                            <Select
                                options={[
                                    { label: "图片工作区", value: "image" },
                                    { label: "视频工作区", value: "video" },
                                    { label: "无限画布", value: "canvas" },
                                    { label: "资产库", value: "asset" },
                                ]}
                            />
                        </Form.Item>
                    </div>
                    <Form.Item name="mediaUrl" label="媒体 URL" rules={[{ required: true, type: "url", message: "请输入有效的媒体 URL" }]}>
                        <Input placeholder="https://..." />
                    </Form.Item>
                    <Form.Item name="thumbnailUrl" label="视频缩略图 URL" rules={[{ type: "url", message: "请输入有效 URL" }]}>
                        <Input placeholder="视频可选，图片无需填写" />
                    </Form.Item>
                    {previewMediaUrl ? (
                        <div className="mb-4 overflow-hidden rounded-[8px] border border-[var(--studio-line)] bg-[var(--studio-media)]">
                            {previewMediaType === "video" ? (
                                <video src={previewMediaUrl} poster={previewThumbnailUrl || undefined} muted controls className="mx-auto max-h-64 w-full object-contain" />
                            ) : (
                                <img src={previewMediaUrl} alt="首页展示预览" className="mx-auto max-h-64 w-full object-contain" />
                            )}
                        </div>
                    ) : null}
                    <div className="grid gap-4 sm:grid-cols-2">
                        <Form.Item name="targetPath" label="目标路径">
                            <Input placeholder="默认按目标入口生成，例如 /image" />
                        </Form.Item>
                        <Form.Item name="sortOrder" label="排序">
                            <InputNumber className="w-full" min={0} precision={0} />
                        </Form.Item>
                    </div>
                    <Form.Item name="promptContent" label="关联提示词">
                        <Input.TextArea rows={3} placeholder="点击作品后可带入工作区的提示词" />
                    </Form.Item>
                    <Form.Item name="status" label="状态">
                        <Select
                            options={[
                                { label: "启用", value: 1 },
                                { label: "停用", value: 0 },
                            ]}
                        />
                    </Form.Item>
                </Form>
            </Modal>
        </div>
    );
}
