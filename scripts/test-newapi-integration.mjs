// Local-only, no paid provider calls. Run against the local Compose stack.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
const env = Object.fromEntries((await readFile(new URL('../.env', import.meta.url), 'utf8')).split(/\r?\n/)
    .filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i=l.indexOf('='); return [l.slice(0,i),l.slice(i+1).replace(/^["']|["']$/g,'')]; }));
const base = 'http://127.0.0.1:' + (env.WEB_PORT || 5550) + '/api/v1';
let token = '';
async function api(path, body) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
        headers: {'Content-Type':'application/json', ...(token ? {Authorization:'Bearer '+token} : {})},
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000) });
    const result = await response.json();
    assert.equal(result.code, 0, path + ': ' + result.msg);
    return result.data;
}
const name = 'NewAPI-QA-' + Date.now();
const sourceId = name.toLowerCase();
const models = [name+'-text', name+'-image', name+'-video'];
const upstreamKey = 'local-mock-only-' + name;
let chatCalls = 0;
const mock = createServer(async(req,res) => {
    if (req.headers.authorization !== 'Bearer '+upstreamKey) { res.writeHead(401).end('{}'); return; }
    res.setHeader('Content-Type','application/json');
    if (req.url === '/v1/models') { res.end(JSON.stringify({object:'list',data:models.map(id=>({id,object:'model'}))})); return; }
    if (req.url === '/v1/chat/completions') {
        chatCalls++;
        let body=''; for await(const chunk of req) body+=chunk;
        const input=JSON.parse(body);
        res.end(JSON.stringify({id:'qa-chat',object:'chat.completion',created:Math.floor(Date.now()/1000),model:input.model,
            choices:[{index:0,message:{role:'assistant',content:'New API relay verified'},finish_reason:'stop'}],
            usage:{prompt_tokens:2,completion_tokens:4,total_tokens:6}})); return;
    }
    res.writeHead(404).end('{}');
});
await new Promise(resolve=>mock.listen(19095,'0.0.0.0',resolve));
const prefix='/admin/newapi';
let gatewayId;
let importId;
const gatewayModels=[];
try {
    const denied=await fetch(base+prefix+'/channels');
    assert.ok(denied.status===401 || (await denied.json()).code!==0);
    token=(await api('/auth/login',{email:env.ADMIN_INITIAL_EMAIL,password:env.ADMIN_INITIAL_PASSWORD})).token;
    assert.equal((await api(prefix+'/status')).connected,true);
    const defaultsBefore=(await api('/config/model/listModelConfigs')).modelConfigs.filter(m=>m.defaultModel).map(m=>m.id).sort();
    const draft={name,type:1,baseUrl:'http://host.docker.internal:19095/v1',apiKey:upstreamKey,models,priority:0,weight:1,modelMapping:'{}'};
    await api(prefix+'/channels/save',draft);
    const page=await api(prefix+'/channels?page=1&pageSize=1&keyword='+name);
    assert.equal(page.total,1); assert.equal(page.items.length,1);
    gatewayId=page.items[0].id;
    assert.ok(!JSON.stringify(page).includes(upstreamKey));
    assert.ok(!JSON.stringify(page).includes(env.NEWAPI_ADMIN_TOKEN));
    assert.deepEqual((await api(prefix+'/channels/models',{id:gatewayId})).sort(),[...models].sort());
    await api(prefix+'/channels/save',{...draft,id:gatewayId,apiKey:'',name:name+' edited'});
    assert.equal((await api(prefix+'/channels/models',{id:gatewayId})).length,3);
    await api(prefix+'/channels/status',{id:gatewayId,enabled:false});
    assert.equal((await api(prefix+'/channels?keyword='+name)).items[0].status,2);
    await api(prefix+'/channels/status',{id:gatewayId,enabled:true});
    assert.ok((await api(prefix+'/models')).some(m=>m.id===models[0]));
    for(const [i,kind] of ['text','image','video'].entries()){
        const input={models:[models[i]],modelType:kind,capabilities:[kind==='text'?'chat':kind==='image'?'text-to-image':'text-to-video'],creditCost:7,resolutions:['720P'],setDefault:false};
        const synced=await api(prefix+'/models/sync',input);
        assert.equal(synced.added,1);
        const created=(await api('/config/model/listModelConfigs')).modelConfigs.find(m=>m.modelName===models[i]);
        assert.ok(created); gatewayModels.push(created);
        const repeat=await api(prefix+'/models/sync',{...input,creditCost:99});
        assert.equal(repeat.retained,1);
        const preserved=(await api('/config/model/listModelConfigs')).modelConfigs.find(m=>m.id===created.id);
        if(kind==='video') assert.equal(preserved.videoBillingConfiguration.modePrices['text-to-video']['720p'],7);
        else assert.equal(preserved.creditCost,7);
    }
    const relay=await fetch('http://127.0.0.1:'+(env.NEWAPI_PORT||3005)+'/v1/chat/completions',{
        method:'POST', headers:{Authorization:'Bearer '+env.NEWAPI_RELAY_KEY,'Content-Type':'application/json'},
        body:JSON.stringify({model:models[0],messages:[{role:'user',content:'test'}],max_tokens:16})
    });
    const relayBody=await relay.json();
    assert.equal(relay.status,200, 'relay failed: '+(relayBody.error?.message||relay.status));
    assert.equal(relayBody.choices[0].message.content,'New API relay verified'); assert.equal(chatCalls,1);
    await api('/config/channel/createChannel',{id:sourceId,name:name+' migration',baseUrl:draft.baseUrl,apiKey:upstreamKey,apiFormat:'openai',models:[models[0]],sortOrder:37});
    const sourceModel=await api('/config/model/createModelConfig',{channelId:sourceId,modelName:models[0],modelType:'text',capabilities:['chat','vision'],sortOrder:3,creditCost:23,thinkingEnabled:false,reasoningEffort:'high',creditUnit:'generation',requestConcurrency:5});
    assert.ok(sourceModel);
    await api(prefix+'/import',{channelId:sourceId});
    await api(prefix+'/import',{channelId:sourceId});
    assert.equal((await api(prefix+'/channels?keyword='+encodeURIComponent(name+' migration'))).total,1);
    importId=(await api(prefix+'/channels?keyword='+encodeURIComponent(name+' migration'))).items[0]?.id;
    assert.ok(importId);
    assert.equal((await api(prefix+'/importable')).find(c=>c.id===sourceId).migrated,true);
    const migrated=(await api('/config/model/listModelConfigs')).modelConfigs.find(m=>m.id===sourceModel.id);
    assert.equal(migrated.creditCost,23); assert.deepEqual(migrated.capabilities,['chat','vision']);
    await api(prefix+'/restore',{channelId:sourceId});
    const restored=(await api('/config/channel/listChannels')).channels.find(c=>c.id===sourceId);
    assert.equal(restored.baseUrl,draft.baseUrl); assert.equal(restored.apiKey,upstreamKey);
    assert.deepEqual((await api('/config/model/listModelConfigs')).modelConfigs.filter(m=>m.defaultModel).map(m=>m.id).sort(), defaultsBefore);
    console.log('PASS: anonymous access denied; connection; CRUD; secret redaction; pagination; model fetch; enable/disable; text/image/video sync; repeat sync preserves pricing; real HTTP relay; migration and restore preserve IDs, capabilities and defaults.');
} finally {
    const channels=token ? await api('/config/channel/listChannels').catch(()=>({channels:[]})) : {channels:[]};
    for(const m of gatewayModels) await api('/config/model/deleteModelConfig',{id:m.id}).catch(()=>{});
    for(const c of channels.channels.filter(c=>c.id.startsWith('studio-newapi-'))) {
        const remaining=c.models.filter(m=>!m.startsWith('NewAPI-QA-'));
        if (remaining.length!==c.models.length) {
            if(remaining.length) await api('/config/channel/updateChannel',{...c,models:remaining}).catch(()=>{});
            else await api('/config/channel/deleteChannel',{channelId:c.id}).catch(()=>{});
        }
    }
    if(token) {
        const imported=await api(prefix+'/importable').catch(()=>[]);
        if(imported.find(c=>c.id===sourceId)?.migrated) await api(prefix+'/restore',{channelId:sourceId}).catch(()=>{});
        await api('/config/channel/deleteChannel',{channelId:sourceId}).catch(()=>{});
        const fixtures=await api(prefix+'/channels?keyword='+encodeURIComponent(name)).catch(()=>({items:[]}));
        for(const row of fixtures.items) await api(prefix+'/channels/delete',{id:row.id}).catch(()=>{});
    }
    await new Promise(resolve=>mock.close(resolve));
}
