// Set Arcads defaults without replacing administrator prices, routes, or model availability.
// Preview by default. --apply saves with a backup and exact readback checks.
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { localClients } from './lib/newapi-local.mjs';
import { arcadsVideos, videoProfile } from './lib/arcads-models.mjs';

const apply = process.argv.includes('--apply');
const { admin, env, close } = await localClients({ studioSession: false });
const channelId = Number(process.env.ARCADS_CHANNEL_ID || 42);
const modes = ['text-to-video', 'image-to-video', 'reference-to-video', 'first-last-frame-to-video'];
const fields = ['id','name','type','base_url','models','group','priority','weight','model_mapping','setting'];
const editable = channel => Object.fromEntries(fields.map(key => [key, channel[key]]));
const snapshot = channel => ({ ...editable(channel), status: channel.status });
const parse = value => typeof value === 'string' ? JSON.parse(value || '{}') : structuredClone(value || {});
let token;
async function studio(path, body) {
    const response = await fetch('http://127.0.0.1:' + (env.WEB_PORT || 5550) + '/api/v1' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000),
    });
    const result = await response.json();
    if (!response.ok || result.code !== 0) throw Error(path + ': HTTP ' + response.status + ', code ' + result.code);
    return result.data;
}
function withDefault(profile, name) {
    const next = structuredClone(profile);
    const billing = next.videoBillingConfiguration;
    assert.ok(billing && ['second', 'generation'].includes(billing.billingUnit), 'Missing billing configuration: ' + name);
    const prices = billing.modePrices ||= {};
    for (const mode of next.capabilities.filter(value => modes.includes(value))) {
        const rates = prices[mode] ||= {};
        if (Number.isSafeInteger(rates['480p']) && rates['480p'] >= 0) continue;
        const source = [billing.defaultResolution, '720p', ...Object.keys(rates)].find(key => Number.isSafeInteger(rates[key]) && rates[key] >= 0);
        assert.ok(source, 'Missing existing price: ' + name + '/' + mode);
        rates['480p'] = rates[source];
    }
    billing.defaultResolution = '480p';
    return next;
}
try {
    let credentials = { email: env.ADMIN_INITIAL_EMAIL, password: env.ADMIN_INITIAL_PASSWORD };
    if (process.argv.includes('--studio-auth-stdin')) {
        let input = '';
        for await (const chunk of process.stdin) input += chunk;
        credentials = JSON.parse(input);
    }
    token = (await studio('/auth/login', credentials)).token;
    const channel = await admin('/api/channel/' + channelId);
    const settings = parse(channel.setting);
    assert.equal(settings.task_plugin_key, 'studio-arcads');
    const configs = (await studio('/config/model/listModelConfigs')).modelConfigs;
    const routes = await studio('/admin/newapi/model-routes');
    const supplierChannels = [];
    for (let page = 1; ; page++) {
        const result = await admin('/api/channel/?p=' + page + '&page_size=100');
        assert.ok(Number.isSafeInteger(result.total) && result.total <= 10000);
        supplierChannels.push(...result.items);
        if (supplierChannels.length >= result.total) break;
    }
    const profiles = settings.studio_model_profiles || {};
    const names = [...new Set([...channel.models.split(',').filter(Boolean), ...(settings.studio_standby_models || []), ...Object.keys(profiles)])];
    if (process.argv.includes('--inspect')) {
        console.log(JSON.stringify({channelId, channelStatus:channel.status, models:names.map(name => ({
            name, profileDefault:profiles[name]?.videoBillingConfiguration?.defaultResolution,
            configs:configs.filter(config => config.modelName === name && config.modelType === 'video').map(config => ({id:config.id,channelId:config.channelId,defaultResolution:config.videoBillingConfiguration?.defaultResolution})),
            suppliers:supplierChannels.filter(channel => channel.models.split(',').includes(name)).map(channel => ({id:channel.id,name:channel.name,status:channel.status})),
            route:routes.find(route => route.model === name),
        }))}, null, 2));
    } else {
        const nextSettings = structuredClone(settings);
        const nextProfiles = nextSettings.studio_model_profiles ||= {};
        const changes = [];
        const checked = [];
        for (const name of names) {
            const item = arcadsVideos.find(item => item[0] === name);
            const profile = profiles[name];
            if (!item && !profile?.capabilities?.some(mode => modes.includes(mode))) continue;
            const active = routes.find(route => route.model === name)?.channels.filter(route => route.active) || [];
            const isPrimary = active.length === 1 && active[0].channelId === channelId;
            const hasOtherSupplier = supplierChannels.some(row => row.id !== channelId && row.models.split(',').includes(name));
            const configureStudio = isPrimary || (!active.length && !hasOtherSupplier);
            const matches = configs.filter(config => config.modelName === name && config.modelType === 'video');
            assert.ok(matches.length <= 1, 'Ambiguous Studio model: ' + name);
            const current = matches[0];
            // Keep the stored Arcads profile authoritative for standby routes.
            const source = profile || ((isPrimary && current) ? {
                capabilities:current.capabilities, customBodyParameters:current.customBodyParameters,
                videoBillingConfiguration:current.videoBillingConfiguration,
            } : (item && videoProfile(item)));
            assert.ok(source, 'Missing Arcads profile: ' + name);
            nextProfiles[name] = withDefault(source, name);
            if (configureStudio && current) {
                const after = {...current, videoBillingConfiguration:withDefault(current, name).videoBillingConfiguration};
                if (!isDeepStrictEqual(current, after)) changes.push({before:current, after});
            }
            checked.push({model:name, primary:isPrimary, studioUpdated:configureStudio && !!current, defaultResolution:'480p', modePrices:nextProfiles[name].videoBillingConfiguration.modePrices});
        }
        assert.ok(checked.length, 'No Arcads videos found');
        const nextChannel = {...editable(channel), setting:JSON.stringify(nextSettings)};
        const channelChanged = !isDeepStrictEqual(settings, nextSettings);
        console.log(JSON.stringify({apply, channelId, profileCount:checked.length, studioChanges:changes.length, channelChanged, models:checked}, null, 2));
        if (apply && (channelChanged || changes.length)) {
            const folder = new URL('../outputs/arcads-default-480p-' + new Date().toISOString().replace(/[:.]/g,'-') + '/', import.meta.url);
            await mkdir(folder, {recursive:true});
            await writeFile(new URL('before.json',folder),JSON.stringify({channel:snapshot(channel),modelConfigs:configs,routes},null,2));
            assert.deepEqual(snapshot(await admin('/api/channel/'+channelId)),snapshot(channel),'Channel changed during maintenance');
            if (channelChanged) await admin('/api/channel/',nextChannel,'PUT');
            for (const change of changes) {
                const latest = (await studio('/config/model/listModelConfigs')).modelConfigs.find(config => config.id === change.before.id);
                assert.deepEqual(latest,change.before,'Model changed during maintenance: '+change.before.modelName);
                await studio('/config/model/updateModelConfig',change.after);
            }
            const savedChannel = await admin('/api/channel/'+channelId);
            assert.deepEqual(parse(savedChannel.setting),nextSettings);
            for (const key of [...fields.filter(key => key !== 'setting'),'status']) assert.deepEqual(savedChannel[key],channel[key],'Channel field changed: '+key);
            const savedConfigs = (await studio('/config/model/listModelConfigs')).modelConfigs;
            for (const before of configs) assert.deepEqual(savedConfigs.find(config => config.id === before.id),changes.find(change => change.before.id === before.id)?.after || before,'Model readback: '+before.modelName);
            assert.deepEqual(await studio('/admin/newapi/model-routes'),routes,'Routes changed');
            await writeFile(new URL('after.json',folder),JSON.stringify({channel:snapshot(savedChannel),modelConfigs:savedConfigs},null,2));
            console.log(JSON.stringify({verified:true,backup:folder.pathname,profiles:checked.length,studioModelsChanged:changes.length}));
        }
    }
} finally { await close(); }
