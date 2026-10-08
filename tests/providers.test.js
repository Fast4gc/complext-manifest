import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockGitHub } from './mockGitHub.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-prov-test-'));
process.env.ENV_FILE = '/nonexistent/mg-tests.env'; // ignora o .env local: testes isolados
process.env.DATA_DIR = tmp;
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.GITHUB_REPOSITORY = 'teste/manifests';
process.env.CACHE_TTL_SECONDS = '600';
process.env.REQUEST_TIMEOUT_MS = '600';
// SOURCE_PRIORITY nao definido: usa o padrao 'github,manifesthub'.

const APPID = '123456';
const gh = await startMockGitHub({ branch: APPID, commit: 'b'.repeat(40) });
process.env.GITHUB_API_URL = gh.url;

const { getManifests, invalidate } = await import('../src/cache.js');
const { SourceError } = await import('../src/githubSource.js');
const {
  withFallback,
  resolveOrder,
  describeSources,
  priorityOrder,
  LOUD_CODES,
} = await import('../src/providers/index.js');
const { start } = await import('../src/server.js');

gh.setFiles({
  [`${APPID}.manifest`]: 'manifest-conteudo',
  'key.vdf': '"DepotKeys"\n{\n"Depot732" { "DecryptionKey" "abcdef" }\n}',
  '999.lua': 'chave lua nao deve ser baixada',
});

/* ------------------------------------------------------------------ */
/* Logica de fallback (sem rede)                                       */
/* ------------------------------------------------------------------ */

const boom = (code) => new SourceError(code, `falhou: ${code}`);

test('withFallback: a primeira fonte que responde vence', async () => {
  const tried = [];
  const r = await withFallback(['a', 'b', 'c'], async (id) => {
    tried.push(id);
    if (id === 'b') return 'ok';
    throw boom('branch_nao_encontrada');
  });
  assert.equal(r.source, 'b');
  assert.equal(r.value, 'ok');
  assert.deepEqual(tried, ['a', 'b'], 'parou na segunda');
  assert.deepEqual(r.attempts.map((a) => a.source), ['a']);
  assert.equal(r.attempts[0].ok, false);
  assert.equal(r.attempts[0].code, 'branch_nao_encontrada');
});

test('withFallback: se tudo falha, sobe o erro da primeira prioridade + tentativas', async () => {
  await assert.rejects(
    withFallback(['a', 'b'], async (id) => {
      throw boom(id === 'a' ? 'branch_nao_encontrada' : 'github_timeout');
    }),
    (err) => {
      assert.equal(err.code, 'branch_nao_encontrada', 'a primeira fonte decide');
      assert.equal(err.attempts.length, 2);
      assert.deepEqual(err.attempts.map((a) => a.code), [
        'branch_nao_encontrada',
        'github_timeout',
      ]);
      return true;
    },
  );
});

test('withFallback: falha ruidosa (auth) so sobe se todas falharem', async () => {
  // auth na fonte A, mas a B da certo: resultado vem, e a auth fica visivel.
  const r = await withFallback(['a', 'b'], async (id) => {
    if (id === 'a') throw boom('github_auth');
    return 'ok';
  });
  assert.equal(r.value, 'ok');
  assert.equal(r.attempts[0].code, 'github_auth');
  assert.ok(LOUD_CODES.has('github_auth'));

  // todas falham: o ruidoso vence o generico.
  await assert.rejects(
    withFallback(['a', 'b'], async () => {
      throw boom('github_auth');
    }),
    (err) => {
      assert.equal(err.code, 'github_auth');
      assert.equal(err.attempts.length, 2);
      return true;
    },
  );
});

test('withFallback: lista de fontes vazia e erro claro', async () => {
  await assert.rejects(withFallback([], async () => 'x'), (err) => {
    assert.equal(err.code, 'nenhuma_fonte');
    return true;
  });
});

/* ------------------------------------------------------------------ */
/* Escolha de fonte                                                     */
/* ------------------------------------------------------------------ */

test('prioridade padrao: github (do operador) antes do manifesthub', () => {
  assert.deepEqual(priorityOrder(), ['github', 'manifesthub']);
  assert.deepEqual(resolveOrder(null), ['github', 'manifesthub']);
});

test('source explicito NAO cai para outra fonte', () => {
  assert.deepEqual(resolveOrder('manifesthub'), ['manifesthub']);
  assert.deepEqual(resolveOrder('github'), ['github']);
});

test('source desconhecida vira fonte_desconhecida', () => {
  assert.throws(
    () => resolveOrder('steamtools'),
    (err) => err.code === 'fonte_desconhecida',
  );
  assert.throws(
    () => resolveOrder('MANIFESTHUB'), // case sensitive: id e lowercase
    (err) => err.code === 'fonte_desconhecida',
  );
});

test('/sources expoe a ordem efetiva e o que cada fonte nao faz', () => {
  const d = describeSources();
  assert.deepEqual(d.order, ['github', 'manifesthub']);
  assert.deepEqual(d.configuredOrder, ['github', 'manifesthub']);
  for (const s of d.sources) {
    assert.equal(s.kind, 'github-branch');
    assert.equal(s.listsAllBranches, false, 'nunca listamos todas as branches');
    assert.ok(Array.isArray(s.cannot));
    // Nunca vaza token na descricao.
    assert.equal(typeof s.auth, 'boolean');
  }
  assert.equal(d.unknown, undefined, 'sem id desconhecido na prioridade');
});

/* ------------------------------------------------------------------ */
/* Integracao: fonte que some, auth e rate limit                        */
/* ------------------------------------------------------------------ */

