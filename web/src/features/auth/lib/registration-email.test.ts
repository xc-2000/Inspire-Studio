import assert from "node:assert/strict";
import test from "node:test";
import { EMAIL_PROVIDER_GROUPS, normalizeEmailDomain, registrationEmailError } from "./registration-email.ts";

test("开放名单精确匹配，不接受相似域名和子域名绕过", () => {
    const policy = { enabled: true, allowedDomains: ["qq.com"] };
    assert.equal(registrationEmailError(" User+tag@QQ.COM ", policy), null);
    for (const email of ["u@evilqq.com", "u@qq.com.evil", "u@vip.qq.com", "u@qq.com.", "u@@qq.com", ".u@qq.com", "u..s@qq.com", "u@-qq.com"]) {
        assert.ok(registrationEmailError(email, policy), email);
    }
});

test("空名单关闭新注册，关闭限制仍检查邮箱格式", () => {
    assert.ok(registrationEmailError("u@qq.com", { enabled: true, allowedDomains: [] }));
    assert.equal(registrationEmailError("u@company.co.uk", { enabled: false, allowedDomains: [] }), null);
    assert.ok(registrationEmailError("u..s@qq.com", { enabled: false, allowedDomains: [] }));
});

test("自定义后缀规范化，所有预置后缀有效且不重复", () => {
    assert.equal(normalizeEmailDomain(" @QQ.COM "), "qq.com");
    for (const value of ["*", "*.qq.com", "https://qq.com", "u@qq.com", "qq.com."]) assert.equal(normalizeEmailDomain(value), null);
    const domains = EMAIL_PROVIDER_GROUPS.flatMap(group => group.items.map(([, domain]) => domain));
    assert.equal(new Set(domains).size, domains.length);
    for (const domain of domains) assert.equal(normalizeEmailDomain(domain), domain);
});
