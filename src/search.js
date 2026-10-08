import { config } from './config.js';
import { SourceError } from './githubSource.js';

/**
 * Pesquisa de nome de jogo -> AppID.
 *
 * Fonte: busca publica da loja da Steam
 * (`store.steampowered.com/api/storesearch/`), verificada ao vivo.
 *
 * Por que esta fonte:
 *   - nao exige token, cadastro nem login;
 *   - devolve `{total, items:[{type, name, id, ...}]}`;
 *   - ja e a mesma base de nomes que a propria loja usa, entao o nome que
 *     o usuario digita e o nome que volta.
 *
 * O parametro `limit` e IGNORADO pelo servidor deles (testado: devolve 10
 * itens com ou sem `limit`), por isso o corte e feito aqui.
 *
 * Este modulo nao inventa AppID: ele so devolve o que a loja respondeu.
 */

export const SEARCH_CODES = {
  busca_desabilitada: 'Busca por nome desabilitada no servidor',
  busca_invalida: 'Termo de busca invalido (de 2 a 64 caracteres)',
  busca_indisponivel: 'Loja da Steam indisponivel no momento',
  busca_timeout: 'Tempo esgotado ao consultar a loja da Steam',
};

/** Erros de busca tambem sao SourceError: mesmo formato de resposta. */
function err(code) {
  return new SourceError(code, SEARCH_CODES[code] || code);
}

const MIN_LEN = 2;
const MAX_LEN = 64;
// Caracteres de controle (0x00-0x1F, 0x7F) nunca entram no termo.
const CONTROL = new RegExp('[\\u0000-\\u001F\\u007F]');

/**
 * Normaliza o termo digitado. Devolve null quando nao da para buscar.
 * Nada de interpretar o termo: ele vira parametro de query ja escapado.
 */
export function normalizeQuery(value) {
  if (typeof value !== 'string') return null;
  const q = value.replace(/\s+/g, ' ').trim();
  if (q.length < MIN_LEN || q.length > MAX_LEN) return null;
  if (CONTROL.test(q)) return null;
  return q;
}

/* ------------------------------------------------------------------ */
/* Cache em memoria                                                    */
/* ------------------------------------------------------------------ */

const cache = new Map(); // termo normalizado -> { value, expiresAt }
const MAX_ENTRIES = 500;

function cacheGet(term) {
  const hit = cache.get(term);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(term);
    return null;
  }
  // reordena: o que acabou de ser usado fica no fim (LRU approx.)
  cache.delete(term);
  cache.set(term, hit);
  return hit.value;
}

function cacheSet(term, value) {
  const ttl = (config.search.ttlSeconds || 0) * 1000;
  if (ttl <= 0) return;
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(term, { value, expiresAt: Date.now() + ttl });
}

/** Para /status e testes. */
export function searchCacheStats() {
  return { entries: cache.size, ttlSeconds: config.search.ttlSeconds };
}

export function clearSearchCache() {
  cache.clear();
}

/* ------------------------------------------------------------------ */
/* Busca                                                               */
/* ------------------------------------------------------------------ */

/**
 * @param {string} query nome do jogo
 * @param {{signal?: AbortSignal, refresh?: boolean}} opts
 * @returns {Promise<object>} resultados + proveniencia da consulta
 * @throws {SourceError} busca_*
 */
export async function searchGames(query, { signal, refresh = false } = {}) {
  if (!config.search.enabled) throw err('busca_desabilitada');

  const term = normalizeQuery(query);
  if (!term) throw err('busca_invalida');

  if (!refresh) {
    const cached = cacheGet(term);
    if (cached) return { ...cached, cached: true };
  }

  const url =
    `${config.search.storeApiUrl}/storesearch/` +
    `?term=${encodeURIComponent(term)}&l=english&cc=US`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.search.timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'manifest-gate/1.0' },
      signal: controller.signal,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    if (controller.signal.aborted) throw err('busca_timeout');
    throw err('busca_indisponivel');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  // A loja devolve 200 + lista vazia quando nao acha nada — isso nao e
  // erro. HTTP 400 significa que nosso termo foi recusado; o resto e
  // problema de integracao com a fonte.
  if (res.status === 400) throw err('busca_invalida');
  if (!res.ok) throw err('busca_indisponivel');

  let body;
  try {
    body = await res.json();
  } catch {
    throw err('busca_indisponivel');
  }
  if (!body || !Array.isArray(body.items)) throw err('busca_indisponivel');

  const limit = config.search.limit;
  const results = [];
  for (const item of body.items) {
    if (results.length >= limit) break;
    if (!item || item.id === undefined || item.id === null) continue;
    // AppID volta como string: nunca passa por Number nas respostas.
    const appid = String(item.id).trim();
    if (!/^\d{1,12}$/.test(appid)) continue;
    results.push({
      appid,
      name: typeof item.name === 'string' ? item.name.slice(0, 200) : '',
      type: typeof item.type === 'string' ? item.type.slice(0, 32) : 'app',
      free: !item.price,
    });
  }

  const payload = {
    query: term,
    total: Number.isFinite(body.total) ? body.total : results.length,
    results,
    source: 'steam-store',
    fetchedAt: new Date().toISOString(),
    cached: false,
    /** Aqui so ha pesquisa: nada e criado, nada e deduzido. */
    note: 'Somente AppIDs devolvidos pela loja. Nenhum manifest ou chave e gerado.',
  };

  cacheSet(term, payload);
  return payload;
}
