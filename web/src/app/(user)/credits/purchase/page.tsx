"use client";

import { Button } from "antd";
import { ExternalLink, ShoppingBag } from "lucide-react";
import Link from "next/link";

import { PageShell } from "@/shared/components/page-shell";
import { WechatPurchase } from "@/features/payments/wechat-purchase";
import { CreditNavigation } from "../components/credit-navigation";

const creditStoreUrl = process.env.NEXT_PUBLIC_CREDIT_STORE_URL?.trim();

/**
 * 渲染积分购买页。
 *
 * @returns 发卡店铺嵌入页面
 */
export default function CreditPurchasePage() {
    return (
        <PageShell icon={<ShoppingBag />}
            eyebrow="账户"
            title="购买积分"
            description="选择适合你的积分套餐，一次性购买，微信支付后全额到账。"
            width="wide"
            actions={
                creditStoreUrl ? (
                    <Button href={creditStoreUrl} target="_blank" rel="noreferrer" icon={<ExternalLink className="size-4" />}>
                        在新窗口打开店铺
                    </Button>
                ) : undefined
            }
            toolbar={<CreditNavigation active="/credits/purchase" />}
        >

            <WechatPurchase />
            {creditStoreUrl ? <>
            <ol className="grid gap-4 rounded-2xl border border-[var(--studio-line)] bg-[var(--studio-surface)] p-5 sm:grid-cols-3" aria-label="积分购买流程">
                {[
                    { title: "购买卡密", detail: "在下方店铺完成购买并领取卡密。" },
                    { title: "兑换积分", detail: "前往兑换页面，将卡密充值到当前账号。" },
                    { title: "开始创作", detail: "积分到账后即可用于图片与视频生成。" },
                ].map((step, index) => (
                    <li key={step.title} className="flex gap-3">
                        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--studio-primary-soft)] text-xs font-semibold text-[var(--studio-primary)]">{index + 1}</span>
                        <div>
                            <h2 className="text-sm font-semibold text-[var(--studio-ink)]">{step.title}</h2>
                            <p className="mt-1 text-xs leading-5 text-[var(--studio-muted)]">{step.detail}</p>
                        </div>
                    </li>
                ))}
            </ol>
            <section className="min-h-[min(720px,calc(100dvh-220px))] overflow-hidden rounded-[24px] border border-[var(--studio-line)] bg-[var(--studio-glass)] backdrop-blur-[20px]" aria-label="积分购买店铺">
                {creditStoreUrl ? (
                    <iframe title="Inspire Studio 积分购买店铺" src={creditStoreUrl} className="h-full min-h-[min(720px,calc(100dvh-220px))] w-full border-0" referrerPolicy="strict-origin-when-cross-origin" />
                ) : (
                    <div className="flex min-h-80 flex-col items-center justify-center px-6 py-12 text-center">
                        <ShoppingBag className="size-9 text-[var(--studio-faint)]" aria-hidden />
                        <h2 className="mt-4 text-base font-semibold text-[var(--studio-ink)]">积分店铺暂未开放</h2>
                        <p className="mt-2 text-sm text-[var(--studio-muted)]">当前没有配置发卡网站。如果已有卡密，可以直接兑换。</p>
                        <Link href="/credits/redeem" className="mt-6 text-sm font-medium text-[var(--studio-primary)]">
                            前往兑换积分 →
                        </Link>
                    </div>
                )}
            </section>
            </> : null}
        </PageShell>
    );
}
