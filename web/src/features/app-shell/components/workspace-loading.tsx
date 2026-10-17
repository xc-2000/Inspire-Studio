/** Keep the sidebar and header usable while the next workspace loads. */
export default function WorkspaceLoading() {
    return (
        <div role="status" aria-label="正在加载页面" className="h-full overflow-hidden bg-[var(--studio-page)] p-4 sm:p-6">
            <span className="sr-only">正在加载页面</span>
            <div aria-hidden="true" className="h-full space-y-5 animate-pulse motion-reduce:animate-none">
                <div className="flex h-14 items-center justify-between border-b border-[var(--studio-line)] pb-4">
                    <div className="h-5 w-36 rounded-md bg-[var(--studio-surface-hover)]" />
                    <div className="h-8 w-24 rounded-lg bg-[var(--studio-surface-hover)]" />
                </div>
                <div className="h-12 rounded-xl border border-[var(--studio-line)] bg-[var(--studio-panel)]" />
                <div className="h-3/4 rounded-xl border border-[var(--studio-line)] bg-[var(--studio-panel)]" />
            </div>
        </div>
    );
}
