import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { startMockGitHub } from './mockGitHub.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-links-test-'));
process.env.ENV_FILE = '/nonexistent/mg-tests.env'; // ignora o .env local: testes isolados
process.env.DATA_DIR = tmp;
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.GITHUB_REPOSITORY = 'teste/manifests';
process.env.ADMIN_TOKEN = 'token-admin-de-teste';
process.env.PUBLIC_BASE_URL = 'https://manifest.example';
process.env.LINK_SECRET = 'segredo-de-teste-que-nao-vaza';
process.env.LINK_TTL_SECONDS = '600';
process.env.LINK_TTL_MAX_SECONDS = '86400';

const APPID = '123456';
const gh = await startMockGitHub({ branch: APPID, commit: 'c'.repeat(40) });
process.env.GITHUB_API_URL = gh.url;
gh.setFiles({
  [`${APPID}.manifest`]: 'manifest-conteudo-links',
  'key.vdf': '"DepotKeys"\n{\n"Depot732" { "DecryptionKey" "abcdef" }\n}',
});

const { start } = await import('../src/server.js');
const { createLink, readLink, linksEnabled, linksStatus, LINK_CODES } = await import(
  '../src/links.js'
);
const { createKey } = await import('../src/store.js');

const server = await start(0, '127.0.0.1');
const BASE = `http://127.0.0.1:${server.address().port}`;
const KEY = createKey({ name: 'links', rateLimitPerMinute: 1000 }).key;

const json = async (url, opts) => {
  const res = await fetch(`${BASE}${url}`, opts);
  let body;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
};

const post = (url, body, headers = {}) =>
  json(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ format: 'manifests', ...body }),
  });

/* ------------------------------------------------------------------ */
/* Unidade: emissao e leitura do token                                 */
/* ------------------------------------------------------------------ */

test('links ligados com PUBLIC_BASE_URL e segredo', () => {
  assert.equal(linksEnabled(), true);
  const st = linksStatus();
  assert.equal(st.enabled, true);
  assert.equal(st.publicBaseUrl, 'https://manifest.example');
  assert.equal(st.defaultTtlSeconds, 600);
  assert.equal(st.maxTtlSeconds, 86400);
  assert.equal(st.secretConfigured, true);
});

test('createLink monta token assinado com expiracao', () => {
  const before = Date.now();
  const link = createLink({ source: 'manifesthub', appid: '730', createdBy: 'chave-1' });

  assert.match(link.token, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(link.url, `https://manifest.example/links/${link.token}`);

  const ttl = (Date.parse(link.expiresAt) - before) / 1000;
  assert.ok(ttl > 540 && ttl <= 610, `ttl ~600s, veio ${ttl}`);
  assert.equal(link.ttlSeconds, 600);

  // O token carrega tudo o que autoriza — e nada alem.
  const scope = readLink(link.token);
  assert.equal(scope.source, 'manifesthub');
  assert.equal(scope.appid, '730');
  assert.equal(scope.createdBy, 'chave-1');
  assert.equal(scope.expiresAt, link.expiresAt);
  assert.ok(!Number.isNaN(Date.parse(scope.createdAt)));
  const decoded = JSON.parse(
    Buffer.from(link.token.split('.')[1], 'base64url').toString('utf8'),
  );
  const keys = Object.keys(decoded).sort();
  assert.deepEqual(keys, ['a', 'c', 'e', 's', 'u'], 'sem campos extra');
  assert.ok(!JSON.stringify(decoded).includes('mk_'), 'sem chave de API');
});

test('ttl fora dos limites e recusado', () => {
  for (const ttl of [59, 0, -1, 86401, 'abc', NaN]) {
    assert.throws(
      () => createLink({ source: 'github', appid: '730', ttlSeconds: ttl }),
      (err) => err.code === 'link_ttl_invalido',
      `ttl=${ttl} deveria ser recusado`,
    );
  }
  // Dentro do intervalo passa: 60s e o minimo, 86400s o teto configurado.
  assert.equal(createLink({ source: 'github', appid: '730', ttlSeconds: 60 }).ttlSeconds, 60);
  assert.equal(
    createLink({ source: 'github', appid: '730', ttlSeconds: 86400 }).ttlSeconds,
    86400,
  );
});

test('token adulterado nao abre', () => {
  const link = createLink({ source: 'github', appid: '730' });
  const [, payload, mac] = link.token.split('.');

  // 1. payload trocado (outro AppID) com a assinatura antiga
  const evilPayload = Buffer.from(
    JSON.stringify({ s: 'github', a: '1', e: Math.floor(Date.now() / 1000) + 600, c: 1 }),
  ).toString('base64url');
  assert.throws(
    () => readLink(`v1.${evilPayload}.${mac}`),
    (err) => err.code === 'link_invalido',
  );

  // 2. assinatura trocada
  assert.throws(
    () => readLink(`v1.${payload}.${'A'.repeat(43)}`),
    (err) => err.code === 'link_invalido',
  );

  // 3. formato quebrado
  for (const bad of ['', 'lixo', 'v1.a', 'v2.a.b', `v1.${payload}.${mac}.x`, 'a.b.c', null, 42]) {
    assert.throws(
      () => readLink(bad),
      (err) => err.code === 'link_invalido',
      `token=${String(bad)} deveria ser recusado`,
    );
  }

  // 4. token gigante (nao vira pre alocação)
  assert.throws(
    () => readLink('v1.' + 'x'.repeat(3000)),
    (err) => err.code === 'link_invalido',
  );
});

test('token vencido responde link_expirado', () => {
  // Mesma receita do servidor, com o mesmo segredo, porem ja vencido.
  const key = crypto.createHash('sha256').update('segredo-de-teste-que-nao-vaza').digest();
  const payload = {
    s: 'github',
    a: '730',
    e: Math.floor(Date.now() / 1000) - 10,
    c: Math.floor(Date.now() / 1000) - 700,
  };
  const pb = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', key).update(pb).digest('base64url');
  const token = `v1.${pb}.${mac}`;

  assert.throws(
    () => readLink(token),
    (err) => {
      assert.equal(err.code, 'link_expirado');
      assert.equal(LINK_CODES.link_expirado, err.message);
      return true;
    },
    'assinatura valida mas data vencida nao abre',
  );
});

/* ------------------------------------------------------------------ */
/* HTTP: emissao                                                       */
/* ------------------------------------------------------------------ */

test('POST /links exige chave de API', async () => {
  const r = await post('/links', { id: APPID });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'formato_de_chave_invalido');
});

