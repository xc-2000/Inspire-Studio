import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createLuminaVideo, createVivixVideo, helperServer, arcadsTask } from './server.mjs';

test('Vivix uploads audio with its MIME type and preserves explicit sound choice',async()=>{
    const calls=[];
    const opts={base:'http://vivix.example:8787',vivixOrigin:'http://vivix.example:8787',apiKey:'test',request:async(url,options)=>{
        calls.push({url,options});
        return new Response(JSON.stringify(url.endsWith('/v1/files/audios')?{url:'https://media.example/ref.wav'}:{id:'test-video'}),{status:200});
    }};
    await createVivixVideo({resolution:'720p',generate_audio:false,reference_audios:['data:audio/wav;base64,UklGRg==']},opts);
    assert.equal(calls[0].options.body.get('file').type,'audio/wav');
    assert.equal(calls[0].url,'http://vivix.example:8787/v1/files/audios');
    const body=JSON.parse(calls[1].options.body);
    assert.deepEqual(body.reference_audios,['https://media.example/ref.wav']);
    assert.equal(body.generate_audio,false);
});

test('Vivix uploads original bytes before submitting URLs with ordered frame fields',async()=>{
    const image=Buffer.from('original-image-bytes'),ref='data:image/webp;base64,'+image.toString('base64'),calls=[];
    const opts={base:'http://vivix.example:8787/v1',vivixOrigin:'http://vivix.example:8787',apiKey:'vivix-key',request:async(url,options)=>{
        if(url.endsWith('/files/images')) {
            const req=new Request(url,options);
            assert.match(req.headers.get('content-type'),/^multipart\/form-data; boundary=/);
            const form=await req.formData(); calls.push({url,options,form});
            assert.deepEqual(Buffer.from(await form.get('file').arrayBuffer()),image);
            return new Response(JSON.stringify({url:'https://img.example/'+calls.length+'.webp'}));
        }
        calls.push({url,options,body:JSON.parse(options.body)});
        return new Response(JSON.stringify({id:'video_1'}));
    }};
    await createVivixVideo({model:'vivix-w1-fast',resolution:'720p',seconds:5,input_reference:ref,last_frame_image:ref},opts);
    assert.equal(calls[0].url,'http://vivix.example:8787/v1/files/images');
    assert.equal(calls[0].options.headers.Authorization,'Bearer vivix-key');
    assert.equal(calls[2].url,'http://vivix.example:8787/v1/videos');
    assert.equal(calls[2].body.input_reference,'https://img.example/1.webp');
    assert.equal(calls[2].body.last_frame_image,'https://img.example/2.webp');
    assert.equal(calls[2].body.resolution,'720p');
    await createVivixVideo({resolution:'720p',reference_images:[ref,ref]},opts);
    assert.deepEqual(calls[5].body.reference_images,['https://img.example/4.webp','https://img.example/5.webp']);
    await assert.rejects(createVivixVideo({resolution:'480p'},opts),/仅支持720P/);
    await assert.rejects(createVivixVideo({resolution:'720p'},{...opts,base:'http://other.example'}),/未配置/);
    await assert.rejects(createVivixVideo({resolution:'720p',input_reference:'bad'},opts),/格式无效/);
    assert.equal(calls.length,6);
    let attempted = 0;
    await assert.rejects(createVivixVideo({resolution:'720p',input_reference:ref},{...opts,request:async()=>{attempted++;return new Response('{}',{status:503});}}),/上传失败/);
    assert.equal(attempted,1);
});

