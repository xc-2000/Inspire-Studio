"use client";

import { createContext, useContext, useEffect, useMemo, useOptimistic, useState, useTransition, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import WorkspaceLoading from "./workspace-loading";

type WorkspaceNavigation = {
    pathname: string;
    pending: boolean;
    navigate: (href: string, options: { replace?: boolean; scroll?: boolean }) => void;
};

const NavigationContext = createContext<WorkspaceNavigation | null>(null);

/** Keep navigation feedback urgent while Next resolves the destination in a transition. */
export function WorkspaceNavigationProvider({ children }: { children: ReactNode }) {
    const router = useRouter();
    const pathname = usePathname();
    const [pending, startTransition] = useTransition();
    const [requestedPathname, setRequestedPathname] = useOptimistic(pathname);
    const value = useMemo<WorkspaceNavigation>(() => ({
        pathname: requestedPathname,
        pending: pending && requestedPathname !== pathname,
        navigate: (href, options) => {
            const destination = new URL(href, window.location.href);
            startTransition(() => {
                setRequestedPathname(destination.pathname);
                if (options.replace) router.replace(href, { scroll: options.scroll });
                else router.push(href, { scroll: options.scroll });
            });
        },
    }), [pathname, pending, requestedPathname, router, setRequestedPathname]);

    return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useWorkspaceNavigation() {
    return useContext(NavigationContext);
}

export function useNavigationPathname() {
    const pathname = usePathname();
    return useWorkspaceNavigation()?.pathname ?? pathname;
}

export function WorkspaceContent({ children }: { children: ReactNode }) {
    const pending = useWorkspaceNavigation()?.pending ?? false;
    const [showLoading, setShowLoading] = useState(false);
    useEffect(() => {
        if (!pending) { setShowLoading(false); return; }
        const timer = window.setTimeout(() => setShowLoading(true), 250);
        return () => window.clearTimeout(timer);
    }, [pending]);
    const loading = pending && showLoading;
    return (
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden" aria-busy={pending} data-workspace-content>
            {/* Preserve the current page until the router commits; never discard an unsaved form just to show loading. */}
            <div className="h-full min-h-0 min-w-0" style={loading ? { visibility: "hidden" } : undefined} inert={pending} aria-hidden={loading || undefined}>{children}</div>
            {loading ? <div className="absolute inset-0"><WorkspaceLoading /></div> : null}
        </div>
    );
}
