// New API-side preflight for Lumina's separate authenticated media-upload API.
// No host port is exposed. The destination must match the explicitly configured upstream origin.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

// Only query the configured supplier. The gateway downloads signed media without credentials.
export async function arcadsTask(taskId, {base, arcadsOrigin, authorization, request = fetch}) {
    const origin = new URL(base);
    if (!arcadsOrigin || origin.origin !== arcadsOrigin || !['', '/', '/v1', '/v1/'].includes(origin.pathname)
        || origin.username || origin.password || origin.search || origin.hash) throw Error('Arcads 查询地址未配置');
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId) || !authorization?.startsWith('Bearer ')) throw Error('视频查询参数无效');
    const endpoint=origin.origin+'/v1/videos/'+taskId;
    const options={headers:{Authorization:authorization},signal:AbortSignal.timeout(60000),redirect:'manual'};
    const result=await request(endpoint,options);
    if(!result.ok) {await result.body?.cancel();throw Error('视频查询失败');}
    const task=await result.json();
    if(task.status==='completed') {
        const content=await request(endpoint+'/content',options);
        const location=content.headers.get('location'); await content.body?.cancel();
        if(![301,302,303,307,308].includes(content.status)||!location) throw Error('上游没有返回视频存储地址');
        const target=new URL(location,endpoint);
        if(target.protocol!=='https:'||target.username||target.password||target.hash) throw Error('视频存储地址无效');
        task.video_url=target.href;
    }
    return task;
}

const MAX_IMAGE = 10 * 1024 * 1024;
export async function createCapcutVideo(input, {base, apiKey, capcutOrigin, request = fetch}) {
    const upstream = new URL(base);
    if (!capcutOrigin || upstream.origin !== capcutOrigin || !['http:', 'https:'].includes(upstream.protocol)
        || !['', '/', '/v1', '/v1/'].includes(upstream.pathname) || upstream.username || upstream.password || upstream.search || upstream.hash)
        throw Error('CapCut 上传地址未配置');
    if (!apiKey) throw Error('CapCut 渠道密钥未配置');
    const form = new FormData();
    for (const field of ['model','prompt','seconds','ratio']) if (input[field] !== undefined) form.set(field, String(input[field]));
    if (input.input_reference) {
        const match = /^data:(image\/(?:png|jpeg|webp|bmp));base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(input.input_reference);
        if (!match) throw Error('CapCut 图生视频需要上传图片文件，不能仅传图片地址');
        const binary = Buffer.from(match[2], 'base64');
        if (!binary.length || binary.length > 25 * 1024 * 1024) throw Error('参考图片须小于25MB');
        await sharp(binary, {limitInputPixels: 40_000_000}).metadata();
        form.set('input_reference', new Blob([binary], {type: match[1]}), 'reference.'+match[1].split('/')[1]);
    }
    return request(upstream.origin+'/v1/videos', {method:'POST',headers:{Authorization:'Bearer '+apiKey},body:form,signal:AbortSignal.timeout(120000),redirect:'error'});
}

