// Local Compose regression: temporary channels/models only, no paid provider requests.
import assert from 'node:assert/strict';
import { localClients } from './lib/newapi-local.mjs';
const { studio, env, close } = await localClients({adminSession:false});
const prefix = '/admin/newapi';
const name = 'NewAPI-Guard-QA-' + Date.now();
const model = name + '-model';
const unused = name + '-unused';
const base = 'http://127.0.0.1:' + (env.WEB_PORT || 5550) + '/api/v1';
const token = (await studio('/auth/login', { email: env.ADMIN_INITIAL_EMAIL, password: env.ADMIN_INITIAL_PASSWORD })).token;
const originalModels = (await studio('/config/model/listModelConfigs')).modelConfigs;
const originalGateway = (await studio('/config/channel/listChannels')).channels.find(c => c.id === 'studio-newapi-text');
const fixtureIds = new Set();
let connectedId;
const draft = { name, type: 1, baseUrl: 'https://example.org', apiKey: 'local-guard-test-unused',
    models: [model, unused], priority: 0, weight: 1, modelMapping: '{}' };

async function request(path, body) {
    const response = await fetch(base + prefix + path, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
    const data = await response.json();
    return { ok: response.ok && data.code === 0, message: data.msg || data.message || '' };
}
async function denied(path, body, reason) {
    const result = await request(path, body);
    assert.equal(result.ok, false, 'Expected the unsafe operation to be blocked: ' + path);
    assert.ok(result.message.includes(reason), 'Missing actionable protection reason for ' + path);
}
async function fixtures() {
    return (await studio(prefix + '/channels?keyword=' + encodeURIComponent(name))).items;
}

try {
    await studio(prefix + '/channels/save', draft);
    const primary = (await fixtures())[0];
    fixtureIds.add(primary.id);
    // Unused channels can be freely disabled and enabled.
    await studio(prefix + '/channels/status', { id: primary.id, enabled: false });
    await studio(prefix + '/channels/status', { id: primary.id, enabled: true });
    await studio(prefix + '/models/sync', { models: [model], modelType: 'text', capabilities: ['chat'], creditCost: 0, setDefault: false });
    connectedId = (await studio('/config/model/listModelConfigs')).modelConfigs.find(m => m.modelName === model)?.id;
    assert.ok(connectedId);
    await denied('/channels/delete', { id: primary.id }, model);
    await studio(prefix + '/channels/status', { id: primary.id, enabled: false });
    assert.equal((await fixtures()).find(c=>c.id===primary.id).status, 2);
    await studio(prefix + '/channels/status', { id: primary.id, enabled: true });
    await denied('/channels/save', { ...draft, id: primary.id, apiKey: '', models: [unused] }, model);
    let saved = (await fixtures())[0];
    assert.equal(saved.status, 1);
    assert.ok(saved.models.includes(model));

    // Adding a model or renaming preserves the connected model and business settings.
    await studio(prefix + '/channels/save', { ...draft, id: primary.id, name: name + ' primary', apiKey: '', models: [model, unused, name + '-new'] });
    await studio(prefix + '/channels/save', { ...draft, name: name + ' backup' });
    const spare = (await fixtures()).find(c => c.id !== primary.id);
    assert.ok(spare); fixtureIds.add(spare.id);
    // Concurrent deletion must leave at least one route available.
    const removals = await Promise.all([primary.id, spare.id].map(id => request('/channels/delete', { id })));
    // The primary may be rejected while the standby hits the in-progress lock.
    // Either zero or one deletion is safe; two must never succeed.
    assert.ok(removals.filter(result => result.ok).length <= 1);
    if (removals.every(result => !result.ok)) await studio(prefix + '/channels/delete', { id: spare.id });
    const remaining = await fixtures();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].status, 1);
    await denied('/channels/delete', { id: remaining[0].id }, model);
    const after = (await studio('/config/model/listModelConfigs')).modelConfigs.filter(m => m.id !== connectedId);
    assert.deepEqual(after, originalModels, 'Existing models, defaults, prices and capabilities must remain unchanged');
    console.log('PASS: enable/disable including last route; last-route delete/model-removal blocked; safe additions; backup retained; concurrent removal; model configurations unchanged.');
} finally {
    // Remove only this run’s fixture model; never remove business models to bypass the guard.
    const added = (await studio('/config/model/listModelConfigs')).modelConfigs.filter(m => m.modelName === model);
    for (const item of added) await studio('/config/model/deleteModelConfig', { id: item.id });
    const gateway = (await studio('/config/channel/listChannels')).channels.find(c => c.id === 'studio-newapi-text');
    if (gateway?.models.includes(model)) {
        const remaining = gateway.models.filter(m => m !== model);
        if (!originalGateway && remaining.length === 0) await studio('/config/channel/deleteChannel', { channelId: gateway.id });
        else await studio('/config/channel/updateChannel', { ...gateway, models: remaining });
    }
    for (const row of await fixtures()) {
        if (fixtureIds.has(row.id) || row.name === name || row.name === name + ' backup')
            await studio(prefix + '/channels/delete', { id: row.id });
    }
    assert.equal((await fixtures()).length, 0);
    console.log('PASS: temporary fixtures removed.');
    await close();
}
