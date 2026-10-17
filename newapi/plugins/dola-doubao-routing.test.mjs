import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// dola-pool 一个渠道承载两条上游通道，模型名不可混用：
//   seedance-2.x   → dola.com 浏览器通道
//   doubao-video-* → 豆包国内版纯 HTTP 通道
// 这里锁住「模型族分流 + 原样透传 + 时长门禁」，防止再次被统一改写成 seedance。
const template = await readFile(new URL('./video-adapter.mjs', import.meta.url), 'utf8');
const dola = await import('data:text/javascript;base64,' + Buffer.from(
    'const config={key:"studio-dola",protocol:"dola",models:["seedance-2.0","seedance-2.5","doubao-video","doubao-video-mini","doubao-video-fast","doubao-video-2.0","doubao-video-2.5"]};\n' + template
).toString('base64'));

function submit(model, seconds, extra = {}) {
    return dola.buildSubmitRequest({
        model, baseUrl: 'http://192.0.2.10:8000', apiKey: 'offline',
        requestBody: { prompt: '雨后街道，霓虹倒影', seconds, size: '16:9', ...extra },
    });
}

// (模型, 时长, 期望上游模型名)
const FORWARDED = [
    ['seedance-2.0', 10, 'seedance-2.0'],
    ['seedance-2.0', 15, 'seedance-2.0'],
    ['seedance-2.5', 15, 'seedance-2.5'],
    ['seedance-2.5', 30, 'seedance-2.5'],
    ['doubao-video', 10, 'doubao-video'],
    ['doubao-video-mini', 15, 'doubao-video-mini'],
    ['doubao-video-fast', 10, 'doubao-video-fast'],
    ['doubao-video-2.0', 10, 'doubao-video-2.0'],
    ['doubao-video-2.0', 15, 'doubao-video-2.0'],
    ['doubao-video-2.5', 10, 'doubao-video-2.5'],
    ['doubao-video-2.5', 30, 'doubao-video-2.5'],
];

for (const [model, seconds, expected] of FORWARDED) {
    test(`dola: ${model} @${seconds}s 原样透传模型名`, () => {
        const request = submit(model, seconds);
        assert.equal(request.body.model, expected);
        assert.equal(request.body.duration, seconds);
        assert.equal(request.url, 'http://192.0.2.10:8000/v1/videos/generations');
        // 豆包档位名绝不能落到浏览器的 seedance 通道上。
        if (model.startsWith('doubao-')) assert.ok(!/^seedance/.test(request.body.model));
    });
}

// 不支持的时长必须在提交前拦下，否则会被上游静默截断成 15 秒。
const REJECTED = [
    ['doubao-video', 30], ['doubao-video-mini', 30], ['doubao-video-fast', 30],
    ['doubao-video-2.0', 30], ['seedance-2.0', 30],
];

for (const [model, seconds] of REJECTED) {
    test(`dola: ${model} @${seconds}s 被拒绝`, () => {
        assert.throws(() => submit(model, seconds), /不支持该时长/);
    });
}

test('dola: 参考图走 i2v 且不改写模型名', () => {
    // 网关侧入参是 `images`，向上游（dola-pool）转成 `reference_images`。
    const request = submit('doubao-video-2.0', 10, { images: ['https://example.invalid/a.png'] });
    assert.equal(request.body.model, 'doubao-video-2.0');
    assert.deepEqual(request.body.reference_images, ['https://example.invalid/a.png']);
});

test('dola: 参考视频/音频被拒绝', () => {
    assert.throws(() => submit('doubao-video-2.0', 10, { videos: ['https://example.invalid/v.mp4'] }), /参考视频或音频/);
    assert.throws(() => submit('doubao-video-2.0', 10, { audio: ['https://example.invalid/a.wav'] }), /参考视频或音频/);
});
