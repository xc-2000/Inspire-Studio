import Link from "next/link";
import { ArrowUpRight, ChartNoAxesCombined, Gift, ShoppingBag } from "lucide-react";

const items = [
    { href: "/credits", label: "积分概览", Icon: ChartNoAxesCombined },
    { href: "/credits/purchase", label: "购买积分", Icon: ShoppingBag },
    { href: "/credits/redeem", label: "兑换积分", Icon: Gift },
];

export function CreditNavigation({ active }: { active: string }) {
    return (
        <nav aria-label="积分中心" className="flex flex-wrap items-center gap-1 border-b border-[var(--studio-line)] pb-3">
            {items.map(({ href, label, Icon }) => (
                <Link
                    key={href}
                    href={href}
                    aria-current={active === href ? "page" : undefined}
                    className={`inline-flex min-h-11 items-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-primary)] ${active === href ? "bg-[var(--studio-primary-soft)] text-[var(--studio-primary)]" : "text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-ink)]"}`}
                >
                    <Icon className="size-4" aria-hidden />
                    {label}
                </Link>
            ))}
            <Link href="/check-in" className="ml-auto inline-flex min-h-11 items-center gap-1.5 px-3 text-sm text-[var(--studio-muted)] hover:text-[var(--studio-primary)]">
                每日签到 <ArrowUpRight className="size-4" aria-hidden />
            </Link>
        </nav>
    );
}