export async function createVivixVideo(input, {base, apiKey, vivixOrigin, request = fetch}) {
    const upstream = new URL(base);
    if (!vivixOrigin || upstream.origin !== vivixOrigin || !['http:', 'https:'].includes(upstream.protocol)
        || !['', '/', '/v1', '/v1/'].includes(upstream.pathname) || upstream.username || upstream.password || upstream.search || upstream.hash)
        throw Error('Vivix 上传地址未配置');
    if (!apiKey) throw Error('Vivix 渠道密钥未配置');
    if (String(input.resolution).toLowerCase() !== '720p') throw Error('Vivix W1 当前仅支持720P');
    const body = {...input};
    let count = 0, audioCount = 0;
    for (const [field,value] of Object.entries(input)) {
        if (!['input_reference','last_frame_image','reference_images','reference_audios'].includes(field)) continue;
        const refs = Array.isArray(value) ? value : [value];
        const urls = [];
        for (const ref of refs) {
            const audio = field === 'reference_audios';
            if (audio ? ++audioCount > 3 : ++count > 5) throw Error('Vivix W1 参考素材数量超限');
            const match = /^data:((?:image|audio)\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(ref);
            if (match) {
                const binary = Buffer.from(match[2],'base64');
                if (match[1].startsWith('audio/') !== audio) throw Error('参考素材类型不匹配');
                if (!binary.length || binary.length > (audio ? 2 : 25) * 1024 * 1024) throw Error(audio ? 'Vivix 参考音频不能超过2MB' : '参考图片不能超过25MB');
                const form = new FormData();
                form.append('file',new Blob([binary],{type:match[1]}),'reference-'+count+'.'+match[1].split('/')[1]);
                const uploaded = await request(upstream.origin+(audio?'/v1/files/audios':'/v1/files/images'),{method:'POST',headers:{Authorization:'Bearer '+apiKey},
                    body:form,signal:AbortSignal.timeout(120000),redirect:'error'});
                if (!uploaded.ok) { await uploaded.body?.cancel(); throw Error('Vivix '+(audio?'参考音频':'参考图')+'上传失败（HTTP '+uploaded.status+'）'); }
                const result = await uploaded.json(), imageUrl = result.url;
                if (typeof imageUrl !== 'string' || !/^https?:\/\//i.test(imageUrl)) throw Error('Vivix 图片上传未返回有效地址');
                urls.push(imageUrl);
            } else if (typeof ref === 'string' && /^https?:\/\//i.test(ref)) urls.push(ref);
            else throw Error('Vivix 参考图格式无效');
        }
        body[field] = Array.isArray(value) ? urls : urls[0];
    }
    return request(upstream.origin+'/v1/videos',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},body:JSON.stringify(body),
        signal:AbortSignal.timeout(180000),redirect:'error'});
}

export async function createLuminaVideo(input, {base, apiKey, uploadOrigin, uploadToken, request = fetch}) {
    const upstream = new URL(base);
    if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash
            || upstream.origin !== uploadOrigin || !upstream.pathname.endsWith('/openai')) throw Error('上游地址与媒体上传配置不一致');
    if (!apiKey || !uploadToken) throw Error('New API 媒体上传令牌尚未配置');
    const files = input._image_files || [], body = {...input};
    delete body._image_files;
    const refs = [...(body.media_urls || body.reference_urls || []), ...[body.first_prompt_pic, body.last_prompt_pic].filter(Boolean)];
    if (refs.length > 30) throw Error('参考图片数量超限');
    const replacements = new Map();
    for (let index = 0; index < refs.length; index++) {
        const original = refs[index];
        if (!/^https?:\/\//i.test(original) && !original.startsWith('data:')) continue;
        const data = files[index] || (original.startsWith('data:') ? original : '');
        const match = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(data);
        if (!match) throw Error('请通过 multipart 上传参考图文件');
        let binary = Buffer.from(match[1], 'base64');
        if (!binary.length || binary.length > MAX_IMAGE) throw Error('参考图片不能超过10MB');
        const metadata = await sharp(binary, {limitInputPixels: 40_000_000}).metadata();
        let mime = {jpeg:'image/jpeg',png:'image/png',gif:'image/gif'}[metadata.format];
        if (!mime) { binary = await sharp(binary, {limitInputPixels:40_000_000}).png().toBuffer(); mime = 'image/png'; }
        if (binary.length > MAX_IMAGE) throw Error('图片转换后超过10MB');
        const uploaded = await request(upstream.origin + upstream.pathname.replace(/\/openai$/, '') + '/v1/media/images', {
            method:'POST',headers:{Authorization:'Bearer '+uploadToken,'Content-Type':mime,'X-Filename':'reference-'+index+'.'+mime.split('/')[1]},body:binary,signal:AbortSignal.timeout(120000),redirect:'error',
        });
        if (!uploaded.ok) throw Error('参考图上传失败（HTTP '+uploaded.status+'）');
        const result = await uploaded.json(), dataBody = result.data || result;
        const uri = dataBody.uri || dataBody.url;
        if (typeof uri !== 'string' || !uri) throw Error('图片上传没有返回内部地址');
        replacements.set(original, uri);
    }
    for(const field of ['media_urls','reference_urls']) if(body[field]) body[field]=body[field].map(v=>replacements.get(v)||v);
    for(const field of ['first_prompt_pic','last_prompt_pic']) if(body[field]) body[field]=replacements.get(body[field])||body[field];
    return request(base.replace(/\/+$/,'')+'/v1/videos', {method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},
        body:JSON.stringify(body),signal:AbortSignal.timeout(180000),redirect:'error'});
}

