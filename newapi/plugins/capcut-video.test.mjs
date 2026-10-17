import test from 'node:test';
import assert from 'node:assert/strict';
import * as plugin from './capcut-video.mjs';
import {createCapcutVideo} from '../helper/server.mjs';
import sharp from '../helper/node_modules/sharp/dist/index.mjs';

const config = {base:'http://capcut.example:8001/v1',capcutOrigin:'http://capcut.example:8001',apiKey:'test-only'};
test('Studio multipart file becomes actual CapCut multipart bytes with the chosen ratio',async()=>{
    const image=await sharp({create:{width:4,height:4,channels:3,background:'#369'}}).png().toBuffer();
    const decoded=plugin.protocols.openai_video.decodeRequest({model:'Seedance 2.5',body:{kind:'multipart',fields:{model:['Seedance 2.5'],prompt:['animate'],seconds:['5'],resolution:['720p'],metadata:['{"aspect_ratio":"9:16"}'],video_generation_mode:['image-to-video'],images:['["https://example.com/old-url.png"]']},files:[{field:'image',ref:'image-0'}]}});
    const request=plugin.buildSubmitRequest({...config,model:decoded.model,requestBody:decoded.requestBody});
    assert.equal(request.body.ratio,'9:16');assert.equal(request.body.input_reference.__fileRef,'image-0');
    await createCapcutVideo({...request.body,input_reference:'data:image/png;base64,'+image.toString('base64')},{...config,request:async(url,options)=>{
        const req=new Request(url,options);assert.match(req.headers.get('content-type'),/^multipart\/form-data; boundary=/);
        const form=await req.formData();assert.equal(form.get('ratio'),'9:16');assert.equal(form.get('seconds'),'5');
        assert.deepEqual(Buffer.from(await form.get('input_reference').arrayBuffer()),image);
        assert.equal(url,'http://capcut.example:8001/v1/videos');return new Response('{"id":"video_1"}');
    }});
});
test('CapCut text input preserves mode and ratio; unsupported references are never silently dropped',async()=>{
    const ctx={model:'Seedance 2.5',baseUrl:config.base,apiKey:'test-only',requestBody:{prompt:'test',seconds:5,resolution:'720p',metadata:{aspect_ratio:'16:9'},video_generation_mode:'text-to-video'}};
    assert.equal(plugin.buildSubmitRequest(ctx).body.ratio,'16:9');
    assert.throws(()=>plugin.buildSubmitRequest({...ctx,requestBody:{...ctx.requestBody,video_generation_mode:'image-to-video'}}),/不匹配/);
    assert.throws(()=>plugin.buildSubmitRequest({...ctx,requestBody:{...ctx.requestBody,video_generation_mode:'first-last-frame-to-video',images:['a','b']}}),/一张/);
    await assert.rejects(createCapcutVideo({input_reference:'https://example.com/image.png'},config),/图片文件/);
    await assert.rejects(createCapcutVideo({},{...config,base:'http://wrong.example'}),/未配置/);
    const content=plugin.buildContentRequest({artifactKey:'video',data:{source_url:'https://cdn.example/result.mp4'},clientRequest:{method:'GET'}});
    assert.equal(content.credentialless,true);assert.equal(content.headers,undefined);
});
