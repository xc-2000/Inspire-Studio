import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { localClients } from './lib/newapi-local.mjs';
import { createHash } from 'node:crypto';

const { studio, admin, env } = await localClients();
const channels = (await studio('/config/channel/listChannels')).channels;
const configs = (await studio('/config/model/listModelConfigs')).modelConfigs;
const template = await readFile(new URL('../newapi/plugins/video-adapter.mjs', import.meta.url), 'utf8');
const labels = { minimax: 'MiniMax H3', openai: 'OpenAI 视频', muse: 'Muse', 'autodl-comfyui': 'AutoDL 工作流', dola: 'Dola Seedance', 'openai-video-json': 'Seedance JSON' };
const installed = await admin('/api/plugin/task');
const lumina = channels.find(c => c.apiFormat === 'openai-video-json' && /\/openai\/v1\/?$/.test(c.baseUrl));
if (lumina && env.LUMINA_LOCAL_API_TOKEN) {
    const path = new URL('../.env', import.meta.url);
    let contents = await readFile(path, 'utf8');
    for (const [key, value] of Object.entries({NEWAPI_LUMINA_UPLOAD_ORIGIN:new URL(lumina.baseUrl).origin, NEWAPI_LUMINA_UPLOAD_TOKEN:env.LUMINA_LOCAL_API_TOKEN})) {
        if (env[key]) continue;
        contents = contents.trimEnd() + '\n' + key + '=' + value + '\n';
    }
    await writeFile(path, contents, {mode:0o600});
}
// Keep SSRF checks enabled; allow only the concrete upstream service ports already configured.
const options = await admin('/api/option/');
const ports = options.find(o => o.key === 'fetch_setting.allowed_ports');
const allowedPorts = new Set(ports ? JSON.parse(ports.value) : ['80','443','8080','8443']);
for (const channel of channels.filter(c => labels[c.apiFormat])) {
    const port = new URL(channel.baseUrl).port;
    if (port) allowedPorts.add(port);
}
await admin('/api/option/', {key:'fetch_setting.allowed_ports',value:JSON.stringify([...allowedPorts])}, 'PUT');
await mkdir(new URL('../newapi/generated/', import.meta.url), { recursive: true });
for (const [protocol, name] of Object.entries(labels)) {
    const key = 'studio-' + protocol;
    const previous = installed.find(p => p.meta.key === key);
    const models = [...new Set([...(previous?.meta.models || []), ...channels.filter(c => c.apiFormat === protocol &&
        (protocol !== 'openai' || configs.some(m => m.channelId === c.id && m.modelType === 'video'))).flatMap(c => c.models)])].sort();
    if (!models.length) continue;
    const version = '1.0.1+' + createHash('sha256').update(template + JSON.stringify(models)).digest('hex').slice(0,12);
    const source = 'const config = ' + JSON.stringify({ key, name, protocol, models, version }) + ';\n' + template;
    await writeFile(new URL('../newapi/generated/' + key + '.js', import.meta.url), source);
    await admin('/api/plugin/task', { source, enabled: true, remark: 'Inspire Studio unified video adapter' });
    // 注册新版本只是写进 task_plugins，真正生效的是同 key 下 active=1 的那一行。
    // 这里必须显式激活，否则安装器会静默变成空操作：新版本入库但旧代码继续执行
    // （studio-dola 曾长期停留在 1.0.0，导致后续所有模板修改都不生效）。
    await admin('/api/plugin/task/' + key + '/activate', { version });
    const active = await admin('/api/plugin/task/' + key);
    assert.equal(active.plugin.version, version, '插件未激活到新版本: ' + key);
    console.log(JSON.stringify({ plugin: key, models: models.length, installed: true, activeVersion: version }));
}