export function helperServer(config) {
    return createServer(async(req,res) => {
        if(req.method==='GET' && req.url==='/health') {res.end('ok');return;}
        if(req.method==='GET' && req.url.startsWith('/arcads/tasks/')) {
            try {
                const task=await arcadsTask(decodeURIComponent(req.url.slice('/arcads/tasks/'.length)), {...config,
                    base:String(req.headers['x-upstream-base']||''),authorization:String(req.headers.authorization||'')});
                res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(task));
            } catch {res.writeHead(502,{'Content-Type':'application/json'}).end(JSON.stringify({error:{message:'Arcads 视频进度或成片地址查询失败'}}));}
            return;
        }
        if(req.method==='GET' && req.url.startsWith('/autodl/tasks/')) {
            try {
                const base=String(req.headers['x-upstream-base']||'').replace(/\/+$/,'');
                if(base !== (config.autodlBase || 'https://autodl.art')) throw Error('工作流查询地址未配置');
                const taskId=decodeURIComponent(req.url.slice('/autodl/tasks/'.length));
                if(!/^[a-zA-Z0-9_-]+$/.test(taskId)) throw Error('任务标识无效');
                const result=await (config.request || fetch)(base+'/api/v1/comfyui/comfyui_workflow/result/'+encodeURIComponent(taskId),{
                    headers:{Authorization:String(req.headers.authorization||'')},signal:AbortSignal.timeout(60000),redirect:'error',
                });
                res.writeHead(result.status,{'Content-Type':'application/json'}).end(JSON.stringify({upstream:await result.json()}));
            } catch {res.writeHead(502,{'Content-Type':'application/json'}).end(JSON.stringify({error:{message:'工作流进度查询失败'}}));}
            return;
        }
        if(req.method!=='POST' || !['/v1/videos','/vivix/videos','/capcut/videos'].includes(req.url)) {res.writeHead(404).end();return;}
        try {
            let size=0; const chunks=[];
            for await(const chunk of req) {size+=chunk.length;if(size>70*1024*1024) throw Error('请求体超过70MB'); chunks.push(chunk);}
            const result=await (req.url==='/capcut/videos' ? createCapcutVideo : req.url==='/vivix/videos' ? createVivixVideo : createLuminaVideo)(JSON.parse(Buffer.concat(chunks).toString()),{
                ...config,base:String(req.headers['x-upstream-base']||''),apiKey:String(req.headers.authorization||'').replace(/^Bearer /,''),
            });
            const output=await result.text();
            res.writeHead(result.status,{'Content-Type':'application/json'}).end(output);
        } catch(error) {
            // No credentials, request payloads or upstream response bodies are logged.
            const message=error instanceof TypeError ? '媒体预处理网络请求失败' : error.message;
            res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:{type:'media_preflight_failed',message}}));
        }
    });
}
if(import.meta.url===pathToFileURL(process.argv[1]).href) {
    helperServer({uploadOrigin:process.env.NEWAPI_LUMINA_UPLOAD_ORIGIN||'',uploadToken:process.env.NEWAPI_LUMINA_UPLOAD_TOKEN||'',autodlBase:process.env.NEWAPI_AUTODL_BASE_URL||'https://autodl.art',arcadsOrigin:process.env.NEWAPI_ARCADS_ORIGIN||'',vivixOrigin:process.env.NEWAPI_VIVIX_ORIGIN||'',capcutOrigin:process.env.NEWAPI_CAPCUT_ORIGIN||''})
        .listen(Number(process.env.PORT||8090),'0.0.0.0');
}
