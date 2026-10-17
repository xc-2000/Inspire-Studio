"use client";

import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import { Bell, Menu, SlidersHorizontal } from "lucide-react";
import { Modal, Popover, Spin, Tooltip } from "antd";

import { AppSidebar } from "@/features/app-shell/components/app-sidebar";
import { UserCreditMenu } from "@/features/app-shell/components/user-credit-menu";
import { WelcomeModal } from "@/features/app-shell/components/welcome-modal";
import { AuthModal } from "@/features/auth/components/auth-modal";
import { MobileNavDrawer } from "@/features/app-shell/components/mobile-nav-drawer";
import { WorkspaceContent, useNavigationPathname } from "./workspace-navigation";
import { NavigationLink } from "@/features/app-shell/components/navigation-link";
import { BrandLogo } from "@/shared/components/brand-logo";
import { navigationTools, type NavigationToolSlug } from "@/shared/constants/navigation-tools";
import { TopbarAnnouncements } from "@/features/notification/components/topbar-announcements";
import { ThemePreferenceMenu } from "@/features/theme/components/theme-preference-menu";
import { useConfigStore } from "@/features/settings/stores/use-config-store";
import { useUserStore } from "@/features/auth/stores/use-user-store";
import { useNotificationStore } from "@/features/notification/stores/use-notification-store";
import styles from "./app-topbar.module.css";

const AppConfigModal = dynamic(() => import("./app-config-modal").then(module => module.AppConfigModal), { ssr: false, loading: ConfigLoading });

function ConfigLoading() {
    const close = useConfigStore((state) => state.setConfigDialogOpen);
    return <Modal open title="配置与用户偏好" footer={null} onCancel={() => close(false)} centered><div role="status" aria-label="正在加载配置" className="flex justify-center p-10"><Spin /></div></Modal>;
}

export function AppShell({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const navigationPathname = useNavigationPathname();
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const isAdmin = useUserStore((state) => state.user?.role === "admin");
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const unreadCount = useNotificationStore((state) => state.unreadCount);

    const hideSidebar = /^\/canvas\/[^/]+/.test(pathname);
    const pathSlug = navigationPathname.split("/").filter(Boolean).slice(0, 2).join("/");
    const slug = pathSlug.startsWith("admin/") ? pathSlug : navigationPathname.split("/").filter(Boolean)[0];
    const activeToolSlug = navigationTools.some((tool) => tool.slug === slug) ? (slug as NavigationToolSlug) : undefined;

    return (
        <div className="studio-app-shell studio-shell-bg relative flex h-dvh flex-col overflow-hidden">
                {!hideSidebar ? (
                    <header className={`studio-topbar ${styles.header}`}>
                        <div className={styles.brand}>
                            <button type="button" className="studio-icon-button md:hidden" onClick={() => setMobileNavOpen(true)} aria-label="打开导航菜单" aria-expanded={mobileNavOpen}>
                                <Menu className="size-5" />
                            </button>
                            <NavigationLink href="/" aria-label="Inspire Studio 首页" className={styles.brandLink}>
                                <BrandLogo compact className="size-7" />
                                <span>Inspire Studio</span>
                            </NavigationLink>
                        </div>
                        <div className={styles.actions}>
                            <Popover trigger="click" placement="bottomRight" title="系统公告" content={<div className="w-[min(420px,calc(100vw-48px))]"><TopbarAnnouncements /></div>}>
                                <button type="button" aria-label="查看公告" className={styles.iconButton}><Bell size={16} strokeWidth={1.6} aria-hidden="true" />{unreadCount > 0 && <span className={styles.unread} />}</button>
                            </Popover>
                            {isAdmin ? (
                                <Tooltip title="配置" placement="bottom">
                                    <button
                                        type="button"
                                        className={styles.iconButton}
                                        onClick={() => openConfigDialog(false)}
                                        aria-label="配置"
                                    >
                                        <SlidersHorizontal className="size-4.5" strokeWidth={1.8} aria-hidden="true" />
                                    </button>
                                </Tooltip>
                            ) : null}
                            <span className={styles.theme}><ThemePreferenceMenu variant="toolbar" className="size-8 rounded-lg text-[var(--studio-muted)] hover:text-[var(--studio-ink)]" /></span>
                            <UserCreditMenu className="shrink-0" />
                        </div>
                    </header>
                ) : null}
            {/* Keep navigation fixed while only the workspace content scrolls. */}
            <div className="relative z-10 flex min-h-0 min-w-0 flex-1 overflow-hidden">
                {!hideSidebar && (
                    <div className="hidden h-full shrink-0 md:block">
                        <AppSidebar />
                    </div>
                )}
                <WorkspaceContent>{children}</WorkspaceContent>
            </div>

            {!hideSidebar ? <MobileNavDrawer open={mobileNavOpen} activeToolSlug={activeToolSlug} onClose={() => setMobileNavOpen(false)} /> : null}
            {isConfigOpen ? <AppConfigModal /> : null}
            <AuthModal />
            <WelcomeModal />
        </div>
    );
}
