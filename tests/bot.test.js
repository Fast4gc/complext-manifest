import test from 'node:test';
import assert from 'node:assert/strict';
import { createCooldown } from '../src/bot/cooldown.js';
import { runManifestCommand, errorReply } from '../src/bot/logic.js';
import { createApiClient, ApiError, BOT_MESSAGES } from '../src/bot/apiClient.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Cooldown                                                            */
/* ------------------------------------------------------------------ */

test('cooldown bloqueia na sequencia e libera depois da janela', async () => {
  const cd = createCooldown(1);
  assert.equal(cd.check('user1').ok, true);
  cd.hit('user1');
  const blocked = cd.check('user1');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryInSec >= 1);
  assert.equal(cd.check('user2').ok, true, 'outro usuario nao afetado');
  await sleep(1100);
  assert.equal(cd.check('user1').ok, true);
});

test('cooldown 0 desabilita limite', () => {
  const cd = createCooldown(0);
  cd.hit('u');
  assert.equal(cd.check('u').ok, true);
});

/* ------------------------------------------------------------------ */
/* Fluxo do comando /manifest (sem Discord)                            */
/* ------------------------------------------------------------------ */

function stubApi() {
  const calls = [];
  return {
    calls,
    download: async (appid, opts) => {
      calls.push({ appid, ...opts });
      return { buffer: Buffer.from('addappid(730)'), filename: '730.lua', source: 'github', commit: 'abcdef123' };
    },
    listManifests: () => { throw new Error('Lua nao deve consultar/baixar manifests'); },
  };
}
const run = (api, extra = {}) => runManifestCommand({
  appid: '730', api, cooldown: createCooldown(0), userId: 'u', maxBytes: 1024, ...extra,
});

test('AppID invalido nao chama a API', async () => {
  const api = stubApi();
  assert.match((await run(api, { appid: 'abc' })).content, /AppID invalido/);
  assert.equal(api.calls.length, 0);
});
test('cooldown impede repetir download', async () => {
  const api = stubApi();
  const cooldown = createCooldown(60);
  await run(api, { cooldown });
  assert.match((await run(api, { cooldown })).content, /Aguarde/);
  assert.equal(api.calls.length, 1);
});
test('bot entrega Lua original e proveniencia sem listar manifests', async () => {
  const api = stubApi();
  const progress = [];
  const result = await run(api, { source: 'github', onProgress: (s) => progress.push(s) });
  assert.equal(result.files[0].name, '730.lua');
  assert.equal(result.files[0].attachment.toString(), 'addappid(730)');
  assert.match(result.content, /abcdef1/);
  assert.match(result.content, /fonte `github`/);
  assert.equal(api.calls[0].source, 'github');
  assert.match(progress[0], /Baixando Lua/);
});
test('ausencia de Lua propaga erro amigavel sem substituicao por manifests', async () => {
  const api = stubApi();
  api.download = async () => { throw new ApiError('sem_lua', BOT_MESSAGES.sem_lua, 404); };
  await assert.rejects(run(api), (e) => e.code === 'sem_lua');
});
test('Lua grande oferece link da fonte resolvida', async () => {
  const api = stubApi();
  api.createLink = async (_id, opts) => {
    assert.equal(opts.source, 'github');
    return { url: 'https://api.test/links/test', expiresAt: '2030-01-01T00:00:00Z' };
  };
  const result = await run(api, { maxBytes: 1 });
  assert.equal(result.files, undefined);
  assert.match(result.content, /https:\/\/api.test\/links\/test/);
});
test('Lua grande sem links aponta API', async () => {
  const result = await run(stubApi(), { maxBytes: 1 });
  assert.equal(result.files, undefined);
  assert.match(result.content, /GET \/download/);
});
test('link indisponivel preserva fallback de API', async () => {
  const api = stubApi();
  api.createLink = async () => { throw new ApiError('link_desabilitado', 'indisponivel'); };
  assert.match((await run(api, { maxBytes: 1 })).content, /GET \/download/);
});

test('errorReply: ApiError vira texto amigavel; erro desconhecido vira generico', () => {
  assert.equal(errorReply(new ApiError('sem_manifests', BOT_MESSAGES.sem_manifests)), BOT_MESSAGES.sem_manifests);
  assert.match(errorReply(new Error('stack secreta com mk_' + 'c'.repeat(32))), /Erro interno/);
});

/* ------------------------------------------------------------------ */
/* Cliente de API                                                      */
/* ------------------------------------------------------------------ */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });

test('cliente: lista com sucesso', async () => {
  const api = createApiClient({
    baseUrl: 'http://api.test/',
    key: 'mk_' + 'a'.repeat(32),
    fetchImpl: async (url) => {
      assert.ok(url.startsWith('http://api.test/manifests?id=730'));
      return json({ count: 2 });
    },
  });
  const body = await api.listManifests('730');
  assert.equal(body.count, 2);
});

test('cliente: erro da API vira ApiError com codigo e mensagem amigavel', async () => {
  const api = createApiClient({
    baseUrl: 'http://api.test',
    key: 'mk_' + 'a'.repeat(32),
    fetchImpl: async () => json({ error: 'sem_manifests' }, 404),
  });
  await assert.rejects(api.listManifests('730'), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.code, 'sem_manifests');
    assert.equal(err.status, 404);
    return true;
  });
});

test('cliente: resposta nao-JSON vira resposta_invalida', async () => {
  const api = createApiClient({
    baseUrl: 'http://api.test',
    key: 'mk_' + 'a'.repeat(32),
    fetchImpl: async () => new Response('<html>proxy</html>', { status: 502 }),
  });
  await assert.rejects(api.listManifests('730'), (err) => err.code === 'resposta_invalida');
});

test('cliente: falha de rede vira api_indisponivel', async () => {
  const api = createApiClient({
    baseUrl: 'http://api.test',
    key: 'mk_' + 'a'.repeat(32),
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  await assert.rejects(api.listManifests('730'), (err) => err.code === 'api_indisponivel');
});

test('cliente: timeout vira timeout', async () => {
  const api = createApiClient({
    baseUrl: 'http://api.test',
    key: 'mk_' + 'a'.repeat(32),
    timeoutMs: 30,
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  });
  await assert.rejects(api.listManifests('730'), (err) => err.code === 'timeout');
});

test('cliente: download devolve Buffer e nome de arquivo', async () => {
  const api = createApiClient({
    baseUrl: 'http://api.test',
    key: 'mk_' + 'a'.repeat(32),
    fetchImpl: async (url) => {
      assert.ok(url.includes('/download?id=730'));
      return new Response(Buffer.from('addappid(730)'), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="730.lua"' },
      });
    },
  });
  const { buffer, filename } = await api.download('730');
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(filename, '730.lua');
});

test('cliente: a chave nunca aparece nas mensagens de erro', async () => {
  const key = 'mk_' + 'd'.repeat(32);
  const api = createApiClient({
    baseUrl: 'http://api.test',
    key,
    fetchImpl: async () => {
      throw new Error(`falha com chave ${key} no meio`);
    },
  });
  try {
    await api.listManifests('730');
    assert.fail('deveria lancar');
  } catch (err) {
    assert.equal(err.message.includes(key), false);
    assert.equal((err.stack || '').includes(key), false);
  }
});

test('cliente rejeita ZIP de uma API antiga em vez de renomear para Lua', async () => {
  const api = createApiClient({ baseUrl: 'http://api.test', key: 'test', fetchImpl: async () =>
    new Response('PK..', { headers: { 'content-type': 'application/zip' } }) });
  await assert.rejects(api.download('730'), (e) => e.code === 'resposta_invalida');
});
