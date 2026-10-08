/**
 * Registro de fontes: qual usar, em que ordem, e o que fazer quando uma
 * delas falha.
 *
 * Duas formas de escolher:
 *
 *   source=<id>   escolha EXPLICA. So esta fonte e consultada; se ela
 *                 falhar, o erro dela e o erro da resposta. Nada de cair
 *                 silenciosamente para outra fonte.
 *   (sem source)  ordem de prioridade configurada em SOURCE_PRIORITY,
 *                 filtrada por fonte habilitada e configurada. A primeira
 *                 que responder com sucesso vence; as demais sao fallback.
 *
 * Em qualquer caso a resposta registra `attempts`: quais fontes foram
 * consultadas e qual codigo cada uma devolveu. Erros de autenticacao e de
 * rate limit (`github_auth`, `github_rate_limit`) nunca sao engolidos —
 * se todas as fontes falharem, o erro alto e o que sobe.
 */

import { config } from '../config.js';
import { SourceError, ERROR_MESSAGES, manifesthubProvider, githubProvider } from './contract.js';

export { SourceError, ERROR_MESSAGES };

/** Fontes neste processo. A ordem aqui nao importa; a de SOURCE_PRIORITY sim. */
export const REGISTRY = {
  manifesthub: manifesthubProvider(),
  github: githubProvider(),
};

/** Codigos novos que esta camada pode gerar. */
export const LOCAL_CODES = {
  fonte_desconhecida: 'Fonte desconhecida',
  fonte_desabilitada: 'Fonte desabilitada no servidor',
  nenhuma_fonte: 'Nenhuma fonte habilitada e configurada no servidor',
};

/** Falha que significa "esta fonte nao tem o que voce pediu". */
export const FALLBACK_CODES = new Set([
  'branch_nao_encontrada',
  'branch_invalida',
  'sem_manifests',
  'arquivo_nao_encontrado',
  'arquivo_invalido',
  'caminho_invalido',
  'repositorio_invalido',
  'appid_invalido',
  'falha_integridade',
  'arquivo_grande_demais',
]);

/** Falha temporaria: rede, cota estourada de forma transiente, 5xx. */
export const TEMPORARY_CODES = new Set([
  'github_timeout',
  'github_indisponivel',
  'github_erro',
  'cache_indisponivel',
]);

/**
 * Falhas que o operador PRECISA ver, mesmo que outra fonte tenha dado certo.
 * Guardadas em `attempts` quando ha sucesso, e promovidas a erro final
 * quando todas as fontes falham.
 */
export const LOUD_CODES = new Set(['github_auth', 'github_rate_limit']);

/** Monta um SourceError com a mensagem pt-BR do codigo (local ou do transporte). */
function localError(code) {
  const message = LOCAL_CODES[code] || ERROR_MESSAGES[code] || code;
  return new SourceError(code, message);
}

/** true se `priority` parece uma ordem valida. */
export function priorityOrder() {
  const seen = new Set();
  const out = [];
  for (const id of config.sources.priority) {
    const p = REGISTRY[id];
    if (!p) continue; // id desconhecido na lista: reportado por describeSources
    if (seen.has(id)) continue;
    seen.add(id);
    const d = p.describe();
    if (!d.enabled || !d.configured) continue;
    out.push(id);
  }
  return out;
}

/**
 * Fontes candidatas nesta ordem de prioridade.
 * @param {string|null} requested  source= explicito, ou null
 * @returns {string[]}
 * @throws {SourceError} fonte_desconhecida | fonte_desabilitada |
 *                      repositorio_nao_configurado | nenhuma_fonte
 */
export function resolveOrder(requested) {
  if (requested) {
    const id = String(requested).trim();
    const p = REGISTRY[id];
    if (!p) throw localError('fonte_desconhecida');
    const d = p.describe();
    if (!d.enabled) throw localError('fonte_desabilitada');
    if (!d.configured) throw localError('repositorio_nao_configurado');
    // Escolha explicita: sem fallback para outra fonte.
    return [id];
  }
  const order = priorityOrder();
  if (order.length === 0) throw localError('nenhuma_fonte');
  return order;
}

/** Lista tudo o que existe, com posicao na prioridade (ou -1 se fora). */
export function describeSources() {
  const prio = config.sources.priority;
  const known = Object.keys(REGISTRY);
  const items = known.map((id) => {
    const d = REGISTRY[id].describe();
    const i = prio.indexOf(id);
    return { ...d, priority: i };
  });
  items.sort((a, b) => {
    const pa = a.priority === -1 ? 999 : a.priority;
    const pb = b.priority === -1 ? 999 : b.priority;
    return pa - pb || a.id.localeCompare(b.id);
  });

  const unknown = prio.filter((id) => !REGISTRY[id]);
  return {
    /** Ordem efetiva ja filtrada por habilitada+configurada. */
    order: priorityOrder(),
    configuredOrder: prio,
    sources: items,
    ...(unknown.length > 0 ? { unknown } : {}),
  };
}

/**
 * Executa `fn(sourceId)` na ordem ate a primeira fonte responder.
 *
 * @param {string[]} order   ordem a tentar (nunca vazia)
 * @param {(sourceId: string) => Promise<T>} fn
 * @returns {Promise<{source: string, value: T, attempts: Array}>}
 * @throws {SourceError} com `.attempts` preenchido quando todas falham
 */
export async function withFallback(order, fn) {
  if (!Array.isArray(order) || order.length === 0) {
    throw localError('nenhuma_fonte');
  }
  const attempts = [];
  let loud = null;
  let first = null;

  for (let i = 0; i < order.length; i += 1) {
    const source = order[i];
    try {
      const value = await fn(source);
      return { source, value, attempts };
    } catch (err) {
      const code = err?.code || 'github_erro';
      attempts.push({ source, code, ok: false, ...(err?.detail ? { detail: err.detail } : {}) });
      if (!first) first = err;
      if (LOUD_CODES.has(code)) {
        // Nao decide aqui: outra fonte ainda pode dar certo. Mas se todas
        // falharem, este e o erro que sobe.
        loud = loud || err;
      }
      const canTryMore = i < order.length - 1;
      if (!canTryMore) break;
      // Qualquer SourceError cai para a proxima fonte. Erros nao esperados
      // (TypeError etc.) tambem: melhor perguntar a outra fonte do que
      // devolver stack trace ao cliente.
    }
  }

  const err = loud || first;
  err.attempts = attempts;
  throw err;
}

/** Roda `fn(sourceId)` para todas as fontes na ordem (usado em ping). */
export async function eachSource(order, fn) {
  const out = [];
  for (const id of order) {
    try {
      out.push({ source: id, ...(await fn(id)) });
    } catch (err) {
      out.push({ source: id, ok: false, code: err?.code || 'github_erro' });
    }
  }
  return out;
}
