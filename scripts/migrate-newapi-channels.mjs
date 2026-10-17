// Bulk-migrate currently compatible Studio channels through the authenticated admin API.
// Preview: node scripts/migrate-newapi-channels.mjs
// Apply:   node scripts/migrate-newapi-channels.mjs --apply
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const env = Object.fromEntries((await readFile(new URL('../.env', import.meta.url), 'utf8')).split(/\r?\n/)
    .filter(line => /^[A-Z_]+=/.test(line)).map(line => {
        const i = line.indexOf('='); return [line.slice(0,i), line.slice(i+1).replace(/^["']|["']$/g, '')];
    }));
const base = 'http://127.0.0.1:' + (env.WEB_PORT || 5550) + '/api/v1';
let token = '';
async function api(path, body) {
    const response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(45000),
        headers: {'Content-Type': 'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {})},
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok || result.code !== 0) throw Error(path + ': ' + (result.msg || 'HTTP ' + response.status));
    return result.data;
}
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
function fingerprint(value) {
    return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
token = (await api('/auth/login', {email: env.ADMIN_INITIAL_EMAIL, password: env.ADMIN_INITIAL_PASSWORD})).token;
const prefix = '/admin/newapi';
const status = await api(prefix + '/status');
if (!status.connected) throw Error(status.message);
const [items, configs, prices] = await Promise.all([
    api(prefix + '/importable'), api('/config/model/listModelConfigs'), api('/admin/model/tokenPricing'),
]);
const plan = items.map(channel => ({
    id: channel.id, name: channel.name, protocol: channel.apiFormat,
    action: channel.migrated ? 'already_migrated' : channel.supported ? 'migrate' : 'requires_adapter',
    models: configs.modelConfigs.filter(m => m.channelId === channel.id).map(m => ({
        name: m.modelName, type: m.modelType, custom: m.isCustomModel === true,
    })),
}));
if (!process.argv.includes('--apply')) {
    console.log(JSON.stringify({connected: true, plan}, null, 2));
    process.exit(0);
}
const report = {time: new Date().toISOString(), migrated: [], alreadyMigrated: [], skipped: [], failed: [], checks: {}};
for (const item of plan) {
    if (item.action === 'requires_adapter') { report.skipped.push({name: item.name, protocol: item.protocol}); continue; }
    if (item.action === 'already_migrated') { report.alreadyMigrated.push(item.name); continue; }
    try {
        await api(prefix + '/import', {channelId: item.id});
        const after = (await api('/config/model/listModelConfigs')).modelConfigs.filter(m => m.channelId === item.id);
        const before = configs.modelConfigs.filter(m => m.channelId === item.id);
        if (fingerprint(after) !== fingerprint(before)) {
            await api(prefix + '/restore', {channelId: item.id});
            throw Error('模型配置校验未通过，已恢复直连');
        }
        const routing = (await api('/config/channel/listChannels')).channels.find(c => c.id === item.id);
        if (routing?.baseUrl !== 'http://newapi:3000/v1') {
            await api(prefix + '/restore', {channelId: item.id});
            throw Error('网关路由校验未通过，已恢复直连');
        }
        report.migrated.push({name: item.name, modelCount: after.length, routeVerified: true, settingsPreserved: true});
        console.log('Migrated: ' + item.name + ' (' + after.length + ' configured models); settings preserved.');
    } catch (error) {
        report.failed.push({name: item.name, message: error.message});
    }
}
const [afterModels, afterPrices, afterItems, catalog] = await Promise.all([
    api('/config/model/listModelConfigs'), api('/admin/model/tokenPricing'),
    api(prefix + '/importable'), api(prefix + '/models'),
]);
report.checks.allModelConfigurationsUnchanged = fingerprint(configs.modelConfigs) === fingerprint(afterModels.modelConfigs);
report.checks.tokenPricesUnchanged = fingerprint(prices) === fingerprint(afterPrices);
report.checks.gatewayModelCount = catalog.length;
report.checks.totalMigratedChannels = afterItems.filter(c => c.migrated).length;
const directory = new URL('../outputs/', import.meta.url);
await mkdir(directory, {recursive: true});
await writeFile(new URL('newapi-migration-report.json', directory), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (report.failed.length || !report.checks.allModelConfigurationsUnchanged || !report.checks.tokenPricesUnchanged) process.exitCode = 1;
