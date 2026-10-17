"use client";

import { useState } from "react";
import { InputNumber, Select } from "antd";
import type { VideoBillingConfiguration } from "../stores/use-config-store";

/** 单项为固定时长，多项为可选档位；最短时长随档位同步。 */
export function VideoDurationEditor({ value, onChange }: { value: VideoBillingConfiguration; onChange: (value: VideoBillingConfiguration) => void }) {
    const durations = value.supportedDurationsSeconds || [];
    const [mode, setMode] = useState(durations.length === 1 ? "fixed" : durations.length > 1 ? "options" : "default");
    const [error, setError] = useState("");
    const commit = (values: number[]) => {
        const sorted = [...new Set(values)].sort((a, b) => a - b);
        setError("");
        onChange({ ...value, supportedDurationsSeconds: sorted, minimumDurationSeconds: sorted[0] || value.minimumDurationSeconds });
    };
    return (
        <div className="space-y-3 md:col-span-2">
            <div className="text-sm font-semibold">生成时长</div>
            <div className="grid gap-3 sm:grid-cols-2">
                <Select aria-label="时长设置" value={mode} options={[
                    { value: "default", label: "使用协议默认时长" },
                    { value: "fixed", label: "固定时长" },
                    { value: "options", label: "多个可选时长" },
                ]} onChange={(next) => {
                    setMode(next);
                    if (next === "default") commit([]);
                    else if (next === "fixed") commit([durations[0] || value.minimumDurationSeconds || 15]);
                    else commit(durations.length > 1 ? durations : [...new Set([durations[0] || value.minimumDurationSeconds || 15, 15, 30])]);
                }} />
                {mode === "fixed" ? <InputNumber aria-label="固定时长（秒）" min={1} max={300} precision={0} suffix="秒" style={{ width: "100%" }} value={durations[0]} onChange={seconds => { if (seconds) commit([Number(seconds)]); }} /> : null}
                {mode === "options" ? <Select aria-label="可选时长（秒）" mode="tags" tokenSeparators={[",", "，", " "]} value={durations.map(String)} options={[4, 5, 6, 8, 10, 15, 20, 30, 60].map(seconds => ({ value: String(seconds), label: `${seconds} 秒` }))} onChange={(values: string[]) => {
                    if (!values.length || values.some(item => !/^\d+$/.test(item) || Number(item) < 1 || Number(item) > 300)) {
                        setError("请至少保留一个时长，填写 1–300 之间的整数秒");
                        return;
                    }
                    commit(values.map(Number));
                }} /> : null}
            </div>
            <p className="text-xs text-[var(--studio-muted)]">{error || (mode === "fixed" ? `该模型每次固定生成 ${durations[0]} 秒，生成页面和 Agent 将自动使用此时长。` : mode === "options" ? "生成页面和 Agent 只能使用这些时长；输入数字并按回车可添加档位。" : "按当前渠道协议提供时长选项。渠道仅支持一个秒数时，请选择固定时长。")}</p>
        </div>
    );
}
