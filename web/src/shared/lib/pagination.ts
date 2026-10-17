function positiveInteger(value: number) {
    return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

export function clampPage(page: number, total: number, pageSize: number) {
    const count = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
    return Math.min(positiveInteger(page), Math.max(1, Math.ceil(count / positiveInteger(pageSize))));
}

export function paginateItems<T>(items: readonly T[], requestedPage: number, requestedPageSize: number) {
    const pageSize = positiveInteger(requestedPageSize);
    const page = clampPage(requestedPage, items.length, pageSize);
    const start = (page - 1) * pageSize;
    return {
        items: items.slice(start, start + pageSize),
        page,
        pageSize,
        total: items.length,
        totalPages: Math.max(1, Math.ceil(items.length / pageSize)),
    };
}
