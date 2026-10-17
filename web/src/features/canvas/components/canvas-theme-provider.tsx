"use client";

import { createContext, useContext, type ReactNode } from "react";
import { ConfigProvider } from "antd";

import type { CanvasTheme } from "@/shared/lib/canvas-theme";

const CanvasThemeContext = createContext<CanvasTheme | null>(null);

/**
 * 画布主题上下文提供者。
 *
 * @param props ReactNode 与当前画布主题
 * @return JSX.Element
 */
export function CanvasThemeProvider({ children, theme }: { children: ReactNode; theme: CanvasTheme }) {
    return <CanvasThemeContext.Provider value={theme}>
        <ConfigProvider theme={{
            token: { colorPrimary: theme.node.activeStroke, colorInfo: theme.node.activeStroke, colorText: theme.node.text, colorTextSecondary: theme.node.muted, colorTextDisabled: theme.node.faint, colorBgContainer: theme.node.panel, colorBgContainerDisabled: theme.toolbar.itemHover, colorBgElevated: theme.node.panel, colorBorder: theme.node.stroke, borderRadius: 8, fontSize: 13, controlHeight: 34 },
            components: {
                Button: { defaultBg: theme.node.panel, defaultBorderColor: theme.node.stroke, defaultColor: theme.node.text, defaultHoverBg: theme.toolbar.activeBg, defaultHoverColor: theme.node.activeStroke, defaultHoverBorderColor: theme.node.activeStroke, primaryColor: theme.toolbar.activeGradientText, controlHeight: 34, borderRadius: 8 },
                Input: { colorBgContainer: theme.toolbar.itemHover, activeBorderColor: theme.node.activeStroke, hoverBorderColor: theme.node.activeStroke, activeShadow: `0 0 0 2px ${theme.toolbar.activeBg}`, borderRadius: 8 },
                Select: { optionActiveBg: theme.toolbar.itemHover, optionSelectedBg: theme.toolbar.activeBg, optionSelectedColor: theme.node.activeStroke },
                Menu: { itemActiveBg: theme.toolbar.activeBg, itemHoverBg: theme.toolbar.itemHover, itemSelectedBg: theme.toolbar.activeBg, itemSelectedColor: theme.node.activeStroke },
            },
        }}>{children}</ConfigProvider>
    </CanvasThemeContext.Provider>;
}

/**
 * 读取当前画布主题。
 *
 * @return CanvasTheme 当前画布主题
 */
export function useCanvasTheme(): CanvasTheme {
    const theme = useContext(CanvasThemeContext);
    if (!theme) {
        throw new Error("画布主题上下文缺失，请确认组件已包裹在 CanvasThemeProvider 中。");
    }
    return theme;
}
