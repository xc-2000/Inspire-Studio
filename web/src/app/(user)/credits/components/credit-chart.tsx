"use client";

import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import type { EChartsCoreOption } from "echarts/core";
import { BarChart, PieChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

import { useThemeStore } from "@/features/theme/stores/use-theme-store";
import styles from "./credit-chart.module.css";

echarts.use([BarChart, PieChart, GridComponent, TooltipComponent, CanvasRenderer]);

const DISTRIBUTION_COLORS = ["#2563eb", "#64748b", "#0891b2", "#8b5cf6", "#059669", "#d97706", "#db2777", "#6366f1", "#0d9488", "#ea580c", "#9333ea", "#0284c7", "#65a30d", "#e11d48", "#a16207", "#475569"];

type CreditChartDataItem = {
    name: string;
    value: number;
};

type CreditChartProps = {
    type: "pie" | "bar";
    data: CreditChartDataItem[];
    ariaLabel: string;
};

type ChartTheme = {
    action: string;
    accent: string;
    info: string;
    success: string;
    warning: string;
    text: string;
    muted: string;
    line: string;
    surface: string;
};

/**
 * 渲染积分统计图表。
 *
 * @param props 图表类型、数据和无障碍说明
 * @return 图表容器
 */
export function CreditChart({ type, data, ariaLabel }: CreditChartProps) {
    const chartElementReference = useRef<HTMLDivElement>(null);
    const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
    const total = data.reduce((sum, item) => sum + item.value, 0);

    useEffect(() => {
        const chartElement = chartElementReference.current;
        if (!chartElement) return;

        const chart = echarts.init(chartElement);
        const theme = readChartTheme(chartElement);
        chart.setOption(type === "pie" ? createPieOption(data, theme) : createBarOption(data, theme));
        const resizeObserver = new ResizeObserver(() => chart.resize());
        resizeObserver.observe(chartElement);
        return () => {
            resizeObserver.disconnect();
            chart.dispose();
        };
    }, [ariaLabel, data, resolvedTheme, type]);

    if (type === "bar") return <div ref={chartElementReference} className="h-72 w-full" role="img" aria-label={ariaLabel} />;

    return (
        <div className={styles.distribution}>
            <div className={styles.layout}>
                <div className={styles.visual}>
                    <div ref={chartElementReference} className={styles.donut} role="img" aria-label={ariaLabel} />
                    <div className={styles.total}>
                        <span>总消耗</span>
                        <strong>{total.toLocaleString("zh-CN")}</strong>
                        <span>积分</span>
                    </div>
                </div>
                <div className={styles.details}>
                    <div className={styles.legendHeading}>
                        <span>消耗明细 · {data.length} 项</span>
                        <span>{data.length > 5 ? "滚动查看全部" : "占比"}</span>
                    </div>
                    <div className={styles.legendScroll} role="region" aria-label={`${ariaLabel}完整明细`} tabIndex={0}>
                        <ul className={styles.legend}>
                            {data.map((item, index) => {
                                const percentage = total > 0 ? item.value / total * 100 : 0;
                                return (
                                    <li key={`${item.name}-${index}`} className={styles.legendRow}>
                                        <span className={styles.swatch} style={{ backgroundColor: DISTRIBUTION_COLORS[index % DISTRIBUTION_COLORS.length] }} aria-hidden="true" />
                                        <div className={styles.itemCopy}>
                                            <span className={styles.itemName}>{item.name}</span>
                                            <span className={styles.itemValue}>{item.value.toLocaleString("zh-CN")} 积分</span>
                                        </div>
                                        <span className={styles.percentage}>{percentage > 0 && percentage < 0.01 ? "<0.01" : percentage.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}%</span>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                </div>
            </div>
        </div>
    );
}

/**
 * 读取当前主题图表颜色。
 *
 * @param element 图表容器
 * @return 当前主题图表颜色
 */
function readChartTheme(element: HTMLElement): ChartTheme {
    const styles = getComputedStyle(element);
    return {
        action: styles.getPropertyValue("--studio-action").trim(),
        accent: styles.getPropertyValue("--studio-accent").trim(),
        info: styles.getPropertyValue("--studio-info").trim(),
        success: styles.getPropertyValue("--studio-success").trim(),
        warning: styles.getPropertyValue("--studio-warning").trim(),
        text: styles.getPropertyValue("--studio-text").trim(),
        muted: styles.getPropertyValue("--studio-muted").trim(),
        line: styles.getPropertyValue("--studio-line").trim(),
        surface: styles.getPropertyValue("--studio-surface").trim(),
    };
}

/**
 * 创建积分分布扇形图配置。
 *
 * @param data 图表数据
 * @param theme 当前主题颜色
 * @return ECharts 配置
 */
function createPieOption(data: CreditChartDataItem[], theme: ChartTheme): EChartsCoreOption {
    return {
        backgroundColor: "transparent",
        color: DISTRIBUTION_COLORS,
        tooltip: {
            trigger: "item",
            confine: true,
            backgroundColor: theme.surface,
            borderColor: theme.line,
            textStyle: { color: theme.text },
            valueFormatter: (value: string | number) => `${Number(value).toLocaleString("zh-CN")} 积分`,
        },
        series: [{
            type: "pie",
            radius: ["65%", "86%"],
            center: ["50%", "50%"],
            label: { show: false },
            labelLine: { show: false },
            emphasis: { scale: true, scaleSize: 3, label: { show: false } },
            data,
        }],
    };
}

/**
 * 创建积分消耗柱状图配置。
 *
 * @param data 图表数据
 * @param theme 当前主题颜色
 * @return ECharts 配置
 */
function createBarOption(data: CreditChartDataItem[], theme: ChartTheme): EChartsCoreOption {
    return {
        backgroundColor: "transparent",
        tooltip: {
            trigger: "axis",
            backgroundColor: theme.surface,
            borderColor: theme.line,
            textStyle: { color: theme.text },
            valueFormatter: (value: string | number) => `${Number(value).toLocaleString("zh-CN")} 积分`,
        },
        grid: { left: 12, right: 12, top: 18, bottom: 32, containLabel: true },
        xAxis: {
            type: "category",
            data: data.map((item) => item.name),
            axisTick: { show: false },
            axisLine: { lineStyle: { color: theme.line } },
            axisLabel: { color: theme.muted, hideOverlap: true },
        },
        yAxis: {
            type: "value",
            minInterval: 1,
            splitLine: { lineStyle: { color: theme.line } },
            axisLabel: { color: theme.muted },
        },
        series: [{
            type: "bar",
            data: data.map((item) => item.value),
            barMaxWidth: 36,
            itemStyle: { color: theme.action, borderRadius: [4, 4, 0, 0] },
        }],
    };
}
