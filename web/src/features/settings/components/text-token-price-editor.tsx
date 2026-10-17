"use client";

import { Alert, Button, Input, InputNumber, Modal, Select, Table } from "antd";
import { useEffect, useState } from "react";
import { saveTextTokenPrice, type OfficialTokenRate, type TextTokenPrice } from "@/services/api/server";

export function TextTokenPriceEditor({ modelId, saved, rates, disabled, onSaved }: {
    modelId: string; saved?: TextTokenPrice; rates: OfficialTokenRate[]; disabled: boolean; onSaved: (p: TextTokenPrice) => void;
}) {
    const [selected, setSelected] = useState(saved?.officialModel || "");
    const [multiplier, setMultiplier] = useState<number | null>(saved?.multiplier ?? 1);
    const [fx, setFx] = useState<number | null>(saved?.exchangeRate ?? null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState(false);
    useEffect(() => {
        setSelected(saved?.officialModel || ""); setMultiplier(saved?.multiplier ?? 1); setFx(saved?.exchangeRate ?? null);
    }, [saved]);
    const rate = rates.find(r => r.id === selected);
    const exchange = rate?.currency === "CNY" ? 1 : fx;
    const dirty = selected !== (saved?.officialModel || "") || multiplier !== (saved?.multiplier ?? 1) || exchange !== saved?.exchangeRate;
    const valid = !!rate && multiplier !== null && multiplier >= 0 && exchange !== null && exchange > 0;
    async function save() {
        if (!rate || !valid) return;
        setSaving(true); setError(""); setSuccess(false);
        try { const p = await saveTextTokenPrice({ modelConfigId: modelId, officialModel: selected, inputPrice: rate.inputPrice, outputPrice: rate.outputPrice, multiplier: multiplier!, currency: rate.currency, exchangeRate: exchange, version: saved?.version ?? 0 }); onSaved(p); setSuccess(true); }
        catch (e) { setError(e instanceof Error ? e.message : "保存失败"); }
        finally { setSaving(false); }
    }
    return <div className="mt-4 space-y-3 border-t border-[var(--studio-line)] pt-3">
        <label className="block text-xs">官方模型与价格档位
            <Select aria-label="官方模型价格" className="mt-2 w-full" showSearch optionFilterProp="label" placeholder="搜索品牌或模型，选择官方价格" value={selected || undefined} disabled={disabled || saving}
                onChange={id => { setSelected(id); setSuccess(false); if(rates.find(r => r.id === id)?.currency === "USD" && rate?.currency !== "USD") setFx(null); }}
                options={rates.map(r => ({ value: r.id, label: `${r.vendor} · ${r.label} · ${r.inputPrice}/${r.outputPrice} ${r.currency}` }))} />
        </label>
        {rate ? <div className="rounded-lg bg-[var(--studio-surface-soft)] p-3 text-xs leading-6">
            <div>官方输入 <strong>{rate.inputPrice}</strong> / 输出 <strong>{rate.outputPrice}</strong> {rate.currency === "CNY" ? "元" : "美元"} / 百万 Token</div>
            <div className="text-[var(--studio-muted)]">{rate.note} 此处按所选档位固定定价，不自动切换档位或扣除缓存折扣。</div>
            <a href={rate.sourceUrl} target="_blank" rel="noreferrer" className="underline">官方价格</a><span className="ml-3 text-[var(--studio-muted)]">核验 {rate.checkedAt}</span>
        </div> : <p className="text-xs text-[var(--studio-muted)]">尚未设置 Token 价格；当前免费。选择官方价格后保存即可启用。</p>}
        <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs">计费倍率（0 为免费）<InputNumber aria-label="Token 计费倍率" className="mt-2 block" min={0} max={1000000} precision={6} value={multiplier} disabled={disabled || saving} onChange={v => {setMultiplier(v);setSuccess(false);}} /></label>
            {rate?.currency === "USD" ? <label className="text-xs">美元兑人民币（1 USD = 人民币元）<InputNumber aria-label="美元兑人民币汇率" className="mt-2 block" min={0.000001} max={1000000} precision={6} value={fx} placeholder="填写实际汇率" disabled={disabled || saving} onChange={v => {setFx(v);setSuccess(false);}} /></label> : null}
            <Button type="primary" loading={saving} disabled={disabled || !valid || !dirty} onClick={save}>保存此模型 Token 价格</Button>
            {success && !dirty ? <span role="status" className="text-xs text-green-600">已保存</span> : null}
        </div>
        <p className="text-xs leading-5 text-[var(--studio-muted)]">换算：9.9 元 = 1000 积分。费用 =（输入 Token × 输入单价 + 输出 Token × 输出单价）÷ 100万 × 汇率 × 倍率，再换算积分，每次模型调用合计后向上取整。多轮 Agent 按每次调用累计。不含搜索、缓存存储等额外服务费。</p>
        {rate && valid ? <div className="text-xs">当前每百万 Token：输入约 {(rate.inputPrice * exchange! * multiplier! * 1000 / 9.9).toFixed(2)} 积分 · 输出约 {(rate.outputPrice * exchange! * multiplier! * 1000 / 9.9).toFixed(2)} 积分</div> : null}
        {error ? <Alert type="error" showIcon title={error} /> : null}
    </div>;
}

export function OfficialPriceCatalog({ rates }: { rates: OfficialTokenRate[] }) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [vendor, setVendor] = useState("all");
    const [page, setPage] = useState(1);
    const filtered = rates.filter(r => (vendor === "all" || r.vendor === vendor) && `${r.vendor} ${r.label}`.toLowerCase().includes(query.trim().toLowerCase()));
    return <>
        <Button className="mt-3" onClick={() => setOpen(true)}>浏览官方文本价格库（{rates.length} 个模型 / 档位）</Button>
        <Modal title="官方文本模型价格库" open={open} onCancel={() => setOpen(false)} footer={null} width={1000}>
            <p className="mb-4 text-xs text-[var(--studio-muted)]">单位均为每百万 Token。收录厂商公开的实时调用基础价格；同模型的不同档位分别列出。选择报价不代表渠道已开通该模型。</p>
            <div className="mb-4 flex flex-wrap gap-2"><Input aria-label="搜索官方价格库" placeholder="搜索模型" className="max-w-sm" value={query} onChange={e => {setQuery(e.target.value);setPage(1);}} allowClear /><Select aria-label="官方价格品牌" value={vendor} onChange={v => {setVendor(v);setPage(1);}} options={[{value:"all",label:"全部品牌"},...Array.from(new Set(rates.map(r => r.vendor))).map(v => ({value:v,label:v}))]} /></div>
            <Table size="small" rowKey="id" dataSource={filtered} scroll={{x:800}} pagination={{current:page,pageSize:10,total:filtered.length,onChange:setPage,showSizeChanger:false}} columns={[
                {title:"模型 / 档位",dataIndex:"label",width:230}, {title:"品牌",dataIndex:"vendor",width:85},
                {title:"币种",dataIndex:"currency",width:70}, {title:"输入",dataIndex:"inputPrice",width:75}, {title:"输出",dataIndex:"outputPrice",width:75},
                {title:"适用条件",dataIndex:"note",width:280}, {title:"核验日期",dataIndex:"checkedAt",width:100},
                {title:"官方报价",render:(_,r:OfficialTokenRate) => <a href={r.sourceUrl} target="_blank" rel="noreferrer">查看</a>,width:80}
            ]} />
        </Modal>
    </>;
}
