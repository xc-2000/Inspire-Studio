"use client";

import { useEffect, useId, useMemo, useState } from "react";

import { Select, SelectContent, SelectItem, SelectTrigger } from "@/shared/components/ui/select";
import { cn } from "@/shared/lib/utils";
import { modelOptionLabel, modelOptionAdminLabel, modelOptionLabelWithRealName, selectableModelsByCapability, type AiConfig, type ModelCapability } from "@/features/settings/stores/use-config-store";


const MODEL_PICKER_OPEN_EVENT = "model-picker-open";

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    onChange: (model: string) => void;
    capability?: ModelCapability;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
    modelOptions?: string[];
    showRealName?: boolean;
    showChannelName?: boolean;
    disabled?: boolean;
    ariaLabel?: string;
};

export function ModelPicker({ config, value, onChange, capability, className, fullWidth = false, placeholder = "选择模型", onMissingConfig, modelOptions, showRealName = false, showChannelName = false, disabled = false, ariaLabel }: ModelPickerProps) {
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const current = value || "";
    const options = useMemo(() => createModelOptions(config, capability, value, modelOptions), [capability, config, modelOptions, value]);
    const visibleOptions = useMemo(() => options.filter((model) => model !== current), [current, options]);
    const modelLabel = (model: string) => showRealName ? modelOptionLabelWithRealName(config, model)
        : showChannelName ? modelOptionAdminLabel(config, model) : modelOptionLabel(config, model);

    useEffect(() => {
        const closeWhenOtherPickerOpens = (event: Event) => {
            const activePickerId = event instanceof CustomEvent ? event.detail : "";
            if (activePickerId !== pickerId) setOpen(false);
        };
        window.addEventListener(MODEL_PICKER_OPEN_EVENT, closeWhenOtherPickerOpens);
        return () => window.removeEventListener(MODEL_PICKER_OPEN_EVENT, closeWhenOtherPickerOpens);
    }, [pickerId]);

    const handleOpenChange = (nextOpen: boolean) => {
        if (nextOpen && !options.length) {
            onMissingConfig?.();
        }
        if (nextOpen) {
            window.dispatchEvent(new CustomEvent(MODEL_PICKER_OPEN_EVENT, { detail: pickerId }));
        }
        setOpen(nextOpen);
    };

    return (
        <Select open={open} value={current} onOpenChange={handleOpenChange} onValueChange={onChange} disabled={disabled}>
            <SelectTrigger
                aria-label={ariaLabel}
                className={cn(
                    "canvas-composer-model-picker h-8 w-fit max-w-full gap-2 rounded-full border border-input bg-transparent px-3 text-sm font-normal shadow-sm transition-colors",
                    fullWidth ? "w-full min-w-0 justify-start" : "min-w-[9rem] justify-start",
                    "data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/20",
                    className,
                )}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                title={current ? modelLabel(current) : placeholder}
            >
                <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">{current ? modelLabel(current) : placeholder}</span>
            </SelectTrigger>
            {open ? (
                <SelectContent
                    data-canvas-no-zoom
                    className="model-picker-menu z-[1200] w-80 max-w-[calc(100vw-24px)] rounded-xl border border-border/70 bg-popover p-1.5 shadow-xl"
                    position="popper"
                    align="start"
                    side="bottom"
                    sideOffset={6}
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                >
                    {options.length ? (
                        <>
                            {options.map((model) => (
                                <SelectItem
                                    key={model}
                                    value={model}
                                    className={cn("model-picker-option min-h-10 py-2 pl-2 pr-2 [&>span:last-child]:w-full", model === current && "hidden")}
                                    title={modelLabel(model)}
                                    textValue={modelLabel(model)}
                                    label={<ModelLabel config={config} model={model} label={modelLabel(model)} />}
                                />
                            ))}
                            {!visibleOptions.length ? (
                                <SelectItem value="__selected_only__" disabled textValue="当前已选择唯一可用模型">
                                    当前已选择唯一可用模型
                                </SelectItem>
                            ) : null}
                        </>
                    ) : (
                        <SelectItem value="__empty__" disabled textValue={emptyModelLabel(config, capability)}>
                            {emptyModelLabel(config, capability)}
                        </SelectItem>
                    )}
                </SelectContent>
            ) : null}
        </Select>
    );
}

function createModelOptions(config: AiConfig, capability: ModelCapability | undefined, value: string | undefined, modelOptions?: string[]) {
    const retainedLocalValue = config.channelMode === "local" && !capability ? [value] : [];
    const configured = selectableModelsByCapability(config, capability);
    const filtered = modelOptions ? configured.filter((model) => modelOptions.includes(model)) : configured;
    const options = Array.from(new Set([...retainedLocalValue, ...filtered].filter(isFilledText)));
    if (!value || !options.includes(value)) return options;
    // Radix打开下拉时会把当前项滚入视口。当前项在列表中隐藏以避免与触发器重复，
    // 因此把它放在首位，防止前面的有效模型被一起滚出可视区域。
    return [value, ...options.filter((model) => model !== value)];
}

function isFilledText(value: string | undefined): value is string {
    return Boolean(value?.trim());
}

function emptyModelLabel(config: AiConfig, capability?: ModelCapability): string {
    if (capability && config.models.length) return "请先在上方配置可选模型";
    if (!config.models.length) return "请先到配置里添加渠道和模型";
    const label = capabilityLabel(capability);
    return label ? `暂无匹配的${label}模型` : "暂无可用模型";
}

function capabilityLabel(capability?: ModelCapability): string {
    switch (capability) {
        case "image":
            return "生图";
        case "video":
            return "视频";
        case "text":
            return "文本";
        default:
            return "";
    }
}

function ModelLabel({ config, model, label }: { config: AiConfig; model: string; label: string }) {
    return (
        <span className="flex w-full min-w-0 items-center gap-2.5">
            <span className="min-w-0 truncate text-[12px]">{label}</span>
            {config.newModels?.includes(model) ? <ModelNewBadge /> : null}
        </span>
    );
}

export function ModelNewBadge() {
    return <span className="model-new-badge" aria-label="新上线模型">NEW</span>;
}