test('fallback real: fonte do operador ausente, manifesthub responde', async () => {
  invalidate(APPID);
  gh.clearRepo404();
  gh.setRepo404('teste/manifests'); // github nao tem esse repo

  const meta = await getManifests(APPID);
  assert.equal(meta.source, 'manifesthub', 'caiu para a segunda fonte');
  assert.equal(meta.origin, 'steamtoolsapp/ManifestHub');
  assert.equal(meta.version, 'b'.repeat(40));
  assert.equal(meta.files.length, 1);
  assert.equal(meta.attempts.length, 1);
  assert.equal(meta.attempts[0].source, 'github');
  assert.equal(meta.attempts[0].code, 'branch_nao_encontrada');

  // Nenhuma chave no disco, nem na listagem.
  const listed = JSON.stringify(meta).toLowerCase();
  assert.ok(!listed.includes('key.vdf'));
  assert.ok(!listed.includes('decryptionkey'));
  const filesOnDisk = fs.readdirSync(path.join(tmp, 'cache', 'manifesthub', APPID, 'files'));
  assert.deepEqual(filesOnDisk, [`${APPID}.manifest`]);

  gh.clearRepo404();
});

test('source explicito na fonte ausente: erro dela, sem fallback', async () => {
  invalidate(APPID);
  gh.setRepo404('teste/manifests');
  try {
    await assert.rejects(getManifests(APPID, { source: 'github' }), (err) => {
      assert.ok(err instanceof SourceError);
      assert.equal(err.code, 'branch_nao_encontrada');
      assert.equal(err.attempts.length, 1, 'so a fonte pedida foi consultada');
      assert.equal(err.attempts[0].source, 'github');
      return true;
    });
  } finally {
    gh.clearRepo404();
    invalidate(APPID);
  }
});

test('credencial recusada vira github_auth, nunca "indisponivel"', async () => {
  invalidate(APPID);
  gh.setMode('auth');
  try {
    await assert.rejects(getManifests(APPID), (err) => {
      assert.equal(err.code, 'github_auth');
      assert.match(err.message, /credenciais/i);
      assert.equal(err.attempts.length, 2, 'as duas fontes foram consultadas');
      assert.ok(err.attempts.every((a) => a.code === 'github_auth'));
      return true;
    });
  } finally {
    gh.setMode('ok');
    invalidate(APPID);
  }
});

test('rate limit vira github_rate_limit com o horario de reset', async () => {
  invalidate(APPID);
  gh.setMode('rate_limit');
  try {
    await assert.rejects(getManifests(APPID), (err) => {
      assert.equal(err.code, 'github_rate_limit');
      assert.match(err.message, /Limit/i);
      assert.equal(err.attempts.length, 2);
      assert.ok(err.detail?.reset, 'informa quando volta a cota');
      assert.ok(LOUD_CODES.has('github_rate_limit'));
      return true;
    });
  } finally {
    gh.setMode('ok');
    invalidate(APPID);
  }
});

test('rede fora do ar vira github_indisponivel e as tentativas ficam visiveis', async () => {
  invalidate(APPID);
  gh.setMode('down');
  try {
    await assert.rejects(getManifests(APPID), (err) => {
      assert.equal(err.code, 'github_indisponivel');
      assert.equal(err.attempts.length, 2);
      assert.ok(err.attempts.every((a) => a.code === 'github_indisponivel'));
      return true;
    });
  } finally {
    gh.setMode('ok');
    invalidate(APPID);
  }
});

/* ------------------------------------------------------------------ */
/* Integracao HTTP: escolha de fonte pela API                           */
/* ------------------------------------------------------------------ */

const server = await start(0, '127.0.0.1');
const BASE = `http://127.0.0.1:${server.address().port}`;
const { createKey } = await import('../src/store.js');
const KEY = createKey({ name: 'prov', rateLimitPerMinute: 1000 }).key;

const get = async (url) => {
  const res = await fetch(`${BASE}${url}`);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
};

test('GET /manifests?source= inexistente responde 400 fonte_desconhecida', async () => {
  const r = await get(`/manifests?id=${APPID}&source=steamtools&key=${KEY}`);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'fonte_desconhecida');
  assert.match(r.body.message, /desconhecida/i);
});

test('GET /manifests?source= valida escolhe a fonte e registra origem', async () => {
  invalidate(APPID);
  const r = await get(`/manifests?id=${APPID}&source=manifesthub&key=${KEY}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'manifesthub');
  assert.equal(r.body.origin, 'steamtoolsapp/ManifestHub');
  assert.deepEqual(
    r.body.attempts.map((a) => a.source),
    [],
    'fonte pedida respondeu de primeira: nenhuma tentativa anterior',
  );
  assert.equal(r.body.download, `/download?id=${APPID}&source=manifesthub`);
});

test('GET /manifests sem source usa a prioridade e registra fallback', async () => {
  invalidate(APPID);
  gh.setRepo404('teste/manifests');
  try {
    const r = await get(`/manifests?id=${APPID}&key=${KEY}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.source, 'manifesthub');
    assert.equal(r.body.attempts[0].source, 'github');
    assert.equal(r.body.attempts[0].code, 'branch_nao_encontrada');
  } finally {
    gh.clearRepo404();
    invalidate(APPID);
  }
});

test('GET /manifests?source= na fonte ausente devolve o erro dela (sem fallback)', async () => {
  invalidate(APPID);
  gh.setRepo404('teste/manifests');
  try {
    const r = await get(`/manifests?id=${APPID}&source=github&key=${KEY}`);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'branch_nao_encontrada');
    assert.equal(r.body.attempts.length, 1);
  } finally {
    gh.clearRepo404();
    invalidate(APPID);
  }
});

test.after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  await gh.close();
});
