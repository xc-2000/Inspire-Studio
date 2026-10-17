import assert from "node:assert/strict";
import test from "node:test";

import { getAntThemeConfig } from "./app-theme.ts";

test("getAntThemeConfig 返回浅色主题 token", () => {
    const config = getAntThemeConfig("light");

    assert.equal(config.token?.colorBgLayout, "#f6f8fc");
    assert.equal(config.token?.colorText, "#172238");
    assert.equal(config.components?.Modal?.contentBg, "#ffffff");
    assert.equal(config.components?.Modal?.headerBg, "#ffffff");
    assert.equal(config.components?.Modal?.footerBg, "#ffffff");
});

test("getAntThemeConfig 返回暗色主题 token", () => {
    const config = getAntThemeConfig("dark");

    assert.equal(config.token?.colorBgLayout, "#080808");
    assert.equal(config.token?.colorText, "#f5f5f5");
    assert.equal(config.token?.colorBgContainer, "#141414");
    assert.equal(config.components?.Modal?.contentBg, "#141414");
    assert.equal(config.components?.Modal?.headerBg, "#141414");
    assert.equal(config.components?.Modal?.footerBg, "#141414");
});
