import { readFile } from 'node:fs/promises';

export async function localClients({ adminSession = true, studioSession = true } = {}) {
    const env = Object.fromEntries((await readFile(new URL('../../.env', import.meta.url), 'utf8'))
        .split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => {
            const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1).replace(/^["']|["']$/g, '')];
        }));
    let adminToken = '', studioToken = '';
    async function call(base, path, body, method, token) {
        const multipart = body instanceof FormData;
        const response = await fetch(base + path, {
            method: method || (body === undefined ? 'GET' : 'POST'),
            headers: { ...(multipart ? {} : {'Content-Type': 'application/json'}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
            body: body === undefined ? undefined : multipart ? body : JSON.stringify(body), signal: AbortSignal.timeout(45000),
        });
        const data = await response.json().catch(() => { throw Error(path + ': HTTP ' + response.status + ' non-JSON response'); });
        if (!response.ok || data.success === false || (data.code !== undefined && data.code !== 0)) {
            // Do not include upstream response bodies, which can echo channel credentials.
            let diagnostic = String(data.message || data.msg || '');
            for (const secret of [...Object.entries(env).filter(([key]) => /KEY|TOKEN|PASSWORD|SECRET/.test(key)).map(([,value]) => value), token, body?.key, body?.channel?.key]) {
                if (typeof secret === 'string' && secret.length > 5) diagnostic = diagnostic.split(secret).join('[redacted]');
            }
            throw Error(path + ': HTTP ' + response.status + ' request rejected' + (['/api/plugin/task','/api/channel/','/ai/task/createTask'].includes(path) ? ': ' + diagnostic.slice(0,700) : ''));
        }
        return data.data;
    }
    const admin = (p, b, m) => call('http://127.0.0.1:' + (env.NEWAPI_PORT || 3005), p, b, m, adminToken);
    const studio = (p, b, m) => call('http://127.0.0.1:' + (env.WEB_PORT || 5550) + '/api/v1', p, b, m, studioToken);
    adminToken = adminSession
        ? (await admin('/api/user/login', { username: env.NEWAPI_ADMIN_USERNAME, password: env.NEWAPI_ADMIN_PASSWORD })).access_token
        : env.NEWAPI_ADMIN_TOKEN;
    let closed = false;
    const onExit = () => { void close().catch(() => { console.error('New API script session logout failed.'); }); };
    async function close() {
        if (closed) return;
        if (adminSession) await admin('/api/user/auth/logout', {});
        closed = true;
        adminToken = '';
        process.removeListener('beforeExit', onExit);
    }
    // Short-lived maintenance scripts must not consume a 30-day login slot.
    process.once('beforeExit', onExit);
    try {
        if (studioSession) studioToken = (await studio('/auth/login', { email: env.ADMIN_INITIAL_EMAIL, password: env.ADMIN_INITIAL_PASSWORD })).token;
    } catch (error) {
        await close().catch(() => {});
        throw error;
    }
    return { admin, studio, env, close };
}
