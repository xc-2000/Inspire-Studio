import type { Metadata } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { AppProviders } from "@/features/app-shell/components/app-providers";
import { ThemeScript } from "@/features/theme/components/theme-script";
import { getInitialResolvedTheme, isDarkResolvedTheme } from "@/shared/lib/theme-preference";
import "antd/dist/reset.css";
import "./globals.css";
import React from "react";

export const metadata: Metadata = {
    title: "Inspire Studio",
    description: "Inspire Studio 是面向 AI 视觉创作的一站式工作台，集图片生成、视频创作、智能 Agent、无限画布与资产管理于一体，帮助创作者高效完成从灵感构思到作品交付。",
    icons: {
        icon: "/logo/inspirestudio.svg?v=wordmark",
        shortcut: "/logo/inspirestudio.svg?v=wordmark",
        apple: "/logo/apple-touch-icon.png",
    },
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    // The shell contains no user data. Resolve the saved theme in the bootstrap
    // script before paint so a theme cookie does not make every route dynamic.
    const initialThemePreference = "dark";
    const initialResolvedTheme = getInitialResolvedTheme(initialThemePreference);

    return (
        <html lang="zh-CN" suppressHydrationWarning className="font-sans" data-theme={initialResolvedTheme} data-theme-preference={initialThemePreference} style={{ colorScheme: isDarkResolvedTheme(initialResolvedTheme) ? "dark" : "light" }}>
            <body
                className="bg-background text-foreground antialiased"
                style={{
                    fontFamily: '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif',
                }}
            >
                <ThemeScript preference={initialThemePreference} />
                <AntdRegistry>
                    <AppProviders initialThemePreference={initialThemePreference} initialResolvedTheme={initialResolvedTheme}>
                        {children}
                    </AppProviders>
                </AntdRegistry>
            </body>
        </html>
    );
}
