import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {localClients} from './lib/newapi-local.mjs';
import {meta} from '../newapi/plugins/capcut-video.mjs';
const {admin,env,close}=await localClients({studioSession:false});
const folder=new URL('../outputs/capcut-install/',import.meta.url);
const fields=['id','name','type','base_url','models','group','priority','weight','model_mapping','setting'];
let previous,changed=false;
try {
    const channelId=Number(env.CAPCUT_CHANNEL_ID);
    assert.ok(Number.isSafeInteger(channelId) && channelId>0,'Set CAPCUT_CHANNEL_ID in .env');
    assert.ok(env.NEWAPI_CAPCUT_ORIGIN,'Set NEWAPI_CAPCUT_ORIGIN in .env');
    const channel=await admin('/api/channel/'+channelId);
    assert.equal(channel.base_url.replace(/\/+$/,''),env.NEWAPI_CAPCUT_ORIGIN.replace(/\/+$/,''));
    assert.ok([1,61].includes(channel.type));
    assert.deepEqual(channel.models.split(',').sort(),[...meta.models].sort());
    previous=Object.fromEntries(fields.map(k=>[k,channel[k]]));
    await mkdir(folder,{recursive:true});
    await writeFile(new URL('channel-before.json',folder),JSON.stringify(previous,null,2),{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const source=await readFile(new URL('../newapi/plugins/capcut-video.mjs',import.meta.url),'utf8');
    await admin('/api/plugin/task',{source,enabled:true,remark:'CapCut multipart image upload and aspect ratio bridge'});
    await admin('/api/plugin/task/'+meta.key+'/activate',{version:meta.version});
    const options=await admin('/api/option/');
    const ports=new Set(JSON.parse(options.find(o=>o.key==='fetch_setting.allowed_ports')?.value||'["80","443","8080","8443"]'));
    ports.add(new URL(channel.base_url).port || (new URL(channel.base_url).protocol==='https:'?'443':'80'));
    await admin('/api/option/',{key:'fetch_setting.allowed_ports',value:JSON.stringify([...ports])},'PUT');
    const setting={...JSON.parse(channel.setting||'{}'),task_plugin_key:meta.key};
    await admin('/api/channel/',{...previous,type:61,setting:JSON.stringify(setting)},'PUT');changed=true;
    const result=await admin('/api/channel/'+channelId);
    assert.equal(result.type,61);assert.equal(JSON.parse(result.setting).task_plugin_key,meta.key);
    console.log(JSON.stringify({channelId,plugin:meta.key,version:meta.version,models:meta.models}));
} catch(error) {
    if(changed) await admin('/api/channel/',previous,'PUT');
    throw error;
} finally {await close();}
