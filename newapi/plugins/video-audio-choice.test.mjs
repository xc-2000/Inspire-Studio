import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as arcads from './arcads-video.mjs';
const template = await readFile(new URL('./video-adapter.mjs',import.meta.url),'utf8');
const vivix = await import('data:text/javascript;base64,'+Buffer.from('const config={key:"test",protocol:"vivix",models:["vivix-w1-fast"]};\n'+template).toString('base64'));

for (const [name,plugin,model,resolution] of [['Arcads',arcads,'seedance-2.0','480p'],['Vivix',vivix,'vivix-w1-fast','720p']]) {
    const ctx={model,baseUrl:'https://example.invalid',apiKey:'offline',requestBody:{prompt:'Sound',seconds:5,resolution,size:'16:9'}};
    test(name+': user choice and audio precedence survive JSON and multipart',()=>{
        for(const value of [undefined,true,false,'false']) {
            const plain=plugin.buildSubmitRequest({...ctx,requestBody:{...ctx.requestBody,generate_audio:value}});
            assert.equal(plain.body.generate_audio,value!==false&&value!=='false');
            for (const kind of ['json','multipart']) {
                const input={...ctx.requestBody,generate_audio:value,audio:['https://example.invalid/ref.wav'],video_generation_mode:'reference-to-video'};
                const body=kind==='json'?{kind,value:input}:{kind,fields:Object.fromEntries(Object.entries(input).filter(([,v])=>v!==undefined).map(([k,v])=>[k,[typeof v==='object'?JSON.stringify(v):String(v)]])),files:[]};
                const request=plugin.protocols.openai_video.decodeRequest({...ctx,body}).requestBody;
                const result=plugin.buildSubmitRequest({...ctx,requestBody:request});
                assert.equal(result.body.generate_audio,false);
                assert.deepEqual(result.body.reference_audios,input.audio);
            }
        }
    });
    test(name+': uploaded audio replaces stale URL and does not become an image',()=>{
        const body={kind:'multipart',fields:{prompt:['Sound'],seconds:['5'],resolution:[resolution],size:['16:9'],video_generation_mode:['reference-to-video'],audio:['["https://old.invalid/a.wav"]']},files:[{field:'audio',ref:'audio-file'}]};
        const request=plugin.protocols.openai_video.decodeRequest({...ctx,body}).requestBody;
        const result=plugin.buildSubmitRequest({...ctx,requestBody:request});
        assert.equal(result.body.generate_audio,false);
        assert.equal(result.body.reference_audios[0].__fileRef,'audio-file');
        assert.ok(!JSON.stringify(result).includes('old.invalid'));
        assert.ok(!result.body.input_reference);
    });
}
