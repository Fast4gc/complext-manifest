/**
 * Interface de provedores.
 *
 * Toda fonte de manifests implementa as mesmas operacoes. Nada fora desta
 * interface fala com a rede — assim API, cache e bot ficam independentes de
 * qual fonte respondeu.
 *
 *   describe()                  -> metadados publicos (sem segredo)
 *   availability(appid, opts)   -> consulta de disponibilidade (barata)
 *   list(appid, opts)           -> listagem de arquivos da branch do AppID
 *   download(appid, file, opts) -> bytes de um .manifest + sha256
 *   ping(opts)                  -> checagem de saude / cota
 *
 * Regras que TODA implementacao precisa respeitar:
 *
 *  1. Consultar a branch do AppID diretamente. NUNCA listar as branches do
 *     repositorio para achar uma — isso e O(n) e joga a lista inteira no
 *     log e na cota.
 *  2. Nunca lancar erro com token, cabecalho de auth ou URL com credencial.
 *  3. Reportar autenticacao (`github_auth`) e rate limit
 *     (`github_rate_limit`) como codigos proprios, nunca como
 *     "indisponivel" generico.
 *  4. Devolver apenas o que ja existe na fonte. Provedor nenhum gera
 *     manifest, gera chave ou deduz conteudo a partir de um AppID.
 *
 * Os dois provedores de baixo sao o mesmo mecanismo (branch por AppID no
 * GitHub) apontando para repositorios diferentes. Fontes que exigem login
 * de terceiros nao estao integradas; ver README > "Fontes suportadas".
 */

import { config } from '../config.js';
import {
  SourceError,
  ERROR_MESSAGES,
  resolveSrc,
  repositoryFormatOk,
  branchHead,
  listManifestsAt,
  fetchFile,
  ping as pingGithub,
} from '../githubSource.js';

export { SourceError, ERROR_MESSAGES };

/**
 * Monta um provedor "github-branch".
 *
 * @param {object} opts
 * @param {string} opts.id            identificador publico (manifesthub|github)
 * @param {string} opts.name          nome legivel
 * @param {() => object} opts.src     devolve a configuracao da fonte
 * @param {() => boolean} opts.enabled     o operador habilitou esta fonte?
 * @param {() => boolean} opts.configured  ela tem repositorio?
 * @param {object} opts.extra         campos extras do describe()
 */
export function githubBranchProvider({ id, name, src, enabled, configured, extra = {} }) {
  /** resolveSrc completa a fonte com os padroes de config.github. */
  const full = () => ({ ...resolveSrc({ ...src(), id }), id });

  return {
    id,
    kind: 'github-branch',

    describe() {
      const s = full();
      // `configured` = tem algo escrito. `valid` = o que esta escrito serve
      // (ou null quando nao ha nada escrito). Separar os dois evita dizer
      // "ok" para um URL colado no campo errado do .env.
      const repo = s.repository || null;
      const valid = repo === null ? null : repositoryFormatOk(repo);
      return {
        id,
        name,
        kind: 'github-branch',
        enabled: enabled(),
        configured: configured(),
        valid,
        ...(valid === false ? { invalid: 'repositorio_invalido' } : {}),
        repository: repo,
        branchTemplate: s.branchTemplate,
        apiUrl: s.apiUrl,
        /** Diz se exige credencial, sem dizer qual. */
        auth: Boolean(s.token),
        rateLimit:
          s.apiUrl === 'https://api.github.com'
            ? { unauthenticated: '60/h', authenticated: '5000/h', note: 'cota por IP/token' }
            : { note: 'instancia propria' },
        /** Operacoes que este provedor NAO faz, declaradas para nao prometer. */
        cannot: ['gerar manifests', 'gerar chaves', 'listar todas as branches'],
        ...extra,
      };
    },

    /** Consulta barata: a branch existe e qual e o commit? */
    async availability(appid, { signal } = {}) {
      const { branch, sha } = await branchHead(appid, { signal, src: full() });
      // `sha` e `commit` dizem a mesma coisa: `sha` e o que a API do GitHub
      // chama, `commit` e o nome que a resposta daqui expoe.
      return { available: true, branch, sha, commit: sha };
    },

    async list(appid, { signal, head } = {}) {
      const s = full();
      // `head` evita repetir a chamada de branch ja feita por availability().
      // Se ele nao trouxer o sha, consulta de novo em vez de montar URL ruim.
      let branch;
      let sha;
      if (head && typeof head.sha === 'string') {
        ({ branch, sha } = head);
      } else {
        ({ branch, sha } = await branchHead(appid, { signal, src: s }));
      }
      const { files, configFiles, truncated } = await listManifestsAt(appid, sha, {
        signal,
        src: s,
      });
      return {
        source: id,
        appid,
        ref: branch,
        /** Commit/versao da fonte — registrado em cada pacote. */
        version: sha,
        fetchedAt: new Date().toISOString(),
        files: files.map((f) => ({ ...f, ref: sha })),
        configFiles,
        truncated,
      };
    },

    /**
     * Baixa um `.manifest` no commit registrado no proprio arquivo.
     * Sem `ref` (arquivo vindo de fora do cache), consulta a branch.
     */
    async download(appid, file, { signal, ref } = {}) {
      const s = full();
      const sha = ref || (await branchHead(appid, { signal, src: s })).sha;
      return fetchFile(appid, file, sha, { signal, src: s });
    },

    async ping() {
      const started = Date.now();
      await pingGithub({ src: full() });
      return { ok: true, latencyMs: Date.now() - started };
    },
  };
}

/** Fonte `manifesthub`: steamtoolsapp/ManifestHub (publico, sem credencial propria). */
export function manifesthubProvider() {
  const cfg = config.sources.manifesthub;
  return githubBranchProvider({
    id: 'manifesthub',
    name: 'ManifestHub (publico)',
    src: () => ({
      repository: cfg.repository,
      branchTemplate: cfg.branchTemplate,
      token: config.github.token,
      apiUrl: config.github.apiUrl,
      rawUrl: config.github.rawUrl,
      timeoutMs: config.github.timeoutMs,
    }),
    enabled: () => cfg.enabled,
    configured: () => Boolean(cfg.repository),
    extra: {
      visibility: 'public',
      docs: 'https://github.com/steamtoolsapp/ManifestHub',
      /** Consultamos a branch do AppID, nunca o listing do repositorio. */
      branchPerAppId: true,
      listsAllBranches: false,
    },
  });
}

/** Fonte `github`: o repositorio que o operador configurou (GITHUB_REPOSITORY). */
export function githubProvider() {
  return githubBranchProvider({
    id: 'github',
    name: 'Repositorio do operador',
    src: () => ({
      repository: config.github.repository,
      branchTemplate: config.github.branchTemplate,
      token: config.github.token,
      apiUrl: config.github.apiUrl,
      rawUrl: config.github.rawUrl,
      timeoutMs: config.github.timeoutMs,
    }),
    enabled: () => config.sources.github.enabled,
    configured: () => Boolean(config.github.repository),
    extra: {
      visibility: config.github.token ? 'private-or-public' : 'public',
      branchPerAppId: true,
      listsAllBranches: false,
    },
  });
}
