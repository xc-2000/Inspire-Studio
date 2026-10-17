const PREFIX = "inspire:auth:email-code-cooldown:";
const deadlines = new Map<string, number>();

export function readEmailCodeCooldownSeconds(email: string, now = Date.now()): number {
    const key = PREFIX + email.trim().toLowerCase();
    let until = deadlines.get(key) || 0;
    try {
        const stored = Number(window.localStorage.getItem(key));
        if (Number.isFinite(stored)) until = Math.max(until, stored);
        if (until <= now) window.localStorage.removeItem(key);
    } catch { /* Private mode may disable storage; the in-memory deadline still works. */ }
    if (until <= now) deadlines.delete(key);
    else deadlines.set(key, until);
    return Math.max(0, Math.ceil((until - now) / 1000));
}

export function startEmailCodeCooldown(email: string, seconds: number, now = Date.now()): void {
    const key = PREFIX + email.trim().toLowerCase();
    const until = now + Math.max(1, seconds) * 1000;
    deadlines.set(key, until);
    try { window.localStorage.setItem(key, String(until)); } catch { /* Keep the in-memory deadline. */ }
}
