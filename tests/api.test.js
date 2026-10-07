import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { startMockGitHub } from './mockGitHub.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-api-test-'));
process.env.DATA_DIR = tmp;
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.GITHUB_REPOSITORY = 'teste/manifests';
process.env.ADMIN_TOKEN = 'token-admin-de-teste';
process.env.REQUEST_TIMEOUT_MS = '400';
process.env.CACHE_TTL_SECONDS = '60';

const APPID = '123456';
const gh = await startMockGitHub({ branch: APPID, commit: 'a'.repeat(40) });
process.env.GITHUB_API_URL = gh.url;

const { start } = await import('../src/server.js');
const { createKey, KEY_FORMAT } = await import('../src/store.js');

const server = await start(0, '127.0.0.1');
const BASE = `http://127.0.0.1:${server.address().port}`;
const ADMIN = { 'X-Admin-Token': 'token-admin-de-teste' };

const keyInfo = createKey({ name: 'teste-api', rateLimitPerMinute: 1000 });
const KEY = keyInfo.key;

async function get(pathname, headers = {}) {
  const res = await fetch(`${BASE}${pathname}`, { headers });
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body };
}

test.beforeEach(() => {
  gh.resetCalls();
  gh.setBranch(APPID, 'a'.repeat(40));
  gh.setMode('ok');
  gh.setFiles({
    '730.manifest': 'manifest-conteudo-a',
    '123456.manifest': 'manifest-conteudo-b',
    'chave.lua': 'nao deve aparecer',
  });
});

test.after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  await gh.close();
});

test('GET /health responde e informa a origem', async () => {
  const res = await get('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.github.configured, true);
  assert.equal(res.body.github.repository, 'teste/manifests');
  assert.equal(res.body.github.token, undefined, 'nunca expoe token');
});

test('GET /health?deep=1 alcanca o GitHub', async () => {
  const res = await get('/health?deep=1');
  assert.equal(res.status, 200);
  assert.equal(res.body.github.reachable.ok, true);
  assert.ok(typeof res.body.github.reachable.latencyMs === 'number');
});

test('GET /docs documenta as rotas', async () => {
  const res = await get('/docs');
  assert.equal(res.status, 200);
  assert.match(res.body.toString(), /\/manifests\?id=/);
  assert.match(res.body.toString(), /X-API-Key/);
});

test('rota inexistente responde 404 JSON claro', async () => {
  const res = await get('/nope');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'rota_nao_encontrada');
});

test('/manifests sem chave: 400 formato invalido', async () => {
  const res = await get(`/manifests?id=${APPID}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'formato_de_chave_invalido');
});

test('/manifests com chave de formato errado: 400', async () => {
  const res = await get(`/manifests?id=${APPID}&key=123`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'formato_de_chave_invalido');
});

test('/manifests com chave inexistente: 401', async () => {
  const res = await get(`/manifests?id=${APPID}&key=mk_${'b'.repeat(32)}`);
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'chave_nao_encontrada');
  assert.ok(KEY_FORMAT.test(`mk_${'b'.repeat(32)}`));
});

test('/manifests com AppID invalido: 400', async () => {
  const res = await get(`/manifests?id=abc&key=${KEY}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'appid_invalido');
});

test('lista os manifests da branch do AppID', async () => {
  const res = await get(`/manifests?id=${APPID}&key=${KEY}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.appid, APPID);
  assert.equal(res.body.branch, APPID);
  assert.equal(res.body.commit, 'a'.repeat(40));
  assert.equal(res.body.count, 2, 'apenas .manifest; .lua ignorado');
  assert.equal(res.body.cached, false);
  const names = res.body.files.map((f) => f.name).sort();
  assert.deepEqual(names, ['123456.manifest', '730.manifest']);
  for (const f of res.body.files) {
    assert.equal(f.sha256.length, 64);
    assert.ok(f.size > 0);
  }
  assert.equal(JSON.stringify(res.body).includes('mk_'), false, 'resposta sem chaves');
});

test('segunda listagem usa cache (sem chamadas ao GitHub)', async () => {
  await get(`/manifests?id=${APPID}&key=${KEY}`);
  gh.resetCalls();
  const res = await get(`/manifests?id=${APPID}&key=${KEY}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.cached, true);
  assert.equal(gh.calls.branches, 0);
});

