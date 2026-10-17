// Add the newly advertised Seedance 2.0 models without changing primary routes.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { localClients } from './lib/newapi-local.mjs';
import { arcadsVideos, videoProfile } from './lib/arcads-models.mjs';

const { admin, studio, close } = await localClients();
const names = ['seedance-2.0', 'seedance-2.0-mini'];
const parse = value => typeof value === 'string' ? JSON.parse(value || '{}') : value || {};
try {
    const channel = await admin('/api/channel/42');
    const settings = parse(channel.setting);
    assert.equal(settings.task_plugin_key, 'studio-arcads');
    const configured = new Set([...channel.models.split(','), ...(settings.studio_standby_models || [])]);
    const upstream = new Set(await admin('/api/channel/fetch_models/42'));
    for (const name of names) {
        assert.ok(configured.has(name), 'Model must already be configured by the administrator: ' + name);
        assert.ok(upstream.has(name), 'Model must be advertised by this upstream: ' + name);
    }
    const beforeModels = (await studio('/config/model/listModelConfigs')).modelConfigs;
    const beforeRoutes = await studio('/admin/newapi/model-routes');
    const previousPlugin = await admin('/api/plugin/task/studio-arcads');
    const folder = new URL('../outputs/arcads-seedance-repair-' + new Date().toISOString().replace(/[:.]/g, '-') + '/', import.meta.url);
    await mkdir(folder, { recursive: true });
    await writeFile(new URL('before.json', folder), JSON.stringify({
        channel: { id: channel.id, type: channel.type, models: channel.models, group: channel.group, setting: settings },
        models: beforeModels, routes: beforeRoutes,
    }, null, 2));
    await writeFile(new URL('previous-plugin.mjs', folder), previousPlugin.source);

    const template = await readFile(new URL('../newapi/plugins/arcads-video.mjs', import.meta.url), 'utf8');
    const version = '1.2.0+' + createHash('sha256').update(template).digest('hex').slice(0, 12);
    await admin('/api/plugin/task', {
        source: template.replace("version: '1.0.0'", "version: '" + version + "'"), enabled: true,
        remark: 'Add Seedance 2.0 and Mini: 4-15 seconds, 720P, image references',
    });
    await admin('/api/plugin/task/studio-arcads/activate', { version });

    // Run the installed gateway engine without submitting any generation or charging credits.
    let checked = 0;
    for (const model of names) for (const seconds of [4, 15]) {
        for (const mode of ['text-to-video', 'image-to-video', 'reference-to-video']) {
            const request = { model, prompt: 'Offline protocol check', seconds, resolution: '720p', size: '16:9', video_generation_mode: mode };
            if (mode !== 'text-to-video') request.images = ['https://example.invalid/reference.png'];
            const result = await admin('/api/plugin/task/studio-arcads/dryrun', { hook: 'buildSubmitRequest', args: [{
                model, baseUrl: 'https://example.invalid/v1', apiKey: 'offline-test', requestBody: request,
            }] });
            assert.equal(result.body.model, model);
            assert.equal(result.body.seconds, String(seconds));
            assert.equal(result.body.size, '1280x720');
            if (mode === 'image-to-video') assert.equal(result.body.input_reference, request.images[0]);
            if (mode === 'reference-to-video') assert.deepEqual(result.body.reference_images, request.images);
            checked++;
        }
    }

    const profiles = { ...settings.studio_model_profiles };
    for (const name of names) {
        if (!profiles[name]) profiles[name] = videoProfile(arcadsVideos.find(item => item[0] === name));
    }
    const latest = await admin('/api/channel/42');
    assert.deepEqual(latest, channel, 'Channel edited during repair; retry against the new configuration');
    const patch = Object.fromEntries(['id', 'name', 'type', 'base_url', 'models', 'group', 'priority', 'weight', 'model_mapping'].map(key => [key, channel[key]]));
    await admin('/api/channel/', { ...patch, setting: JSON.stringify({ ...settings, studio_model_profiles: profiles }) }, 'PUT');
    const saved = await admin('/api/channel/42');
    for (const key of ['key', 'status', 'models', 'group', 'model_mapping']) assert.deepEqual(saved[key], channel[key], key + ' must be preserved');
    for (const name of names) assert.deepEqual(parse(saved.setting).studio_model_profiles[name], profiles[name]);

    const options = await admin('/api/option/');
    assert.equal(parse(options.find(option => option.key === 'GroupRatio').value).default, 0);
    const prices = parse(options.find(option => option.key === 'ModelPrice').value);
    for (const name of names) if (prices[name] === undefined) prices[name] = 0;
    await admin('/api/option/', { key: 'ModelPrice', value: JSON.stringify(prices) }, 'PUT');
    assert.deepEqual(await studio('/admin/newapi/model-routes'), beforeRoutes);
    assert.deepEqual((await studio('/config/model/listModelConfigs')).modelConfigs, beforeModels);
    console.log(JSON.stringify({ channel: 42, pluginVersion: version, profilesReady: names, gatewayChecks: checked, routesAndSettingsPreserved: true, backup: folder.pathname }));
} finally {
    await close();
}
