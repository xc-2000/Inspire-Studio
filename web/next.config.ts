import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const localVersion = process.env.NEXT_PUBLIC_APP_VERSION || "dev";
const localServerUrl = process.env.NEXT_PUBLIC_SERVER_URL?.trim().replace(/\/+$/, "") || "http://127.0.0.1:8080";

function nextConfig(phase: string): NextConfig {
    const isDev = phase === PHASE_DEVELOPMENT_SERVER;

    return {
        output: "standalone",
        poweredByHeader: false,
        // Reuse visited workspace shells. User data continues to refresh through authenticated APIs.
        experimental: { staleTimes: { dynamic: 120, static: 300 } },
        devIndicators: false,
        allowedDevOrigins: isDev ? ["*.*.*.*"] : [],
        typescript: {
            ignoreBuildErrors: true,
        },
        env: {
            NEXT_PUBLIC_APP_VERSION: localVersion,
        },
        async headers() {
            return [{
                source: "/:path*",
                headers: [
                    { key: "Content-Security-Policy", value: "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'" },
                    { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=()" },
                    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
                    { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
                    { key: "X-Content-Type-Options", value: "nosniff" },
                    { key: "X-Frame-Options", value: "DENY" },
                ],
            }, {
                source: "/prompts/covers/:path*",
                headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
            }, {
                source: "/homepage/entries/:path*",
                headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }],
            }, {
                source: "/styles/covers/:path*",
                headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
            }];
        },
        async rewrites() {
            if (!isDev) return [];

            return [{ source: "/api/v1/:path*", destination: `${localServerUrl}/api/v1/:path*` }];
        },
    };
}

export default function configuredNextConfig(phase: string): NextConfig {
    return nextConfig(phase);
}
