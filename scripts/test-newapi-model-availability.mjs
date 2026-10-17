// Local Compose check: a temporary route only; no generation requests or paid calls.
import assert from 'node:assert/strict';
import { localClients } from './lib/newapi-local.mjs';

const { studio, close } = await localClients({ adminSession: false });
const prefix = '/admin/newapi';
const name = 'NewAPI-Availability-QA-' + Date.now();
const extraModel = name + '-unconnected';
const before = (await studio('/config/model/listModelConfigs')).modelConfigs;
const beforeGateway = (await studio('/config/channel/listChannels')).channels.find(c => c.id === 'studio-newapi-text');
let routeId;
let routeName = name;

async function assertAvailability(enabled) {
    const configs = (await studio('/config/model/listModelConfigs')).modelConfigs;
    const saved = configs.find(c => c.modelName === name);
    assert.ok(saved, 'Disabled configuration must be retained');
    const channel = (await studio('/config/channel/listChannels')).channels.find(c => c.id === saved.channelId);
    assert.ok(channel.models.includes(name), 'Full management model list must remain unchanged');
    assert.equal(channel.availableModels.includes(name), enabled, 'Admin dropdown availability');
    if (enabled) assert.equal(channel.modelChannelNames[name], routeName, 'Admin label must show the active supplier');
    const publicModels = (await studio('/ai/model/listModels')).models;
    assert.equal(publicModels.some(m => m.value === saved.channelId + '::' + name), enabled, 'User and Agent model catalog');
    if (enabled) assert.equal(publicModels.find(m => m.value === saved.channelId + '::' + name).provider, routeName);
    const route = (await studio(prefix + '/model-routes')).find(r => r.model === name);
    assert.equal(Boolean(route), enabled, 'Primary/standby list must hide disabled-only models');
    if (enabled) assert.ok(route.channels.every(c => c.channelStatus === 1), 'Disabled channels must not count as standby choices');
    return saved;
}

try {
    await studio(prefix + '/channels/save', { name, type: 1, baseUrl: 'https://example.org', apiKey: 'unused-availability-test',
        models: [name, extraModel], priority: 0, weight: 1, modelMapping: '{}' });
    routeId = (await studio(prefix + '/channels?keyword=' + name)).items.find(c => c.name === name).id;
    await studio(prefix + '/models/sync', { models: [name], modelType: 'text', capabilities: ['chat'], creditCost: 0, setDefault: false });
    const original = await assertAvailability(true);
    await studio(prefix + '/channels/status', { id: routeId, enabled: false });
    assert.deepEqual(await assertAvailability(false), original);
    await studio(prefix + '/channels/status', { id: routeId, enabled: true });
    assert.deepEqual(await assertAvailability(true), original);
    routeName = name + '-renamed';
    await studio(prefix + '/channels/save', { id: routeId, name: routeName, type: 1, baseUrl: 'https://example.org', apiKey: '',
        models: [name, extraModel], priority: 0, weight: 1, modelMapping: '{}' });
    assert.deepEqual(await assertAvailability(true), original);
    // Removing the final published route must hide the model, not delete its Studio configuration.
    await studio(prefix + '/channels/save', { id: routeId, name: routeName, type: 1, baseUrl: 'https://example.org', apiKey: '',
        models: [extraModel], priority: 0, weight: 1, modelMapping: '{}' });
    assert.deepEqual(await assertAvailability(false), original);
    await studio(prefix + '/channels/save', { id: routeId, name: routeName, type: 1, baseUrl: 'https://example.org', apiKey: '',
        models: [name, extraModel], priority: 0, weight: 1, modelMapping: '{}' });
    assert.deepEqual(await assertAvailability(true), original);
    // Deleting an idle channel also permits taking its final model route offline.
    await studio(prefix + '/channels/delete', { id: routeId });
    routeId = undefined;
    assert.deepEqual(await assertAvailability(false), original);
    assert.deepEqual((await studio('/config/model/listModelConfigs')).modelConfigs.filter(c => c.modelName !== name), before);
    console.log('PASS: disable/enable, remove/re-add the last model route, delete the last idle channel, supplier rename sync; saved prices/defaults/aliases unchanged.');
} finally {
    try {
        for (const c of (await studio('/config/model/listModelConfigs')).modelConfigs.filter(c => c.modelName === name))
            await studio('/config/model/deleteModelConfig', { id: c.id });
        const gateway = (await studio('/config/channel/listChannels')).channels.find(c => c.id === 'studio-newapi-text');
        if (gateway?.models.includes(name)) {
            const models = gateway.models.filter(m => m !== name);
            if (!beforeGateway && !models.length) await studio('/config/channel/deleteChannel', { channelId: gateway.id });
            else await studio('/config/channel/updateChannel', { ...gateway, models });
        }
        if (routeId) await studio(prefix + '/channels/delete', { id: routeId });
        assert.deepEqual((await studio('/config/model/listModelConfigs')).modelConfigs, before);
        console.log('PASS: temporary route and model removed; existing configuration retained.');
    } finally { await close(); }
}
