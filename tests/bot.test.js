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

function stubApi(overrides = {}) {
  const calls = { list: 0, download: 0 };
  return {
    calls,
    listManifests: async () => {
      calls.list += 1;
      return overrides.list ?? { count: 1, commit: 'abcdef123456', totalBytes: 10, stale: false };
    },
    download: async () => {
      calls.download += 1;
      return overrides.download ?? { buffer: Buffer.from('zip-bytes'), filename: 'x.zip' };
    },
  };
}

test('AppID invalido responde aviso sem chamar a API', async () => {
  const api = stubApi();
  const res = await runManifestCommand({
    appid: 'abc',
    api,
    cooldown: createCooldown(30),
    userId: 'u1',
    maxBytes: 1024,
  });
  assert.match(res.content, /AppID invalido/);
  assert.equal(api.calls.list, 0);
});

test('cooldown responde tempo de espera', async () => {
  const api = stubApi();
  const cd = createCooldown(60);
  await runManifestCommand({ appid: '730', api, cooldown: cd, userId: 'u1', maxBytes: 1024 });
  const res = await runManifestCommand({ appid: '730', api, cooldown: cd, userId: 'u1', maxBytes: 1024 });
  assert.match(res.content, /Aguarde/);
  assert.equal(api.calls.list, 1, 'nao consultou a API de novo');
});

test('sem manifests: resposta amigavel', async () => {
  const api = stubApi({ list: { count: 0 } });
  const res = await runManifestCommand({
    appid: '730',
    api,
    cooldown: createCooldown(30),
    userId: 'u',
    maxBytes: 1024,
  });
  assert.match(res.content, /Nenhum \.manifest/);
  assert.equal(api.calls.download, 0);
});

test('sucesso devolve anexo com ZIP e resumo do commit', async () => {
  const api = stubApi();
  const res = await runManifestCommand({
    appid: '730',
    api,
    cooldown: createCooldown(30),
    userId: 'u',
    maxBytes: 1024 * 1024,
  });
  assert.match(res.content, /abcdef1/);
  assert.equal(res.files.length, 1);
  assert.equal(res.files[0].name, 'x.zip');
  assert.ok(Buffer.isBuffer(res.files[0].attachment));
});

test('ZIP acima do limite do Discord: avisa sem anexar', async () => {
  const api = stubApi({
    list: { count: 3, commit: 'abcdef123456', totalBytes: 9 * 1024 * 1024, stale: false },
    download: { buffer: Buffer.alloc(9 * 1024 * 1024), filename: 'big.zip' },
  });
  const res = await runManifestCommand({
    appid: '730',
    api,
    cooldown: createCooldown(30),
    userId: 'u',
    maxBytes: 8 * 1024 * 1024,
  });
  assert.match(res.content, /limite de anexo do Discord/);
  assert.match(res.content, /GET \/download/);
  assert.equal(res.files, undefined);
});

test('erro da API propaga com mensagem amigavel', async () => {
  const api = {
    listManifests: async () => {
      throw new ApiError('github_rate_limit', BOT_MESSAGES.github_rate_limit, 503);
    },
  };
  await assert.rejects(
    runManifestCommand({ appid: '730', api, cooldown: createCooldown(0), userId: 'u', maxBytes: 1 }),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, 'github_rate_limit');
      assert.match(err.message, /GitHub/);
      return true;
    },
  );
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
      return new Response(Buffer.from('PK..zip'), {
        status: 200,
        headers: { 'content-type': 'application/zip' },
      });
    },
  });
  const { buffer, filename } = await api.download('730');
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(filename, 'appid-730-manifests.zip');
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
