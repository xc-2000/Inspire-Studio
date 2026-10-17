// Installed as separate New API task plugins. All upstream-specific behavior lives here.
// The installer prepends `const config = { key, name, protocol, models };`.
export const meta = {
    apiVersion: 1, key: config.key, name: config.name, version: config.version || '1.0.1',
    author: { name: 'Inspire Studio' },
    description: { en: 'Video submission, polling and content through a unified API', zh: '统一视频提交、任务查询与成片下载' },
    models: config.models, fetchMode: 'per_task', protocols: ['openai_video'],
    allowedHosts: ['openai-video-json', 'autodl-comfyui', 'vivix'].includes(config.protocol) ? ['newapi-video-helper:8090'] : [],
};

function requireValue(condition, message) { if (!condition) throw new Error(message); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function nativeAudio(req) {
    if (array(req.audio || req.reference_audios).length) return false;
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
function array(value) { return Array.isArray(value) ? value : value ? [value] : []; }
function text(value) { return String(value === undefined || value === null ? '' : value).trim(); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function unwrap(body) { return object(body.data && !Array.isArray(body.data) ? body.data : body); }
function taskBody(body) {
    const data = unwrap(body.upstream || body);
    return object(config.protocol === 'minimax' ? data.task || data : data);
}
function url(base, path) { return base.replace(/\/+$/, '').replace(/\/v1$/, '') + path; }
function auth(ctx) { return { Authorization: (config.protocol === 'autodl-comfyui' ? '' : 'Bearer ') + ctx.apiKey }; }
function ratio(req) {
    const raw = text(req.aspect_ratio || object(req.metadata).aspect_ratio || req.size || '16:9');
    if (/^\d+(\.\d+)?:\d+(\.\d+)?$/.test(raw) || raw === 'adaptive') return raw;
    const dimensions = raw.split('x').map(Number);
    if (dimensions.length !== 2 || !dimensions.every(n => n > 0)) return '16:9';
    return ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'].sort((a, b) => {
        const value = s => { const p = s.split(':').map(Number); return Math.abs(p[0] / p[1] - dimensions[0] / dimensions[1]); };
        return value(a) - value(b);
    })[0];
}
function resolution(req, fallback) { return text(req.resolution || req.resolution_name || fallback).toLowerCase().replace(/^(\d+)$/, '$1p'); }
function images(req) {
    return array(req.images || object(req.metadata).reference_images || req.input_reference || req.image)
        .map(v => typeof v === 'string' ? v : v.image_url || v.url || v).filter(Boolean);
}
function orderedImages(req) {
    const values = images(req), roles = array(req.reference_image_roles);
    if (req.video_generation_mode !== 'first-last-frame-to-video') return values;
    requireValue(values.length === 2, '首尾帧模式需要两张图片');
    const first = roles.indexOf('first_frame'), last = roles.indexOf('last_frame');
    if (first < 0 && last < 0) return values;
    requireValue(first >= 0 && last >= 0 && first !== last, '请分别指定首帧和尾帧');
    return [values[first], values[last]];
}
function readRequest(ctx) {
    requireValue(ctx.body && ['json', 'multipart'].includes(ctx.body.kind), '请提交 JSON 或 multipart 请求');
    let req;
    if (ctx.body.kind === 'json') req = clone(ctx.body.value);
    else {
        req = {};
        const fields = ctx.body.fields || {};
        for (const key of Object.keys(fields)) {
            requireValue(fields[key].length === 1, '重复参数: ' + key);
            req[key] = fields[key][0];
        }
        for (const key of ['images', 'reference_images', 'reference_image_roles', 'metadata', 'audio', 'videos', 'options']) {
            if (req[key] !== undefined) req[key] = JSON.parse(req[key]);
        }
        if (config.protocol === 'vivix') {
            const files = ctx.body.files || [];
            requireValue(files.every(f => ['image', 'input_reference', 'reference_images', 'audio'].includes(f.field)), 'Vivix 当前接入仅支持图片参考');
            const imageFiles = files.filter(f => f.field !== 'audio');
            if (imageFiles.length) req.images = imageFiles.map(f => ({ __fileRef: f.ref, encoding: 'dataUrl', maxBytes: 25 * 1024 * 1024 }));
            const audioFiles = files.filter(f => f.field === 'audio');
            if (audioFiles.length) req.audio = audioFiles.map(f => ({ __fileRef: f.ref, encoding: 'dataUrl', maxBytes: 15 * 1024 * 1024 }));
        }
        if (['autodl-comfyui', 'openai-video-json'].includes(config.protocol)) {
            const files = ctx.body.files || [];
            const fileValues = field => files.filter(f => f.field === field).map(f => ({ __fileRef: f.ref, encoding: 'dataUrl', maxBytes: 52428800 }));
            if (config.protocol === 'autodl-comfyui') {
                if (fileValues('image').length) req.images = fileValues('image');
                if (fileValues('audio').length) req.audio = fileValues('audio');
            } else req.inline_images = fileValues('image');
        }
    }
    requireValue(req && !Array.isArray(req) && text(req.prompt), '视频提示词不能为空');
    req.seconds = Number(req.seconds === undefined ? req.duration : req.seconds);
    requireValue(Number.isInteger(req.seconds) && req.seconds > 0 && req.seconds <= 3600, '时长必须是正整数秒');
    return req;
}

export const protocols = {
    openai_video: {
        decodeRequest(ctx) {
            const req = readRequest(ctx);
            return { kind: 'submit', model: ctx.model, action: req.video_generation_mode || (images(req).length ? 'image-to-video' : 'text-to-video'), requestBody: req };
        },
        render(ctx, task) {
            // Gateway-owned /content always handles authenticated and public upstream results alike.
            return { seconds: text(object(task.data).seconds || object(task.data).duration || ''),
                error: task.status === 'FAILURE' ? { message: task.fail_reason || '视频生成失败' } : undefined };
        },
    },
};

export function buildSubmitRequest(ctx) {
    const req = ctx.requestBody, model = ctx.upstreamModel || ctx.model;
    const refs = orderedImages(req), videos = array(req.videos || object(req.metadata).reference_videos), audio = array(req.audio || req.reference_audios);
    const mode = req.video_generation_mode || (audio.length ? 'reference-to-video' : refs.length ? 'image-to-video' : 'text-to-video');
    const size = ratio(req), seconds = Number(req.seconds), headers = auth(ctx);
    let path = '/v1/videos', body;
    if (config.protocol === 'minimax') {
        requireValue(seconds >= 4 && seconds <= 15, 'MiniMax H3 时长为4～15秒');
        requireValue(refs.length <= 9 && videos.length <= 3 && audio.length <= 3, 'MiniMax H3 参考素材数量超限');
        const res = resolution(req, '768p');
        requireValue(['480p', '768p'].includes(res), 'MiniMax H3 支持480P和768P');
        const frames = ['image-to-video', 'first-last-frame-to-video'].includes(mode);
        if (frames) requireValue(refs.length >= 1 && refs.length <= 2 && !videos.length && !audio.length, '首尾帧不能混合其他参考素材');
        const roles = array(req.reference_image_roles);
        const content = [{ type: 'text', text: req.prompt }];
        refs.forEach((v, i) => content.push({ type: 'image_url', image_url: { url: v }, role: frames ? (i === 0 ? 'first_frame' : 'last_frame') : roles[i] || 'reference_image' }));
        videos.forEach(v => content.push({ type: 'video_url', video_url: { url: v }, role: 'reference_video' }));
        audio.forEach(v => content.push({ type: 'audio_url', audio_url: { url: v }, role: 'reference_audio' }));
        body = { model, content, duration: seconds, resolution: res, ratio: frames ? 'adaptive' : size };
        if (object(req.metadata).watermark !== undefined) body.aigc_watermark = object(req.metadata).watermark;
        path = '/v2/video_generation';
    } else if (config.protocol === 'vivix') {
        requireValue(['vivix-w1-ultrafast', 'vivix-w1-fast'].includes(model), 'Vivix 视频模型未配置');
        requireValue(seconds >= 5 && seconds <= 15, 'Vivix W1 支持5～15秒');
        requireValue(!videos.length, 'Vivix 当前接入不支持视频参考');
        requireValue(audio.length <= 3, 'Vivix W1 最多支持3段参考音频');
        requireValue(!audio.length || mode === 'reference-to-video', '参考音频请使用全能参考模式');
        const res = resolution(req, '720p');
        requireValue(res === '720p', 'Vivix W1 当前仅支持720P');
        requireValue(['16:9', '9:16', '4:3', '3:4', '1:1'].includes(size), 'Vivix W1 支持16:9、9:16、4:3、3:4、1:1');
        requireValue(['text-to-video', 'image-to-video', 'reference-to-video', 'first-last-frame-to-video'].includes(mode), 'Vivix 视频模式不支持');
        requireValue(mode !== 'text-to-video' || !refs.length, '文生视频不能附带参考图');
        requireValue(mode === 'text-to-video' || refs.length || audio.length, '请上传参考素材');
        const dimensions = size.split(':').map(Number), scale = parseInt(res, 10) / Math.min(...dimensions);
        body = { model, prompt: req.prompt, seconds, resolution: res, video_ratio: size, generate_audio: nativeAudio(req),
            size: dimensions.map(n => Math.round(n * scale / 2) * 2).join('x'), n: 1 };
        if (mode === 'image-to-video') {
            requireValue(refs.length === 1, '图生视频请上传一张首帧图片，多图请选择参考图模式');
            body.input_reference = refs[0];
        } else if (mode === 'reference-to-video') {
            requireValue(refs.length <= 5, 'Vivix W1 最多支持5张参考图');
            body.reference_images = refs;
        } else if (mode === 'first-last-frame-to-video') {
            body.input_reference = refs[0];
            body.last_frame_image = refs[1];
        }
        if (audio.length) body.reference_audios = audio;
        const options = object(req.options);
        if (options.seed !== undefined && Number.isInteger(Number(options.seed))) body.seed = Number(options.seed);
        if (['standard', 'enhanced'].includes(options.pe_mode)) body.pe_mode = options.pe_mode;
        // Upload original bytes via /v1/files/images, then use the returned URLs.
        // Vivix ignores input_reference files, and rc.42 loses multipart headers.
        if ([...refs, ...audio].some(ref => object(ref).__fileRef || text(ref).startsWith('data:'))) {
            return { url: 'http://newapi-video-helper:8090/vivix/videos', method: 'POST',
                headers: Object.assign(headers, {'Content-Type':'application/json', 'X-Upstream-Base':ctx.baseUrl}), body };
        }
    } else if (config.protocol === 'dola') {
        requireValue(!videos.length && !audio.length, 'Dola 不支持参考视频或音频');
        // dola-pool 同时承载两条上游通道，模型名不可混用：
        //   seedance-2.x   → dola.com 浏览器通道（10/15 秒；2.5 另有 30 秒）
        //   doubao-video-* → 豆包国内版纯 HTTP 通道（10/15 秒）
        // 早期版本无条件把模型名改写成 seedance，于是画布上选豆包档位时实际请求的
        // 是 seedance-2.x，豆包号池从未被调用（`doubao-video-2.0` 也被静默降级到
        // seedance-2.0，丢失 2.0 档位语义）。这里按模型族分流并原样透传豆包档位名。
        // 豆包通道的 30 秒**只**支持 doubao-video-2.5：其他档位求 30 秒会被上游
        // 静默截断为 15 秒（文案却称已改用 2.5），故直接拒绝，避免按 30 秒验收拿到
        // 15 秒成片。
        const doubao = /^doubao[-_]/i.test(model);
        const upstream = doubao ? model : (/2[._-]5/.test(model) ? 'seedance-2.5' : 'seedance-2.0');
        const allowed = upstream === 'seedance-2.5' || (doubao && /2[._-]5/.test(model)) ? [10, 15, 30] : [10, 15];
        requireValue(allowed.includes(seconds), '当前 ' + (doubao ? '豆包' : 'Dola') + '模型不支持该时长');
        body = { model: upstream, prompt: req.prompt, duration: seconds, ratio: size };
        if (refs.length) body.reference_images = refs;
        path = '/v1/videos/generations';
    } else if (config.protocol === 'autodl-comfyui') {
        requireValue(/^[A-Za-z0-9_.-]+$/.test(model), '工作流 ID 格式无效');
        requireValue(seconds <= 15 && refs.length <= 9 && audio.length <= 3 && !videos.length, '工作流参数超出支持范围');
        const res = resolution(req, '768p');
        requireValue(['480p', '768p'].includes(res), '工作流支持480P和768P');
        body = { prompt: req.prompt, duration: seconds, resolution: res + (['9:16', '3:4'].includes(size) ? '竖' : '横') };
        refs.forEach((v, i) => { body['ref_image_' + i] = v; });
        audio.forEach((v, i) => { body['ref_audio_' + i] = v; });
        if (object(req.options).seed !== undefined) body.seed = Number(req.options.seed);
        path = '/api/v1/comfyui/comfyui_workflow/' + encodeURIComponent(model);
    } else if (config.protocol === 'muse') {
        requireValue(seconds === 10, 'Muse 当前只支持10秒');
        requireValue(refs.length <= 30 && !videos.length && !audio.length, 'Muse 支持最多30张参考图片');
        body = { model, prompt: '目标视频时长10秒，请严格控制为10秒。画面比例' + size + '。' + (mode === 'first-last-frame-to-video' ? '第一张图作为首帧，第二张图作为尾帧。' : '') + req.prompt };
        if (['9:16', '3:4'].includes(size)) body.size = '720x1280';
        if (refs.length) body.input_reference = refs.map(v => ({ image_url: v }));
    } else if (config.protocol === 'openai-video-json') {
        requireValue(!videos.length && !audio.length, '该渠道不支持参考视频或音频');
        const mini = /mini/i.test(model);
        requireValue(seconds >= 4 && seconds <= (mini ? 8 : 15), '当前 Seedance 模型不支持该时长');
        body = { model, prompt: req.prompt, seconds, resolution: resolution(req, '480p'), aspect_ratio: size,
            with_audio: nativeAudio(req) };
        if (mode === 'first-last-frame-to-video') Object.assign(body, { task_type: 'flf', first_prompt_pic: refs[0], last_prompt_pic: refs[1] });
        else if (mode === 'reference-to-video') Object.assign(body, { task_type: 'r2v', reference_urls: refs });
        else if (refs.length) Object.assign(body, { task_type: 'i2v', media_urls: refs });
        else body.task_type = 't2v';
        if (refs.length && /\/openai\/?$/.test(ctx.baseUrl)) {
            body._image_files = req.inline_images || [];
            if (mode === 'first-last-frame-to-video') {
                const roles = array(req.reference_image_roles), first = roles.indexOf('first_frame'), last = roles.indexOf('last_frame');
                if(first>=0 && last>=0) body._image_files = [body._image_files[first],body._image_files[last]];
            }
            headers['X-Upstream-Base'] = ctx.baseUrl;
            headers['Content-Type'] = 'application/json';
            return { url: 'http://newapi-video-helper:8090/v1/videos', method: 'POST', headers, body };
        }
    } else {
        // This upstream accepts OpenAI video multipart fields, including repeated URL references.
        requireValue(!videos.length && !audio.length, '当前 OpenAI 视频渠道只支持图片参考');
        const parts = [{ name: 'model', value: model }, { name: 'prompt', value: req.prompt },
            { name: 'seconds', value: String(seconds) }, { name: 'size', value: /^\d+x\d+$/.test(req.size || '') ? req.size : ['9:16', '3:4'].includes(size) ? '720x1280' : '1280x720' },
            { name: 'resolution_name', value: resolution(req, '720p') }, { name: 'preset', value: 'normal' }];
        refs.forEach(v => parts.push({ name: 'input_reference[]', value: v }));
        const boundary = '----NewApiVideo' + utils.uuid().replace(/-/g, '');
        headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary;
        const bodyText = parts.map(p => '--' + boundary + '\r\nContent-Disposition: form-data; name="' + p.name + '"\r\n\r\n' + p.value + '\r\n').join('') + '--' + boundary + '--\r\n';
        return { url: url(ctx.baseUrl, path), method: 'POST', headers, body: bodyText };
    }
    headers['Content-Type'] = 'application/json';
    return { url: url(ctx.baseUrl, path), method: 'POST', headers, body };
}

export function parseSubmitResponse(ctx, resp) {
    if (config.protocol === 'autodl-comfyui') requireValue(resp.body.code === 'success', '工作流提交失败');
    const body = unwrap(resp.body), taskId = body.id || body.task_id;
    requireValue(taskId, '上游未返回视频任务 ID');
    return { taskId: String(taskId), taskData: body, state: { seconds: ctx.requestBody.seconds } };
}
export function buildQueryRequest(ctx) {
    const taskId = encodeURIComponent(ctx.taskId);
    // AutoDL's code:success envelope otherwise hits the host's legacy New API
    // passthrough before parseTaskResult. The gateway helper wraps it unchanged.
    if (config.protocol === 'autodl-comfyui') return {
        url: (config.helperBase || 'http://newapi-video-helper:8090') + '/autodl/tasks/' + taskId,
        method: 'GET', headers: Object.assign(auth(ctx), {'X-Upstream-Base': ctx.baseUrl}),
    };
    const path = config.protocol === 'minimax' ? '/v2/query/video_generation/' + taskId
        : '/v1/videos/' + taskId;
    return { url: url(ctx.baseUrl, path), method: 'GET', headers: auth(ctx) };
}
export function parseTaskResult(ctx, raw) {
    const body = taskBody(raw), value = text(body.status).toLowerCase();
    const status = ['completed', 'success', 'succeeded', 'done'].includes(value) ? 'SUCCESS'
        : ['failed', 'failure', 'fail', 'error', 'cancelled', 'canceled'].includes(value) ? 'FAILURE'
        : ['queued', 'pending', 'waiting', 'submitted'].includes(value) ? 'QUEUED'
        : ['running', 'processing', 'in_progress', 'preparing'].includes(value) ? 'IN_PROGRESS' : 'UNKNOWN';
    return { status, progress: status === 'SUCCESS' ? '100%' : Math.min(99, Math.max(0, parseInt(body.progress, 10) || 0)) + '%',
        reason: status === 'FAILURE' ? text(object(body.error).message || body.message || body.error || '上游视频生成失败') : status === 'UNKNOWN' ? '未知任务状态: ' + value : undefined };
}
function resultUrl(raw) {
    const body = taskBody(raw);
    return text(body.video_url || body.url || body.output_url || body.content_url || object(body.content).url
        || object(body.output).url || object(body.result).url || object(body.video).url || object(array(body.results)[0]).url);
}
export function listArtifacts(task) { return task.status === 'SUCCESS' ? [{ key: 'video', type: 'video' }] : []; }
export function buildContentRequest(ctx) {
    requireValue(ctx.artifactKey === 'video', '视频文件不存在');
    let target = resultUrl(ctx.data);
    const base = ctx.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    if (target.startsWith('/')) target = base.replace(/^(https?:\/\/[^/]+).*$/, '$1') + target;
    if (!target) target = url(base, '/v1/videos/' + encodeURIComponent(ctx.upstreamTaskId) + '/content');
    requireValue(/^https?:\/\//.test(target), '上游没有返回有效的视频地址');
    // Never send the API key to a third-party media CDN.
    const sameOrigin = target.match(/^https?:\/\/[^/]+/)[0] === base.match(/^https?:\/\/[^/]+/)[0];
    return sameOrigin ? { url: target, method: ctx.clientRequest.method, headers: auth(ctx) }
        : { url: target, method: ctx.clientRequest.method, credentialless: true };
}
