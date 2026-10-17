// Exercise the real New API plugin host with a local mock supplier. No paid generation.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { localClients } from './lib/newapi-local.mjs';
const { admin, env } = await localClients();
const template = await readFile(new URL('../newapi/plugins/video-adapter.mjs', import.meta.url), 'utf8');
const configs = [
    ['minimax', 'MiniMax-H3', 6], ['openai', 'veo-3.1-lite', 8], ['muse', 'sora-2', 10],
    ['autodl-comfyui', 'h3', 5], ['dola', 'seedance-2.5', 30], ['openai-video-json', 'Doubao-Seedance-2.0-mini', 8],
];
const stamp = Date.now().toString(36), fixtures = [], observed = [], errors = [];
const binary = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432','hex');
const mock = createServer(async (req, res) => {
    try {
        const path = new URL(req.url, 'http://example.com').pathname;
        const protocol = path.split('/')[1];
        observed.push({protocol, method:req.method, path});
        assert.equal(req.headers.authorization, protocol === 'autodl-comfyui' ? 'qa-video-key' : 'Bearer qa-video-key');
        if (req.url.endsWith('/content')) { res.setHeader('Content-Type','video/mp4'); res.end(binary); return; }
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'POST') {
            let raw = ''; for await (const chunk of req) raw += chunk;
            const body = req.headers['content-type']?.includes('application/json') ? JSON.parse(raw) : raw;
            observed.push({protocol, url: req.url, body});
            const taskId='qa-'+stamp+'-'+protocol;
            res.end(JSON.stringify(protocol === 'autodl-comfyui' ? {code:'success', data:{task_id:taskId}} : {id:taskId, task_id:taskId}));
        } else {
            const result = { status:'completed', seconds:30, video_url:`http://example.com/${protocol}/content` };
            if (protocol === 'minimax') { result.content = {url:result.video_url}; res.end(JSON.stringify({task:result})); }
            else if (protocol === 'autodl-comfyui') { result.results = [{url:result.video_url}]; res.end(JSON.stringify({upstream:{code:'success',data:result}})); }
            else res.end(JSON.stringify(result));
        }
    } catch (e) { errors.push(e.message); res.writeHead(500).end('{}'); }
});
await new Promise(resolve => mock.listen(19096, '0.0.0.0', resolve));
const relay = async (path, body) => {
    const response = await fetch('http://127.0.0.1:'+(env.NEWAPI_PORT || 3005)+path, {
        method: body ? 'POST' : 'GET', headers: {Authorization:'Bearer '+env.NEWAPI_RELAY_KEY, ...(body instanceof FormData ? {} : {'Content-Type':'application/json'})},
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) { const error = await response.text(); throw Error('Gateway HTTP '+response.status+': '+error.slice(0,600)); }
    return response;
};
try {
    for (const [protocol, upstreamModel, seconds] of configs.filter(c => !process.env.TEST_PROTOCOL || c[0] === process.env.TEST_PROTOCOL)) {
        const key = 'qa-v-' + stamp + '-' + configs.findIndex(c=>c[0]===protocol), model = 'qa-video-' + protocol + '-' + stamp;
        await admin('/api/plugin/task', {source:'const config = '+JSON.stringify({key, name:key, protocol, models:[model], helperBase:'http://example.com/'+protocol+'/helper'})+';\n'+template, enabled:true});
        fixtures.push({key});
        await admin('/api/channel/', {mode:'single',channel:{name:model, type:61, key:'qa-video-key', base_url:'http://example.com/'+protocol,
            models:model, group:'default', status:1, priority:0, weight:1, model_mapping:JSON.stringify({[model]:upstreamModel}), setting:JSON.stringify({task_plugin_key:key, proxy:'http://host.docker.internal:19096'})}});
        const rows=await admin('/api/channel/search?keyword='+encodeURIComponent(model)+'&p=1&page_size=100');
        fixtures.at(-1).id=rows.items[0].id;
        const input={model,prompt:'Gateway protocol verification',seconds, resolution: protocol === 'openai-video-json' ? '480p' : '768p',
            video_generation_mode:'image-to-video', images:['https://example.com/reference.png'], metadata:{aspect_ratio:'9:16'}, reference_image_roles:['first_frame']};
        let body=input;
        if(protocol==='autodl-comfyui' || protocol==='dola') {
            body=new FormData();
            for(const [key,value] of Object.entries(input)) body.append(key,typeof value==='object'?JSON.stringify(value):String(value));
            body.append('image',new Blob([Buffer.from('reference bytes')],{type:'image/png'}),'reference.png');
        }
        const created=await (await relay('/v1/videos',body)).json();
        assert.ok(created.id, JSON.stringify(created));
        let result;
        for(let i=0;i<90;i++) {
            result=await (await relay('/v1/videos/'+created.id)).json();
            if(['completed','failed'].includes(result.status)) break;
            await new Promise(resolve=>setTimeout(resolve,2000));
        }
        assert.equal(result.status,'completed',JSON.stringify({result, requests:observed.filter(o=>o.method),errors}));
        const content=Buffer.from(await (await relay('/v1/videos/'+created.id+'/content')).arrayBuffer());
        assert.deepEqual(content,binary);
        const submitted=observed.find(o=>o.protocol===protocol && o.body);
        assert.ok(submitted,protocol+' missing upstream submit');
        if(protocol==='dola') { assert.equal(submitted.body.duration,30); assert.equal(submitted.body.model,'seedance-2.5'); assert.equal(submitted.body.reference_images.length,1); }
        if(protocol==='autodl-comfyui') assert.equal(submitted.body.ref_image_0,'data:image/png;base64,'+Buffer.from('reference bytes').toString('base64'));
        if(protocol==='minimax') assert.equal(submitted.body.content[1].role,'first_frame');
        if(protocol==='muse') { assert.equal(submitted.body.input_reference.length,1); assert.ok(!('seconds' in submitted.body)); }
        if(protocol==='openai-video-json') { assert.equal(submitted.body.task_type,'i2v'); assert.equal(submitted.body.media_urls.length,1); }
        if(protocol==='openai') { assert.ok(submitted.body.includes('input_reference[]')); assert.ok(submitted.body.includes(upstreamModel)); }
        console.log('PASS '+protocol+': submit → poll → authenticated content, reference and model mapping verified');
    }
    assert.deepEqual(errors,[]);
} finally {
    for(const f of fixtures.reverse()) {
        if(f.id) await admin('/api/channel/'+f.id,undefined,'DELETE').catch(()=>{});
        await admin('/api/plugin/task/'+f.key+'/versions/1.0.1?force=true',undefined,'DELETE').catch(()=>{});
    }
    mock.closeAllConnections();
    await new Promise(resolve=>mock.close(resolve));
}
