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
  const calls = { list: 0, download: 0, link: 0, listOpts: [], downloadOpts: [] };
  const api = {
    calls,
    listManifests: async (appid, opts) => {
      calls.list += 1;
      calls.listOpts.push(opts ?? {});
      return overrides.list ?? { count: 1, commit: 'abcdef123456', totalBytes: 10, stale: false };
    },
    download: async (appid, opts) => {
      calls.download += 1;
      calls.downloadOpts.push(opts ?? {});
      return overrides.download ?? { buffer: Buffer.from('zip-bytes'), filename: 'x.zip' };
    },
  };
  if (overrides.link !== null) {
    api.createLink = async (appid, opts) => {
      calls.link += 1;
      calls.linkOpts = opts ?? {};
      return (
        overrides.link ?? {
          url: 'http://api.test/links/abc.def.ghi',
          expiresAt: '2030-01-01T00:00:00.000Z',
        }
      );
    };
  }
  return api;
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
    link: null, // servidor sem PUBLIC_BASE_URL: sem link disponivel
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

test('ZIP acima do limite: oferece link temporario com expiracao', async () => {
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
  assert.match(res.content, /<http:\/\/api\.test\/links\/abc\.def\.ghi>/);
  assert.match(res.content, /Expira em/);
  assert.equal(res.files, undefined, 'nao anexa o ZIP');
  assert.equal(api.calls.link, 1);
});

test('ZIP grande com link recusado pela API cai no aviso sem vazar erro', async () => {
  const api = stubApi({
    list: { count: 3, totalBytes: 9 * 1024 * 1024 },
    download: { buffer: Buffer.alloc(9 * 1024 * 1024), filename: 'big.zip' },
    link: null,
  });
  // Simula o servidor com PUBLIC_BASE_URL ligado mas LINK_SECRET ausente.
  api.createLink = async () => {
    throw new ApiError('link_desabilitado', BOT_MESSAGES.link_desabilitado, 503);
  };
  const res = await runManifestCommand({
    appid: '730',
    api,
    cooldown: createCooldown(30),
    userId: 'u',
    maxBytes: 8 * 1024 * 1024,
  });
  assert.match(res.content, /GET \/download/);
  assert.doesNotMatch(res.content, /link_desabilitado/, 'codigo interno nao vaza');
  assert.equal(res.files, undefined);
});

test('fonte escolhida e repassada para listagem e download', async () => {
  const api = stubApi();
  await runManifestCommand({
    appid: '730',
    api,
    cooldown: createCooldown(0),
    userId: 'u',
    maxBytes: 1024 * 1024,
    source: 'manifesthub',
  });
  assert.equal(api.calls.listOpts[0].source, 'manifesthub');
  assert.equal(api.calls.downloadOpts[0].source, 'manifesthub');
});

test('sem fonte escolhida, nao manda source undefined explicito', async () => {
  const api = stubApi();
  await runManifestCommand({
    appid: '730',
    api,
    cooldown: createCooldown(0),
    userId: 'u',
    maxBytes: 1024 * 1024,
  });
  assert.equal(api.calls.listOpts[0].source, undefined);
  assert.equal(api.calls.downloadOpts[0].source, undefined);
});

test('confirma a solicitacao enquanto processa (onProgress)', async () => {
  const api = stubApi();
  const progress = [];
  await runManifestCommand({
    appid: '730',
    api,
    cooldown: createCooldown(0),
    userId: 'u',
    maxBytes: 1024 * 1024,
    source: 'github',
    onProgress: (text) => progress.push(text),
  });
  assert.equal(progress.length, 2, 'uma antes de listar e outra antes de baixar');
  assert.match(progress[0], /730/);
  assert.match(progress[0], /`github`/);
  assert.match(progress[1], /manifest\(s\) localizados/);
  assert.match(progress[1], /Baixando o ZIP/);
});

test('resumo traz proveniencia e avisa sobre arquivos de configuracao', async () => {
  const api = stubApi({
    list: {
      count: 1,
      commit: 'abcdef1234567890',
      version: 'abcdef1234567890',
      source: 'manifesthub',
      origin: 'steamtoolsapp/ManifestHub',
      totalBytes: 10,
      stale: true,
      configCount: 1,
      configFiles: [
        {
          name: '730.lua',
          containsKeys: true,
          warning: 'Contem chaves de descriptografia de depot.',
          rawUrl: 'https://raw.githubusercontent.com/steamtoolsapp/ManifestHub/refs/heads/730/730.lua',
        },
      ],
    },
  });
  const res = await runManifestCommand({
    appid: '730',
    api,
    cooldown: createCooldown(0),
    userId: 'u',
    maxBytes: 1024 * 1024,
  });
  assert.match(res.content, /fonte `manifesthub`/);
  assert.match(res.content, /repo `steamtoolsapp\/ManifestHub`/);
  assert.match(res.content, /commit `abcdef1`/);
  assert.match(res.content, /cache antigo/);
  assert.match(res.content, /chaves de depot/, 'avisa por que o .lua nao veio');
  assert.match(res.content, /730\.lua/);
  assert.match(res.content, /https:\/\/raw\.githubusercontent\.com/);
  assert.equal(res.files.length, 1, 'so o .manifest vai no anexo');
});

test('sem manifests mas com config: explica o que existe e por que nao veio', async () => {
  const api = stubApi({
    list: {
      count: 0,
      configCount: 2,
      configFiles: [{ name: '730.lua' }, { name: '730.json' }],
    },
  });
  const res = await runManifestCommand({
    appid: '730',
    api,
    cooldown: createCooldown(0),
    userId: 'u',
    maxBytes: 1024 * 1024,
  });
  assert.match(res.content, /Nenhum \.manifest/);
  assert.match(res.content, /chaves de depot/);
  assert.match(res.content, /730\.lua/);
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
