// Upgrade only the Arcads protocol plugin. Keep administrator profiles, prices and routes intact.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {localClients} from './lib/newapi-local.mjs';
import {meta} from '../newapi/plugins/arcads-video.mjs';

const {admin,close}=await localClients({studioSession:false});
const digest=value=>createHash('sha256').update(value).digest('hex');
const fields=['id','name','type','base_url','models','group','status','priority','weight','model_mapping','setting'];
const config=channel=>Object.fromEntries(fields.map(key=>[key,channel[key]]));
const channelId=Number(process.env.ARCADS_CHANNEL_ID||42);
let previous,installed=false;
try {
    const before=await admin('/api/channel/'+channelId);
    assert.equal(JSON.parse(before.setting||'{}').task_plugin_key,meta.key);
    previous=await admin('/api/plugin/task/'+meta.key);
    assert.ok(previous.plugin.version);
    const template=await readFile(new URL('../newapi/plugins/arcads-video.mjs',import.meta.url),'utf8');
    const version='1.4.0+'+digest(template).slice(0,12);
    const folder=new URL('../outputs/arcads-resolutions-'+new Date().toISOString().replace(/[:.]/g,'-')+'/',import.meta.url);
    await mkdir(folder,{recursive:true});
    await writeFile(new URL('previous-plugin.mjs',folder),previous.source);
    await writeFile(new URL('rollback.json',folder),JSON.stringify({key:meta.key,version:previous.plugin.version,channelId,configurationHash:digest(JSON.stringify(config(before)))},null,2));
    await admin('/api/plugin/task',{source:template.replace("version: '1.0.0'","version: '"+version+"'"),enabled:true,remark:'Forward configured Arcads resolution and matching video dimensions; preserve uploaded references'});
    installed=true;
    await admin('/api/plugin/task/'+meta.key+'/activate',{version});
    const checks=[];
    for (const model of meta.models) checks.push(async()=>{
        const requestBody={prompt:'Offline default resolution verification',seconds:8,size:'16:9',video_generation_mode:'image-to-video',input_reference:'https://example.invalid/frame.png'};
        const result=await admin('/api/plugin/task/'+meta.key+'/dryrun',{hook:'buildSubmitRequest',args:[{model,baseUrl:'https://example.invalid/v1',apiKey:'offline-test',requestBody}]});
        assert.equal(result.body.resolution,'480p');assert.equal(result.body.size,'854x480');
        assert.equal(result.body.input_reference,requestBody.input_reference);
    });
    const resolutions=process.argv.includes('--defaults-only')?[]:[['480p','854x480'],['720p','1280x720'],['768p','1366x768'],['1080p','1920x1080']];
    for(const model of meta.models) for(const [resolution,size] of resolutions) {
        for(const mode of ['text-to-video','image-to-video','reference-to-video']) {
            if(mode==='reference-to-video'&&['kling-3.0','grok-video'].includes(model)) continue;
            checks.push(async()=>{
                const request={model,prompt:'Offline Arcads resolution verification',seconds:8,resolution,size:'16:9',video_generation_mode:mode};
                if(mode!=='text-to-video') request.images=['https://example.invalid/reference.png'];
                const result=await admin('/api/plugin/task/'+meta.key+'/dryrun',{hook:'buildSubmitRequest',args:[{model,baseUrl:'https://example.invalid/v1',apiKey:'offline-test',requestBody:request}]});
                assert.equal(result.body.resolution,resolution);assert.equal(result.body.size,size);
                assert.equal(result.body.model,model.toLowerCase());assert.equal(result.body.seconds,'8');
                if(mode==='image-to-video') assert.equal(result.body.input_reference,request.images[0]);
                if(mode==='reference-to-video') assert.deepEqual(result.body.reference_images,request.images);
            });
        }
    }
    for(let i=0;i<checks.length;i+=6) await Promise.all(checks.slice(i,i+6).map(check=>check()));
    assert.deepEqual(config(await admin('/api/channel/'+channelId)),config(before),'Channel configuration changed during verification');
    assert.equal((await admin('/api/plugin/task/'+meta.key)).plugin.version,version);
    const report={plugin:meta.key,version,channelId,gatewayChecks:checks.length,channelConfigurationPreserved:true,backup:folder.pathname};
    await writeFile(new URL('verification.json',folder),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
} catch(error) {
    if(installed&&previous) await admin('/api/plugin/task/'+meta.key+'/activate',{version:previous.plugin.version});
    throw error;
} finally {await close();}
