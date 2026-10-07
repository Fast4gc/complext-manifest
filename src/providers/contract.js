import { config } from '../config.js';
import {
  SourceError,
  ERROR_MESSAGES,
  resolveSrc,
  branchHead,
  listManifestsAt,
  fetchFile,
  ping as ghPing,
} from '../githubSource.js';
import { isDeliverable } from '../validate.js';

/**
 * Interface de provedores de manifests.
 *
 * Cada provedor expoe tres operacoes:
 *
 *   availability(appid)  -> { available, reason? }   consulta de disponibilidade
 *   list(appid)          -> Listing                  listagem de arquivos
 *   download(appid,file) -> { buffer, sha256 }       download de um arquivo
 *
 * Listing (formato normalizado que TODOS os provedores devolvem):
 *
 *   {
 *     source:    string   id do provedor que respondeu
 *     appid:     string   AppID consultado (1-12 digitos)
 *     ref:       string   branch/ref usada
 *     version:   string   commit SHA (imutavel) - origem/versao do pacote
 *     files:     File[]   apenas arquivos ENTREGAVEIS
 *     truncated: boolean  true se a fonte cortou a listagem
 *   }
 *
 * File: { path, name, size, kind, depotId, manifestId, ref }
 *   kind       'manifest' | 'config'  (fileKind em validate.js)
 *   depotId    string|null  INFERIDO do nome do arquivo
 *   manifestId string|null  SEMPRE string (ultrapassa 2^53; nunca Number)
 *   ref        string       copia de Listing.version, para download sem ida e volta
 *
 * Regras de todos os provedores:
 *   - AppID chega como string ja validada.
 *   - ManifestId NUNCA passa por Number.
 *   - Falha = SourceError com `code` presente em ERROR_MESSAGES.
 *   - Credenciais nunca aparecem em erro, log ou retorno.
 *   - Arquivos recebidos sao DADOS: nada aqui executa Lua ou qualquer script.
 */

/** Monta um Listing a partir da arvore de uma branch GitHub. */
async function listFromBranch(appid, { signal, src }) {
  const s = resolveSrc(src);
  const head = await branchHead(appid, { signal, src: s });
  const { files, truncated } = await listManifestsAt(appid, head.sha, { signal, src: s });

  const deliverable = [];
  for (const f of files) {
    if (!isDeliverable(f.path)) continue; // manifest por padrao; config so se pedido
    deliverable.push({ ...f, ref: head.sha });
  }

  return {
    source: s.id,
    appid,
    ref: head.branch,
    version: head.sha,
    files: deliverable,
    truncated: truncated === true,
  };
}

/**
 * Provedor base para qualquer origem servida por branch GitHub.
 * `getRepoConfig()` devolve { repository, branchTemplate, apiUrl, token, timeoutMs }.
 */
function githubBranchProvider({ id, name, getRepoConfig, enabledBy }) {
  const srcFor = (override) => {
    const cfg = getRepoConfig();
    return resolveSrc({
      id,
      repository: cfg.repository,
      branchTemplate: cfg.branchTemplate,
      apiUrl: cfg.apiUrl,
      token: cfg.token,
      timeoutMs: cfg.timeoutMs,
      ...override,
    });
  };

  return {
    id,
    name,
    kind: 'github-branch',
    enabledBy,
    requiresCredentials: false,

    async availability(appid, { signal, src } = {}) {
      try {
        await branchHead(appid, { signal, src: srcFor(src) });
        return { available: true };
      } catch (err) {
        if (err instanceof SourceError && err.code === 'branch_nao_encontrada') {
          return { available: false, reason: 'branch_ausente' };
        }
        if (
          err instanceof SourceError &&
          ['repositorio_nao_configurado', 'repositorio_invalido'].includes(err.code)
        ) {
          return { available: false, reason: 'nao_configurado' };
        }
        throw err;
      }
    },

    list(appid, { signal, src } = {}) {
      return listFromBranch(appid, { signal, src: srcFor(src) });
    },

    async download(appid, file, { signal, src } = {}) {
      const version = file.ref;
      if (!version) {
        throw new SourceError('github_erro', ERROR_MESSAGES.github_erro, 'arquivo sem ref/commit');
      }
      return fetchFile(appid, file, version, { signal, src: srcFor(src) });
    },

    async ping({ src } = {}) {
      const started = Date.now();
      try {
        await ghPing({ src: srcFor(src) });
        return { ok: true, latencyMs: Date.now() - started };
      } catch (err) {
        return { ok: false, latencyMs: Date.now() - started, error: err?.code || 'erro' };
      }
    },

    describe() {
      const cfg = getRepoConfig();
      return {
        id,
        name,
        kind: 'github-branch',
        enabled: enabledBy(),
        configured: Boolean(cfg.repository),
        repository: cfg.repository || null,
        // O token NUNCA sai daqui; so indicamos se ha um configurado.
        credential: cfg.token ? 'token_configurado' : 'nenhum',
        endpoint: cfg.apiUrl,
      };
    },
  };
}

/**
 * Fonte `manifesthub`: repositorio publico steamtoolsapp/ManifestHub.
 *
 * CONSULTA DIRETA da branch do AppID
 * (GET /repos/:owner/:repo/branches/:appid), SEM passar pelo listador
 * /branches (62 mil entradas, 600 paginas - desperdicio de cota).
 */
export const manifesthubProvider = githubBranchProvider({
  id: 'manifesthub',
  name: 'ManifestHub',
  getRepoConfig: () => ({
    repository: config.sources.manifesthub.repository,
    branchTemplate: config.sources.manifesthub.branchTemplate,
    apiUrl: config.github.apiUrl,
    token: config.github.token,
    timeoutMs: config.github.timeoutMs,
  }),
  enabledBy: () => config.sources.manifesthub.enabled,
});

/** Fonte `github`: repositorio proprio do operador (GITHUB_REPOSITORY). */
export const githubProvider = githubBranchProvider({
  id: 'github',
  name: 'Repositorio proprio (GitHub)',
  getRepoConfig: () => ({
    repository: config.github.repository,
    branchTemplate: config.github.branchTemplate,
    apiUrl: config.github.apiUrl,
    token: config.github.token,
    timeoutMs: config.github.timeoutMs,
  }),
  enabledBy: () => config.sources.github.enabled,
});

export { SourceError, ERROR_MESSAGES };
