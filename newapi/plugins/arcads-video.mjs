// Arcads OpenAI bridge. Installed in New API; Studio keeps its unified protocol.
// Source contract: OPENAI_API.md and openai_api.py.
export const meta = {
    apiVersion: 1, key: 'studio-arcads', name: 'Arcads 视频', version: '1.0.0',
    author: { name: 'Inspire Studio' }, fetchMode: 'per_task', protocols: ['openai_video'],
    upstreams: ['vendor', 'new_api'], allowedHosts: ['newapi-video-helper:8090'],
    // Use the gateway's canonical spelling; each supplier remains a separate route.
    models: ['kling-3.0', 'MiniMax-H3', 'minimax-h3-max', 'seedance', 'seedance-2.0', 'seedance-2.0-mini', 'seedance-2.5', 'veo-3.1', 'wan-3.0', 'grok-video'],
};

const commonRatios = ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'];
const defaultResolution = '480p';
const policies = {
    'kling-3.0': { min: 3, max: 15, resolution: '1080p', ratios: ['16:9', '9:16', '1:1'], refs: 0 },
    'minimax-h3': { min: 5, max: 15, resolution: '720p', ratios: commonRatios, refs: 9 },
    'minimax-h3-max': { min: 5, max: 15, resolution: '720p', ratios: commonRatios, refs: 9 },
    'seedance': { min: 4, max: 12, resolution: '720p', ratios: ['16:9', '9:16'], refs: 1 },
    'seedance-2.0': { min: 4, max: 15, resolution: '720p', ratios: ['16:9', '9:16', '4:3'], refs: 9 },
    'seedance-2.0-mini': { min: 4, max: 15, resolution: '720p', ratios: commonRatios, refs: 9 },
    'seedance-2.5': { min: 4, max: 30, resolution: '720p', ratios: ['16:9', '9:16', '4:3'], refs: 30 },
    'veo-3.1': { min: 8, max: 8, resolution: '720p', ratios: ['16:9', '9:16'], refs: 3 },
    'wan-3.0': { min: 2, max: 30, resolution: '720p', ratios: ['16:9', '9:16', '1:1', '3:4', '4:3'], refs: 10 },
    'grok-video': { min: 1, max: 15, resolution: '720p', ratios: commonRatios, refs: 0 },
};
function check(ok, message) { if (!ok) throw new Error(message); }
function nativeAudio(req) {
    if (list(req.audio || req.reference_audios).length) return false;
    const options = req.options && typeof req.options === 'object' ? req.options : {};
    const value = req.generate_audio ?? req.with_audio ?? options.generate_audio ?? options.with_audio;
    if (value === undefined || value === null) return true;
    if (value === true || value === false) return value;
    if (value === 1 || value === 0) return value === 1;
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1'].includes(normalized)) return true;
    if (['false', '0'].includes(normalized)) return false;
    throw new Error('generate_audio 必须是布尔值');
}
function list(value) { return Array.isArray(value) ? value : value ? [value] : []; }
function url(base, path) { return base.replace(/\/+$/, '').replace(/\/v1$/, '') + path; }
function auth(ctx) { return { Authorization: 'Bearer ' + ctx.apiKey }; }
function videoSize(req, policy, ratio) {
    const dimensions = /^\d+x\d+$/i.test(String(req.size || '').trim())
        ? String(req.size).toLowerCase().split('x').map(Number) : null;
    check(!dimensions || dimensions.every(n => Number.isSafeInteger(n) && n > 0), '视频宽高必须大于 0');
    const raw = req.resolution || req.resolution_name || (dimensions ? Math.min(...dimensions) + 'p' : defaultResolution);
    const resolution = String(raw).trim().toLowerCase().replace(/^(\d+)$/, '$1p');
    // Resolution availability belongs to the channel configuration, not a per-model allowlist.
    // Send both the explicit resolution and dimensions for upstreams that infer it from size.
    check(!/^\d+kp?$/.test(resolution), 'Arcads 没有 2K、4K 档位，请选择渠道已配置的 P 分辨率');
    const short = resolution === 'auto' ? parseInt(defaultResolution, 10)
        : (/^[1-9]\d*p$/.test(resolution) ? Number(resolution.slice(0, -1)) : 0);
    check(Number.isSafeInteger(short) && short > 0 && short <= 16384, '视频分辨率格式无效');
    const parts = ratio.split(':').map(Number), scale = short / Math.min(...parts);
    return { resolution, size: parts.map(n => Math.round(n * scale / 2) * 2).join('x') };
}
function decode(ctx) {
    check(ctx.body && ['json', 'multipart'].includes(ctx.body.kind), '请提交 JSON 或 multipart');
    let req;
    if (ctx.body.kind === 'json') req = JSON.parse(JSON.stringify(ctx.body.value));
    else {
        req = {};
        for (const key of Object.keys(ctx.body.fields || {})) {
            const values = ctx.body.fields[key]; check(values.length === 1, '重复参数: ' + key); req[key] = values[0];
        }
        for (const key of ['images', 'metadata', 'options', 'reference_image_roles', 'reference_images', 'videos', 'audio']) {
            if (req[key] !== undefined) req[key] = JSON.parse(req[key]);
        }
        const files = ctx.body.files || [];
        check(files.every(f => ['image', 'input_reference', 'reference_images', 'audio'].includes(f.field)), 'Arcads 当前接口只支持图片参考');
        const imageFiles = files.filter(f => f.field !== 'audio');
        if (imageFiles.length) req.images = imageFiles.map(f => ({ __fileRef: f.ref, encoding: 'dataUrl', maxBytes: 25 * 1024 * 1024 }));
        const audioFiles = files.filter(f => f.field === 'audio');
        if (audioFiles.length) req.audio = audioFiles.map(f => ({ __fileRef: f.ref, encoding: 'dataUrl', maxBytes: 15 * 1024 * 1024 }));
    }
    check(req && typeof req === 'object' && !Array.isArray(req) && String(req.prompt || '').trim(), '视频提示词不能为空');
    return req;
}
export const protocols = { openai_video: {
    decodeRequest(ctx) {
        const req = decode(ctx);
        const refs = list(req.images || req.input_reference || req.reference_images || (req.metadata || {}).reference_images);
        return { kind: 'submit', model: ctx.model, action: req.video_generation_mode || (refs.length ? 'image-to-video' : 'text-to-video'), requestBody: req };
    },
    render(ctx, task) { return { seconds: String((task.data || {}).seconds || ''), error: task.status === 'FAILURE' ? { message: task.fail_reason || '视频生成失败' } : undefined }; },
} };
export function buildSubmitRequest(ctx) {
    const req = ctx.requestBody, model = (ctx.upstreamModel || ctx.model).toLowerCase(), policy = policies[model];
    check(policy, 'Arcads 视频模型未配置');
    const seconds = Number(req.seconds === undefined ? req.duration : req.seconds);
    check(Number.isInteger(seconds) && seconds >= policy.min && seconds <= policy.max, '该模型时长需为 ' + policy.min + '～' + policy.max + ' 秒');
    const metadata = req.metadata || {};
    check(!list(req.videos || metadata.reference_videos).length, 'Arcads 当前接口尚未开放视频参考');
    const audio = list(req.audio || req.reference_audios);
    const supportsAudio = ['minimax-h3', 'minimax-h3-max', 'seedance-2.0', 'seedance-2.0-mini', 'seedance-2.5', 'wan-3.0'].includes(model);
    check(!audio.length || supportsAudio, '该模型不支持参考音频');
    check(audio.length <= 3, '最多上传3段参考音频');
    let ratio = String(metadata.aspect_ratio || req.aspect_ratio || req.size || '16:9').trim().toLowerCase();
    if (/^\d+x\d+$/.test(ratio)) {
        const dimensions = ratio.split('x').map(Number);
        check(dimensions.every(n => n > 0), '视频宽高必须大于 0');
        ratio = commonRatios.slice().sort((a,b) => { const distance = s => { const p=s.split(':').map(Number); return Math.abs(p[0]/p[1]-dimensions[0]/dimensions[1]); }; return distance(a)-distance(b); })[0];
    }
    check(policy.ratios.includes(ratio), '该模型支持比例: ' + policy.ratios.join('、'));
    const refs = list(req.images || req.input_reference || req.reference_images || metadata.reference_images).map(v => typeof v === 'object' && !v.__fileRef ? v.image_url || v.url : v);
    const mode = req.video_generation_mode || (audio.length ? 'reference-to-video' : refs.length ? 'image-to-video' : 'text-to-video');
    check(['text-to-video', 'image-to-video', 'reference-to-video'].includes(mode), 'Arcads 当前接口尚未开放首尾帧模式');
    check(mode !== 'text-to-video' || !refs.length, '文生视频模式不能附带参考图');
    check(mode === 'text-to-video' || refs.length || (mode === 'reference-to-video' && audio.length), '请上传参考素材');
    check(!audio.length || mode === 'reference-to-video', '参考音频请使用全能参考模式');
    const body = { model, prompt: req.prompt, seconds: String(seconds), generate_audio: nativeAudio(req), ...videoSize(req, policy, ratio) };
    if (audio.length) body.reference_audios = audio;
    if (mode === 'image-to-video') { check(refs.length === 1, '图生视频请上传一张首帧图片，多图请使用参考图模式'); body.input_reference = refs[0]; }
    if (mode === 'reference-to-video') { check(policy.refs && refs.length <= policy.refs, '该模型参考图数量上限为 ' + policy.refs); body.reference_images = refs; }
    return { url: url(ctx.baseUrl, '/v1/videos'), method: 'POST', headers: { ...auth(ctx), 'Content-Type': 'application/json' }, body };
}
export function parseSubmitResponse(ctx, resp) {
    const body = resp.body || {}; check(body.id, '上游未返回视频任务 ID');
    return { taskId: String(body.id), taskData: body };
}
export function buildQueryRequest(ctx) { return { url: 'http://newapi-video-helper:8090/arcads/tasks/' + encodeURIComponent(ctx.taskId), method: 'GET', headers: { ...auth(ctx), 'X-Upstream-Base': ctx.baseUrl } }; }
export function parseTaskResult(ctx, body) {
    const status = { queued: 'QUEUED', in_progress: 'IN_PROGRESS', completed: 'SUCCESS', failed: 'FAILURE' }[body.status] || 'UNKNOWN';
    return { status, progress: status === 'SUCCESS' ? '100%' : Math.max(0, Math.min(99, Number(body.progress) || 0)) + '%', reason: status === 'FAILURE' ? (body.error || {}).message || '视频生成失败' : status === 'UNKNOWN' ? '未知视频状态' : undefined };
}
export function listArtifacts(task) { return task.status === 'SUCCESS' ? [{ key: 'video', type: 'video' }] : []; }
export function buildContentRequest(ctx) {
    check(ctx.artifactKey === 'video', '视频文件不存在');
    const target = (ctx.data || {}).video_url;
    check(typeof target === 'string' && /^https:\/\//.test(target), '上游没有返回视频存储地址');
    return { url: target, method: ctx.clientRequest.method, credentialless: true };
}
