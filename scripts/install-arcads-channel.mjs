// Configure the existing mixed image/video channel without replacing its key.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { localClients } from './lib/newapi-local.mjs';
import { meta } from '../newapi/plugins/arcads-video.mjs';
import {arcadsImages,arcadsVideos,videoProfile} from './lib/arcads-models.mjs';

const { admin, close } = await localClients();
try {
    const id = Number(process.env.ARCADS_CHANNEL_ID || 42);
    const channel = await admin('/api/channel/' + id);
    assert.equal(channel.name.toLowerCase(), 'arcads', 'Only the explicitly configured Arcads channel may be changed');
    assert.ok([1, 60].includes(channel.type), 'Only migrate an OpenAI-compatible mixed channel');
    const previousSetting=JSON.parse(channel.setting||'{}');
    const models=[...new Set([...channel.models.split(','),...(previousSetting.studio_standby_models||[])])].filter(Boolean)
        .map(model=>['minimax-h3','arcads-minimax-h3'].includes(model)?'MiniMax-H3':model);
    const mapping = { ...JSON.parse(channel.model_mapping || '{}'), 'MiniMax-H3': 'minimax-h3' };
    delete mapping['arcads-minimax-h3'];
    const template = await readFile(new URL('../newapi/plugins/arcads-video.mjs', import.meta.url), 'utf8');
    const version='1.1.0+'+createHash('sha256').update(template).digest('hex').slice(0,12);
    const source=template.replace("version: '1.0.0'", "version: '"+version+"'");
    await admin('/api/plugin/task', { source, enabled: true, remark: 'Arcads video multipart reference bridge; image relay remains OpenAI' });
    await admin('/api/plugin/task/'+meta.key+'/activate',{version});
    const options = await admin('/api/option/');
    const option = key => options.find(o => o.key === key)?.value;
    const ports = new Set(JSON.parse(option('fetch_setting.allowed_ports') || '["80","443","8080","8443"]'));
    ports.add(new URL(channel.base_url).port || '80');
    await admin('/api/option/', { key: 'fetch_setting.allowed_ports', value: JSON.stringify([...ports]) }, 'PUT');
    // Studio owns the user-facing credit charge; this local gateway uses its existing free group.
    assert.equal(JSON.parse(option('GroupRatio')).default, 0, 'Review gateway pricing before using this installer on a paid gateway');
    const prices = JSON.parse(option('ModelPrice') || '{}');
    const addedPrices = [];
    for (const model of models) {
        if (prices[model] === undefined) { prices[model] = 0; addedPrices.push(model); }
    }
    await admin('/api/option/', { key: 'ModelPrice', value: JSON.stringify(prices) }, 'PUT');
    const others=(await admin('/api/channel/?p=1&page_size=100')).items.filter(c=>c.id!==id && c.group.split(',').includes('default'));
    const standby=models.filter(model=>(previousSetting.studio_standby_models||[]).includes(model)||others.some(c=>c.models.split(',').includes(model)));
    const active=models.filter(model=>!standby.includes(model));
    const profiles={...previousSetting.studio_model_profiles};
    for(const [model] of arcadsImages) profiles[model]={capabilities:['text-to-image','image-to-image'],customBodyParameters:{}};
    for(const item of arcadsVideos) profiles[item[0]]=videoProfile(item);
    const setting = { ...previousSetting, task_plugin_key: meta.key,studio_standby_models:standby,studio_model_profiles:profiles };
    const originalGroup=previousSetting.studio_standby_only?previousSetting.studio_active_groups:channel.group;
    const group=active.length?originalGroup:'studio-standby';
    const published=active.length?active:models;
    if(active.length) {
        delete setting.studio_standby_only; delete setting.studio_active_groups;
    } else {
        setting.studio_standby_only=true; setting.studio_active_groups=originalGroup;
    }
    const envPath=new URL('../.env',import.meta.url);
    let envText=await readFile(envPath,'utf8');
    const origin='NEWAPI_ARCADS_ORIGIN='+new URL(channel.base_url).origin;
    envText=/^NEWAPI_ARCADS_ORIGIN=/m.test(envText)?envText.replace(/^NEWAPI_ARCADS_ORIGIN=.*$/m,origin):envText.trimEnd()+'\n'+origin+'\n';
    await writeFile(envPath,envText);
    // Explicit editable fields only: status is a separate endpoint; key stays untouched.
    await admin('/api/channel/', {
        // Type 60 retains OpenAI image relay and permits explicit task plugin binding.
        id, type: 60, name: channel.name, base_url: channel.base_url,
        models:published.join(','), group, priority: channel.priority, weight: channel.weight,
        model_mapping: JSON.stringify(mapping), setting: JSON.stringify(setting),
    }, 'PUT');
    const saved = await admin('/api/channel/' + id);
    assert.equal(saved.type, 60);
    assert.equal(saved.models, published.join(','));
    assert.equal(saved.group, group);
    assert.equal(JSON.parse(saved.setting).task_plugin_key, meta.key);
    console.log(JSON.stringify({ channel: id, plugin: meta.key, activeModels:active, standbyModels:standby, addedGatewayPrices: addedPrices }));
} finally { await close(); }
