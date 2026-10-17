// Explicit smoke test: creates one short audio task, then validates its saved result.
// Usage: node scripts/test-speech-integration.mjs --generate grok-voice-latest
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { localClients } from './lib/newapi-local.mjs';

const modelName = process.argv[3];
if (process.argv[2] !== '--generate' || !/^grok-voice-(latest|think-fast-[12]\.0)$/.test(modelName || '')) {
    throw Error('Provide --generate and one connected Grok voice model.');
}
const { studio, close } = await localClients({ adminSession: false });
try {
    const configs = (await studio('/config/model/listModelConfigs')).modelConfigs;
    const model = configs.find(m => m.modelType === 'audio' && m.modelName === modelName);
    assert.ok(model, 'Speech model must be connected first');
    const list = await studio('/ai/model/listModels');
    const selected = model.channelId + '::' + model.modelName;
    assert.ok(list.audioModels.includes(selected));
    assert.ok(!list.textModels.includes(selected) && !list.videoModels.includes(selected) && !list.imageModels.includes(selected));
    let task = await studio('/ai/task/createTask', {
        taskType: 'audio', model: selected,
        prompt: '你好，欢迎来到灵感工作室。让每一个好故事，都拥有自己的声音。',
        parameters: { voice: 'eve', format: 'mp3' }, references: [], generationSource: 'canvas',
    });
    const taskId = task.id || task.taskId;
    assert.ok(taskId);
    console.log(JSON.stringify({ model: modelName, taskId, status: task.status }));
    const end = Date.now() + 6 * 60 * 1000;
    let lastStatus = '';
    while (!['succeeded', 'success', 'completed', 'failed', 'cancelled', 'canceled'].includes(task.status)) {
        if (Date.now() > end) throw Error('Speech task still pending: ' + taskId);
        await new Promise(resolve => setTimeout(resolve, 4000));
        task = await studio('/ai/task/getTaskInfo?taskId=' + encodeURIComponent(taskId));
        if (lastStatus !== task.status) {
            console.log(JSON.stringify({ taskId, status: task.status }));
            lastStatus = task.status;
        }
    }
    if (task.status === 'failed') throw Error('Speech generation failed: ' + task.errorMessage);
    const result = typeof task.resultData === 'string' ? JSON.parse(task.resultData) : task.resultData;
    const media = result?.item;
    assert.ok(media?.storageKey && media?.url, 'Speech must be persisted');
    assert.ok(media.durationMs > 0 && media.bytes > 0, 'Speech must have validated duration and bytes');
    assert.match(media.mimeType, /^audio\//);
    await mkdir(new URL('../tmp/speech-verification/', import.meta.url), { recursive: true });
    await writeFile(new URL('../tmp/speech-verification/' + modelName + '.json', import.meta.url), JSON.stringify({ model: selected, taskId, media }, null, 2));
    console.log(JSON.stringify({ model: modelName, taskId, status: task.status, durationMs: media.durationMs, bytes: media.bytes, mimeType: media.mimeType, storageKey: media.storageKey, stored: true }));
} finally { await close(); }
