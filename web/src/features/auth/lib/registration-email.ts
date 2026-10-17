import type { RegistrationEmailPolicy } from "@/services/api/server";

export const EMAIL_PROVIDER_GROUPS = [
    { name: "国内常用", items: [
        ["QQ 邮箱", "qq.com"], ["QQ VIP", "vip.qq.com"], ["Foxmail", "foxmail.com"],
        ["网易 163", "163.com"], ["网易 126", "126.com"], ["网易 Yeah", "yeah.net"],
        ["网易 VIP 163", "vip.163.com"], ["网易 VIP 126", "vip.126.com"], ["网易 188", "188.com"],
        ["新浪邮箱", "sina.com"], ["新浪邮箱", "sina.cn"], ["新浪 VIP", "vip.sina.com"],
        ["搜狐邮箱", "sohu.com"], ["阿里邮箱", "aliyun.com"], ["移动 139", "139.com"],
        ["电信 189", "189.cn"], ["联通沃邮箱", "wo.cn"], ["21CN", "21cn.com"],
        ["TOM 邮箱", "tom.com"], ["263 邮箱", "263.net"],
    ] },
    { name: "国际常用", items: [
        ["Gmail", "gmail.com"], ["Outlook", "outlook.com"], ["Outlook 中国", "outlook.com.cn"],
        ["Hotmail", "hotmail.com"], ["Live", "live.com"], ["MSN", "msn.com"],
        ["iCloud", "icloud.com"], ["Apple Me", "me.com"], ["Apple Mac", "mac.com"],
        ["Yahoo", "yahoo.com"], ["Yahoo 日本", "yahoo.co.jp"],
        ["Proton", "proton.me"], ["Proton Mail", "protonmail.com"],
        ["Tuta", "tuta.com"], ["Tuta Mail", "tutamail.com"],
        ["Mail.com", "mail.com"], ["GMX", "gmx.com"], ["Zoho", "zoho.com"],
        ["AOL", "aol.com"], ["Yandex", "yandex.com"],
    ] },
] as const;

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/;

export function normalizeEmailDomain(value: string): string | null {
    const domain = value.trim().toLowerCase().replace(/^@/, "");
    return domain.length <= 253 && DOMAIN.test(domain) ? domain : null;
}

export function registrationEmailError(value: string, policy: RegistrationEmailPolicy): string | null {
    const email = value.trim().toLowerCase();
    const parts = email.split("@");
    const local = parts[0] || "";
    if (email.length > 254 || parts.length !== 2 || !local || local.length > 64
        || !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)
        || local.startsWith(".") || local.endsWith(".") || local.includes("..")
        || !DOMAIN.test(parts[1]) || parts[1].length > 253) return "邮箱格式不正确";
    if (!policy.enabled || policy.allowedDomains.includes(parts[1])) return null;
    return policy.allowedDomains.length ? "该邮箱后缀尚未开放，请使用下方列出的邮箱" : "暂未开放邮箱注册，请联系管理员";
}

