import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = 'const config={key:"studio-vivix",name:"Vivix",protocol:"vivix",models:["vivix-w1-fast","vivix-w1-ultrafast"]};\n' + await readFile(new URL('./video-adapter.mjs', import.meta.url), 'utf8');
const plugin = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const ctx = {baseUrl:'https://vivix.example/v1',apiKey:'test-key',model:'vivix-w1-fast'};
const input = {prompt:'A paper boat crosses the lake',seconds:5,resolution:'720p',metadata:{aspect_ratio:'16:9'}};
const submit = body => plugin.buildSubmitRequest({...ctx,requestBody:{...input,...body}});

test('both models submit 720P with the correct duration, ratio and route', () => {
    for (const model of plugin.meta.models) for (const seconds of [5,15]) {
        const request = plugin.buildSubmitRequest({...ctx,model,requestBody:{...input,seconds}});
        assert.equal(request.url, 'https://vivix.example/v1/videos');
        assert.equal(request.body.model,model); assert.equal(request.body.seconds,seconds);
        assert.equal(request.body.size,'1280x720'); assert.equal(request.body.resolution,'720p');
        assert.equal(request.body.video_ratio,'16:9'); assert.equal(request.body.n,1);
    }
    assert.equal(submit({resolution:'720p',metadata:{aspect_ratio:'9:16'}}).body.size,'720x1280');
});
test('uploaded image replaces stale URLs and keeps the original multipart file reference', () => {
    const req = plugin.protocols.openai_video.decodeRequest({...ctx,body:{kind:'multipart',
        fields:{prompt:[input.prompt],seconds:['5'],resolution:['720p'],images:['["https://old.example/image.png"]'],video_generation_mode:['image-to-video']},
        files:[{field:'image',ref:'upload-1',filename:'reference.webp'}]}}).requestBody;
    const request = plugin.buildSubmitRequest({...ctx,requestBody:req});
    assert.equal(request.url,'http://newapi-video-helper:8090/vivix/videos');
    assert.equal(request.headers['X-Upstream-Base'],ctx.baseUrl);
    assert.deepEqual(request.body.input_reference,{__fileRef:'upload-1',encoding:'dataUrl',maxBytes:26214400});
    assert.ok(!JSON.stringify(request.body).includes('old.example'));
});
test('reference images and first/last frames are forwarded with distinct upstream fields', () => {
    const refs = ['https://img.example/last.png','https://img.example/first.png'];
    const result = submit({images:refs,video_generation_mode:'first-last-frame-to-video',reference_image_roles:['last_frame','first_frame']}).body;
    assert.equal(result.input_reference,refs[1]); assert.equal(result.last_frame_image,refs[0]);
    assert.equal(result.reference_images,undefined);
    const multi = submit({images:refs,video_generation_mode:'reference-to-video'}).body;
    assert.deepEqual(multi.reference_images,refs); assert.equal(multi.input_reference,undefined);
});
test('invalid duration, resolution, ratio and reference combinations fail before charging', () => {
    for(const patch of [{seconds:4},{seconds:16},{resolution:'480p'},{resolution:'1080p'},{metadata:{aspect_ratio:'21:9'}},
        {images:['a','b'],video_generation_mode:'image-to-video'}, {images:['a'],video_generation_mode:'first-last-frame-to-video'},
        {images:Array(6).fill('x'),video_generation_mode:'reference-to-video'}, {video_generation_mode:'image-to-video'},
        {images:['a'],video_generation_mode:'text-to-video'}, {audio:Array(4).fill('https://example/audio.mp3')}, {audio:['https://example/audio.mp3'],video_generation_mode:'text-to-video'}]) assert.throws(()=>submit(patch));
});
test('polling errors surface and downloading media never leaks credentials to another host', () => {
    assert.equal(plugin.buildQueryRequest({...ctx,taskId:'video_1'}).url,'https://vivix.example/v1/videos/video_1');
    assert.equal(plugin.parseTaskResult({}, {status:'failed',error:{message:'No available accounts'}}).reason,'No available accounts');
    assert.equal(plugin.parseTaskResult({}, {status:'completed'}).status,'SUCCESS');
    const download={...ctx,artifactKey:'video',upstreamTaskId:'video_1',clientRequest:{method:'GET'}};
    assert.equal(plugin.buildContentRequest({...download,data:{}}).headers.Authorization,'Bearer test-key');
    const remote=plugin.buildContentRequest({...download,data:{video_url:'https://media.example/video.mp4'}});
    assert.equal(remote.headers,undefined);assert.equal(remote.credentialless,true);
});
