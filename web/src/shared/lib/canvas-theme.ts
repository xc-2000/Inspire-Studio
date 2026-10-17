/** 画布主题色板明暗标识。 */
export type CanvasColorTheme = "light" | "dark";

/** 画布背景渲染模式。 */
export type CanvasBackgroundMode = "dots" | "blank";

/** 画布背景相关色值。 */
interface CanvasBgColors {
    background: string;
    /** 画布主背景，与工作台页面背景保持一致。 */
    backgroundGradient: string;
    dot: string;
    selectionStroke: string;
    selectionFill: string;
}

/** 画布节点相关色值。 */
interface CanvasNodeColors {
    label: string;
    fill: string;
    panel: string;
    stroke: string;
    activeStroke: string;
    placeholder: string;
    text: string;
    muted: string;
    faint: string;
}

/** 画布工具栏相关色值。 */
interface CanvasToolbarColors {
    panel: string;
    border: string;
    item: string;
    itemHover: string;
    activeBg: string;
    activeText: string;
    activeGradient: string;
    activeGradientText: string;
}

/** 单个主题色板。 */
interface CanvasColorPalette {
    canvas: CanvasBgColors;
    node: CanvasNodeColors;
    toolbar: CanvasToolbarColors;
}

/**
 * 画布主题色板表。
 * <p>
 * 画布主题色板与工作台深浅主题保持相同的页面背景和操作色。
 * 色值为字符串字面量并 `as const`，便于类型推导。
 */
export const canvasThemes = {
    light: {
        canvas: {
            background: "#f6f7f8",
            backgroundGradient: "radial-gradient(circle at 50% -10%, #ffffff 0%, #f8f9fa 42%, #f3f5f6 100%)",
            dot: "rgba(88,101,109,.20)",
            selectionStroke: "#2f7d85",
            selectionFill: "rgba(47,125,133,.09)",
        },
        node: {
            label: "#5e686f",
            fill: "#ffffff",
            panel: "#ffffff",
            stroke: "#d8dde1",
            activeStroke: "#2f7d85",
            placeholder: "#6b757c",
            text: "#14181b",
            muted: "#667078",
            faint: "#6b757c",
        },
        toolbar: {
            panel: "rgba(255,255,255,.92)",
            border: "rgba(20,24,27,.09)",
            item: "#5e686f",
            itemHover: "#f0f2f3",
            activeBg: "rgba(47,125,133,.10)",
            activeText: "#236168",
            activeGradient: "#2f7d85",
            activeGradientText: "#ffffff",
        },
    },
    dark: {
        canvas: {
            background: "#0b0d0f",
            backgroundGradient: "radial-gradient(circle at 50% -10%, #181b1f 0%, #101316 44%, #0b0d0f 100%)",
            dot: "rgba(190,202,210,.14)",
            selectionStroke: "#7dd3d8",
            selectionFill: "rgba(125,211,216,.09)",
        },
        node: {
            label: "#b4bcc2",
            fill: "#121417",
            panel: "#121417",
            stroke: "#343a41",
            activeStroke: "#7dd3d8",
            placeholder: "#5f676e",
            text: "#eef1f3",
            muted: "#858e96",
            faint: "#5f676e",
        },
        toolbar: {
            panel: "rgba(18,20,23,.92)",
            border: "rgba(238,241,243,.10)",
            item: "#b4bcc2",
            itemHover: "#1f2328",
            activeBg: "rgba(125,211,216,.13)",
            activeText: "#eef1f3",
            activeGradient: "#7dd3d8",
            activeGradientText: "#0a1517",
        },
    },
} as const satisfies Record<CanvasColorTheme, CanvasColorPalette>;

/** 单个主题色板类型。 */
export type CanvasTheme = (typeof canvasThemes)[CanvasColorTheme];
