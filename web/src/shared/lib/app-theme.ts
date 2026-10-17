import type { ThemeConfig } from "antd";
import { theme as antdTheme } from "antd";

import { isDarkResolvedTheme, type ResolvedTheme } from "@/shared/lib/theme-preference";

const CSS_VAR_KEY_LIGHT = "inspire-studio-light";
const CSS_VAR_KEY_DARK = "inspire-studio-dark";

/** Logo 品牌色 */
const BRAND = {
    light: { primary: "#2563eb", hover: "#3b82f6", active: "#1d4ed8", foreground: "#ffffff", soft: "rgba(37,99,235,0.09)", border: "rgba(37,99,235,0.22)" },
    dark: { primary: "#8ab4ff", hover: "#aecbff", active: "#6b9fff", foreground: "#0b0b0b", soft: "rgba(138,180,255,0.13)", border: "rgba(138,180,255,0.26)" },
};

interface Palette {
    bg: string;
    bgElevated: string;
    border: string;
    borderLight: string;
    text: string;
    textSecondary: string;
    textMuted: string;
    fill: string;
    fillSecondary: string;
    tableSelected: string;
    tableSelectedHover: string;
    tagDefaultBg: string;
    tagDefaultBorder: string;
    tagDefaultText: string;
    layout: string;
    modal: string;
    hoverBg: string;
    shadow: string;
}

const lightPalette: Palette = {
    bg: "rgba(255,255,255,0.88)",
    bgElevated: "#ffffff",
    border: "#cbd5e1",
    borderLight: "#e4e9f1",
    text: "#172238",
    textSecondary: "#475569",
    textMuted: "#64748b",
    fill: "rgba(37,99,235,0.06)",
    fillSecondary: "#f0f3f8",
    tableSelected: "rgba(37,99,235,0.09)",
    tableSelectedHover: "rgba(37,99,235,0.14)",
    tagDefaultBg: "#f6f8fc",
    tagDefaultBorder: "#e4e9f1",
    tagDefaultText: "#475569",
    layout: "#f6f8fc",
    modal: "#ffffff",
    hoverBg: "rgba(255,255,255,0.94)",
    shadow: "0 1px 2px rgba(20,24,27,0.04), 0 8px 24px rgba(20,24,27,0.06)",
};

const darkPalette: Palette = {
    bg: "#141414",
    bgElevated: "#1c1c1c",
    border: "#3a3a3a",
    borderLight: "#292929",
    text: "#f5f5f5",
    textSecondary: "#d4d4d4",
    textMuted: "#a3a3a3",
    fill: "rgba(255,255,255,0.06)",
    fillSecondary: "#1c1c1c",
    tableSelected: "rgba(138,180,255,0.10)",
    tableSelectedHover: "rgba(138,180,255,0.16)",
    tagDefaultBg: "#1c1c1c",
    tagDefaultBorder: "#3a3a3a",
    tagDefaultText: "#d4d4d4",
    layout: "#080808",
    modal: "#141414",
    hoverBg: "rgba(36,36,36,0.96)",
    shadow: "0 1px 2px rgba(0,0,0,0.28), 0 8px 28px rgba(0,0,0,0.38)",
};

const PALETTES: Record<ResolvedTheme, Palette> = {
    light: lightPalette,
    dark: darkPalette,
};

const CSS_VAR_KEYS: Record<ResolvedTheme, string> = {
    light: CSS_VAR_KEY_LIGHT,
    dark: CSS_VAR_KEY_DARK,
};

/**
 * 生成 Ant Design 主题配置。
 *
 * @param resolvedTheme ResolvedTheme 当前生效主题
 * @return antd ThemeConfig
 */
export function getAntThemeConfig(resolvedTheme: ResolvedTheme): ThemeConfig {
    const isDark = isDarkResolvedTheme(resolvedTheme);
    const p = PALETTES[resolvedTheme];
    const brand = BRAND[resolvedTheme];

    return {
        algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        cssVar: { key: CSS_VAR_KEYS[resolvedTheme] },
        token: {
            colorPrimary: brand.primary,
            colorInfo: isDark ? "#8ab6d6" : "#235a8a",
            colorSuccess: isDark ? "#6ee7a8" : "#14724a",
            colorWarning: isDark ? "#f0c674" : "#8a6100",
            colorError: isDark ? "#f08a8a" : "#b02a37",
            colorLink: brand.primary,
            colorLinkHover: brand.hover,
            colorLinkActive: brand.active,
            colorTextLightSolid: "#ffffff",
            colorBgLayout: p.layout,
            colorBgContainer: p.bg,
            colorBgElevated: p.bgElevated,
            colorBorder: p.border,
            colorBorderSecondary: p.borderLight,
            colorText: p.text,
            colorTextSecondary: p.textSecondary,
            colorTextTertiary: p.textMuted,
            colorFillQuaternary: p.fill,
            colorFillTertiary: p.fillSecondary,
            colorSplit: p.borderLight,
            borderRadius: 10,
            boxShadow: p.shadow,
            fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
        },
        components: {
            Button: {
                primaryShadow: "none",
                primaryColor: brand.foreground,
                defaultBg: p.bg,
                defaultBorderColor: p.border,
                defaultColor: p.textSecondary,
                defaultHoverBg: p.hoverBg,
                defaultHoverColor: p.text,
                defaultHoverBorderColor: brand.border,
                borderRadius: 10,
                controlHeight: 38,
            },
            Input: {
                activeBorderColor: brand.primary,
                activeShadow: `0 0 0 2px ${brand.soft}`,
                hoverBorderColor: p.border,
                borderRadius: 10,
                colorBgContainer: p.bg,
            },
            Modal: {
                contentBg: p.modal,
                headerBg: p.modal,
                footerBg: p.modal,
                borderRadiusLG: 18,
            },
            Table: {
                rowSelectedBg: p.tableSelected,
                rowSelectedHoverBg: p.tableSelectedHover,
                headerBg: p.fillSecondary,
                headerColor: p.textMuted,
                borderColor: p.borderLight,
            },
            Tag: {
                defaultBg: p.tagDefaultBg,
                defaultColor: p.tagDefaultText,
            },
            Select: {
                optionActiveBg: p.fillSecondary,
                optionSelectedBg: brand.soft,
                optionSelectedColor: brand.primary,
            },
            Menu: {
                itemActiveBg: brand.soft,
                itemHoverBg: p.fill,
                itemSelectedBg: brand.soft,
                itemSelectedColor: p.text,
                darkItemBg: p.bg,
                darkItemHoverBg: brand.soft,
                darkItemSelectedBg: brand.soft,
                darkItemSelectedColor: p.text,
            },
        },
    };
}
