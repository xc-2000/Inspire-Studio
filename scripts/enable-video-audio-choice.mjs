// Preserve routing, defaults, billing and enabled states while adding audio references.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {localClients} from './lib/newapi-local.mjs';
import {execFileSync} from 'node:child_process';
const stdinAuth=process.argv.includes('--studio-auth-stdin');
const databaseMode=process.argv.includes('--studio-database');
const {admin,studio:localStudio,env,close}=await localClients({studioSession:!stdinAuth&&!databaseMode});
function databaseQuery(sql) {
 return execFileSync('docker',['exec','-i','inspirestudio-postgres','sh','-c','exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1'],{input:sql,encoding:'utf8'}).trim();
}
const sqlValue=value=>"'"+String(value).replaceAll("'","''")+"'";
let studioToken;
async function studio(path,body) {
 if(databaseMode) {
  if(path==='/config/model/listModelConfigs')return {modelConfigs:JSON.parse(databaseQuery(`SELECT COALESCE(json_agg(json_build_object('id',model_config_id,'modelName',model_name,'modelType',model_type,'capabilities',capabilities)),'[]'::json) FROM platform_ai_model_configs;`))};
  assert.equal(path,'/config/model/updateModelConfig');
  assert.ok(Array.isArray(body.capabilities));
  const changed=databaseQuery(`UPDATE platform_ai_model_configs SET capabilities=${sqlValue(JSON.stringify(body.capabilities))}::jsonb,updated_at=CURRENT_TIMESTAMP WHERE model_config_id=${sqlValue(body.id)} RETURNING model_config_id;`);
  assert.ok(changed.split('\n').includes(body.id),'Model disappeared during migration');
  return;
 }
 if(!stdinAuth)return localStudio(path,body);
 const r=await fetch('http://127.0.0.1:'+(env.WEB_PORT||5550)+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(studioToken?{Authorization:'Bearer '+studioToken}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
 const j=await r.json();if(!r.ok||j.code!==0)throw Error(path+': HTTP '+r.status+' code '+j.code);return j.data;
}
const supportsArcads=new Set(['minimax-h3','minimax-h3-max','seedance-2.0','seedance-2.0-mini','seedance-2.5','wan-3.0']);
const folder=new URL('../outputs/audio-choice-'+new Date().toISOString().replace(/[:.]/g,'-')+'/',import.meta.url);
const rollback=[];
const report={plugins:[],profiles:0,studioModels:0};
try {
 if(stdinAuth) { let input='';for await(const part of process.stdin)input+=part;studioToken=(await studio('/auth/login',JSON.parse(input))).token; }
 await mkdir(folder,{recursive:true});
 const template=await readFile(new URL('../newapi/plugins/video-adapter.mjs',import.meta.url),'utf8');
 const arcads=await readFile(new URL('../newapi/plugins/arcads-video.mjs',import.meta.url),'utf8');
 const all=await admin('/api/plugin/task');
 for(const key of ['studio-arcads','studio-vivix']) {
  assert.ok(all.some(p=>p.meta.key===key));
  const before=await admin('/api/plugin/task/'+key);
  await writeFile(new URL(key+'-before.mjs',folder),before.source);
  const version='1.6.0+'+createHash('sha256').update(key==='studio-arcads'?arcads:template).digest('hex').slice(0,12);
  let source;
  if(key==='studio-arcads') source=arcads.replace("version: '1.0.0'", "version: '"+version+"'");
  else {
   const line=before.source.split('\n')[0];
   assert.ok(line.startsWith('const config = '));
   const config=JSON.parse(line.slice(15).replace(/;\s*$/,''));
   config.version=version;
   source='const config = '+JSON.stringify(config)+';\n'+template;
   await writeFile(new URL('../newapi/generated/studio-vivix.js',import.meta.url),source);
  }
  await admin('/api/plugin/task',{source,enabled:before.plugin.enabled,remark:'Audio reference forwarding and user native sound choice'});
  rollback.push(()=>admin('/api/plugin/task/'+key+'/activate',{version:before.plugin.version}));
  await admin('/api/plugin/task/'+key+'/activate',{version});
  let checks=0;
  for(const audio of [undefined,true,false]) for(const ref of [false,true]) {
   const model=key==='studio-arcads'?'seedance-2.0':'vivix-w1-fast';
   const body={prompt:'Offline verification',seconds:5,size:'16:9',resolution:key==='studio-arcads'?'480p':'720p',generate_audio:audio,
    ...(ref?{audio:['https://example.invalid/ref.wav'],video_generation_mode:'reference-to-video'}:{})};
   const result=await admin('/api/plugin/task/'+key+'/dryrun',{hook:'buildSubmitRequest',args:[{model,baseUrl:'https://example.invalid',apiKey:'offline',requestBody:body}]});
   assert.equal(result.body.generate_audio,ref?false:audio!==false);
   if(ref) assert.deepEqual(result.body.reference_audios,body.audio);
   checks++;
  }
  report.plugins.push({key,version,checks});
 }
 const result=await admin('/api/channel/?p=0&page_size=100');
 const channels=Array.isArray(result)?result:result.items;
 const routingBefore=channels.map(c=>({id:c.id,status:c.status,models:c.models,priority:c.priority,weight:c.weight,group:c.group}));
 const eligible=new Set();
 for (const summary of channels.filter(c=>['arcads','vivix'].includes(c.name.toLowerCase()))) {
  const channel=await admin('/api/channel/'+summary.id);
  const setting=JSON.parse(channel.setting||'{}');
  const before=channel.setting;
  for(const [model,profile] of Object.entries(setting.studio_model_profiles||{})) {
   if(summary.name.toLowerCase()==='arcads'&&!supportsArcads.has(model.toLowerCase())) continue;
   eligible.add(model);
   if(!profile.capabilities?.includes('audio-input')) { profile.capabilities=[...(profile.capabilities||[]),'audio-input'];report.profiles++; }
  }
  if(JSON.stringify(setting)!==before) {
   await writeFile(new URL('channel-'+channel.id+'-setting.json',folder),before||'{}');
   const patch={id:channel.id,setting:JSON.stringify(setting)};
   await admin('/api/channel/',patch,'PUT');
   rollback.push(()=>admin('/api/channel/',{id:channel.id,setting:before},'PUT'));
  }
 }
 const beforeModels=(await studio('/config/model/listModelConfigs')).modelConfigs;
 await writeFile(new URL('model-capabilities-before.json',folder),JSON.stringify(beforeModels.map(m=>({id:m.id,capabilities:m.capabilities})),null,2));
 // Only alter Studio models whose active gateway route belongs to one of these channels.
 for(const m of beforeModels) {
  if(m.modelType!=='video'||!eligible.has(m.modelName)||m.capabilities?.includes('audio-input')) continue;
  const active=channels.filter(c=>c.status===1&&c.models.split(',').includes(m.modelName));
  if(!active.length||active.some(c=>!['arcads','vivix'].includes(c.name.toLowerCase()))) continue;
  await studio('/config/model/updateModelConfig',{...m,capabilities:[...(m.capabilities||[]),'audio-input']});
  rollback.push(()=>studio('/config/model/updateModelConfig',m));
  report.studioModels++;
 }
 const after=(await admin('/api/channel/?p=0&page_size=100'));
 assert.deepEqual((Array.isArray(after)?after:after.items).map(c=>({id:c.id,status:c.status,models:c.models,priority:c.priority,weight:c.weight,group:c.group})),routingBefore);
 await writeFile(new URL('verification.json',folder),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
} catch(error) {
 for(const undo of rollback.reverse()) await undo().catch(()=>console.error('Rollback needs review'));
 throw error;
} finally {await close();}
