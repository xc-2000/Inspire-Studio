// Run --prepare, start the newapi service, then run without arguments.
// Credentials are written only to the ignored .env file.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
let envText = await readFile(envPath, 'utf8').catch(() => '');
const values = Object.fromEntries(envText.split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => {
    const n = l.indexOf('='); return [l.slice(0, n), l.slice(n + 1).replace(/^["']|["']$/g, '')];
}));
async function save(key, value) {
    values[key] = String(value);
    const line = key + '=' + value;
    envText = new RegExp('^' + key + '=.*$', 'm').test(envText)
        ? envText.replace(new RegExp('^' + key + '=.*$', 'm'), () => line)
        : envText.trimEnd() + '\n' + line + '\n';
    await writeFile(envPath, envText, { mode: 0o600 });
}
for (const [key, value] of Object.entries({
    NEWAPI_SESSION_SECRET: randomBytes(32).toString('hex'),
    NEWAPI_ADMIN_USERNAME: 'studio',
    NEWAPI_ADMIN_PASSWORD: 'Ns9!' + randomBytes(24).toString('hex'),
})) if (!values[key]) await save(key, value);
if (process.argv.includes('--prepare')) {
    console.log('New API local secrets prepared. Start the newapi service next.');
    process.exit(0);
}
const base = 'http://127.0.0.1:' + (values.NEWAPI_PORT || '3005');
let session = '';
async function call(path, body, method = body === undefined ? 'GET' : 'POST', headers = {}) {
    const response = await fetch(base + path, { method, headers: {
        'Content-Type': 'application/json', ...(session ? {Authorization: 'Bearer ' + session} : {}), ...headers,
    }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const result = await response.json();
    if (!response.ok || result.success === false) throw new Error(path + ': HTTP ' + response.status + ' ' + (result.code || 'request rejected'));
    return result.data;
}
const setup = await call('/api/setup');
if (!setup.status) await call('/api/setup', {
    username: values.NEWAPI_ADMIN_USERNAME, password: values.NEWAPI_ADMIN_PASSWORD,
    confirmPassword: values.NEWAPI_ADMIN_PASSWORD, SelfUseModeEnabled: true, DemoSiteEnabled: false,
});
const login = await call('/api/user/login', { username: values.NEWAPI_ADMIN_USERNAME, password: values.NEWAPI_ADMIN_PASSWORD });
session = login.access_token;
if (!session) throw new Error('New API login did not return a dashboard session');
await save('NEWAPI_USER_ID', login.user.id);
// Upgrade the existing token in place; keep its value so a live server needs no restart.
const requiredScopes = ['channel:read', 'channel:write', 'channel:operate', 'channel:sensitive_write', 'task_plugin:bind', 'log:read'];
async function ensureManagementScopes() {
    const tokenRef = values.NEWAPI_ADMIN_TOKEN ? createHash('sha256').update(values.NEWAPI_ADMIN_TOKEN.trimEnd()).digest('hex') : '';
    const items = (await call('/api/user/access_tokens')).items;
    const existing = items.find(item => item.token_ref === tokenRef);
    if (existing) {
        const scopes = [...new Set([...(existing.scopes || []), ...requiredScopes])].sort();
        if (requiredScopes.every(scope => existing.scopes?.includes(scope))) return;
        const proof = await call('/api/verify', { method: 'password', password: values.NEWAPI_ADMIN_PASSWORD,
            scope: 'access_token.update', context: { token_id: existing.id, scopes } });
        await call('/api/user/access_tokens/' + existing.id, { name: existing.name, scopes },
            'PATCH', { 'X-Security-Proof': proof.proof_token });
        return;
    }
    if (process.argv.includes('--channel-protection')) throw new Error('Configured management token was not found; rerun full initialization.');
    const proof = await call('/api/verify', { method: 'password', password: values.NEWAPI_ADMIN_PASSWORD,
        scope: 'access_token.generate', context: { scopes: requiredScopes, expires_at: 0 } });
    const token = await call('/api/user/access_tokens', { name: 'Inspire Studio channels', scopes: requiredScopes, expires_at: 0 },
        'POST', { 'X-Security-Proof': proof.proof_token });
    await save('NEWAPI_ADMIN_TOKEN', token.token);
}
await ensureManagementScopes();
if (process.argv.includes('--channel-protection')) {
    console.log('New API management token now includes read-only task checks. Token value unchanged; no restart required.');
    process.exit(0);
}
// This private gateway routes requests; Studio remains the user-facing credit ledger.
await call('/api/option/', {key: 'GroupRatio', value: '{"default":0}'}, 'PUT');
await call('/api/option/', {key: 'RegisterEnabled', value: 'false'}, 'PUT');
if (!values.NEWAPI_RELAY_KEY) {
    let tokens = await call('/api/token/?p=1&page_size=100');
    let item = tokens.items.find(t => t.name === 'Inspire Studio internal');
    if (!item) {
        await call('/api/token/', { name: 'Inspire Studio internal', expired_time: -1, unlimited_quota: true, group: 'default' });
        tokens = await call('/api/token/?p=1&page_size=100');
        item = tokens.items.find(t => t.name === 'Inspire Studio internal');
    }
    const key = await call('/api/token/' + item.id + '/key', {});
    await save('NEWAPI_RELAY_KEY', key.key);
}
console.log('New API initialized; scoped management token and relay key saved to .env. Recreate the server to load them.');
