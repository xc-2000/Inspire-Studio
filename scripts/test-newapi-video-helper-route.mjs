// Verifies the real gateway -> helper route; invalid image bytes stop before any supplier request.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {localClients} from './lib/newapi-local.mjs';
const {admin,env}=await localClients();
const template=await readFile(new URL('../newapi/plugins/video-adapter.mjs',import.meta.url),'utf8');
const key='qa-bridge-'+Date.now().toString(36), model=key+'-mini';
let channelId;
try {
    await admin('/api/plugin/task',{source:'const config = '+JSON.stringify({key,name:key,protocol:'openai-video-json',models:[model]})+';\n'+template,enabled:true});
    await admin('/api/channel/',{mode:'single',channel:{name:key,type:61,key:'qa-no-supplier-credential',base_url:env.NEWAPI_LUMINA_UPLOAD_ORIGIN+'/openai',
        models:model,group:'default',status:1,setting:JSON.stringify({task_plugin_key:key})}});
    channelId=(await admin('/api/channel/search?keyword='+key+'&p=1&page_size=100')).items[0].id;
    const form=new FormData();
    for(const [k,v] of Object.entries({model,prompt:'verify helper rejects invalid image',seconds:'8',resolution:'480p',images:JSON.stringify(['https://example.invalid/reference.png'])}))form.append(k,v);
    form.append('image',new Blob([Buffer.from('invalid image')],{type:'image/png'}),'reference.png');
    const response=await fetch('http://127.0.0.1:'+(env.NEWAPI_PORT||3005)+'/v1/videos',{method:'POST',headers:{Authorization:'Bearer '+env.NEWAPI_RELAY_KEY},body:form,signal:AbortSignal.timeout(45000)});
    const result=await response.json();
    assert.equal(response.status,400,JSON.stringify(result));
    assert.match(JSON.stringify(result),/unsupported image format/i);
    console.log('PASS: real New API -> internal helper; invalid reference rejected before supplier submission.');
} finally {
    if(channelId) await admin('/api/channel/'+channelId,undefined,'DELETE');
    await admin('/api/plugin/task/'+key+'/versions/1.0.1?force=true',undefined,'DELETE');
}
