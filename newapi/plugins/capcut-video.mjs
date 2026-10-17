// CapCut requires uploaded image bytes, not an input_reference URL.
export const meta = {
    apiVersion: 1, key: 'studio-capcut', name: 'CapCut 视频', version: '1.0.0',
    author: {name: 'Inspire Studio'}, fetchMode: 'per_task', protocols: ['openai_video'],
    models: ['Seedance 2.5', 'Seedance 2.0', 'Seedance 2.0 Fast', 'Seedance 2.0 Mini'],
    allowedHosts: ['newapi-video-helper:8090'],
};
const check = (ok, message) => { if (!ok) throw Error(message); };
const list = value => Array.isArray(value) ? value : value ? [value] : [];
const endpoint = (base, path) => base.replace(/\/+$/, '').replace(/\/v1$/, '') + path;
const auth = ctx => ({Authorization: 'Bearer ' + ctx.apiKey});
function decode(ctx) {
    check(ctx.body && ['json', 'multipart'].includes(ctx.body.kind), '请提交 JSON 或 multipart 请求');
    let req;
    if (ctx.body.kind === 'json') req = JSON.parse(JSON.stringify(ctx.body.value));
    else {
        req = {};
        for (const key of Object.keys(ctx.body.fields || {})) {
            check(ctx.body.fields[key].length === 1, '重复参数: ' + key);
            req[key] = ctx.body.fields[key][0];
        }
        for (const key of ['metadata', 'images', 'videos', 'audio', 'options']) if (req[key] !== undefined) req[key] = JSON.parse(req[key]);
        const files = ctx.body.files || [];
        check(files.every(f => ['image', 'input_reference'].includes(f.field)) && files.length <= 1, 'CapCut 图生视频仅支持一张首帧图片');
        if (files.length) req.images = [{__fileRef: files[0].ref, encoding: 'dataUrl', maxBytes: 25 * 1024 * 1024}];
    }
    check(req && typeof req === 'object' && String(req.prompt || '').trim(), '视频提示词不能为空');
    return req;
}
export const protocols = {openai_video: {
    decodeRequest(ctx) {
        const req = decode(ctx);
        return {kind: 'submit', model: ctx.model, action: req.video_generation_mode || (list(req.images || req.input_reference).length ? 'image-to-video' : 'text-to-video'), requestBody: req};
    },
    render(ctx, task) {
        const data = task.data || {};
        return {seconds: String(data.seconds || ''), mode: data.mode, ratio: data.ratio, size: data.size,
            error: task.status === 'FAILURE' ? {message: task.fail_reason || '视频生成失败'} : undefined};
    },
}};
export function buildSubmitRequest(ctx) {
    const req = ctx.requestBody, metadata = req.metadata || {};
    const refs = list(req.images || req.input_reference || req.image || metadata.reference_images);
    check(!list(req.videos || metadata.reference_videos).length && !list(req.audio || req.reference_audios).length, 'CapCut 当前接口不支持参考视频或音频');
    check(refs.length <= 1, 'CapCut 图生视频仅支持一张首帧图片');
    const mode = req.video_generation_mode || (refs.length ? 'image-to-video' : 'text-to-video');
    check(['text-to-video', 'image-to-video'].includes(mode), 'CapCut 当前接口仅支持文生视频和单图生视频');
    check(mode === 'image-to-video' ? refs.length === 1 : refs.length === 0, '生成模式与参考图片不匹配');
    const seconds = Number(req.seconds ?? req.duration);
    check([5, 8, 10, 12, 15, 30, 60, 120, 180, 300].includes(seconds), 'CapCut 不支持该时长，请选择 5、8、10、12、15、30、60、120、180 或 300 秒');
    let ratio = metadata.aspect_ratio || req.ratio || req.aspect_ratio;
    if (!ratio && /^\d+x\d+$/.test(req.size || '')) {
        const [w,h] = req.size.split('x').map(Number);
        ratio = ['16:9','9:16','1:1','4:3','3:4','21:9'].sort((a,b) => {
            const diff = r => {const [rw,rh]=r.split(':').map(Number);return Math.abs(rw/rh-w/h);};return diff(a)-diff(b);
        })[0];
    }
    ratio = ratio || '16:9';
    check(['16:9','9:16','1:1','4:3','3:4','21:9','Auto','adaptive'].includes(ratio), 'CapCut 不支持该画幅');
    check(!req.resolution || String(req.resolution).toLowerCase() === '720p', 'CapCut 当前按原生 720P 输出');
    const body = {model: ctx.upstreamModel || ctx.model, prompt: req.prompt, seconds: String(seconds), ratio: ratio === 'adaptive' ? 'Auto' : ratio};
    if (refs.length) body.input_reference = refs[0];
    return {url: 'http://newapi-video-helper:8090/capcut/videos', method: 'POST', headers: {...auth(ctx), 'Content-Type':'application/json', 'X-Upstream-Base':ctx.baseUrl}, body};
}
export function parseSubmitResponse(ctx, resp) {
    check(resp.statusCode < 400 && resp.body?.id, resp.body?.error?.message || 'CapCut 未返回任务 ID');
    return {taskId: String(resp.body.id), taskData: resp.body};
}
export function buildQueryRequest(ctx) {return {url:endpoint(ctx.baseUrl, '/v1/videos/'+encodeURIComponent(ctx.taskId)),method:'GET',headers:auth(ctx)};}
export function parseTaskResult(ctx, body) {
    const status = {queued:'QUEUED',in_progress:'IN_PROGRESS',completed:'SUCCESS',failed:'FAILURE'}[body.status] || 'UNKNOWN';
    return {status,progress:status==='SUCCESS'?'100%':Math.max(0,Math.min(99,Number(body.progress)||0))+'%',reason:status==='FAILURE'?body.error?.message||'CapCut 生成失败':undefined};
}
export function listArtifacts(task) {return task.status==='SUCCESS'?[{key:'video',type:'video'}]:[];}
export function buildContentRequest(ctx) {
    check(ctx.artifactKey==='video', '视频文件不存在');
    const source=(ctx.data || {}).source_url;
    if (source) {check(/^https:\/\//.test(source),'成片地址无效');return {url:source,method:ctx.clientRequest.method,credentialless:true};}
    return {url:endpoint(ctx.baseUrl, '/v1/videos/'+encodeURIComponent(ctx.upstreamTaskId)+'/content'),method:ctx.clientRequest.method,headers:auth(ctx)};
}