test('POST /links emite link temporario e consome 1 uso', async () => {
  const oneUse = createKey({ name: 'uso-unico', maxUses: 1, rateLimitPerMinute: 1000 });
  const r = await post('/links', { id: APPID }, { 'X-API-Key': oneUse.key });
  assert.equal(r.status, 201);
  assert.match(r.body.url, /^https:\/\/manifest\.example\/links\/v1\./);
  assert.ok(!Number.isNaN(Date.parse(r.body.expiresAt)));
  assert.equal(r.body.ttlSeconds, 600);
  assert.deepEqual(r.body.scope, { id: APPID, source: 'github', format: 'manifests' });
  assert.match(r.body.note, /assinado/i);
  assert.ok(!JSON.stringify(r.body).includes(oneUse.key), 'chave nao volta na resposta');

  // O link em si ja e um download: nao da pra emitir dois com uma unica chave.
  const again = await post('/links', { id: APPID }, { 'X-API-Key': oneUse.key });
  assert.equal(again.status, 403);
  assert.equal(again.body.error, 'limite_de_usos_atingido');
});

test('POST /links com fonte e ttl customizados', async () => {
  const r = await post('/links', { id: APPID, source: 'manifesthub', ttl: 120 }, { 'X-API-Key': KEY });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.scope, { id: APPID, source: 'manifesthub', format: 'manifests' });
  assert.equal(r.body.ttlSeconds, 120);
  const scope = readLink(r.body.url.split('/links/')[1]);
  assert.equal(scope.source, 'manifesthub');
});

test('POST /links com ttl invalido responde 400 link_ttl_invalido', async () => {
  const r = await post('/links', { id: APPID, ttl: 5 }, { 'X-API-Key': KEY });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'link_ttl_invalido');
  assert.match(r.body.message, /validade/i);
});

test('POST /links com AppID invalido responde 400', async () => {
  const r = await post('/links', { id: 'abc' }, { 'X-API-Key': KEY });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'appid_invalido');
});

test('POST /links com fonte desconhecida responde o erro da fonte', async () => {
  const r = await post('/links', { id: APPID, source: 'nope' }, { 'X-API-Key': KEY });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'fonte_desconhecida');
});

test('POST /links nao promete o que nao existe: AppID sem branch recusa o link', async () => {
  const r = await post('/links', { id: '999999' }, { 'X-API-Key': KEY });
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'branch_nao_encontrada');
});

/* ------------------------------------------------------------------ */
/* HTTP: uso do link                                                   */
/* ------------------------------------------------------------------ */

test('GET /links/:token entrega o ZIP sem chave de API', async () => {
  const emitted = await post('/links', { id: APPID }, { 'X-API-Key': KEY });
  const token = emitted.body.url.split('/links/')[1];

  const res = await fetch(`${BASE}/links/${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.equal(res.headers.get('x-manifest-gate-source'), 'github');
  assert.equal(res.headers.get('x-manifest-gate-origin'), 'teste/manifests');

  const entries = new AdmZip(Buffer.from(await res.arrayBuffer()))
    .getEntries()
    .map((e) => e.entryName);
  assert.deepEqual(entries, [`${APPID}.manifest`], 'só .manifest, sem chave');
});

test('GET /links/:token adulterado responde 400 link_invalido', async () => {
  const emitted = await post('/links', { id: APPID }, { 'X-API-Key': KEY });
  const token = emitted.body.url.split('/links/')[1];
  const [v, payload] = token.split('.');
  const res = await fetch(`${BASE}/links/${v}.${payload}.${'A'.repeat(43)}`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'link_invalido');
  assert.match(body.message, /adulterado/i);
});

test('GET /links/:token vencido responde 410 link_expirado', async () => {
  const key = crypto.createHash('sha256').update('segredo-de-teste-que-nao-vaza').digest();
  const payload = {
    s: 'github',
    a: APPID,
    e: Math.floor(Date.now() / 1000) - 5,
    c: Math.floor(Date.now() / 1000) - 700,
  };
  const pb = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', key).update(pb).digest('base64url');

  const res = await fetch(`${BASE}/links/v1.${pb}.${mac}`);
  assert.equal(res.status, 410);
  const body = await res.json();
  assert.equal(body.error, 'link_expirado');
  assert.match(body.message, /expirado/i);
});

test('rate limit por IP vale tambem para o link', async () => {
  const emitted = await post('/links', { id: APPID }, { 'X-API-Key': KEY });
  const token = emitted.body.url.split('/links/')[1];
  let blocked = null;
  for (let i = 0; i < 70; i += 1) {
    const res = await fetch(`${BASE}/links/${token}`);
    if (res.status === 429) {
      blocked = res;
      break;
    }
  }
  assert.ok(blocked, 'depois de 60 pedidos em um minuto, bloqueia');
  const body = await blocked.json();
  assert.equal(body.error, 'limite_de_requisicoes');
});

test.after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  await gh.close();
});
