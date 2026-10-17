import assert from "node:assert/strict";
import test from "node:test";
import { entryPackage, packageSavingsPercent, packageUnitPrice } from "./package-pricing.ts";

const packs = [
    { id: "basic", name: "基础", amountFen: 990, credits: 1000 },
    { id: "plus", name: "进阶", amountFen: 2990, credits: 3300 },
    { id: "pro", name: "专业", amountFen: 5990, credits: 7500 },
    { id: "max", name: "旗舰", amountFen: 9990, credits: 14000 },
];
test("package savings compare unit prices, not the package price or card order", () => {
    const baseline = entryPackage([...packs].reverse());
    assert.equal(baseline?.id, "basic");
    assert.deepEqual(packs.map(p => packageSavingsPercent(p, baseline)), [0, 8, 19, 27]);
    assert.equal(packageUnitPrice(packs[0]), "¥0.0099");
    assert.equal(packageUnitPrice(packs[3]), "¥0.0071");
});
test("single packages and more expensive unit prices never claim savings", () => {
    assert.equal(packageSavingsPercent(packs[0], packs[0]), 0);
    assert.equal(packageSavingsPercent({ ...packs[1], credits: 100 }, packs[0]), 0);
    assert.equal(packageSavingsPercent(packs[0]), 0);
    assert.equal(entryPackage([]), undefined);
    assert.equal(packageUnitPrice({ ...packs[0], amountFen: 1, credits: 10000000 }), "< ¥0.0001");
});
