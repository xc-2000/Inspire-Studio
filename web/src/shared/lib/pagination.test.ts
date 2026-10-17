import assert from "node:assert/strict";
import test from "node:test";

import { clampPage, paginateItems } from "./pagination.ts";

test("分页覆盖所有记录，末页无重复或遗漏", () => {
    const records = Array.from({ length: 23 }, (_, index) => index + 1);
    const pages = [1, 2, 3].map((page) => paginateItems(records, page, 10));
    assert.deepEqual(
        pages.map((page) => page.items.length),
        [10, 10, 3],
    );
    assert.deepEqual(
        pages.flatMap((page) => page.items),
        records,
    );
});

test("删除末页、空列表和无效页码都回到有效页", () => {
    assert.equal(clampPage(3, 20, 10), 2);
    assert.equal(clampPage(8, 0, 10), 1);
    assert.equal(clampPage(-5, 40, 10), 1);
    assert.equal(clampPage(Number.NaN, 40, 10), 1);
    assert.deepEqual(paginateItems([], 9, 10).items, []);
    assert.deepEqual(paginateItems([1, 2, 3], 50, 2).items, [3]);
});
