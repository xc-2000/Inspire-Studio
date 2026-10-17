"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, type ComponentProps } from "react";
import { useWorkspaceNavigation } from "./workspace-navigation";

type Props = Omit<ComponentProps<typeof Link>, "href"> & { href: string };

const prefetchedRoutes = new Map<string, number>();

/** Warm the user's intended destination without downloading every workspace on first paint. */
export function NavigationLink({ href, children, className, onPointerEnter, onPointerLeave, onPointerDown, onFocus, onBlur, onNavigate, prefetch, ...props }: Props) {
    const router = useRouter();
    const navigation = useWorkspaceNavigation();
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const cancelPreload = () => { clearTimeout(timer.current); timer.current = undefined; };
    useEffect(() => () => clearTimeout(timer.current), [href]);
    const preload = () => {
        cancelPreload();
        if (prefetch === false || !href.startsWith("/") || href.startsWith("//")) return;
        const now = Date.now();
        for (const [path, at] of prefetchedRoutes) if (now - at >= 30_000) prefetchedRoutes.delete(path);
        if (prefetchedRoutes.has(href)) return;
        prefetchedRoutes.set(href, now);
        router.prefetch(href);
    };
    return (
        <Link {...props} href={href} prefetch={prefetch === true} className={`relative ${className || ""}`}
            onNavigate={event => {
                // Next calls onNavigate only for client navigation (not downloads, external URLs or modifier clicks).
                let prevented = false;
                onNavigate?.({ preventDefault: () => { prevented = true; event.preventDefault(); } });
                if (prevented || !navigation) return;
                event.preventDefault();
                navigation.navigate(href, { replace: props.replace, scroll: props.scroll });
            }}
            onPointerEnter={event => {
                if (event.pointerType !== "touch") { cancelPreload(); timer.current = setTimeout(preload, 100); }
                onPointerEnter?.(event);
            }}
            onPointerLeave={event => { cancelPreload(); onPointerLeave?.(event); }}
            onPointerDown={event => { preload(); onPointerDown?.(event); }}
            onFocus={event => { preload(); onFocus?.(event); }}
            onBlur={event => { cancelPreload(); onBlur?.(event); }}>
            {children}
        </Link>
    );
}
