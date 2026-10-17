"use client";

import { House } from "lucide-react";
import { NavigationLink as Link } from "./navigation-link";
import { useNavigationPathname } from "./workspace-navigation";
import { Tooltip } from "antd";

import { NAV_GROUPS, navigationTools, type NavigationToolSlug } from "@/shared/constants/navigation-tools";
import { useUserStore } from "@/features/auth/stores/use-user-store";
import { cn } from "@/shared/lib/utils";
import styles from "./app-sidebar.module.css";

const compactLabels: Partial<Record<NavigationToolSlug, string>> = {
    canvas: "画布",
    publish: "发布",
    ecommerce: "电商",
    assets: "资产",
    prompts: "提示词",
    "admin/system": "管理",
};

export function AppSidebar() {
    const pathname = useNavigationPathname();
    const isAdmin = useUserStore((state) => state.user?.role === "admin");

    const pathSlug = pathname.split("/").filter(Boolean).slice(0, 2).join("/");
    const slug = pathSlug.startsWith("admin/") ? pathSlug : pathname.split("/").filter(Boolean)[0];

    const visibleTools = navigationTools.filter((tool) => {
        if (tool.adminOnly && !isAdmin) return false;
        return true;
    });
    const activeSlug = navigationTools.some((tool) => tool.slug === slug) ? (slug as NavigationToolSlug) : undefined;

    const renderNavItem = (tool: (typeof navigationTools)[number]) => {
        const Icon = tool.icon;
        const active = tool.slug === activeSlug;

        return (
            <Tooltip key={tool.slug} title={tool.label} placement="right" mouseEnterDelay={0.45}>
                <Link
                    href={`/${tool.slug}`}
                    className={cn(styles.item, active && styles.active)}
                    aria-label={tool.label}
                    aria-current={active ? "page" : undefined}
                >
                    <Icon className={styles.icon} strokeWidth={active ? 1.8 : 1.5} aria-hidden="true" />
                    <span className={styles.label}>{compactLabels[tool.slug] || tool.label}</span>
                </Link>
            </Tooltip>
        );
    };

    return (
        <aside className={styles.rail}>
            <nav className={styles.navigation} aria-label="主导航">
                <Tooltip title="首页" placement="right" mouseEnterDelay={0.45}>
                    <Link href="/" aria-label="首页" aria-current={pathname === "/" ? "page" : undefined} className={cn(styles.item, pathname === "/" && styles.active)}>
                        <House className={styles.icon} strokeWidth={pathname === "/" ? 1.8 : 1.5} aria-hidden="true" />
                        <span className={styles.label}>首页</span>
                    </Link>
                </Tooltip>
                {NAV_GROUPS.map((group) => {
                    const items = visibleTools.filter((tool) => tool.group === group.key);
                    return items.length ? (
                        <div key={group.key} className={cn(styles.group, group.key === "resources" && styles.resources, group.key === "settings" && styles.settings)}>
                            {items.map(renderNavItem)}
                        </div>
                    ) : null;
                })}
            </nav>
        </aside>
    );
}
