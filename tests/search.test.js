import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-search-test-'));
process.env.ENV_FILE = '/nonexistent/mg-tests.env'; // ignora o .env local: testes isolados
process.env.DATA_DIR = tmp;
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ADMIN_TOKEN = 'token-admin-de-teste';
process.env.SEARCH_TIMEOUT_MS = '250';
process.env.SEARCH_LIMIT = '3';
process.env.SEARCH_TTL_SECONDS = '600';

/* ------------------------------------------------------------------ */
/* Loja da Steam simulada (mesmo formato da real, verificado ao vivo)   */
/* ------------------------------------------------------------------ */

const store = {
  mode: 'ok',
  calls: 0,
  lastTerm: null,
  items: [
    { type: 'app', name: 'Counter-Strike 2', id: 730 },
    { type: 'dlc', name: 'Counter-Strike 2 Upgrade', id: 999999, price: { final: 499 } },
    { type: 'app', name: 'id quebrado', id: 'nao-e-numero' },
    { type: 'app', name: 'Sem id', semId: true },
    { type: 'app', name: 'Counter Extra A', id: 111 },
    { type: 'app', name: 'Counter Extra B', id: 222 },
  ],
};

const storeServer = http.createServer((req, res) => {
  store.calls += 1;
  const url = new URL(req.url, 'http://localhost');
  if (store.mode === 'down') {
    res.destroy();
    return;
  }
  if (store.mode === 'slow') {
    setTimeout(() => finish(res), 2000);
    return;
  }
  finish(res);

  function finish(r) {
    // Aceita o prefixo configurado (ex.: /api/storesearch/).
    if (!url.pathname.endsWith('/storesearch/')) {
      r.writeHead(404, { 'content-type': 'application/json' });
      return r.end('{"error":"not found"}');
    }
    const term = url.searchParams.get('term') || '';
    store.lastTerm = term;
    if (store.mode === 'bad-json') {
      r.writeHead(200, { 'content-type': 'application/json' });
      return r.end('<html>pagina de erro</html>');
    }
    // Termo "counter" devolve o lote inteiro (com entradas invalidas de
    // proposito); qualquer outro termo nao acha nada, como na loja real.
    const items = term.toLowerCase().includes('counter') ? store.items : [];
    r.writeHead(200, { 'content-type': 'application/json' });
    r.end(JSON.stringify({ total: items.length, items }));
  }
});
await new Promise((r) => storeServer.listen(0, '127.0.0.1', r));
process.env.STEAM_STORE_API_URL = `http://127.0.0.1:${storeServer.address().port}/api`;

const { searchGames, normalizeQuery, clearSearchCache, searchCacheStats } = await import(
  '../src/search.js'
);
const { SourceError } = await import('../src/githubSource.js');
const { start } = await import('../src/server.js');
const { createKey } = await import('../src/store.js');

/* ------------------------------------------------------------------ */
/* Normalizacao do termo                                               */
/* ------------------------------------------------------------------ */

test('termo e normalizado antes de ir para a loja', () => {
  assert.equal(normalizeQuery('  counter   strike  '), 'counter strike');
  assert.equal(normalizeQuery('CS2'), 'CS2');
  assert.equal(normalizeQuery('a'), null, 'minimo 2 caracteres');
  assert.equal(normalizeQuery(''), null);
  assert.equal(normalizeQuery('   '), null);
  assert.equal(normalizeQuery('x'.repeat(65)), null, 'maximo 64');
  assert.equal(normalizeQuery('abc\u0000def'), null, 'caractere de controle');
  assert.equal(normalizeQuery('abc\u001F'), null);
  assert.equal(normalizeQuery(12345), null, 'nao-string');
  assert.equal(normalizeQuery(null), null);
  assert.equal(normalizeQuery(undefined), null);
});

/* ------------------------------------------------------------------ */
/* Busca                                                                */
/* ------------------------------------------------------------------ */

test('busca devolve AppID como string e diz a fonte da consulta', async () => {
  clearSearchCache();
  const r = await searchGames('counter-strike 2');
  assert.equal(r.query, 'counter-strike 2');
  assert.equal(r.source, 'steam-store');
  assert.equal(r.cached, false);
  assert.ok(!Number.isNaN(Date.parse(r.fetchedAt)), 'data da consulta registrada');
  assert.match(r.note, /Nenhum manifest ou chave e gerado/);

  const cs2 = r.results.find((x) => x.appid === '730');
  assert.ok(cs2, 'achou o jogo');
  assert.equal(typeof cs2.appid, 'string', 'AppID nunca vira Number');
  assert.equal(cs2.name, 'Counter-Strike 2');
  assert.equal(cs2.free, true, 'sem price = gratuito');
  // Entradas invalidas sao descartadas em vez de virarem AppID maluco.
  assert.ok(r.results.every((x) => /^\d{1,12}$/.test(x.appid)));
  assert.ok(!r.results.some((x) => x.appid === 'nao-e-numero'));
  assert.ok(!r.results.some((x) => x.appid === 'undefined'));
});

