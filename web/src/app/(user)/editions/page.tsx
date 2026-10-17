import type { Metadata } from "next";
import type { LucideIcon } from "lucide-react";
import { Check, Code2, Layers3, Minus, Network, Server, ListChecks } from "lucide-react";

import { ContactMe } from "./components/contact-me";
import { IconLabel } from "@/shared/components/icon-label";
import { PageShell } from "@/shared/components/page-shell";

export const metadata: Metadata = {
    title: "版本对比 - Inspire Studio",
    description: "对比 Inspire Studio 开源版、单机企业版与集群企业版的企业增强能力。",
};

type EditionKey = "openSource" | "standaloneEnterprise" | "clusterEnterprise";

type Edition = {
    key: EditionKey;
    name: string;
    description: string;
    Icon: LucideIcon;
};

type Feature = {
    name: string;
    availability: Record<EditionKey, boolean>;
};

type FeatureGroup = {
    name: string;
    features: Feature[];
};

const editions: Edition[] = [
    {
        key: "openSource",
        name: "开源版",
        description: "面向个人创作者与具备自主部署能力的团队。",
        Icon: Code2,
    },
    {
        key: "standaloneEnterprise",
        name: "单机企业版",
        description: "包含开源版全部能力，并增加企业级业务、治理和工作台能力。",
        Icon: Server,
    },
    {
        key: "clusterEnterprise",
        name: "集群企业版",
        description: "包含单机企业版全部能力，并支持服务拆分与 Kubernetes 集群部署。",
        Icon: Network,
    },
];

const featureGroups: FeatureGroup[] = [
    {
        name: "架构与部署",
        features: [
            {
                name: "分布式微服务、服务拆分、Kubernetes（K8s）支持",
                availability: { openSource: false, standaloneEnterprise: false, clusterEnterprise: true },
            },
        ],
    },
    {
        name: "商业能力",
        features: [
            {
                name: "支付增强",
                availability: { openSource: false, standaloneEnterprise: true, clusterEnterprise: true },
            },
        ],
    },
    {
        name: "治理与运维",
        features: [
            {
                name: "日志审计增强",
                availability: { openSource: false, standaloneEnterprise: true, clusterEnterprise: true },
            },
            {
                name: "安全增强",
                availability: { openSource: false, standaloneEnterprise: true, clusterEnterprise: true },
            },
            {
                name: "监控增强",
                availability: { openSource: false, standaloneEnterprise: true, clusterEnterprise: true },
            },
        ],
    },
    {
        name: "工作流与工作台",
        features: [
            {
                name: "更多工作流技能（Skill）",
                availability: { openSource: false, standaloneEnterprise: true, clusterEnterprise: true },
            },
            {
                name: "剧本工作台（独立菜单）",
                availability: { openSource: false, standaloneEnterprise: true, clusterEnterprise: true },
            },
            {
                name: "漫剧工作台（独立菜单）",
                availability: { openSource: false, standaloneEnterprise: true, clusterEnterprise: true },
            },
        ],
    },
    {
        name: "商业运营",
        features: [
            {
                name: "套餐订阅模式",
                availability: { openSource: false, standaloneEnterprise: true, clusterEnterprise: true },
            },
        ],
    },
    {
        name: "服务支持",
        features: [
            {
                name: "一年技术支持",
                availability: { openSource: false, standaloneEnterprise: true, clusterEnterprise: true },
            },
        ],
    },
];

export default function EditionsPage() {
    return (
        <PageShell icon={<Layers3 />} eyebrow="Inspire Studio Editions" title="选择适合你的版本" description="两种企业版均包含开源版全部能力；集群企业版相比单机企业版仅增加分布式微服务、服务拆分与 Kubernetes（K8s）部署支持。" width="wide">
            <section aria-labelledby="edition-overview-title">
                <h2 id="edition-overview-title" className="sr-only">
                    版本概览
                </h2>
                <div className="grid gap-4 md:grid-cols-3">
                    {editions.map(({ key, name, description, Icon }) => (
                        <article
                            key={key}
                            className={`flex flex-col rounded-2xl border p-5 sm:p-6 ${key === "standaloneEnterprise" ? "border-[var(--studio-primary-line)] bg-[var(--studio-primary-soft)]" : "border-[var(--studio-line)] bg-[var(--studio-surface)]"}`}
                        >
                            <div className="flex items-center gap-3">
                                <span className="grid size-10 shrink-0 place-items-center rounded-[18px] bg-[var(--studio-primary-soft)] text-[var(--studio-action)]">
                                    <Icon className="size-[18px]" aria-hidden="true" />
                                </span>
                                <h3 className="text-base font-semibold text-[var(--studio-ink)]">{name}</h3>
                            </div>
                            <p className="mt-4 flex-1 text-sm leading-6 text-[var(--studio-muted)]">{description}</p>
                            <p className="mt-6 border-t border-[var(--studio-line)] pt-4 text-xs font-medium text-[var(--studio-ink)]">
                                {key === "openSource" ? "自主部署 · 自由扩展" : key === "standaloneEnterprise" ? "企业运营 · 完整工作台" : "服务拆分 · 集群部署"}
                            </p>
                        </article>
                    ))}
                </div>
            </section>

            <section aria-labelledby="edition-comparison-title">
                <div className="mb-6">
                    <h2 id="edition-comparison-title" className="text-xl font-semibold text-[var(--studio-ink)]">
                        <IconLabel icon={<ListChecks />}>企业增强能力对比</IconLabel>
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-[var(--studio-muted)]">以下仅列出企业版相对开源版增加的能力。</p>
                </div>

                <DesktopComparisonTable />
                <MobileComparisonList />
            </section>

            <ContactMe />
        </PageShell>
    );
}

