import assert from "node:assert/strict";
import test from "node:test";
import { readDramaShotSelection, updateDramaShotSelection } from "./drama-shot-selection";

const shots = ["one", "two", "three", "four"].map(id => ({ id }));

test("selecting another page retains earlier choices in storyboard order", () => {
    const first = updateDramaShotSelection("board", shots, null, ["three", "four"], true);
    const next = updateDramaShotSelection("board", shots, first, ["two"], true);
    assert.deepEqual(next.shotIds, ["two", "three", "four"]);
    assert.deepEqual(first.shotIds, ["three", "four"]);
});

test("deselecting a filtered page preserves selected shots outside that page", () => {
    const all = updateDramaShotSelection("board", shots, null, shots.map(s => s.id), true);
    assert.deepEqual(updateDramaShotSelection("board", shots, all, ["two", "four"], false).shotIds, ["one", "three"]);
});

test("another chapter never inherits selection even if shot IDs collide", () => {
    const old = { boardId: "first", shotIds: ["one", "two"] };
    assert.deepEqual(readDramaShotSelection("second", shots, old), []);
    assert.deepEqual(updateDramaShotSelection("second", shots, old, ["four"], true), { boardId: "second", shotIds: ["four"] });
    assert.deepEqual(readDramaShotSelection(undefined, shots, old), []);
});

test("deleted or replaced shots are excluded instead of broadening generation scope", () => {
    const old = { boardId: "board", shotIds: ["one", "two", "removed"] };
    assert.deepEqual(readDramaShotSelection("board", [shots[1], shots[2]], old), ["two"]);
    assert.deepEqual(readDramaShotSelection("board", [{ id: "new" }], old), []);
});

test("select all ignores stale targets and repeated IDs without duplicate jobs", () => {
    assert.deepEqual(updateDramaShotSelection("board", shots, null, ["two", "two", "unknown", "one"], true).shotIds, ["one", "two"]);
});

test("cleared selection remains empty on rerenders and empty pages do not change it", () => {
    const old = { boardId: "board", shotIds: ["one", "three"] };
    assert.deepEqual(updateDramaShotSelection("board", shots, old, [], false), old);
    assert.deepEqual(readDramaShotSelection("board", shots, null), []);
    assert.deepEqual(updateDramaShotSelection("board", shots, old, ["one", "three"], false).shotIds, []);
});
