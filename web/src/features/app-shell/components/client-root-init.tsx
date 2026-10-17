"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { App } from "antd";
import { usePathname } from "next/navigation";

import { useAiTaskStore } from "@/features/ai-task/stores/use-ai-task-store";
import { useConfigStore } from "@/features/settings/stores/use-config-store";
import { useNotificationStore } from "@/features/notification/stores/use-notification-store";
import { useUserStore } from "@/features/auth/stores/use-user-store";
import { getCurrentUserInfo, subscribeCreditBalanceEvents } from "@/services/api/server";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const pathname = usePathname();
    const sessionHydrated = useUserStore((state) => state.hydrated);
    const hydrateSession = useUserStore((state) => state.hydrateSession);
    const user = useUserStore((state) => state.user);
    const userId = user?.id;
    const canPollNotifications = Boolean(userId) && pathname !== "/auth";
    const needsAssets = pathname === "/assets" || pathname === "/publish" || pathname.startsWith("/canvas/");
    const setUser = useUserStore((state) => state.setUser);
    const setCreditBalance = useUserStore((state) => state.setCreditBalance);
    const hydrateConfig = useConfigStore((state) => state.hydrateConfig);
    const hydrateRunningTasks = useAiTaskStore((state) => state.hydrateRunningTasks);
    const startTaskSubscribe = useAiTaskStore((state) => state.startSubscribe);
    const stopTaskSubscribe = useAiTaskStore((state) => state.stopSubscribe);

    useEffect(() => {
        hydrateSession();
    }, [hydrateSession]);

    useEffect(() => {
        if (!sessionHydrated || !user) return;
        // 登录态只保存了快照，应用启动后以服务端余额覆盖，避免展示过期积分。
        let active = true;
        void getCurrentUserInfo()
            .then((profile) => {
                if (active) setUser(profile);
            })
            .catch(() => undefined);
        return () => {
            active = false;
        };
    }, [sessionHydrated, setUser, user?.id]);

    useEffect(() => {
        if (!user) return;
        const userId = user.id;
        return subscribeCreditBalanceEvents((creditBalance) => {
            if (useUserStore.getState().user?.id === userId) {
                setCreditBalance(creditBalance);
            }
        });
    }, [setCreditBalance, user?.id]);

    useEffect(() => {
        if (!sessionHydrated || !user) return;
        startTaskSubscribe();
        void Promise.all([hydrateConfig(), hydrateRunningTasks()]).catch((error) => {
            message.error(error instanceof Error ? error.message : "加载后端数据失败");
        });
        return stopTaskSubscribe;
    }, [hydrateConfig, hydrateRunningTasks, message, sessionHydrated, startTaskSubscribe, stopTaskSubscribe, userId]);

    useEffect(() => {
        if (!sessionHydrated || !userId || !needsAssets) return;
        let active = true;
        // Load each library only on its consuming routes; image/video editors
        // request assets when the picker opens instead of blocking every visit.
        const tasks: Promise<unknown>[] = [];
        if (needsAssets) tasks.push(import("@/features/assets/stores/use-asset-store")
            .then(async ({ useAssetStore }) => { if (active) await useAssetStore.getState().hydrateAssets(); }));
        void Promise.all(tasks).catch((error) => {
            if (active) message.error(error instanceof Error ? error.message : "加载创作数据失败，请刷新重试");
        });
        return () => { active = false; };
    }, [message, needsAssets, sessionHydrated, userId]);

    // Keep the subscription across workspace navigation and credit balance updates.
    useEffect(() => {
        if (!canPollNotifications) return;
        useNotificationStore.getState().loadNotifications();
        const timer = window.setInterval(() => useNotificationStore.getState().loadNotifications(), 30_000);
        return () => window.clearInterval(timer);
    }, [canPollNotifications, userId]);

    return <>{children}</>;
}
