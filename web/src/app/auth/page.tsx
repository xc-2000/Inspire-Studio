"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { AuthPageFrame } from "./components/auth-page-frame";
import { AuthForm } from "@/features/auth/components/auth-form";
import { safeAuthRedirect } from "@/features/auth/lib/oauth2-login";
import { useUserStore } from "@/features/auth/stores/use-user-store";

export default function AuthPage() {
    return (
        <Suspense fallback={<main className="studio-shell-bg flex min-h-dvh items-center justify-center text-sm text-[var(--studio-muted)]">正在打开登录页...</main>}>
            <AuthPageContent />
        </Suspense>
    );
}

function AuthPageContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const hydrateSession = useUserStore((state) => state.hydrateSession);
    const hydrated = useUserStore((state) => state.hydrated);
    const user = useUserStore((state) => state.user);
    const redirect = safeAuthRedirect(searchParams.get("redirect"));
    const invitationCode = searchParams.get("invitationCode")?.trim() || undefined;

    useEffect(() => {
        hydrateSession();
    }, [hydrateSession]);

    useEffect(() => {
        if (hydrated && user) router.replace(redirect);
    }, [hydrated, redirect, router, user]);

    return (
        <AuthPageFrame>
            <section className="w-full" aria-labelledby="auth-page-title">
                <div className="mb-6">
                    <h1 id="auth-page-title" className="studio-title text-2xl font-semibold">
                        欢迎回到创作工作台
                    </h1>
                    <p className="studio-subtitle mt-2 text-sm">登录后继续你的 AI 视觉创作工作台。</p>
                    {invitationCode ? <p className="mt-3 rounded-md bg-[var(--studio-surface-soft)] px-3 py-2 text-sm text-[var(--studio-text)]">你正在通过邀请链接注册，完成注册后邀请人将获得积分奖励。</p> : null}
                </div>
                <AuthForm onSuccess={() => router.replace(redirect)} redirectPath={redirect} invitationCode={invitationCode} />
            </section>
        </AuthPageFrame>
    );
}
