import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockGitHub } from './mockGitHub.js';

process.env.ENV_FILE = '/nonexistent/lua-test.env';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-lua-'));
process.env.CACHE_DIR = path.join(process.env.DATA_DIR, 'cache');
process.env.GITHUB_REPOSITORY = 'test/lua';
process.env.MANIFESTHUB_ENABLED = 'false';
process.env.SOURCE_PRIORITY = 'github';
process.env.ADMIN_TOKEN = 'test-admin';
process.env.PUBLIC_BASE_URL = 'https://api.test';
const gh = await startMockGitHub({ branch: '4001890' });
process.env.GITHUB_API_URL = gh.url;
const { start } = await import('../src/server.js');
const { createKey } = await import('../src/store.js');
const { REGISTRY } = await import('../src/providers/index.js');
const { getLua } = await import('../src/lua.js');
const { SourceError } = await import('../src/githubSource.js');
const server = await start(0, '127.0.0.1');
const base = `http://127.0.0.1:${server.address().port}`;
const key = createKey({ name: 'lua-tests', rateLimitPerMinute: 1000 }).key;
const headers = { 'X-API-Key': key };
const lua = '-- fixture\naddappid(4001890)\nsetManifestid(4001891, "6932805931423228382")\n';
test.beforeEach(() => {
  gh.resetCalls();
  gh.setFiles({ '4001890.lua': lua, 'other.lua': 'other', 'a.manifest': 'manifest', 'b.manifest': 'manifest' });
});
test.after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await gh.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});
test('download padrao retorna Lua exato e nao baixa nenhum manifest', async () => {
  const res = await fetch(`${base}/download?id=4001890`, { headers });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="4001890.lua"');
  assert.equal(await res.text(), lua);
  assert.equal(gh.calls.contents, 1);
  assert.equal(res.headers.get('x-manifest-gate-source'), 'github');
});
test('branch apenas com Lua funciona sem depender do cache de manifests', async () => {
  gh.setFiles({ 'scripts/4001890.lua': lua });
  const res = await fetch(`${base}/download?id=4001890&format=lua`, { headers });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), lua);
});
test('sem Lua retorna 404 e nao baixa manifests', async () => {
  gh.setFiles({ 'a.manifest': 'manifest' });
  const res = await fetch(`${base}/download?id=4001890`, { headers });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'sem_lua');
  assert.equal(gh.calls.contents, 0);
});
test('Lua ambiguo nao escolhe arquivo arbitrario', async () => {
  gh.setFiles({ 'one.lua': 'one', 'two.lua': 'two' });
  const res = await fetch(`${base}/download?id=4001890`, { headers });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'lua_ambiguo');
});
test('formato desconhecido rejeitado antes de consultar fonte', async () => {
  const res = await fetch(`${base}/download?id=4001890&format=exe`, { headers });
  assert.equal(res.status, 400);
  assert.equal(gh.calls.branches, 0);
});
test('download exige autenticacao', async () => {
  const res = await fetch(`${base}/download?id=4001890`);
  assert.ok([400, 401].includes(res.status));
  assert.equal(gh.calls.contents, 0);
});
test('download Lua consome um uso somente quando tem sucesso', async () => {
  const limited = createKey({ name: 'lua-limited', maxUses: 1, rateLimitPerMinute: 1000 });
  const auth = { 'X-API-Key': limited.key };
  gh.setFiles({ 'a.manifest': 'manifest' });
  assert.equal((await fetch(`${base}/download?id=4001890`, { headers: auth })).status, 404);
  gh.setFiles({ '4001890.lua': lua });
  assert.equal((await fetch(`${base}/download?id=4001890`, { headers: auth })).status, 200);
  assert.equal((await fetch(`${base}/download?id=4001890`, { headers: auth })).status, 403);
});
test('Lua respeita tamanho e integridade do blob', async () => {
  const { fetchFile } = await import('../src/githubSource.js');
  const { config } = await import('../src/config.js');
  const file = { path: '4001890.lua', name: '4001890.lua', size: Buffer.byteLength(lua), gitSha: '0'.repeat(40) };
  await assert.rejects(fetchFile('4001890', file, 'a'.repeat(40), { format: 'lua' }),
    (e) => e.code === 'falha_integridade');
  const previous = config.limits.maxFileBytes;
  config.limits.maxFileBytes = 1;
  try {
    await assert.rejects(getLua('4001890'), (e) => e.code === 'arquivo_grande_demais');
  } finally {
    config.limits.maxFileBytes = previous;
  }
});
test('link temporario preserva formato Lua', async () => {
  const res = await fetch(`${base}/links`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: '4001890' }),
  });
  assert.equal(res.status, 201);
  const link = await res.json();
  assert.equal(link.scope.format, 'lua');
  const download = await fetch(`${base}/links/${link.token}`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), lua);
});
test('fallback procura Lua na proxima fonte e respeita fonte explicita', async () => {
  const original = REGISTRY.github;
  REGISTRY.github = { ...original, list: async () => { throw new SourceError('sem_lua', 'missing'); } };
  REGISTRY.lua_test = { ...original, id: 'lua_test' };
  const { config } = await import('../src/config.js');
  const priority = config.sources.priority;
  config.sources.priority = ['github', 'lua_test'];
  try {
    const result = await getLua('4001890');
    assert.equal(result.source, 'lua_test');
    assert.equal(result.buffer.toString(), lua);
    assert.equal(result.attempts[0].code, 'sem_lua');
    await assert.rejects(getLua('4001890', { source: 'github' }), (e) => e.code === 'sem_lua');
  } finally {
    config.sources.priority = priority;
    REGISTRY.github = original;
    delete REGISTRY.lua_test;
  }
});
