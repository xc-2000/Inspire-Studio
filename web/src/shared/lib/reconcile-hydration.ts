/** Retain edits/additions made while an initial library request was in flight. */
export function reconcileHydration<T>(loaded: T[], before: T[], current: T[], key: (item: T) => string): T[] {
    const baseline = new Map(before.map(item => [key(item), item]));
    const latest = new Map(current.map(item => [key(item), item]));
    const loadedKeys = new Set(loaded.map(key));
    return [
        ...current.filter(item => !loadedKeys.has(key(item))),
        ...loaded.flatMap(item => {
            const id = key(item);
            if (baseline.has(id) && !latest.has(id)) return []; // deleted during hydration
            const local = latest.get(id);
            return [local && local !== baseline.get(id) ? local : item];
        }),
    ];
}
