// Patch only native audio forwarding in installed plugins; keep routes, models and prices intact.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {localClients} from './lib/newapi-local.mjs';

const {admin,close}=await localClients({studioSession:false});
const digest=value=>createHash('sha256').update(value).digest('hex');
const template=await readFile(new URL('../newapi/plugins/arcads-video.mjs',import.meta.url),'utf8');
const helper=template.slice(template.indexOf('function nativeAudio(req)'),template.indexOf('function list(value)'));
assert.ok(helper.startsWith('function nativeAudio(req)'));
const folder=new URL('../outputs/native-video-audio-'+new Date().toISOString().replace(/[:.]/g,'-')+'/',import.meta.url);
const changed=[];
const channelConfig=channel=>Object.fromEntries(['id','name','type','base_url','models','group','status','priority','weight','model_mapping','setting']
    .map(key=>[key,channel[key]]));
try {
    const channelId=Number(process.env.ARCADS_CHANNEL_ID||42);
    const channelBefore=await admin('/api/channel/'+channelId);
    const installed=await admin('/api/plugin/task');
    await mkdir(folder,{recursive:true});
    const results=[];
    for(const key of ['studio-arcads','studio-openai-video-json']) {
        if(!installed.some(p=>p.meta.key===key)) continue;
        const previous=await admin('/api/plugin/task/'+key);
        let source=previous.source;
        if(!source.includes('function nativeAudio(req)')) {
            await writeFile(new URL(key+'-before.mjs',folder),source);
            const marker=key==='studio-arcads'?'function list(value)':'function array(value)';
            assert.ok(source.includes(marker));
            source=source.replace(marker,helper+marker);
            if(key==='studio-arcads') {
                const before='const body = { model, prompt: req.prompt, seconds: String(seconds), ...videoSize(req, policy, ratio) };';
                assert.ok(source.includes(before),'Arcads source changed; review audio mapping before upgrading');
                source=source.replace(before,'const body = { model, prompt: req.prompt, seconds: String(seconds), generate_audio: nativeAudio(req), ...videoSize(req, policy, ratio) };');
                source=source.replace(/version: '[^']+'/,"version: '1.5.0+"+digest(source).slice(0,12)+"'");
            } else {
                const before='with_audio: object(req.options).with_audio === undefined ? true : req.options.with_audio';
                assert.ok(source.includes(before),'Seedance JSON source changed; review audio mapping before upgrading');
                source=source.replace(before,'with_audio: nativeAudio(req)');
                const firstLine=source.slice(0,source.indexOf('\n'));
                assert.ok(firstLine.startsWith('const config = '));
                const config=JSON.parse(firstLine.slice('const config = '.length).replace(/;\s*$/,''));
                config.version='1.5.0+'+digest(source).slice(0,12);
                source='const config = '+JSON.stringify(config)+';'+source.slice(source.indexOf('\n'));
                source=source.replace(/version: '[^']+'/, 'version: config.version');
            }
            await writeFile(new URL(key+'-rollback.json',folder),JSON.stringify({key,version:previous.plugin.version},null,2));
            assert.equal(typeof previous.plugin.enabled,'boolean');
            await admin('/api/plugin/task',{source,enabled:previous.plugin.enabled,remark:'Default native video audio on; preserve model-specific schema'});
            changed.push({key,version:previous.plugin.version});
            const version=key==='studio-arcads'?source.match(/version: '([^']+)'/)[1]:JSON.parse(source.split('\n')[0].slice('const config = '.length).replace(/;\s*$/,'')).version;
            await admin('/api/plugin/task/'+key+'/activate',{version});
        }
        const active=await admin('/api/plugin/task/'+key);
        assert.equal(active.plugin.enabled,previous.plugin.enabled);
        const candidates=key==='studio-arcads'?['seedance-2.0','seedance-2.0-mini']:['Doubao-Seedance-2.0-mini'];
        let checks=0;
        for(const model of candidates) for(const mode of ['text-to-video','image-to-video']) for(const audio of [undefined,true,false,'false']) {
            const requestBody={prompt:'Native audio parameter verification',seconds:5,video_generation_mode:mode,
                ...(mode==='image-to-video'?{images:['https://example.invalid/frame.png']}:{}),
                ...(audio===undefined?{}:{generate_audio:audio})};
            const result=await admin('/api/plugin/task/'+key+'/dryrun',{hook:'buildSubmitRequest',args:[{model,baseUrl:'https://example.invalid/v1',apiKey:'offline-test',requestBody}]});
            assert.equal(result.body[key==='studio-arcads'?'generate_audio':'with_audio'],audio!==false&&audio!=='false');
            assert.equal(result.body.resolution,'480p');
            checks++;
        }
        results.push({key,version:active.plugin.version,checks});
    }
    assert.deepEqual(channelConfig(await admin('/api/channel/'+channelId)),channelConfig(channelBefore),'Channel configuration changed');
    const report={plugins:results,channelConfigurationPreserved:true};
    await writeFile(new URL('verification.json',folder),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
} catch(error) {
    for(const previous of changed.reverse()) await admin('/api/plugin/task/'+previous.key+'/activate',{version:previous.version});
    throw error;
} finally { await close(); }
