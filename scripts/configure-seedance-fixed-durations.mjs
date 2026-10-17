import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { localClients } from './lib/newapi-local.mjs';

// Only the specified supplier's models are changed. Credentials are never logged.
const { studio } = await localClients();
const channelId = '9d573a0e-092f-44f9-8dad-45ef2c3d0bed';
const durations = new Map([['doubao-video-2.0', 15], ['seedance-2.0', 15], ['doubao-video-2.5', 30], ['seedance-2.5', 30]]);
const { modelConfigs } = await studio('/config/model/listModelConfigs');
const targets = modelConfigs.filter(model => model.channelId === channelId && model.modelType === 'video' && durations.has(model.modelName));
assert.equal(targets.length, 4, 'Expected exactly four matching models');
await mkdir(new URL('../outputs/', import.meta.url), { recursive: true });
await writeFile(new URL(`../outputs/seedance-durations-backup-${Date.now()}.json`, import.meta.url), JSON.stringify(targets.map(({ id, modelName, videoBillingConfiguration }) => ({ id, modelName, videoBillingConfiguration })), null, 2));
for (const model of targets) {
    const seconds = durations.get(model.modelName);
    const billing = { ...model.videoBillingConfiguration, minimumDurationSeconds: seconds, supportedDurationsSeconds: [seconds] };
    await studio('/config/model/updateModelConfig', { ...model, videoBillingConfiguration: billing });
}
const saved = (await studio('/config/model/listModelConfigs')).modelConfigs;
const published = (await studio('/ai/model/listModels')).models;
for (const model of targets) {
    const actual = saved.find(item => item.id === model.id);
    const expected = { ...model, videoBillingConfiguration: { ...model.videoBillingConfiguration, minimumDurationSeconds: durations.get(model.modelName), supportedDurationsSeconds: [durations.get(model.modelName)] } };
    assert.deepEqual(actual, expected, 'Only duration fields should change');
    const publicModel = published.find(item => item.value === `${channelId}::${model.modelName}`);
    assert.deepEqual(publicModel.videoBillingConfiguration.supportedDurationsSeconds, [durations.get(model.modelName)]);
    console.log(JSON.stringify({ model: model.modelName, fixedSeconds: durations.get(model.modelName), saved: true, exposedToGeneration: true }));
}
