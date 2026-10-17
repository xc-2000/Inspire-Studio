"use client";

import { Button, Empty, Input, InputNumber, Select } from "antd";
import { useEffect, useState } from "react";
import { getOfficialTokenRates, getTextTokenPrices, type OfficialTokenRate, type TextTokenPrice, type ServerModelConfig } from "@/services/api/server";
import { ListPagination } from "@/shared/components/list-pagination";
import { usePaginatedList } from "@/shared/hooks/use-paginated-list";
import { VIDEO_GENERATION_MODE_OPTIONS } from "@/features/generation/lib/video-billing";

import { TextTokenPriceEditor, OfficialPriceCatalog } from "./text-token-price-editor";

type Props = {
    models: ServerModelConfig[];
    label: (model: ServerModelConfig) => string;
    disabled: boolean;
    dirty: boolean;
    saving: boolean;
    onCost: (id: string, cost: number) => void;
    onEdit: (model: ServerModelConfig) => void;
    onSave: () => void;
};

export function ModelPricingPanel({ models, label, disabled, dirty, saving, onCost, onEdit, onSave }: Props) {
    const [rates, setRates] = useState<OfficialTokenRate[]>([]);
    const [prices, setPrices] = useState<TextTokenPrice[]>([]);
    const [loadError, setLoadError] = useState("");
    const [reload, setReload] = useState(0);
    useEffect(() => {
        let active = true;
        Promise.all([getOfficialTokenRates(), getTextTokenPrices()]).then(([r,p]) => { if(active) { setRates(r); setPrices(p); setLoadError(""); } })
            .catch(e => { if(active) setLoadError(e instanceof Error ? e.message : "加载失败"); });
        return () => { active = false; };
    }, [reload]);
    const [query, setQuery] = useState("");
    const [kind, setKind] = useState("all");
    const filtered = models.filter(model => (kind === "all" || model.modelType === kind)
        && label(model).toLowerCase().includes(query.trim().toLowerCase()));
    const pagination = usePaginatedList(filtered, 10, JSON.stringify([query, kind]));
    return <section className="mb-6 rounded-lg border border-[var(--studio-line)] bg-[var(--studio-surface-soft)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
                <h3 className="text-sm font-semibold">每个模型独立定价</h3>
                <p className="mt-1 text-xs leading-5 text-[var(--studio-muted)]">按渠道和模型独立保存。图片、视频和语音使用“保存模型价格”；文本价格在对应模型下单独保存。</p>
            </div>
            <Button type="primary" disabled={disabled || !dirty} loading={saving} onClick={onSave}>保存模型价格</Button>
        </div>
        <OfficialPriceCatalog rates={rates} />
        {loadError ? <div role="alert" className="mt-3 text-red-500">{loadError} <Button onClick={() => setReload(x => x+1)}>重新加载价格</Button></div> : null}
        <div className="my-4 flex flex-wrap gap-2">
            <Input aria-label="搜索定价模型" placeholder="搜索模型名称或渠道" value={query} allowClear onChange={e => setQuery(e.target.value)} className="max-w-sm" />
            <Select aria-label="定价模型类型" value={kind} onChange={setKind} options={[{value:"all",label:"全部模型"},{value:"image",label:"图片模型"},{value:"video",label:"视频模型"},{value:"audio",label:"语音模型"},{value:"text",label:"文本模型"}]} />
        </div>
        <div className="space-y-3">
            {pagination.items.map(model => <div key={model.id} className="rounded-lg border border-[var(--studio-line)] bg-[var(--studio-panel)] p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                        <div className="break-words text-sm font-medium">{label(model)}</div>
                        <div className="mt-1 text-xs text-[var(--studio-muted)]">{model.modelType === "image" ? "图片 · 单价 × 生成张数" : model.modelType === "video" ? "视频 · 按模式与分辨率计价" : model.modelType === "audio" ? "语音 · 每段配音按次计价" : "文本 · 按实际输入和输出 Token 结算"}</div>
                    </div>
                    {model.modelType === "image" || model.modelType === "audio" ? <div className="flex items-center gap-2">
                        <InputNumber aria-label={`${label(model)} ${model.modelType === "audio" ? "每段" : "每张"}积分`} min={0} max={2147483647} precision={0} value={model.creditCost} disabled={disabled} onChange={value => { if (value !== null) onCost(model.id, value); }} />
                        <span className="text-xs text-[var(--studio-muted)]">{model.modelType === "audio" ? "积分/段" : "积分/张"}</span>
                    </div> : model.modelType === "video" ? <Button disabled={disabled} onClick={() => onEdit(model)}>配置视频价格</Button> : null}
                </div>
                {model.modelType === "text" ? <TextTokenPriceEditor modelId={model.id} rates={rates} saved={prices.find(p => p.modelConfigId === model.id)} disabled={disabled || !!loadError || !rates.length} onSaved={p => setPrices(old => [...old.filter(x => x.modelConfigId !== p.modelConfigId), p])} /> : null}
                {model.modelType === "video" ? <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--studio-muted)]">
                    {Object.entries(model.videoBillingConfiguration?.modePrices || {}).flatMap(([mode, prices]) => Object.entries(prices || {}).filter(([,price]) => typeof price === "number").map(([resolution, price]) => <span key={`${mode}-${resolution}`} className="rounded border border-[var(--studio-line)] px-2 py-1">
                        {VIDEO_GENERATION_MODE_OPTIONS.find(x => x.value === mode)?.label || mode} · {resolution} · {price} 积分/{model.videoBillingConfiguration?.billingUnit === "second" ? "秒" : "次"}
                    </span>))}
                    {!Object.values(model.videoBillingConfiguration?.modePrices || {}).some(prices => Object.values(prices || {}).some(price => typeof price === "number")) ? <span>尚未配置可用价格，请先配置视频价格。</span> : null}
                </div> : null}
            </div>)}
            {!filtered.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无匹配模型，请先在“我的模型”中添加" /> : null}
        </div>
        <ListPagination current={pagination.page} pageSize={pagination.pageSize} total={pagination.total} onChange={pagination.onChange} label="模型价格分页" />
    </section>;
}
