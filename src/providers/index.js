import { config } from '../config.js';
import { SourceError, ERROR_MESSAGES } from '../githubSource.js';
import { manifesthubProvider, githubProvider } from './contract.js';

/**
 * Registro de provedores: prioridade, selecao explicita e fallback.
 *
 * Prioridade: config.sources.priority (SOURCE_PRIORITY), na ordem escrita.
 *   Ex.: SOURCE_PRIORITY=manifesthub,github
 *
 * Selecao explicita: { source: 'manifesthub' } na consulta.
 *   Fonte desconhecida ou desabilitada => SourceError 'fonte_desconhecida'
 *   (nunca cai silenciosamente em outra fonte: o usuario pediu uma).
 *
 * Fallback: se uma fonte nao tem o AppID (branch_ausente/sem_manifests) ou
 * esta temporariamente indisponivel, tenta a proxima. Erros que o operador
 * PRECISA ver nao sao escondidos: autenticacao (github_auth) e limite de
 * cota (github_rate_limit) sao propagados com o codigo original quando
 * TODAS as fontes falham, e sempre aparecem em `attempts`.
 */

/** Fontes cujo codigo e 'ausencia' (proximo por favor) e nao 'falha dura'. */
const FALLBACK_CODES = new Set([
  'branch_nao_encontrada',
  'branch_invalida',
  'sem_manifests',
  'repositorio_nao_configurado',
  'repositorio_invalido',
  'fonte_indisponivel',
  'appid_invalido',
]);

/** Falhas temporarias: tambem tenta a proxima fonte, mas avisa. */
const TEMPORARY_CODES = new Set([
  'github_timeout',
  'github_indisponivel',
  'github_erro',
  'cache_indisponivel',
  'arquivo_nao_encontrado',
  'falha_integridade',
]);

/**
 * Erros que NUNCA devem ser trocados em silencio por outro codigo:
 * se acontecerem e nao houver sucesso, eles sao o erro final.
 */
const LOUD_CODES = new Set(['github_auth', 'github_rate_limit', 'fonte_sem_credenciais']);

const REGISTRY = new Map([
  [manifesthubProvider.id, manifesthubProvider],
  [githubProvider.id, githubProvider],
]);

/** Ordem efetiva de prioridade, filtrando fontes desconhecidas/desabilitadas. */
export function priorityOrder() {
  const ids = [];
  for (const id of config.sources.priority) {
    const p = REGISTRY.get(id);
    if (!p) continue;
    if (typeof p.enabledBy === 'function' && !p.enabledBy()) continue;
    ids.push(id);
  }
  // Fontes registradas mas fora do SOURCE_PRIORITY entram no fim (atuais,
  // nao configuradas explicitamente). Sem isso, um provedor novo ficaria
  // inacessivel para quem nao mexeu no .env.
  for (const [id, p] of REGISTRY) {
    if (ids.includes(id)) continue;
    if (typeof p.enabledBy === 'function' && !p.enabledBy()) continue;
    ids.push(id);
  }
  return ids;
}

/** Lista publica das fontes (para GET /sources e /health). */
export function describeSources() {
  const order = priorityOrder();
  return [...REGISTRY.values()].map((p) => ({
    ...p.describe(),
    priority: order.indexOf(p.id),
    default: order[0] === p.id,
  }));
}

export function getProvider(id) {
  return REGISTRY.get(id) || null;
}

function sourceError(code, message, detail) {
  return new SourceError(code, ERROR_MESSAGES[code] || message, detail);
}

/**
 * Resolve a ordem de tentativa para uma consulta.
 * @param {string|null} requested source explicito ou null (usa prioridade)
 */
export function resolveOrder(requested) {
  const order = priorityOrder();
  if (!requested) return order;

  const p = REGISTRY.get(requested);
  if (!p) {
    throw sourceError(
      'fonte_desconhecida',
      `Fonte desconhecida: '${requested}'. Disponiveis: ${order.join(', ')}`,
      { disponiveis: order },
    );
  }
  if (typeof p.enabledBy === 'function' && !p.enabledBy()) {
    throw sourceError('fonte_desabilitada', `Fonte '${requested}' esta desabilitada no servidor.`);
  }
  return [requested];
}

/**
 * Tenta as fontes em ordem ate uma devolver sucesso.
 *
 * @param {(provider: object) => Promise<any>} fn
 * @param {{ source?: string|null }} opts
 * @returns {Promise<{result: any, source: string, attempts: object[]}>}
 * @throws {SourceError} com `attempts` anexado quando todas falham
 */
export async function withFallback(fn, { source = null } = {}) {
  const order = resolveOrder(source);
  const attempts = [];

  if (order.length === 0) {
    throw sourceError('nenhuma_fonte', 'Nenhuma fonte habilitada no servidor.');
  }

  let loud = null;
  for (const id of order) {
    const provider = REGISTRY.get(id);
    if (!provider) continue;
    try {
      const result = await fn(provider);
      return { result, source: id, attempts };
    } catch (err) {
      const code = err instanceof SourceError ? err.code : 'github_erro';
      attempts.push({ source: id, code });
      if (LOUD_CODES.has(code) && !loud) loud = err;

      const finalAttempt = id === order[order.length - 1];
      if (finalAttempt) {
        // Prefere o erro "alto" (auth/quota) ao ultimo erro fragil:
        // esconder um 401 por causa de um 404 posterior engana o operador.
        const chosen = loud || err;
        if (chosen !== err && chosen instanceof SourceError) chosen.attempts = attempts;
        if (err instanceof SourceError) err.attempts = attempts;
        throw chosen;
      }

      const canFallback = FALLBACK_CODES.has(code) || TEMPORARY_CODES.has(code);
      if (!canFallback && !LOUD_CODES.has(code)) {
        err.attempts = attempts;
        throw err; // erro nao-tratavel (ex.: zip grande): nao tem o que tentar
      }
    }
  }
  // inalcancavel: a sempre lanca dentro do loop
  const err = sourceError('nenhuma_fonte', 'Nenhuma fonte respondeu.');
  err.attempts = attempts;
  throw err;
}

export { SourceError, ERROR_MESSAGES };