test('tipo do item (app/dlc) e preservado; limite de resultados respeitado', async () => {
  clearSearchCache();
  const r = await searchGames('counter');
  // A loja IGNORA `limit` e devolve tudo; o corte acontece aqui.
  assert.equal(r.results.length, 3, 'cortado no SEARCH_LIMIT=3');
  assert.equal(r.total, 6, 'total veio da loja (6 itens, 4 validos)');
  assert.ok(
    !r.results.some((x) => x.appid === '222'),
    'o 4o resultado valido ficou de fora pelo limite',
  );
  const dlc = r.results.find((x) => x.type === 'dlc');
  assert.ok(dlc, 'dlc mantido, so marcado');
  assert.equal(dlc.appid, '999999');
  assert.equal(dlc.free, false, 'com price = pago');
});

test('sem resultados: devolve lista vazia, nao e erro', async () => {
  clearSearchCache();
  const r = await searchGames('zzz jogo inexistente');
  assert.equal(r.results.length, 0);
  assert.equal(r.total, 0);
  assert.equal(r.source, 'steam-store');
});

test('segunda busca do mesmo termo vem do cache sem chamar a loja', async () => {
  clearSearchCache();
  await searchGames('counter-strike 2');
  const before = store.calls;
  const r = await searchGames('counter-strike 2');
  assert.equal(r.cached, true);
  assert.equal(store.calls, before, 'nenhuma chamada extra');

  const stats = searchCacheStats();
  assert.ok(stats.entries >= 1);
  assert.equal(stats.ttlSeconds, 600);
});

test('refresh=1 força nova consulta mesmo com cache', async () => {
  clearSearchCache();
  await searchGames('counter-strike 2');
  const before = store.calls;
  const r = await searchGames('counter-strike 2', { refresh: true });
  assert.equal(r.cached, false);
  assert.equal(store.calls, before + 1);
});

test('termo invalido responde busca_invalida sem tocar na rede', async () => {
  const before = store.calls;
  await assert.rejects(searchGames('a'), (err) => {
    assert.ok(err instanceof SourceError);
    assert.equal(err.code, 'busca_invalida');
    assert.match(err.message, /2 a 64/);
    return true;
  });
  assert.equal(store.calls, before, 'rede intocada');
});

test('loja fora do ar responde busca_indisponivel', async () => {
  clearSearchCache();
  store.mode = 'down';
  try {
    await assert.rejects(searchGames('counter'), (err) => {
      assert.equal(err.code, 'busca_indisponivel');
      return true;
    });
  } finally {
    store.mode = 'ok';
  }
});

test('loja lenta responde busca_timeout dentro do prazo configurado', async () => {
  clearSearchCache();
  store.mode = 'slow';
  const started = Date.now();
  try {
    await assert.rejects(searchGames('counter'), (err) => {
      assert.equal(err.code, 'busca_timeout');
      return true;
    });
    assert.ok(Date.now() - started < 1500, 'abortou no timeout (250ms), nao esperou 2s');
  } finally {
    store.mode = 'ok';
  }
});

test('resposta nao-JSON responde busca_indisponivel (nao vaza conteudo)', async () => {
  clearSearchCache();
  store.mode = 'bad-json';
  try {
    await assert.rejects(searchGames('counter'), (err) => {
      assert.equal(err.code, 'busca_indisponivel');
      return true;
    });
  } finally {
    store.mode = 'ok';
  }
});

test('cache de busca e limitado a 500 entradas (nao cresce sem limite)', async () => {
  clearSearchCache();
  // 510 termos distintos: o cache deve descartar os mais antigos.
  for (let i = 0; i < 510; i += 1) await searchGames(`termo-x-${i}`);
  assert.equal(searchCacheStats().entries, 500, 'teto respeitado');
  clearSearchCache();
});

/* ------------------------------------------------------------------ */
/* Rota HTTP /search                                                    */
/* ------------------------------------------------------------------ */

const server = await start(0, '127.0.0.1');
const BASE = `http://127.0.0.1:${server.address().port}`;
const KEY = createKey({ name: 'busca', rateLimitPerMinute: 1000 }).key;

const get = async (url) => {
  const res = await fetch(`${BASE}${url}`);
  let body;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
};

test('GET /search exige chave de API', async () => {
  assert.equal((await get('/search?q=counter')).status, 400);
  assert.equal((await get('/search?q=counter&key=mk_curta')).status, 400);
});

test('GET /search devolve resultados com proveniencia', async () => {
  clearSearchCache();
  const r = await get(`/search?q=counter&key=${KEY}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'steam-store');
  assert.equal(r.body.query, 'counter');
  assert.ok(Array.isArray(r.body.results));
  assert.ok(r.body.results.every((x) => typeof x.appid === 'string'));
});

test('GET /search com termo curto responde 400 busca_invalida', async () => {
  const r = await get(`/search?q=x&key=${KEY}`);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'busca_invalida');
  assert.match(r.body.message, /invalido/i);
});

test('GET /search sem q responde busca_invalida (nao consulta a loja)', async () => {
  const before = store.calls;
  const r = await get(`/search?key=${KEY}`);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'busca_invalida');
  assert.equal(store.calls, before);
});

test('GET /search nao vaza chave nem o URL da loja', async () => {
  clearSearchCache();
  const r = await get(`/search?q=counter&key=${KEY}`);
  const raw = JSON.stringify(r.body);
  assert.ok(!raw.includes('mk_'));
  assert.ok(!raw.includes('127.0.0.1'), 'URL interno da loja nao aparece');
});

test.after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  storeServer.closeAllConnections?.();
  await new Promise((r) => storeServer.close(r));
});
