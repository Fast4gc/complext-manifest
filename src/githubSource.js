import crypto from 'node:crypto';
import { config } from './config.js';
import { branchNameFor, isSafeRepoPath, safeBaseName, fileKind, CONTAINS_KEYS_WARNING, rawFileUrl } from './validate.js';

/**
 * Transporte HTTP para repositorios GitHub com uma branch por AppID.
 *
 * Todas as funcoes aceitam `src` (configuracao de uma fonte). Sem `src`,
 * usam `config.github` (a fonte `github` do operador) — o que mantem
 * compativel quem so passa o AppID.
 *
 * Um "src" e um objeto simples:
 *   { id, repository, branchTemplate, token, apiUrl, timeoutMs }
 */

export class SourceError extends Error {
  constructor(code, message, detail = undefined) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.detail = detail;
  }
}

/** Codigos HTTP/sucesso mapeados para mensagens em pt-BR. */
export const ERROR_MESSAGES = {
  repositorio_nao_configurado: 'GITHUB_REPOSITORY nao configurado no servidor',
  repositorio_invalido: 'Formato de repositorio invalido (esperado owner/repo)',
  appid_invalido: 'AppID invalido',
  branch_invalida: 'Nome de branch invalido para este AppID',
  branch_nao_encontrada: 'Nenhuma branch encontrada para este AppID',
  sem_manifests: 'Nenhum .manifest encontrado nesta branch',
  sem_lua: 'Nenhum Lua ou JSON do AppID encontrado na fonte',
  lua_ambiguo: 'Mais de um .lua encontrado sem um arquivo correspondente ao AppID',
  lua_dados_invalidos: 'Dados invalidos para gerar Lua (AppID, depot, key ou Manifest ID)',
  lua_dados_incompletos: 'Nao foi possivel gerar Lua: faltam depots, keys ou manifests publicos na fonte',
  formato_invalido: 'Formato invalido: use lua ou manifests',
  arquivo_nao_encontrado: 'Manifest listado nao esta mais disponivel no repositorio',
  arquivo_invalido: 'Manifest rejeitado (caminho ou conteudo invalido)',
  arquivo_grande_demais: 'Manifest excede o tamanho maximo permitido',
  zip_grande_demais: 'ZIP excede o tamanho maximo permitido',
  github_timeout: 'Tempo esgotado ao consultar o GitHub',
  github_indisponivel: 'GitHub indisponivel no momento',
  github_rate_limit: 'Limite de requisicoes do GitHub atingido, tente mais tarde',
  github_auth: 'GitHub recusou as credenciais (GITHUB_TOKEN invalido ou sem permissao)',
  github_erro: 'Erro inesperado ao consultar o GitHub',
  cache_indisponivel: 'Cache local indisponivel e o GitHub nao respondeu',
  falha_integridade: 'Falha de integridade ao baixar manifesto',
  caminho_invalido: 'Caminho de arquivo rejeitado',
};

/** Normaliza um src parcial usando config.github como padrao. */
export function resolveSrc(src) {
  const base = config.github;
  if (!src) {
    return {
      id: 'github',
      repository: base.repository,
      branchTemplate: base.branchTemplate,
      token: base.token,
      apiUrl: base.apiUrl,
      rawUrl: base.rawUrl,
      timeoutMs: base.timeoutMs,
    };
  }
  return {
    id: src.id || 'github',
    repository: src.repository ?? base.repository,
    branchTemplate: src.branchTemplate ?? base.branchTemplate,
    token: src.token ?? base.token,
    apiUrl: (src.apiUrl ?? base.apiUrl).replace(/\/+$/, ''),
    rawUrl: (src.rawUrl ?? base.rawUrl).replace(/\/+$/, ''),
    timeoutMs: src.timeoutMs ?? base.timeoutMs,
  };
}

function repositoryOf(src) {
  const repo = src.repository;
  if (!repo) throw new SourceError('repositorio_nao_configurado', ERROR_MESSAGES.repositorio_nao_configurado);
  if (!repositoryFormatOk(repo)) {
    throw new SourceError('repositorio_invalido', ERROR_MESSAGES.repositorio_invalido);
  }
  return repo;
}

/**
 * Checagem de formato `owner/repo` SEM lancar erro.
 *
 * Existe para `/health` e `/sources` dizerem "a fonte esta configurada, mas
 * com valor invalido" antes de qualquer ida a rede — senao um URL colado no
 * lugar errado do `.env` so apareceria depois, como falha de rede.
 */
