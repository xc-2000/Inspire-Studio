import test from 'node:test';
import assert from 'node:assert/strict';
import * as plugin from './arcads-video.mjs';
const base = {baseUrl:'https://arcads.example/v1',apiKey:'test-key',model:'minimax-h3'};
const request = {model:'minimax-h3',prompt:'A paper boat drifts across a lake',seconds:'5',resolution:'720p',metadata:{aspect_ratio:'16:9'}};
test('native audio defaults on for every model and preserves explicit JSON and multipart booleans', () => {
    for (const model of plugin.meta.models) {
        for (const mode of ['text-to-video', 'image-to-video']) {
            const requestBody = {prompt: request.prompt, seconds: 8, video_generation_mode: mode,
                ...(mode === 'image-to-video' ? {input_reference: 'https://example.com/frame.png'} : {})};
            const body = plugin.buildSubmitRequest({...base, model, requestBody}).body;
            assert.equal(body.generate_audio, true);
            assert.equal(body.resolution, '480p');
        }
    }
    for (const value of [true, false, 'true', 'false', 1, 0]) {
        const expected = [true, 'true', 1].includes(value);
        for (const body of [
            {kind:'json', value:{...request, generate_audio:value}},
            {kind:'multipart', fields:{prompt:[request.prompt],seconds:['5'],generate_audio:[String(value)]}}
        ]) {
            const requestBody = decode(body);
            assert.equal(plugin.buildSubmitRequest({...base, requestBody}).body.generate_audio, expected);
        }
    }
    assert.equal(plugin.buildSubmitRequest({...base, requestBody:{...request, options:{with_audio:false}}}).body.generate_audio, false);
    assert.throws(() => plugin.buildSubmitRequest({...base, requestBody:{...request,generate_audio:'invalid'}}));
});
function decode(body){return plugin.protocols.openai_video.decodeRequest({...base,body}).requestBody;}
test('Studio multipart file becomes a JSON input_reference instead of losing the uploaded image',()=>{
    const req=decode({kind:'multipart',fields:{prompt:[request.prompt],seconds:['5'],resolution:['720p'],metadata:[JSON.stringify(request.metadata)],images:['["https://stale.example/image.png"]'],video_generation_mode:['image-to-video']},files:[{field:'image',ref:'upload-1'}]});
    const upstream=plugin.buildSubmitRequest({...base,requestBody:req});
    assert.equal(upstream.url,'https://arcads.example/v1/videos');
    assert.deepEqual(upstream.body.input_reference,{__fileRef:'upload-1',encoding:'dataUrl',maxBytes:26214400});
    assert.equal(upstream.body.seconds,'5');assert.equal(upstream.body.size,'1280x720');
    assert.equal(upstream.body.reference_images,undefined);
});
test('reference mode preserves every image and is separate from the first-frame input',()=>{
    const images=['https://a.example/one.png','https://a.example/two.png'];
    const upstream=plugin.buildSubmitRequest({...base,requestBody:{...request,images,video_generation_mode:'reference-to-video'}});
    assert.deepEqual(upstream.body.reference_images,images);assert.equal(upstream.body.input_reference,undefined);
});
test('all video models retain their exact supported endpoint and duration',()=>{
    const cases=[['kling-3.0',3,'1080p'],['minimax-h3',15,'720p'],['minimax-h3-max',5,'720p'],['seedance',12,'720p'],['seedance-2.0',15,'720p'],['seedance-2.0-mini',4,'720p'],['seedance-2.5',30,'720p'],['veo-3.1',8,'720p'],['wan-3.0',30,'720p'],['grok-video',1,'720p']];
    for(const [model,seconds,resolution] of cases){
        const upstream=plugin.buildSubmitRequest({...base,model,requestBody:{...request,seconds,resolution,metadata:{aspect_ratio:'9:16'}}});
        assert.equal(upstream.body.seconds,String(seconds));assert.equal(upstream.body.model,model);
        assert.equal(upstream.body.size,resolution==='1080p'?'1080x1920':'720x1280');
    }
});
test('new Seedance models support text, first-image and nine-image reference input within 4-15 seconds',()=>{
    for(const model of ['seedance-2.0','seedance-2.0-mini']) {
        assert.ok(plugin.meta.models.includes(model));
        const context={...base,model};
        for(const seconds of [4,15]) {
            const body={...request,seconds,model};
            assert.equal(plugin.buildSubmitRequest({...context,requestBody:body}).body.model,model);
            assert.equal(plugin.buildSubmitRequest({...context,requestBody:{...body,video_generation_mode:'image-to-video',images:['https://example.com/first.png']}}).body.input_reference,'https://example.com/first.png');
            const images=Array.from({length:9},(_,i)=>`https://example.com/${i}.png`);
            assert.deepEqual(plugin.buildSubmitRequest({...context,requestBody:{...body,video_generation_mode:'reference-to-video',images}}).body.reference_images,images);
            assert.throws(()=>plugin.buildSubmitRequest({...context,requestBody:{...body,video_generation_mode:'reference-to-video',images:[...images,'extra']}}));
        }
        for(const seconds of [3,16]) assert.throws(()=>plugin.buildSubmitRequest({...context,requestBody:{...request,seconds}}));
        assert.equal(plugin.buildSubmitRequest({...context,requestBody:{...request,resolution:'1080p'}}).body.size,'1920x1080');
    }
});
test('unsupported input is rejected before upstream charges or silently changes it',()=>{
    for(const patch of [{seconds:4},{resolution:'invalid'},{resolution:'2K'},{resolution:'4kp'},{resolution:'0p'},{resolution:'99999999999p'},{size:'0x480'},{video_generation_mode:'first-last-frame-to-video'}, {videos:['https://a.example/video.mp4']},{audio:Array(4).fill('https://a.example/audio.mp3')},{images:['a','b'],video_generation_mode:'image-to-video'}]){
        assert.throws(()=>plugin.buildSubmitRequest({...base,requestBody:{...request,...patch}}));
    }
    assert.throws(()=>plugin.buildSubmitRequest({...base,model:'veo-3.1',requestBody:request}));
    assert.throws(()=>plugin.buildSubmitRequest({...base,model:'grok-video',requestBody:{...request,images:['a'],video_generation_mode:'reference-to-video'}}));
});
test('every Arcads model forwards configured resolution without a fixed 720P/1080P restriction',()=>{
    const cases=[['480p',480,854],['720p',720,1280],['768p',768,1366],['1080p',1080,1920]];
    for(const model of plugin.meta.models) for(const [resolution,short,long] of cases) {
        for(const [ratio,size] of [['16:9',long+'x'+short],['9:16',short+'x'+long]]) {
            const body=plugin.buildSubmitRequest({...base,model,requestBody:{...request,seconds:8,resolution,metadata:{aspect_ratio:ratio}}}).body;
            assert.equal(body.resolution,resolution,model+' '+resolution);
            assert.equal(body.size,size,model+' '+ratio);
        }
    }
});
test('480P multipart first frame and JSON reference images retain resolution and input',()=>{
    const context={...base,model:'seedance-2.0-mini'};
    const req=decode({kind:'multipart',fields:{prompt:[request.prompt],seconds:['5'],resolution:['480P'],size:['16:9'],video_generation_mode:['image-to-video']},files:[{field:'input_reference',ref:'480p-frame'}]});
    const body=plugin.buildSubmitRequest({...context,requestBody:req}).body;
    assert.equal(body.resolution,'480p');assert.equal(body.size,'854x480');
    assert.deepEqual(body.input_reference,{__fileRef:'480p-frame',encoding:'dataUrl',maxBytes:26214400});
    const json=decode({kind:'json',value:{...request,resolution:'480p',images:['https://example.com/a.png','https://example.com/b.png'],video_generation_mode:'reference-to-video'}});
    const reference=plugin.buildSubmitRequest({...context,requestBody:json}).body;
    assert.equal(reference.size,'854x480');assert.equal(reference.resolution,'480p');
    assert.deepEqual(reference.reference_images,json.images);
});
test('explicit resolution overrides stale dimensions; size-only requests and auto remain usable',()=>{
    const submit=patch=>plugin.buildSubmitRequest({...base,requestBody:{...request,...patch}}).body;
    assert.equal(submit({resolution:'480p',size:'1920x1080'}).size,'854x480');
    assert.equal(submit({resolution:undefined,size:'854x480'}).resolution,'480p');
    assert.equal(submit({resolution:undefined,resolution_name:' 1080P '}).size,'1920x1080');
    assert.equal(submit({resolution:'768'}).resolution,'768p');
    assert.equal(submit({resolution:'auto'}).resolution,'auto');
    assert.equal(submit({resolution:undefined}).size,'854x480');
});
test('every Arcads video defaults to 480P when the caller omits resolution',()=>{
    for (const model of plugin.meta.models) for (const ratio of ['16:9','9:16']) {
        for (const mode of ['text-to-video','image-to-video']) {
            const body=plugin.buildSubmitRequest({...base,model,requestBody:{prompt:request.prompt,seconds:8,size:ratio,video_generation_mode:mode,
                ...(mode==='image-to-video'?{input_reference:'https://example.com/frame.png'}:{})}}).body;
            assert.equal(body.resolution,'480p');
            assert.equal(body.size,ratio==='16:9'?'854x480':'480x854');
            if (mode==='image-to-video') assert.equal(body.input_reference,'https://example.com/frame.png');
        }
    }
});
test('query and content use the stored upstream task and surface failures',()=>{
    assert.equal(plugin.parseSubmitResponse({}, {body:{id:'video_1',seconds:'5'}}).taskId,'video_1');
    assert.equal(plugin.buildQueryRequest({...base,taskId:'video_1'}).url,'http://newapi-video-helper:8090/arcads/tasks/video_1');
    assert.equal(plugin.parseTaskResult({}, {status:'failed',error:{message:'No available account'}}).reason,'No available account');
    assert.deepEqual(plugin.listArtifacts({status:'SUCCESS'}),[{key:'video',type:'video'}]);
    const content=plugin.buildContentRequest({...base,artifactKey:'video',upstreamTaskId:'video_1',clientRequest:{method:'GET'},data:{video_url:'https://cdn.example/video.mp4'}});
    assert.equal(content.url,'https://cdn.example/video.mp4'); assert.equal(content.credentialless,true); assert.equal(content.headers,undefined);
});
