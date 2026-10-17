import assert from "node:assert/strict";
import test from "node:test";
import { reconcileHydration } from "./reconcile-hydration";

const key = (item: { id: string }) => item.id;
test("initial response populates an empty library", () => {
    const loaded = [{ id: "saved" }];
    assert.deepEqual(reconcileHydration(loaded, [], [], key), loaded);
});
test("a generation completed during loading is retained without duplicates", () => {
    const added = { id: "new", title: "generated" };
    assert.deepEqual(reconcileHydration([{ id: "saved", title: "old" }], [], [added], key), [added, { id: "saved", title: "old" }]);
    assert.deepEqual(reconcileHydration([{ id: "new", title: "stale" }], [], [added], key), [added]);
});
test("edits and deletions made during loading beat the stale server response", () => {
    const edited = { id: "a", title: "before" };
    const removed = { id: "b", title: "removed" };
    const unchanged = { id: "c", title: "old" };
    const current = { id: "a", title: "after" };
    assert.deepEqual(reconcileHydration([edited, removed, { id: "c", title: "latest" }], [edited, removed, unchanged], [current, unchanged], key), [current, { id: "c", title: "latest" }]);
});
