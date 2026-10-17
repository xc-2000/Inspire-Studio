// Read-only integration check. Credentials stay in memory and never enter reports.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
const expected = JSON.parse(readFileSync(new URL('third-party/prompts/infinite-canvas-20261006/normalized.json', root), 'utf8'));
const env = Object.fromEntries(readFileSync(new URL('.env', root), 'utf8').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => {
  const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^['"]|['"]$/g, '')];
}));
const base = process.env.PROMPT_VERIFY_BASE_URL || 'http://127.0.0.1:5550';
async function api(path, token, body) {
  const r = await fetch(base + '/api/v1' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const v = await r.json();
  assert.equal(r.ok, true, path + ': HTTP ' + r.status);
  assert.equal(v.code, 0, path + ': application error');
  return v.data;
}
const auth = await api('/auth/login', null, { email: env.ADMIN_INITIAL_EMAIL, password: env.ADMIN_INITIAL_PASSWORD });
const list = query => api('/prompt/listPrompts?' + new URLSearchParams(query), auth.token);
const first = await list({ page: '1', pageSize: '100' });
assert.equal(first.total, expected.length);
const items = [...first.items];
for (let page = 2; items.length < first.total; page++) {
  const data = await list({ page: String(page), pageSize: '100' });
  assert.ok(data.items.length, 'Pagination unexpectedly empty');
  items.push(...data.items);
}
assert.equal(items.length, expected.length);
assert.equal(new Set(items.map(i => i.id)).size, expected.length, 'Duplicated pages/ids');
const normalize = s => s.normalize('NFKC').replace(/\s+/gu, ' ').trim();
assert.equal(new Set(items.map(i => normalize(i.prompt))).size, expected.length, 'Duplicate prompts');
for (let i = 0; i < expected.length; i++) {
  for (const field of ['title', 'prompt', 'coverUrl', 'preview', 'category']) assert.equal(items[i][field], expected[i][field], `${i}: ${field}`);
  assert.deepEqual(items[i].tags, expected[i].tags);
}
const categoryChecks = [];
for (const category of first.categories) {
  const result = await list({ category, pageSize: '1' });
  const count = expected.filter(p => p.category === category).length;
  assert.equal(result.total, count);
  assert.equal(result.items[0].category, category);
  categoryChecks.push({ category, count });
}
const keyword = '海报';
const searched = await list({ keyword, pageSize: '100' });
assert.ok(searched.total > 0);
assert.ok(searched.items.every(p => [p.title, p.prompt, p.category].some(s => s.includes(keyword))));
const tag = first.tags.find(t => expected.some(p => p.tags.includes(t)));
const tagged = await list({ tag, pageSize: '100' });
assert.equal(tagged.total, expected.filter(p => p.tags.includes(tag)).length);
assert.ok(tagged.items.every(p => p.tags.includes(tag)));
const beyond = await list({ page: String(Math.ceil(first.total / 100) + 1), pageSize: '100' });
assert.equal(beyond.items.length, 0);
const covers = [...new Set(items.map(p => p.coverUrl).filter(Boolean))];
let next = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  for (;;) {
    const i = next++; if (i >= covers.length) return;
    const path = covers[i];
    assert.ok(path.startsWith('/prompts/covers/'));
    const r = await fetch(base + path, { method: 'HEAD' });
    assert.equal(r.status, 200, path);
    assert.ok(r.headers.get('content-type')?.startsWith('image/'), path + ': MIME');
    const bytes = readFileSync(new URL('web/public' + path, root)).length;
    assert.equal(Number(r.headers.get('content-length')), bytes, path + ': length');
  }
}));
const report = { verifiedAt: new Date().toISOString(), total: items.length, pages: Math.ceil(items.length / 100), duplicates: 0,
  categories: categoryChecks, search: { keyword, total: searched.total }, tag: { name: tag, total: tagged.total },
  localCoverUrlsVerified: covers.length, itemsWithoutCover: items.filter(p => !p.coverUrl).length, beyondLastPageEmpty: true };
const destination = new URL('outputs/prompt-library-verification.json', root);
writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, report: fileURLToPath(destination) }));
