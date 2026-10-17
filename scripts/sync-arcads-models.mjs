import assert from 'node:assert/strict';
import {localClients} from './lib/newapi-local.mjs';
import {arcadsImages,arcadsVideos,videoProfile} from './lib/arcads-models.mjs';
const {studio,close}=await localClients({adminSession:false});
try {
    const before=(await studio('/config/model/listModelConfigs')).modelConfigs;
    const defaults=before.filter(m=>m.isDefault).map(m=>m.id).sort();
    let added=0,retained=0;
    for(const [model,label] of arcadsImages) {
        const result=await studio('/admin/newapi/models/sync',{models:[model],modelType:'image',capabilities:['text-to-image','image-to-image'],creditCost:10,setDefault:false});
        added+=result.added;retained+=result.retained;
        if(result.added) {
            const config=(await studio('/config/model/listModelConfigs')).modelConfigs.find(m=>m.modelName===model&&m.modelType==='image');
            await studio('/config/model/updateModelConfig',{...config,displayName:label,newModel:true,requestConcurrency:5});
        }
    }
    for(const item of arcadsVideos) {
        const [model,label,,,resolution]=item,profile=videoProfile(item);
        const result=await studio('/admin/newapi/models/sync',{models:[model],modelType:'video',capabilities:profile.capabilities,creditCost:10,resolutions:[resolution.toUpperCase()],setDefault:false});
        added+=result.added;retained+=result.retained;
        if(result.added) {
            const config=(await studio('/config/model/listModelConfigs')).modelConfigs.find(m=>m.modelName===model&&m.modelType==='video');
            await studio('/config/model/updateModelConfig',{...config,...profile,displayName:label,newModel:true,requestConcurrency:5});
        }
    }
    const after=(await studio('/config/model/listModelConfigs')).modelConfigs;
    assert.deepEqual(after.filter(m=>m.isDefault).map(m=>m.id).sort(),defaults);
    console.log(JSON.stringify({added,retained,defaultsPreserved:true,models:after.filter(m=>[...arcadsImages,...arcadsVideos].some(([name])=>name===m.modelName)).map(({modelName,displayName,modelType})=>({modelName,displayName,modelType}))}));
}finally{await close();}
