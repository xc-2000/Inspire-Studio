type PreviewCallbacks = { nearby: () => void; visible: (value: boolean) => void };
type ObserverPool = { callbacks: Map<Element, PreviewCallbacks>; preload: IntersectionObserver; playback: IntersectionObserver };
const pools = new Map<Element | null, ObserverPool>();

/** Two observers per gallery, regardless of how many infinite-scroll cards it contains. */
export function observeVideoPreview(frame: Element, callbacks: PreviewCallbacks) {
    const root = frame.closest("[data-homepage-scroll]");
    let pool = pools.get(root);
    if (!pool) {
        const listeners = new Map<Element, PreviewCallbacks>();
        const preload = new IntersectionObserver(entries => {
            for (const entry of entries) if (entry.isIntersecting) {
                listeners.get(entry.target)?.nearby();
                preload.unobserve(entry.target);
            }
        }, { root, rootMargin: "160px" });
        const playback = new IntersectionObserver(entries => {
            for (const entry of entries) listeners.get(entry.target)?.visible(entry.isIntersecting && entry.intersectionRatio >= 0.2);
        }, { root, threshold: [0, 0.2] });
        pool = { callbacks: listeners, preload, playback };
        pools.set(root, pool);
    }
    const current = pool;
    current.callbacks.set(frame, callbacks);
    current.preload.observe(frame);
    current.playback.observe(frame);
    return () => {
        current.callbacks.delete(frame);
        current.preload.unobserve(frame);
        current.playback.unobserve(frame);
        if (!current.callbacks.size) {
            current.preload.disconnect();
            current.playback.disconnect();
            pools.delete(root);
        }
    };
}
