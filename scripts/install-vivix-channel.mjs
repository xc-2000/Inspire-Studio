// Install the existing Vivix channel in New API and connect its video models to Studio.
// No credentials are written to source, logs, or generated plugin files.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { localClients } from './lib/newapi-local.mjs';

const models = ['vivix-w1-ultrafast', 'vivix-w1-fast'];
const labels = ['Vivix W1 UltraFast', 'Vivix W1 Fast'];
const capabilities = ['text-to-video', 'image-to-video', 'reference-to-video', 'first-last-frame-to-video'];
const billing = { billingUnit: 'second', minimumDurationSeconds: 5, defaultResolution: '720p',
    supportedDurationsSeconds: Array.from({length: 11}, (_, i) => i + 5),
    modePrices: Object.fromEntries(capabilities.map(mode => [mode, {'720p': 10}])) };
const profile = { capabilities, customBodyParameters: {}, videoBillingConfiguration: billing };
function only720(original = billing) {
    return {...original, defaultResolution:'720p', modePrices:Object.fromEntries(
        Object.entries(original.modePrices || billing.modePrices).map(([mode,prices]) => [mode, {'720p':prices['720p'] ?? prices['720P'] ?? 10}]))};
}
const {admin, studio, env, close} = await localClients();
try {
    const matching = (await studio('/admin/newapi/channels?keyword=vivix')).items.filter(c => c.name.toLowerCase() === 'vivix');
    assert.equal(matching.length, 1, 'Expected the single configured Vivix channel');
    const channel = await admin('/api/channel/' + matching[0].id);
    assert.ok(env.NEWAPI_VIVIX_ORIGIN, 'Set NEWAPI_VIVIX_ORIGIN in .env');
    assert.equal(new URL(channel.base_url).origin, new URL(env.NEWAPI_VIVIX_ORIGIN).origin);
    assert.ok([1, 61].includes(channel.type), 'Expected OpenAI-compatible or existing Vivix plugin channel');
    assert.deepEqual(channel.models.split(',').sort(), [...models].sort());
    const envPath = new URL('../.env',import.meta.url);
    let envText = await readFile(envPath,'utf8');
    const origin = 'NEWAPI_VIVIX_ORIGIN='+new URL(channel.base_url).origin;
    envText = /^NEWAPI_VIVIX_ORIGIN=/m.test(envText) ? envText.replace(/^NEWAPI_VIVIX_ORIGIN=.*$/m,origin) : envText.trimEnd()+'\n'+origin+'\n';
    await writeFile(envPath,envText);
    const before = (await studio('/config/model/listModelConfigs')).modelConfigs;
    const defaults = before.filter(m => m.defaultModel).map(m => m.id).sort();
    const template = await readFile(new URL('../newapi/plugins/video-adapter.mjs', import.meta.url), 'utf8');
    const version = '1.0.0+' + createHash('sha256').update(template + JSON.stringify(models)).digest('hex').slice(0,12);
    const key = 'studio-vivix';
    const source = 'const config = ' + JSON.stringify({key, name:'Vivix W1 视频', protocol:'vivix', models, version}) + ';\n' + template;
    await mkdir(new URL('../newapi/generated/', import.meta.url), {recursive:true});
    await writeFile(new URL('../newapi/generated/studio-vivix.js', import.meta.url), source);
    await admin('/api/plugin/task', {source, enabled:true, remark:'Vivix W1 text, image, references and first/last frame video'});
    await admin('/api/plugin/task/' + key + '/activate', {version});
    const options = await admin('/api/option/');
    const option = key => options.find(o => o.key === key)?.value;
    assert.equal(JSON.parse(option('GroupRatio')).default, 0, 'Gateway billing must remain in the existing free relay group');
    const ports = new Set(JSON.parse(option('fetch_setting.allowed_ports') || '["80","443","8080","8443"]'));
    ports.add(new URL(channel.base_url).port);
    await admin('/api/option/', {key:'fetch_setting.allowed_ports', value:JSON.stringify([...ports])}, 'PUT');
    const prices = JSON.parse(option('ModelPrice') || '{}');
    for (const model of models) if (prices[model] === undefined) prices[model] = 0;
    await admin('/api/option/', {key:'ModelPrice', value:JSON.stringify(prices)}, 'PUT');
    const setting = JSON.parse(channel.setting || '{}');
    setting.task_plugin_key = key;
    setting.studio_model_profiles = {...setting.studio_model_profiles};
    for (const model of models) {
        const existing = setting.studio_model_profiles[model] || profile;
        setting.studio_model_profiles[model] = {...existing, videoBillingConfiguration:only720(existing.videoBillingConfiguration)};
    }
    await admin('/api/channel/', {id:channel.id, type:61, name:channel.name, base_url:channel.base_url,
        models:channel.models, group:channel.group, priority:channel.priority, weight:channel.weight,
        model_mapping:channel.model_mapping || '{}', setting:JSON.stringify(setting)}, 'PUT');
    const sync = await studio('/admin/newapi/models/sync', {models, modelType:'video', capabilities,
        creditCost:10, resolutions:['720P'], setDefault:false});
    for (const [i, modelName] of models.entries()) {
        const config = (await studio('/config/model/listModelConfigs')).modelConfigs.find(m => m.modelName === modelName && m.modelType === 'video');
        assert.ok(config);
        const existing = before.some(m => m.modelType === 'video' && m.modelName === modelName);
        await studio('/config/model/updateModelConfig', existing
            ? {...config, videoBillingConfiguration:only720(config.videoBillingConfiguration)}
            : {...config, ...profile, displayName:labels[i], newModel:true, requestConcurrency:5});
    }
    const after = (await studio('/config/model/listModelConfigs')).modelConfigs;
    assert.deepEqual(after.filter(m => m.defaultModel).map(m => m.id).sort(), defaults);
    const visible = await studio('/ai/model/listModels');
    for (const name of models) {
        const value = 'studio-newapi-video::' + name;
        assert.ok(visible.videoModels.includes(value), 'Video model must be available');
        assert.ok(!visible.imageModels.includes(value) && !visible.textModels.includes(value) && !visible.audioModels.includes(value));
    }
    console.log(JSON.stringify({channelId:channel.id, plugin:key, version, ...sync, models, defaultModelsPreserved:true}));
} finally { await close(); }
