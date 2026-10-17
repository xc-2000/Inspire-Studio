import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const template = await readFile(new URL('./video-adapter.mjs', import.meta.url), 'utf8');
const source = 'const config = ' + JSON.stringify({key:'test', name:'test', protocol:'openai-video-json', models:['seedance']}) + ';\n' + template;
const plugin = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
test('Seedance JSON maps unified native audio to with_audio for JSON, multipart and legacy callers', () => {
    for (const value of [undefined, true, false, 'true', 'false']) {
        for (const kind of ['json', 'multipart']) {
            const request = {prompt:'Ambient sound', seconds:5, ...(value === undefined ? {} : {generate_audio:value})};
            const body = kind === 'json' ? {kind, value:request} : {kind, fields:Object.fromEntries(Object.entries(request).map(([k,v])=>[k,[String(v)]]))};
            const ctx = {model:'seedance',baseUrl:'https://example.invalid/v1',apiKey:'test',body};
            const requestBody = plugin.protocols.openai_video.decodeRequest(ctx).requestBody;
            const result = plugin.buildSubmitRequest({...ctx,requestBody}).body;
            assert.equal(result.with_audio, value !== false && value !== 'false');
            assert.equal(result.generate_audio, undefined);
        }
    }
});
