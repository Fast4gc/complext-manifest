import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockGitHub } from './mockGitHub.js';

process.env.ENV_FILE = '/nonexistent/mg-tests.env'; // ignora o .env local: testes isolados
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-repo-test-'));
process.env.DATA_DIR = tmp;
process.env.CACHE_DIR = path.join(tmp, 'cache');
// O erro que motivou este teste: um URL bruto colado no campo que espera
// `owner/repo`. O servico precisa DIZER que esta quebrado, nao falhar depois.
process.env.GITHUB_REPOSITORY = 'https://raw.githubusercontent.com/steamtoolsapp/ManifestHub/refs/heads/main/archive/depotkeys.json';

const APPID = '123456';
const gh = await startMockGitHub({ branch: APPID, commit: 'f'.repeat(40) });
process.env.GITHUB_API_URL = gh.url;
gh.setFiles({ [`${APPID}.manifest`]: 'manifest-conteudo' });

const { describeSources, priorityOrder, resolveOrder } = await import(
  '../src/providers/index.js'
);const { getManifests, invalidate } = await import('../src/cache.js');
const { start } = await import('../src/server.js');
const { createKey } = await import('../src/store.js');

const server = await start(0, '127.0.0.1');
const BASE = `http://127.0.0.1:${server.address().port}`;
const KEY = createKey({ name: 'repo-invalido', rateLimitPerMinute: 1000 }).key;

const get = async (url) => {
  const res = await fetch(`${BASE}${url}`);
  let body;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, headers: res.headers, body };
};

test('describe() marca a fonte como configurada mas INVALIDA', () => {
  const d = describeSources();
  const ghSrc = d.sources.find((s) => s.id === 'github');
  assert.equal(ghSrc.enabled, true);
  assert.equal(ghSrc.configured, true, 'tem valor escrito');
  assert.equal(ghSrc.valid, false, 'mas o valor nao serve');
  assert.equal(ghSrc.invalid, 'repositorio_invalido');
  assert.match(ghSrc.repository, /^https:\/\//, 'mostra o valor para o operador consertar');

  // A fonte publica continua inteira.
  const mh = d.sources.find((s) => s.id === 'manifesthub');
  assert.equal(mh.valid, true);
  assert.equal(mh.invalid, undefined);

  // Nao vaza segredo nenhum na descricao.
  const raw = JSON.stringify(d);
  assert.ok(!raw.includes('mk_'));
  assert.ok(!raw.includes('ghp_'));
  assert.ok(!raw.includes('gho_'));
});

test('a fonte invalida fica em order, mas sinalizada em sources.invalid', () => {
  // Fica na prioridade de proposito: o fallback resolve a requisicao e o
  // `attempts` mostra o que deu errado — desaparecer seria esconder o problema.
  assert.deepEqual(priorityOrder(), ['github', 'manifesthub']);
  assert.deepEqual(resolveOrder(null), ['github', 'manifesthub']);
  // A escolha explicita tambem passa: quem decide o erro e a fonte, sem rede.
  assert.deepEqual(resolveOrder('github'), ['github']);
});

test('/health diz que o repositorio esta invalido, sem depender de rede', async () => {
  const r = await get('/health');
  assert.equal(r.status, 200, 'liveness continua 200: a API responde');
  assert.equal(r.body.github.configured, true);
  assert.equal(r.body.github.valid, false, 'NAO reporta so "configured: true"');
  assert.equal(r.body.github.invalid, 'repositorio_invalido');
  assert.match(r.body.github.repository, /^https:\/\//);
  assert.equal(r.body.github.token, undefined, 'nunca expoe token');

  assert.deepEqual(r.body.sources.order, ['github', 'manifesthub']);
  assert.deepEqual(r.body.sources.invalid, [
    { source: 'github', code: 'repositorio_invalido' },
  ]);
});

test('/health?deep=1 mostra a falha do github e a saude do resto', async () => {
  const r = await get('/health?deep=1');
  assert.equal(r.status, 200, 'uma fonte boa mantem ok=true');
  const github = r.body.deep.find((x) => x.source === 'github');
  assert.equal(github.ok, false);
  assert.equal(github.code, 'repositorio_invalido');
  const mh = r.body.deep.find((x) => x.source === 'manifesthub');
  assert.equal(mh.ok, true);
});

test('/sources expoe valid/invalid para o operador consertar', async () => {
  const r = await get(`/sources?key=${KEY}`);
  assert.equal(r.status, 200);
  const ghSrc = r.body.sources.find((s) => s.id === 'github');
  assert.equal(ghSrc.configured, true);
  assert.equal(ghSrc.valid, false);
  assert.equal(ghSrc.invalid, 'repositorio_invalido');
});

test('sem source escolhido: cai na fonte boa e registra o motivo no attempts', async () => {
  invalidate(APPID);
  const meta = await getManifests(APPID);
  assert.equal(meta.source, 'manifesthub', 'fallback resolveu');
  assert.equal(meta.files.length, 1);
  assert.equal(meta.attempts.length, 1);
  assert.equal(meta.attempts[0].source, 'github');
  assert.equal(meta.attempts[0].code, 'repositorio_invalido');
});

test('source=github explicito: erro da fonte, sem rede e sem fallback', async () => {
  gh.resetCalls();
  invalidate(APPID);
  try {
    await assert.rejects(getManifests(APPID, { source: 'github' }), (err) => {
      assert.equal(err.code, 'repositorio_invalido');
      assert.equal(err.attempts.length, 1);
      return true;
    });
    assert.equal(gh.calls.branches, 0, 'nem uma chamada de rede foi feita');
  } finally {
    invalidate(APPID);
  }
});

test('GET /manifests?source=github devolve 503 repositorio_invalido', async () => {
  const r = await get(`/manifests?id=${APPID}&source=github&key=${KEY}`);
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'repositorio_invalido');
  assert.match(r.body.message, /owner\/repo/);
});

test('GET /manifests sem source entrega o ZIP pela fonte que deu certo', async () => {
  invalidate(APPID);
  const r = await get(`/manifests?id=${APPID}&key=${KEY}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'manifesthub');
  assert.equal(r.body.attempts[0].code, 'repositorio_invalido');

  const dl = await get(`/download?id=${APPID}&format=manifests&key=${KEY}`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('x-manifest-gate-source'), 'manifesthub');
});

test.after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  await gh.close();
});
