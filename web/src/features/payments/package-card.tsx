"use client";

import { Button } from "antd";
import { Check, Sparkles, Zap } from "lucide-react";
import type { CreditPaymentPackage } from "@/services/api/server";
import { packageSavingsPercent, packageUnitPrice } from "./package-pricing";

export function PackageCard({ pack, baseline, loading, disabled, onBuy }: {
    pack: CreditPaymentPackage;
    baseline?: CreditPaymentPackage;
    loading?: boolean;
    disabled?: boolean;
    onBuy: () => void;
}) {
    const savings = packageSavingsPercent(pack, baseline);
    const features = pack.features?.length ? pack.features : ["支持图片与视频生成", "可用于画布与电商创作", "微信支付，积分自动到账"];
    return <article className="credit-plan" data-recommended={!!pack.recommended} aria-label={`${pack.name}，${pack.credits.toLocaleString("zh-CN")} 积分，${(pack.amountFen / 100).toFixed(2)} 元`}>
        {pack.recommended && <div className="credit-plan-ribbon"><Sparkles size={12} aria-hidden="true" /> 推荐套餐</div>}
        <div className="credit-plan-top"><h3>{pack.name}</h3>{savings > 0 && <span className="credit-plan-saving">单价省 {savings}%</span>}</div>
        <p className="credit-plan-subtitle">{pack.subtitle || "按需补充创作积分"}</p>
        <p className="credit-plan-unit">{packageUnitPrice(pack)}<span> / 积分</span></p>
        <div className="credit-plan-price"><span>¥</span><strong>{(pack.amountFen / 100).toFixed(2)}</strong><small>一次性</small></div>
        <div className="credit-plan-quota"><strong>{pack.credits.toLocaleString("zh-CN")}</strong><span>积分全额到账</span></div>
        <Button className="credit-plan-buy" block type={pack.recommended ? "primary" : "default"} icon={<Zap size={15} aria-hidden="true" />} loading={loading} disabled={disabled} onClick={onBuy}>立即购买</Button>
        <div className="credit-plan-divider" />
        <p className="credit-plan-includes">套餐说明</p>
        <ul className="credit-plan-features">{features.map((feature, i) => <li key={`${i}-${feature}`}><Check size={15} aria-hidden="true" /><span>{feature}</span></li>)}</ul>
        <p className="credit-plan-footnote">一次充值，按需使用</p>
    </article>;
}
