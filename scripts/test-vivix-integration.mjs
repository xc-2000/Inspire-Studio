// Real generation is opt-in: --generate MODEL [--mode text-to-video|image-to-video]
// Resume an existing test without generating again: --task TASK_ID
import assert from 'node:assert/strict';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {localClients} from './lib/newapi-local.mjs';
const [action,value,modeFlag,mode] = process.argv.slice(2);
assert.ok((action === '--generate' && ['vivix-w1-ultrafast','vivix-w1-fast'].includes(value)) || (action === '--task' && value));
assert.ok(modeFlag === undefined || (action === '--generate' && modeFlag === '--mode' && ['text-to-video','image-to-video'].includes(mode)), 'Use --mode text-to-video or --mode image-to-video');
const {studio,close} = await localClients({adminSession:false});
try {
    let task;
    if (action === '--task') task = await studio('/ai/task/getTaskInfo?taskId=' + encodeURIComponent(value));
    else {
        const imageMode = mode ? mode === 'image-to-video' : value === 'vivix-w1-fast';
        const image = imageMode ? await readFile(new URL('../web/public/styles/generated/style-8.webp', import.meta.url)) : null;
        let reference;
        if (image) {
            const form = new FormData();
            form.set('file',new Blob([image],{type:'image/webp'}),'city-chase.webp');
            form.set('kind','image'); form.set('mimeType','image/webp');
            const media = await studio('/media/uploadMedia',form);
            reference = {id:'vivix-reference',name:'city-chase.webp',mimeType:'image/webp',role:'first_frame',storageKey:media.storageKey,url:media.url};
        }
        task = await studio('/ai/task/createTask', {taskType:'video',model:'studio-newapi-video::'+value,
            prompt:imageMode
                ? '保持参考图里的人物身份、服装和老城石阶场景一致。男子抱着石雕沿台阶向前跑，小狗跟着奔跑，后面两人追赶；镜头平稳后退跟拍，日光穿过树叶，动作自然连贯，5秒，无字幕。'
                : '5秒电影镜头：清晨金色湖面上，一只红色纸船随涟漪轻轻向前漂动，镜头缓慢贴近水面跟随，倒影清晰，远处白鹭掠过水面，真实柔和晨光，画面连续，无字幕。',
            parameters:{seconds:5,resolution:'720P',size:imageMode?'3:4':'16:9'},
            references:reference?[reference]:[],
            videoGenerationMode:imageMode?'image-to-video':'text-to-video',generationSource:'videoPage'});
    }
    const taskId=task.id;
    assert.ok(taskId);
    console.log(JSON.stringify({taskId,model:task.model,status:task.status}));
    await mkdir(new URL('../tmp/vivix-integration/',import.meta.url),{recursive:true});
    const report=new URL('../tmp/vivix-integration/'+taskId+'.json',import.meta.url);
    await writeFile(report,JSON.stringify({taskId,model:task.model,status:task.status},null,2));
    const deadline=Date.now()+20*60*1000;
    let previous='';
    while(!['succeeded','success','completed','failed','cancelled'].includes(task.status)){
        if(Date.now()>deadline) throw Error('Still pending; resume with --task '+taskId);
        await new Promise(resolve=>setTimeout(resolve,10000));
        task=await studio('/ai/task/getTaskInfo?taskId='+encodeURIComponent(taskId));
        const state=task.status+':'+task.progress;
        if(state!==previous){console.log(JSON.stringify({taskId,status:task.status,progress:task.progress}));previous=state;}
    }
    const result=typeof task.resultData==='string'?JSON.parse(task.resultData):task.resultData;
    const item=result?.item || result?.items?.[0];
    await writeFile(report,JSON.stringify({taskId,model:task.model,status:task.status,errorMessage:task.errorMessage,result},null,2));
    assert.ok(['succeeded','success','completed'].includes(task.status),task.errorMessage || 'Generation did not succeed');
    assert.ok(item?.storageKey && item?.url,'Generated video must be persisted');
    assert.ok(item.bytes>0 && item.durationMs>0);
    console.log(JSON.stringify({taskId,status:task.status,stored:true,width:item.width,height:item.height,durationMs:item.durationMs,bytes:item.bytes}));
} finally {await close();}