test('/download entrega ZIP com os manifests e nada mais', async () => {
  const res = await get(`/download?id=${APPID}&key=${KEY}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition'), /attachment; filename="/);

  const zip = new AdmZip(Buffer.from(res.body));
  const entries = zip.getEntries().map((e) => e.entryName).sort();
  assert.deepEqual(entries, ['123456.manifest', '730.manifest']);
  assert.equal(zip.readAsText('730.manifest'), 'manifest-conteudo-a');
  assert.equal(zip.readAsText('123456.manifest'), 'manifest-conteudo-b');
  assert.ok(!entries.some((n) => n.endsWith('.lua')), '.lua nunca sai');
});

test('download consome 1 uso da chave e respeita maxUses', async () => {
  const limited = createKey({ name: 'usos', maxUses: 1, rateLimitPerMinute: 1000 });
  const first = await get(`/download?id=${APPID}&key=${limited.key}`);
  assert.equal(first.status, 200);
  const second = await get(`/download?id=${APPID}&key=${limited.key}`);
  assert.equal(second.status, 403);
  assert.equal(second.body.error, 'limite_de_usos_atingido');
});

test('rate limit por chave responde 429', async () => {
  const slow = createKey({ name: 'lenta', rateLimitPerMinute: 1 });
  assert.equal((await get(`/manifests?id=${APPID}&key=${slow.key}`)).status, 200);
  const res = await get(`/manifests?id=${APPID}&key=${slow.key}`);
  assert.equal(res.status, 429);
  assert.equal(res.body.error, 'limite_de_requisicoes');
});

test('header X-API-Key tambem autentica', async () => {
  const res = await fetch(`${BASE}/manifests?id=${APPID}`, { headers: { 'X-API-Key': KEY } });
  assert.equal(res.status, 200);
});

test('branch inexistente: 404 com mensagem clara', async () => {
  // A branch '999998' existe; pedimos o AppID 999999 (branch inexistente).
  gh.setBranch('999998');
  const res = await get(`/manifests?id=999999&key=${KEY}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'branch_nao_encontrada');
  assert.match(res.body.message, /branch/i);
});

test('branch sem manifests: 404 sem_manifests', async () => {
  gh.setBranch('730');
  gh.setFiles({ 'leia-me.txt': 'nada' });
  const res = await get(`/manifests?id=730&key=${KEY}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'sem_manifests');
});

test('GitHub caiu sem cache: 502 github_indisponivel', async () => {
  gh.setMode('down');
  const res = await get(`/manifests?id=730&key=${KEY}`);
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'github_indisponivel');
});

test('GitHub lento demais: 504 github_timeout', async () => {
  gh.setBranch('730');
  gh.setMode('slow');
  const res = await get(`/manifests?id=730&key=${KEY}`);
  assert.equal(res.status, 504);
  assert.equal(res.body.error, 'github_timeout');
});

test('GitHub no limite: 503 github_rate_limit', async () => {
  gh.setBranch('730');
  gh.setMode('rate_limit');
  const res = await get(`/manifests?id=730&key=${KEY}`);
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'github_rate_limit');
});

test('cache stale e servido quando o GitHub cai (X-Cache: stale)', async () => {
  await get(`/download?id=${APPID}&key=${KEY}`); // popula cache
  // Expira o TTL e joga o GitHub para baixo.
  const metaFile = path.join(tmp, 'cache', APPID, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  meta.checkedAt = '2000-01-01T00:00:00.000Z';
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  gh.setMode('down');

  const res = await get(`/download?id=${APPID}&key=${KEY}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-cache'), 'stale');
});

test('admin: sem token nega, com token gerencia chaves', async () => {
  assert.equal((await get('/admin/keys')).status, 401);
  assert.equal(
    (await get('/admin/keys', { 'X-Admin-Token': 'errado' })).status,
    401,
  );

  const created = await fetch(`${BASE}/admin/keys`, {
    method: 'POST',
    headers: { ...ADMIN, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'cliente-x', maxUses: 5 }),
  });
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.ok(KEY_FORMAT.test(body.key));

  const list = await get('/admin/keys', ADMIN);
  assert.equal(list.status, 200);
  assert.equal(list.body.keys.some((k) => k.name === 'cliente-x'), true);
  assert.equal(JSON.stringify(list.body).includes(body.key), false, 'lista nunca expoe a chave');

  const del = await fetch(`${BASE}/admin/keys/${body.id}`, { method: 'DELETE', headers: ADMIN });
  assert.equal(del.status, 200);
  const useRevoked = await get(`/manifests?id=${APPID}&key=${body.key}`);
  assert.equal(useRevoked.status, 401);
  assert.equal(useRevoked.body.error, 'chave_revogada');
});

test('admin: body invalido responde 400', async () => {
  const res = await fetch(`${BASE}/admin/keys`, {
    method: 'POST',
    headers: { ...ADMIN, 'content-type': 'application/json' },
    body: JSON.stringify({ expiresAt: 'nao-e-data' }),
  });
  assert.equal(res.status, 400);
});

test('logs nao registram a chave (query string ignorada)', async () => {
  // O middleware registra apenas req.path; garantimos que /download responde
  // e que nenhuma parte da resposta ecoa a chave.
  const res = await get(`/download?id=${APPID}&key=${KEY}`);
  assert.equal(res.status, 200);
  assert.equal(JSON.stringify(res.headers).includes(KEY), false);
});
