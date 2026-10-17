type ToolReceipt<T> = { result: Promise<T>; delivery?: Promise<void>; delivered: boolean };

/** One execution per request/call in this mounted canvas; delivery can be retried independently. */
export class CanvasToolLedger<T> {
    private receipts = new Map<string, ToolReceipt<T>>();

    run(key: string, execute: () => Promise<T>, submit: (result: T) => Promise<void>): Promise<void> {
        let receipt = this.receipts.get(key);
        if (!receipt) {
            receipt = { result: Promise.resolve().then(execute), delivered: false };
            this.receipts.set(key, receipt);
        }
        if (receipt.delivered) return Promise.resolve();
        if (receipt.delivery) return receipt.delivery;
        const current = receipt;
        current.delivery = current.result.then(submit).then(() => { current.delivered = true; })
            .finally(() => { current.delivery = undefined; });
        return current.delivery;
    }

    clear() { this.receipts.clear(); }
}

export async function deliverCanvasToolReceipt(
    submit: () => Promise<void>, signal: AbortSignal,
    retryable: (error: unknown) => boolean,
    delay: (milliseconds: number) => Promise<void> = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted();
        try { await submit(); return; } catch (error) {
            if (signal.aborted || attempt === 2 || !retryable(error)) throw error;
            await delay(500 * 2 ** attempt);
        }
    }
}