export function repositoryFormatOk(repo) {
  return typeof repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo);
}

/** Headers da API do GitHub. O token nunca aparece em logs ou erros. */
function headersOf(src, raw = false) {
  const h = {
    'User-Agent': 'manifest-gate',
    Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (src.token) h.Authorization = `Bearer ${src.token}`;
  return h;
}

/** GET com timeout, mapeando falhas, limites e auth para SourceError. */
async function ghGet(src, pathname, { raw = false, signal } = {}) {
  const url = `${src.apiUrl}${pathname}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), src.timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let res;
  try {
    res = await fetch(url, { headers: headersOf(src, raw), signal: controller.signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    if (controller.signal.aborted) {
      throw new SourceError('github_timeout', ERROR_MESSAGES.github_timeout);
    }
    throw new SourceError('github_indisponivel', ERROR_MESSAGES.github_indisponivel, String(err?.code || err?.message || err));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  if (res.status === 404) return { status: 404, res };
  if (res.status === 401 || res.status === 403) {
    // 403 sem esgotamento de cota = credencial recusada (SSO, escopo, token
    // invalido). Nao confundir com rate limit: o usuario precisa saber.
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (res.status === 403 && remaining === '0') {
      const reset = res.headers.get('x-ratelimit-reset');
      throw new SourceError('github_rate_limit', ERROR_MESSAGES.github_rate_limit, {
        reset: reset ? new Date(Number(reset) * 1000).toISOString() : undefined,
      });
    }
    throw new SourceError('github_auth', ERROR_MESSAGES.github_auth, `http ${res.status}`);
  }
  if (res.status === 429) {
    const reset = res.headers.get('x-ratelimit-reset');
    throw new SourceError('github_rate_limit', ERROR_MESSAGES.github_rate_limit, {
      reset: reset ? new Date(Number(reset) * 1000).toISOString() : undefined,
    });
  }
  if (!res.ok) {
    throw new SourceError('github_erro', ERROR_MESSAGES.github_erro, `http ${res.status}`);
  }
  return { status: res.status, res };
}

/** SHA1 de blob git: sha1("blob <len>\0<conteudo>"). Usado para integridade. */
export function gitBlobSha1(buffer) {
  const header = Buffer.from(`blob ${buffer.length}\0`);
  return crypto.createHash('sha1').update(header).update(buffer).digest('hex');
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Consulta direta da branch do AppID, sem listar branches do repositorio. */
export async function branchHead(appid, { signal, src } = {}) {
  const s = resolveSrc(src);
  const repo = repositoryOf(s);
  const branch = branchNameFor(appid, s.branchTemplate);
  if (!branch) throw new SourceError('branch_invalida', ERROR_MESSAGES.branch_invalida);

  const enc = encodeURIComponent(branch);
  const { status, res } = await ghGet(s, `/repos/${repo}/branches/${enc}`, { signal });
  if (status === 404) {
    throw new SourceError('branch_nao_encontrada', ERROR_MESSAGES.branch_nao_encontrada, { branch });
  }
  const body = await res.json().catch(() => null);
  const sha = body?.commit?.sha;
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new SourceError('github_erro', ERROR_MESSAGES.github_erro, 'resposta sem commit sha');
  }
  return { branch, sha };
}

/**
 * Lista os arquivos da branch (arvore recursiva no commit), SEM baixar
 * nenhum conteudo — apenas metadados que a propria API do GitHub devolve.
 *
 * A listagem ja vem separada por politica de entrega:
 *   files       .manifest        -> baixados no cache e entregues no ZIP
 *   configFiles .lua / .json     -> metadados, com aviso e link direto
 *
 * Nada de `*.vdf` (chave) aparece em qualquer um dos dois.
 *
 * @returns {{files: Array, configFiles: Array, truncated: boolean}}
 */
export async function listManifestsAt(appid, sha, { signal, src } = {}) {
  const s = resolveSrc(src);
  const repo = repositoryOf(s);
  const { status, res } = await ghGet(
    s,
    `/repos/${repo}/git/trees/${encodeURIComponent(sha)}?recursive=1`,
    { signal },
  );
  if (status === 404) {
    throw new SourceError('branch_nao_encontrada', ERROR_MESSAGES.branch_nao_encontrada);
  }
  const body = await res.json().catch(() => null);
  const tree = Array.isArray(body?.tree) ? body.tree : null;
  if (!tree) throw new SourceError('github_erro', ERROR_MESSAGES.github_erro, 'arvore invalida');

  const files = [];
  const configFiles = [];
  for (const entry of tree) {
    if (entry.type !== 'blob') continue;
    if (typeof entry.path !== 'string') continue;
    const kind = fileKind(entry.path);
    if (kind !== 'manifest' && kind !== 'config') continue; // proibido/ignorado
    if (!isSafeRepoPath(entry.path)) continue;
    const size = Number(entry.size);
    if (!Number.isFinite(size) || size < 0) continue;

    const base = {
      path: entry.path,
      name: safeBaseName(entry.path),
      size,
      gitSha: entry.sha,
      kind,
    };

    if (kind === 'manifest') {
      // ignorado por exceder limite: fora da listagem tambem, para o
      // cliente nao pedir um ZIP que nunca caberia.
      if (size > config.limits.maxFileBytes) continue;
      files.push(base);
      continue;
    }

    // Nesta listagem, config inclui so metadados. O fluxo Lua baixa separadamente.
    configFiles.push({
      ...base,
      containsKeys: true,
      warning: CONTAINS_KEYS_WARNING,
      rawUrl: rawFileUrl(s, entry.path, appid),
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  configFiles.sort((a, b) => a.path.localeCompare(b.path));
  return { files, configFiles, truncated: body.truncated === true };
}

/** Baixa um arquivo do repositorio no commit informado, validando integridade. */
export async function fetchFile(appid, file, sha, { signal, src, format = 'manifests' } = {}) {
  const s = resolveSrc(src);
  const repo = repositoryOf(s);
  if (!isSafeRepoPath(file.path)) {
    throw new SourceError('caminho_invalido', ERROR_MESSAGES.caminho_invalido);
  }
  // O cache/ZIP usa manifests. Lua exige selecao explicita do formato.
  // O JSON do AppID pode ser lido internamente para gerar Lua.
  const allowed = format === 'lua'
    ? fileKind(file.path) === 'config' && /\.lua$/i.test(file.path)
    : format === 'lua-json'
    ? fileKind(file.path) === 'config' && safeBaseName(file.path).toLowerCase() === `${appid}.json`
    : fileKind(file.path) === 'manifest';
  if (!allowed) {
    throw new SourceError('arquivo_invalido', ERROR_MESSAGES.arquivo_invalido, file.name);
  }
  if (file.size > config.limits.maxFileBytes) {
    throw new SourceError('arquivo_grande_demais', ERROR_MESSAGES.arquivo_grande_demais, file.name);
  }
  const pathname =
    `/repos/${repo}/contents/${file.path.split('/').map(encodeURIComponent).join('/')}` +
    `?ref=${encodeURIComponent(sha)}`;
  const { status, res } = await ghGet(s, pathname, { raw: true, signal });
  if (status === 404) {
    throw new SourceError('arquivo_nao_encontrado', ERROR_MESSAGES.arquivo_nao_encontrado, file.name);
  }
  const buffer = Buffer.from(await res.arrayBuffer());

  if (buffer.length > config.limits.maxFileBytes) {
    throw new SourceError('arquivo_grande_demais', ERROR_MESSAGES.arquivo_grande_demais, file.name);
  }
  if (buffer.length !== file.size) {
    throw new SourceError('falha_integridade', ERROR_MESSAGES.falha_integridade, {
      name: file.name,
      esperado: file.size,
      recebido: buffer.length,
    });
  }
  const blobSha = gitBlobSha1(buffer);
  if (file.gitSha && blobSha !== file.gitSha) {
    throw new SourceError('falha_integridade', ERROR_MESSAGES.falha_integridade, {
      name: file.name,
      motivo: 'sha1 do blob nao confere',
    });
  }
  return { buffer, sha256: sha256(buffer) };
}

/** Verifica de passagem se o GitHub responde (usado pelo health check profundo). */
export async function ping({ src } = {}) {
  const started = Date.now();
  const s = resolveSrc(src);
  // Confirma a configuracao antes de tocar na rede: um `owner/repo` no
  // formato errado nao pode aparecer como "fonte saudavel" no /health?deep=1.
  repositoryOf(s);
  await ghGet(s, '/rate_limit');
  return { ok: true, latencyMs: Date.now() - started };
}
