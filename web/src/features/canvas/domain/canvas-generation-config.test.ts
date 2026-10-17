import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "@/features/settings/stores/use-config-store";
import { normalizeCanvasVideoConfig } from "./canvas-generation-config.ts";

test("Muse node uses ten seconds for display and submission before opening settings", () => {
    const config = { ...defaultConfig, channels: [], apiFormat: "muse" as const, videoSeconds: "5" };
    assert.equal(normalizeCanvasVideoConfig(config).videoSeconds, "10");
    assert.equal(config.videoSeconds, "5");
    const other = { ...config, apiFormat: "openai" as const };
    assert.equal(normalizeCanvasVideoConfig(other).videoSeconds, "5");
});