function DesktopComparisonTable() {
    return (
        <div className="hidden overflow-hidden rounded-[20px] border border-[var(--studio-line)] bg-[var(--studio-glass)] backdrop-blur-[20px] md:block">
            <table className="w-full table-fixed border-collapse text-sm">
                <caption className="sr-only">开源版、单机企业版和集群企业版功能对比</caption>
                <thead className="bg-[var(--studio-surface-raised)] text-[var(--studio-ink)]">
                    <tr>
                        <th scope="col" className="w-[40%] px-5 py-4 text-left font-semibold">
                            功能
                        </th>
                        {editions.map((edition) => (
                            <th key={edition.key} scope="col" className="w-[20%] border-l border-[var(--studio-line)] px-3 py-4 text-center font-semibold">
                                {edition.name}
                            </th>
                        ))}
                    </tr>
                </thead>
                {featureGroups.map((group) => (
                    <FeatureGroupRows key={group.name} group={group} />
                ))}
            </table>
        </div>
    );
}

function FeatureGroupRows({ group }: { group: FeatureGroup }) {
    return (
        <tbody>
            <tr className="border-t border-[var(--studio-line-strong)] bg-[var(--studio-surface-soft)]">
                <th scope="rowgroup" colSpan={4} className="px-5 py-2.5 text-left text-xs font-semibold uppercase tracking-[0.12em] text-[var(--studio-muted)]">
                    {group.name}
                </th>
            </tr>
            {group.features.map((feature) => (
                <tr key={feature.name} className="border-t border-[var(--studio-line)]">
                    <th scope="row" className="px-5 py-4 text-left font-medium leading-6 text-[var(--studio-text)]">
                        {feature.name}
                    </th>
                    {editions.map((edition) => (
                        <td key={edition.key} className="border-l border-[var(--studio-line)] px-3 py-4 text-center">
                            <FeatureAvailabilityStatus supported={feature.availability[edition.key]} />
                        </td>
                    ))}
                </tr>
            ))}
        </tbody>
    );
}

function MobileComparisonList() {
    return (
        <div className="space-y-5 md:hidden">
            {featureGroups.map((group) => (
                <section key={group.name} className="overflow-hidden rounded-[20px] border border-[var(--studio-line)] bg-[var(--studio-glass)] backdrop-blur-[20px]" aria-labelledby={`mobile-${group.name}`}>
                    <h3 id={`mobile-${group.name}`} className="bg-[var(--studio-surface-raised)] px-4 py-3 text-sm font-semibold text-[var(--studio-ink)]">
                        {group.name}
                    </h3>
                    <div className="divide-y divide-[var(--studio-line)]">
                        {group.features.map((feature) => (
                            <article key={feature.name} className="p-4">
                                <h4 className="text-sm font-medium leading-6 text-[var(--studio-ink)]">{feature.name}</h4>
                                <dl className="mt-3 space-y-2">
                                    {editions.map((edition) => (
                                        <div key={edition.key} className="flex min-w-0 items-center justify-between gap-4">
                                            <dt className="text-sm text-[var(--studio-muted)]">{edition.name}</dt>
                                            <dd className="shrink-0">
                                                <FeatureAvailabilityStatus supported={feature.availability[edition.key]} />
                                            </dd>
                                        </div>
                                    ))}
                                </dl>
                            </article>
                        ))}
                    </div>
                </section>
            ))}
        </div>
    );
}

function FeatureAvailabilityStatus({ supported }: { supported: boolean }) {
    return supported ? (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm font-medium text-[var(--studio-success)]">
            <Check className="size-4" aria-hidden="true" />
            支持
        </span>
    ) : (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-[var(--studio-muted)]">
            <Minus className="size-4" aria-hidden="true" />
            不包含
        </span>
    );
}
