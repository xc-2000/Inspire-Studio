type Price = { id: string; name: string; amountFen: number; credits: number };

/** The lowest purchase amount is the entry tier used for unit-price comparisons. */
export function entryPackage<T extends Price>(packages: T[]): T | undefined {
    return packages.filter(p => p.amountFen > 0 && p.credits > 0)
        .reduce<T | undefined>((best, p) => !best || p.amountFen < best.amountFen || (p.amountFen === best.amountFen && p.credits < best.credits) ? p : best, undefined);
}

export function packageSavingsPercent(pack: Price, baseline?: Price): number {
    if (!baseline || pack.credits <= 0 || baseline.credits <= 0 || pack.amountFen <= 0 || baseline.amountFen <= 0) return 0;
    const reference = baseline.amountFen * pack.credits;
    const saving = reference - pack.amountFen * baseline.credits;
    return Math.max(0, Math.floor(saving * 100 / reference));
}

export function packageUnitPrice(pack: Price): string {
    if (pack.credits <= 0) return "—";
    const price = pack.amountFen / 100 / pack.credits;
    return price > 0 && price < 0.0001 ? "< ¥0.0001" : `¥${price.toFixed(4)}`;
}
