// Repair existing Arcads video profiles. Preview by default; pass --apply to save.
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { localClients } from './lib/newapi-local.mjs';
import { arcadsVideos, videoProfile } from './lib/arcads-models.mjs';
import { buildSubmitRequest } from '../newapi/plugins/arcads-video.mjs';

const apply = process.argv.includes('--apply');
const { studio, close } = await localClients({ adminSession: false });
const modes = ['text-to-video', 'image-to-video', 'reference-to-video', 'first-last-frame-to-video'];
try {
    const before = (await studio('/config/model/listModelConfigs')).modelConfigs;
    const routes = await studio('/admin/newapi/model-routes');
    const plans = [];
    for (const item of arcadsVideos) {
        const [model, , , , resolution] = item;
        const active = routes.find(route => route.model === model)?.channels.filter(channel => channel.active && channel.channelStatus === 1) || [];
        // This maintenance operation targets the verified Arcads installation only.
        if (active.length !== 1 || active[0].channelId !== 42) continue;
        const matches = before.filter(config => config.modelType === 'video' && config.modelName === model);
        // A gateway model need not have been admitted to the Studio catalog yet.
        if (!matches.length) continue;
        assert.equal(matches.length, 1, 'Expected a unique configuration for ' + model);
        const config = matches[0];
        const profile = videoProfile(item);
        const existing = config.videoBillingConfiguration;
        const hasExistingPrice = profile.capabilities.some(mode => Number.isInteger(existing?.modePrices?.[mode]?.[resolution]));
        const billingUnit = hasExistingPrice ? existing.billingUnit : 'second';
        assert.ok(['second', 'generation'].includes(billingUnit));
        const modePrices = Object.fromEntries(modes.map(mode => [mode, {}]));
        for (const mode of profile.capabilities) {
            const price = existing?.modePrices?.[mode]?.[resolution];
            // Never silently convert a retained per-generation tariff into a per-second one.
            if (!Number.isInteger(price) && hasExistingPrice && billingUnit !== 'second') {
                throw new Error('Missing per-generation tariff requires an explicit price: ' + model + '/' + mode);
            }
            modePrices[mode][resolution] = Number.isInteger(price) ? price : 10;
            for (const seconds of profile.videoBillingConfiguration.supportedDurationsSeconds) {
                buildSubmitRequest({
                    model, baseUrl: 'https://example.invalid/v1', apiKey: 'offline-contract-check',
                    requestBody: {
                        prompt: 'Offline profile validation', seconds, resolution, size: '16:9', video_generation_mode: mode,
                        ...(mode === 'text-to-video' ? {} : { images: ['https://example.invalid/reference.png'] }),
                    },
                });
            }
        }
        const next = {
            ...config,
            capabilities: profile.capabilities,
            creditUnit: billingUnit,
            videoBillingConfiguration: { ...profile.videoBillingConfiguration, billingUnit, modePrices },
        };
        plans.push({ before: config, after: next, changed: !isDeepStrictEqual(config, next) });
    }
    assert.ok(plans.length, 'No active Arcads video models found');
    const changes = plans.filter(plan => plan.changed);
    console.log(JSON.stringify({ apply, checked: plans.length, changes: changes.length, models: plans.map(({ after, changed }) => ({
        model: after.modelName, changed, modes: after.capabilities,
        durations: after.videoBillingConfiguration.supportedDurationsSeconds,
        unit: after.creditUnit, prices: after.videoBillingConfiguration.modePrices,
    })) }, null, 2));
    if (apply && changes.length) {
        const folder = new URL('../outputs/arcads-video-config-' + new Date().toISOString().replace(/[:.]/g, '-') + '/', import.meta.url);
        await mkdir(folder, { recursive: true });
        await writeFile(new URL('before.json', folder), JSON.stringify({ modelConfigs: before }, null, 2));
        console.log('Backup: ' + folder.pathname);
        for (const plan of changes) {
            const current = (await studio('/config/model/listModelConfigs')).modelConfigs.find(config => config.id === plan.before.id);
            assert.deepEqual(current, plan.before, 'Configuration changed during maintenance: ' + plan.before.modelName);
            await studio('/config/model/updateModelConfig', plan.after);
            console.log('Saved: ' + plan.after.modelName);
        }
        const after = (await studio('/config/model/listModelConfigs')).modelConfigs;
        for (const original of before) {
            const expected = plans.find(plan => plan.before.id === original.id)?.after || original;
            assert.deepEqual(after.find(config => config.id === original.id), expected, 'Readback mismatch: ' + original.modelName);
        }
        assert.deepEqual(await studio('/admin/newapi/model-routes'), routes, 'Primary routes changed');
        await writeFile(new URL('after.json', folder), JSON.stringify({ modelConfigs: after }, null, 2));
        console.log('Verified all profiles, existing prices, unrelated configurations, defaults, aliases, and routes.');
    }
} finally {
    await close();
}