test('Arcads queries status and resolves the signed URL without following it with the API key',async()=>{
    const calls=[];
    const opts={base:'http://arcads.example:5000/v1',arcadsOrigin:'http://arcads.example:5000',authorization:'Bearer secret',
        request:async(url,options)=>{calls.push({url,options});return url.endsWith('/content')
            ?new Response(null,{status:302,headers:{location:'https://cdn.example/video.mp4?signature=test'}})
            :new Response(JSON.stringify({status:'completed',seconds:'5'}));}};
    const result=await arcadsTask('video_1',opts);
    assert.equal(result.video_url,'https://cdn.example/video.mp4?signature=test');
    assert.equal(calls.length,2);
    assert.ok(calls.every(c=>new URL(c.url).origin===opts.arcadsOrigin&&c.options.redirect==='manual'));
    await assert.rejects(arcadsTask('video_1',{...opts,base:'http://other.example'}),/未配置/);
    await assert.rejects(arcadsTask('../other',opts),/无效/);
    assert.equal(calls.length,2);
});

test('uploads reference files, preserves frame order and separates both credentials',async()=>{
    const image=await sharp({create:{width:2,height:2,channels:3,background:'#369'}}).webp().toBuffer();
    const file='data:image/webp;base64,'+image.toString('base64'), calls=[];
    const request=async(url,opts)=>{calls.push({url,opts});return new Response(JSON.stringify(url.endsWith('/media/images')?{uri:'internal-'+calls.length}:{id:'video-1'}),{status:200});};
    await createLuminaVideo({model:'mini',first_prompt_pic:'https://cdn.example/first',last_prompt_pic:'https://cdn.example/last',_image_files:[file,file]},
        {base:'http://supplier.example/openai',apiKey:'api-only',uploadOrigin:'http://supplier.example',uploadToken:'upload-only',request});
    assert.equal(calls.length,3);
    assert.equal(calls[0].opts.headers.Authorization,'Bearer upload-only');
    assert.equal(calls[0].opts.headers['Content-Type'],'image/png');
    assert.equal((await sharp(calls[0].opts.body).metadata()).format,'png');
    assert.equal(calls[2].opts.headers.Authorization,'Bearer api-only');
    assert.deepEqual(JSON.parse(calls[2].opts.body),{model:'mini',first_prompt_pic:'internal-1',last_prompt_pic:'internal-2'});
});
test('rejects origin changes and stops before generation on failed upload',async()=>{
    const opts={base:'http://other.example/openai',apiKey:'key',uploadOrigin:'http://supplier.example',uploadToken:'secret',request:()=>{throw Error('unexpected call');}};
    await assert.rejects(createLuminaVideo({},opts),/不一致/);
    await assert.rejects(createLuminaVideo({media_urls:['https://example.com/file']},{...opts,base:'http://supplier.example/openai'}),/multipart/);
    const image=await sharp({create:{width:2,height:2,channels:3,background:'#369'}}).png().toBuffer();
    const calls=[];
    await assert.rejects(createLuminaVideo({media_urls:['https://example.com/file'],_image_files:['data:image/png;base64,'+image.toString('base64')]},
        {...opts,base:'http://supplier.example/openai',request:async(url)=>{calls.push(url);return new Response('{}',{status:503});}}),/上传失败/);
    assert.deepEqual(calls,['http://supplier.example/v1/media/images']);
});

test('AutoDL helper preserves raw authentication and wraps the success envelope for plugin parsing',async()=>{
    const calls=[], upstream={code:'success',data:{status:'completed',results:[{url:'https://cdn.example/video.mp4'}]}};
    const server=helperServer({request:async(url,opts)=>{calls.push({url,opts});return new Response(JSON.stringify(upstream));}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
        const root='http://127.0.0.1:'+server.address().port;
        const response=await fetch(root+'/autodl/tasks/video_1',{headers:{'X-Upstream-Base':'https://autodl.art',Authorization:'raw-key'}});
        assert.deepEqual(await response.json(),{upstream});
        assert.equal(calls[0].url,'https://autodl.art/api/v1/comfyui/comfyui_workflow/result/video_1');
        assert.equal(calls[0].opts.headers.Authorization,'raw-key');
        assert.equal((await fetch(root+'/autodl/tasks/video_1',{headers:{'X-Upstream-Base':'https://other.example'}})).status,502);
        assert.equal(calls.length,1);
    } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
