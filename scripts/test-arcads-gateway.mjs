// Real New API runtime + mock supplier: no paid generation, no production channel changes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { localClients } from './lib/newapi-local.mjs';
import { arcadsTask } from '../newapi/helper/server.mjs';
const { admin, env, close } = await localClients({studioSession:false});
const stamp = Date.now().toString(36), model = 'qa-arcads-' + stamp, key = model;
const image = Buffer.from('uploaded-reference-fixture'), binary = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex');
const observed = [], errors = [];
let channelId, pricesAdded = false;
const mock = createServer(async (req, res) => {
    try {
        const target = new URL(req.url, 'http://example.com');
        if (target.hostname === 'newapi-video-helper') {
            const task = await arcadsTask(target.pathname.split('/')[3], {
                base:req.headers['x-upstream-base'],arcadsOrigin:'http://example.com',authorization:req.headers.authorization,
                request:async(url,options)=>{
                    assert.equal(options.headers.Authorization,'Bearer qa-arcads-key');
                    return url.endsWith('/content')
                        ? new Response(null,{status:302,headers:{location:'https://example.net/video.mp4'}})
                        : new Response(JSON.stringify({status:'completed',progress:100,seconds:'5'}));
                },
            });
            res.setHeader('Content-Type','application/json');res.end(JSON.stringify(task));return;
        }
        if (target.hostname === 'example.net') {
            assert.equal(req.headers.authorization, undefined, 'Do not leak the channel key to a signed media host');
            res.setHeader('Content-Type', 'video/mp4'); res.end(binary); return;
        }
        assert.equal(req.headers.authorization, 'Bearer qa-arcads-key');
        if (target.pathname.endsWith('/content')) {
            res.writeHead(302, { Location: 'http://example.net/final.mp4?signed=qa' }).end(); return;
        }
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'POST') {
            let raw = ''; for await (const chunk of req) raw += chunk;
            const body = JSON.parse(raw); observed.push(body);
            assert.equal(body.model, 'minimax-h3');
            assert.ok(['480p','720p'].includes(body.resolution));
            assert.equal(body.size, body.resolution==='480p'?'854x480':'1280x720'); assert.equal(body.seconds, '5');
            res.end(JSON.stringify({ id: 'qa-video-' + observed.length, status: 'queued', seconds: '5' }));
        } else res.end(JSON.stringify({ status: 'completed', progress: 100, seconds: '5' }));
    } catch (error) { errors.push(error.message); res.writeHead(500).end('{}'); }
});
const relay = async (path, body) => {
    const response = await fetch('http://127.0.0.1:' + (env.NEWAPI_PORT || 3005) + path, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + env.NEWAPI_RELAY_KEY, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) throw Error('Gateway HTTP ' + response.status + ': ' + (await response.text()).slice(0, 900));
    return response;
};
try {
    await new Promise(resolve => mock.listen(19097, '0.0.0.0', resolve));
    const template = await readFile(new URL('../newapi/plugins/arcads-video.mjs', import.meta.url), 'utf8');
    const source = template.replace("key: 'studio-arcads'", "key: '" + key + "'").replace(/models: \[[^\]]+\]/, 'models: ' + JSON.stringify([model]))
        // Route the signed HTTPS object to our plain HTTP proxy fixture only in this isolated plugin.
        .replace('url: target, method:', `url: target.replace('https:', 'http:'), method:`);
    await admin('/api/plugin/task', { source, enabled: true });
    const options = await admin('/api/option/');
    const prices = JSON.parse(options.find(o => o.key === 'ModelPrice').value);
    prices[model] = 0;
    await admin('/api/option/', { key: 'ModelPrice', value: JSON.stringify(prices) }, 'PUT'); pricesAdded = true;
    await admin('/api/channel/', { mode: 'single', channel: {
        name: model, type: 60, key: 'qa-arcads-key', base_url: 'http://example.com', models: model,
        group: 'default', status: 1, priority: 0, weight: 1,
        model_mapping: JSON.stringify({ [model]: 'minimax-h3' }),
        setting: JSON.stringify({ task_plugin_key: key, proxy: 'http://host.docker.internal:19097' }),
    } });
    channelId = (await admin('/api/channel/search?keyword=' + model + '&p=1&page_size=100')).items[0].id;
    for (const resolution of ['480p','720p']) for (const mode of ['text-to-video', 'image-to-video', 'reference-to-video']) {
        const input = { model, prompt: 'Arcads isolated protocol verification', seconds: 5, resolution, metadata: { aspect_ratio: '16:9' }, video_generation_mode: mode };
        let body = input;
        if (mode === 'image-to-video') {
            body = new FormData();
            for (const [key, value] of Object.entries(input)) body.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
            body.append('images', '["https://example.com/stale-reference.png"]');
            body.append('image', new Blob([image], { type: 'image/png' }), 'reference.png');
        } else if (mode === 'reference-to-video') input.images = ['https://example.com/one.png', 'https://example.com/two.png'];
        const created = await (await relay('/v1/videos', body)).json(); assert.ok(created.id);
        let result;
        for (let i = 0; i < 45; i++) {
            result = await (await relay('/v1/videos/' + created.id)).json();
            if (['completed', 'failed'].includes(result.status)) break;
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        assert.equal(result.status, 'completed', JSON.stringify({ result, errors }));
        assert.deepEqual(Buffer.from(await (await relay('/v1/videos/' + created.id + '/content')).arrayBuffer()), binary);
        const sent = observed.at(-1);
        assert.equal(sent.resolution,resolution);
        if (mode === 'image-to-video') assert.equal(sent.input_reference, 'data:image/png;base64,' + image.toString('base64'));
        if (mode === 'reference-to-video') assert.deepEqual(sent.reference_images, input.images);
        if (mode === 'text-to-video') assert.equal(sent.input_reference, undefined);
        console.log('PASS ' + mode + ' '+resolution+': model mapping, submit, poll, redirected content, credential isolation');
    }
    assert.deepEqual(errors, []);
} finally {
    if (channelId) await admin('/api/channel/' + channelId, undefined, 'DELETE');
    await admin('/api/plugin/task/' + key + '/versions/1.0.0?force=true', undefined, 'DELETE').catch(() => {});
    if (pricesAdded) {
        const options = await admin('/api/option/');
        const prices = JSON.parse(options.find(o => o.key === 'ModelPrice').value);
        delete prices[model];
        await admin('/api/option/', { key: 'ModelPrice', value: JSON.stringify(prices) }, 'PUT');
    }
    mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); await close();
}
