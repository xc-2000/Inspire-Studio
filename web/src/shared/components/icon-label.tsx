import type { ReactNode } from "react";

import { cn } from "@/shared/lib/utils";
import "./page-details.css";

/** A decorative icon paired with a visible label; the text remains the accessible name. */
export function IconLabel({ icon, children, className }: { icon: ReactNode; children: ReactNode; className?: string }) {
    return <span className={cn("studio-icon-label", className)}><span className="studio-label-glyph" aria-hidden="true">{icon}</span><span className="min-w-0">{children}</span></span>;
}

export function EmptyGlyph({ children }: { children: ReactNode }) {
    return <span className="studio-empty-glyph" aria-hidden="true">{children}</span>;
}
