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
  branch_nao_encontrada: 'Nao existe branch para esse AppID nas fontes configuradas.',
  sem_lua: 'Nenhum .lua existente encontrado para esse AppID nas fontes consultadas.',
  lua_ambiguo: 'A fonte tem varios .lua sem um arquivo identificado pelo AppID.',
  lua_dados_invalidos: 'A fonte tem dados invalidos; nao foi possivel gerar o Lua.',
  lua_dados_incompletos: 'Faltam keys ou manifests publicos na fonte para gerar o Lua completo.',
  sem_manifests: 'Nenhum .manifest encontrado para esse AppID.',
  appid_invalido: 'AppID invalido. Use apenas numeros (ex.: 123456).',
  formato_de_chave_invalido: 'Chave da API invalida no servidor (contate o administrador).',
  chave_nao_encontrada: 'Chave da API invalida no servidor (contate o administrador).',
  chave_revogada: 'Chave da API foi revogada (contate o administrador).',
  chave_expirada: 'Chave da API expirou (contate o administrador).',
  limite_de_usos_atingido: 'Atingi o limite de usos da chave da API (contate o administrador).',
  limite_de_requisicoes: 'Muitas requisicoes agora, aguarde um minuto e tente de novo.',
  github_auth: 'O GitHub recusou as credenciais do servidor (contate o administrador).',
  github_rate_limit: 'O GitHub esta limitando consultas no momento, tente em alguns minutos.',
  github_timeout: 'A fonte demorou para responder, tente novamente.',
  github_indisponivel: 'Fonte indisponivel no momento, tente mais tarde.',
  github_erro: 'Erro inesperado ao consultar a fonte, tente mais tarde.',
  zip_grande_demais: 'O pacote ultrapassa o tamanho maximo permitido pela API.',
  arquivo_grande_demais: 'Um dos manifests excede o tamanho maximo permitido.',
  repositorio_nao_configurado: 'O servidor nao tem repositorio configurado (contate o administrador).',
  falha_integridade: 'Falha de integridade nos arquivos, tente novamente.',
  cache_indisponivel: 'Cache local indisponivel, tente novamente em instantes.',
  api_indisponivel: 'A API nao esta respondendo, tente novamente em instantes.',
  resposta_invalida: 'A API respondeu em formato inesperado, tente novamente.',
  timeout: 'A API demorou demais para responder, tente novamente.',
  // escolha de fonte
  fonte_desconhecida: 'Essa fonte nao existe aqui. Use `/fontes` ou pergunte ao administrador.',
  fonte_desabilitada: 'Essa fonte esta desabilitada no servidor.',
  nenhuma_fonte: 'Nenhuma fonte configurada no servidor (contate o administrador).',
  // busca
  busca_invalida: 'Termo de busca invalido (de 2 a 64 caracteres).',
  busca_indisponivel: 'A busca por nome esta indisponivel agora, tente depois.',
  busca_timeout: 'A busca por nome demorou demais, tente novamente.',
  busca_desabilitada: 'Busca por nome desabilitada no servidor.',
  // links
  link_desabilitado: 'Links temporarios desabilitados no servidor.',
  link_sem_segredo: 'Links temporarios nao configurados no servidor.',
  link_invalido: 'Link invalido ou adulterado.',
  link_expirado: 'Esse link expirou, peça um novo.',
  link_ttl_invalido: 'Tempo de validade do link invalido.',
};

export function createApiClient({ baseUrl, key, timeoutMs = 30_000, fetchImpl = fetch }) {
  const root = baseUrl.replace(/\/+$/, '');

  function qs(params) {
    const parts = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    return parts.length > 0 ? `?${parts.join('&')}` : '';
  }

  async function call(pathname, { signal, method = 'GET', json: body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let res;
    try {
      res = await fetchImpl(`${root}${pathname}`, {
        method,
        headers: {
          'X-API-Key': key,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      const code = controller.signal.aborted ? 'timeout' : 'api_indisponivel';
      throw new ApiError(code, BOT_MESSAGES[code]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new ApiError('resposta_invalida', BOT_MESSAGES.resposta_invalida, res.status);
    }
    const parsed = await res.json().catch(() => null);

    if (!res.ok) {
      const code = parsed?.error || 'github_erro';
      throw new ApiError(code, BOT_MESSAGES[code] || parsed?.message || 'Erro na API.', res.status);
    }
    return parsed;
  }

  return {
    /** Lista os manifests de um AppID. `source` escolhe a fonte (opcional). */
    listManifests(appid, { refresh = false, source } = {}) {
      return call(
        `/manifests${qs({ id: appid, refresh: refresh ? '1' : undefined, source })}`,
      );
    },

    /** Baixa o Lua existente como Buffer, sem executa-lo. */
    async download(appid, { refresh = false, source } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(
          `${root}/download${qs({ id: appid, refresh: refresh ? '1' : undefined, source })}`,
          { headers: { 'X-API-Key': key }, signal: controller.signal },
        );
      } catch {
        throw new ApiError('api_indisponivel', BOT_MESSAGES.api_indisponivel);
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const code = body?.error || 'github_erro';
        throw new ApiError(code, BOT_MESSAGES[code] || body?.message || 'Erro na API.', res.status);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      const type = res.headers.get('content-type') || '';
      const disposition = res.headers.get('content-disposition') || '';
      if (!type.includes('application/octet-stream') || !disposition.includes(`filename="${appid}.lua"`)) {
        throw new ApiError('resposta_invalida', BOT_MESSAGES.resposta_invalida, res.status);
      }
      return {
        buffer, filename: `${appid}.lua`,
        source: res.headers.get('x-manifest-gate-source'),
        commit: res.headers.get('x-manifest-gate-version'),
        mode: res.headers.get('x-lua-mode'),
      };
    },

    /** Fontes configuradas: usada para montar o seletor do comando. */
    listSources() {
      return call('/sources');
    },

    /** Pesquisa por nome de jogo -> AppID. */
    search(query) {
      return call(`/search${qs({ q: query })}`);
    },

    /** Emite um link temporario de download (quando o Lua nao cabe no anexo). */
    createLink(appid, { source, ttl } = {}) {
      return call('/links', { method: 'POST', json: { id: appid, source, ttl } });
    },
  };
}
