import assert from "node:assert/strict";
import test from "node:test";
import { readEmailCodeCooldownSeconds, startEmailCodeCooldown } from "./email-code-cooldown";

test("倒计时按邮箱隔离、规范化并按实际时间过期；存储不可用时仍有效", () => {
    startEmailCodeCooldown(" USER@example.com ", 60, 1000);
    assert.equal(readEmailCodeCooldownSeconds("user@example.com", 1000), 60);
    assert.equal(readEmailCodeCooldownSeconds("another@example.com", 1000), 0);
    assert.equal(readEmailCodeCooldownSeconds("user@example.com", 59999), 2);
    assert.equal(readEmailCodeCooldownSeconds("user@example.com", 61000), 0);
});

test("服务端较长的重试时间会替换默认 60 秒", () => {
    startEmailCodeCooldown("limited@example.com", 1200, 1000);
    assert.equal(readEmailCodeCooldownSeconds("limited@example.com", 61000), 1140);
});
