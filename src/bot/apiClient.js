/**
 * Cliente HTTP usado pelo bot para falar com a API do proprio projeto.
 * Nunca inclui a chave em mensagens de erro ou logs.
 */

export class ApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** Mensagens amigaveis por codigo de erro da API. */
export const BOT_MESSAGES = {
  branch_nao_encontrada: 'Nao existe branch para esse AppID no repositorio configurado.',
  sem_manifests: 'Nenhum .manifest encontrado para esse AppID.',
  appid_invalido: 'AppID invalido. Use apenas numeros (ex.: 123456).',
  formato_de_chave_invalido: 'Chave da API invalida no servidor (contate o administrador).',
  chave_nao_encontrada: 'Chave da API invalida no servidor (contate o administrador).',
  chave_revogada: 'Chave da API foi revogada (contate o administrador).',
  chave_expirada: 'Chave da API expirou (contate o administrador).',
  limite_de_usos_atingido: 'Atingi o limite de usos da chave da API (contate o administrador).',
  limite_de_requisicoes: 'Muitas requisicoes agora, aguarde um minuto e tente de novo.',
  github_rate_limit: 'O GitHub esta limitando consultas no momento, tente em alguns minutos.',
  github_timeout: 'O GitHub demorou para responder, tente novamente.',
  github_indisponivel: 'GitHub indisponivel no momento, tente mais tarde.',
  github_erro: 'Erro inesperado ao consultar o repositorio, tente mais tarde.',
  zip_grande_demais: 'O pacote ultrapassa o tamanho maximo permitido pela API.',
  arquivo_grande_demais: 'Um dos manifests excede o tamanho maximo permitido.',
  repositorio_nao_configurado: 'O servidor nao tem repositorio configurado (contate o administrador).',
  falha_integridade: 'Falha de integridade nos arquivos, tente novamente.',
  cache_indisponivel: 'Cache local indisponivel, tente novamente em instantes.',
  api_indisponivel: 'A API nao esta respondendo, tente novamente em instantes.',
  resposta_invalida: 'A API respondeu em formato inesperado, tente novamente.',
  timeout: 'A API demorou demais para responder, tente novamente.',
};

export function createApiClient({ baseUrl, key, timeoutMs = 30_000, fetchImpl = fetch }) {
  const root = baseUrl.replace(/\/+$/, '');

  async function call(pathname, { signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let res;
    try {
      res = await fetchImpl(`${root}${pathname}`, {
        headers: { 'X-API-Key': key, Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new ApiError(
        controller.signal.aborted ? 'timeout' : 'api_indisponivel',
        BOT_MESSAGES[controller.signal.aborted ? 'timeout' : 'api_indisponivel'],
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new ApiError('resposta_invalida', BOT_MESSAGES.resposta_invalida, res.status);
    }
    const body = await res.json().catch(() => null);

    if (!res.ok) {
      const code = body?.error || 'github_erro';
      throw new ApiError(code, BOT_MESSAGES[code] || 'Erro na API.', res.status);
    }
    return body;
  }

  return {
    /** Lista os manifests de um AppID. */
    listManifests(appid, { refresh = false } = {}) {
      return call(`/manifests?id=${encodeURIComponent(appid)}${refresh ? '&refresh=1' : ''}`);
    },

    /** Baixa o ZIP dos manifests como Buffer. */
    async download(appid, { refresh = false } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(
          `${root}/download?id=${encodeURIComponent(appid)}${refresh ? '&refresh=1' : ''}`,
          { headers: { 'X-API-Key': key }, signal: controller.signal },
        );
      } catch (err) {
        throw new ApiError('api_indisponivel', BOT_MESSAGES.api_indisponivel);
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const code = body?.error || 'github_erro';
        throw new ApiError(code, BOT_MESSAGES[code] || 'Erro na API.', res.status);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      return { buffer, filename: `appid-${appid}-manifests.zip` };
    },
  };
}
