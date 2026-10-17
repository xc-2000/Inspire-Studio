"use client";

import { Input, Select } from "antd";
import { Search, Tags, ListFilter } from "lucide-react";

import { ALL_PROMPTS_OPTION } from "../api/prompts";
import { normalizePromptTags } from "../lib/prompt-query";

type PromptFilterPanelProps = {
    keyword: string;
    selectedTags: string[];
    selectedCategory: string;
    tags: string[];
    categories: string[];
    onKeywordChange: (value: string) => void;
    onTagsChange: (value: string[]) => void;
    onCategoryChange: (value: string) => void;
};

export function PromptFilterPanel(props: PromptFilterPanelProps) {
    return (
        <section className="studio-toolbar grid grid-cols-2 gap-3 p-3 sm:p-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,1fr)]" aria-label="提示词筛选">
            <div className="col-span-2 min-w-0 xl:col-span-1">
                <Input allowClear aria-label="搜索提示词" prefix={<Search className="size-4 text-[var(--studio-faint)]" />} value={props.keyword} placeholder="搜索提示词标题" onChange={(event) => props.onKeywordChange(event.target.value)} />
            </div>
            <Select prefix={<ListFilter />} className="min-w-0" value={props.selectedCategory} options={props.categories.map((category) => ({ label: category, value: category }))} onChange={props.onCategoryChange} aria-label="提示词分类" />
            <Select
                className="min-w-0"
                aria-label="提示词标签"
                prefix={<Tags />}
                mode="multiple"
                allowClear
                maxTagCount="responsive"
                value={props.selectedTags}
                options={props.tags.filter((tag) => tag !== ALL_PROMPTS_OPTION).map((tag) => ({ label: tag, value: tag }))}
                placeholder="筛选标签"
                popupRender={(menu) => <div onWheelCapture={(event) => event.stopPropagation()}>{menu}</div>}
                onChange={(values) => props.onTagsChange(normalizePromptTags(values))}
            />
        </section>
    );
}
