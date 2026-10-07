import crypto from 'node:crypto';
import { config } from './config.js';
import { branchNameFor, isSafeRepoPath, safeBaseName } from './validate.js';

/**
 * Erros tipados da origem GitHub. `code` vira a mensagem clara da API.
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
  arquivo_nao_encontrado: 'Manifest listado nao esta mais disponivel no repositorio',
  arquivo_invalido: 'Manifest rejeitado (caminho ou conteudo invalido)',
  arquivo_grande_demais: 'Manifest excede o tamanho maximo permitido',
  zip_grande_demais: 'ZIP excede o tamanho maximo permitido',
  github_timeout: 'Tempo esgotado ao consultar o GitHub',
  github_indisponivel: 'GitHub indisponivel no momento',
  github_rate_limit: 'Limite de requisicoes do GitHub atingido, tente mais tarde',
  github_erro: 'Erro inesperado ao consultar o GitHub',
  cache_indisponivel: 'Cache local indisponivel e o GitHub nao respondeu',
  falha_integridade: 'Falha de integridade ao baixar manifesto',
  caminho_invalido: 'Caminho de arquivo rejeitado',
};

function repository() {
  const repo = config.github.repository;
  if (!repo) throw new SourceError('repositorio_nao_configurado', ERROR_MESSAGES.repositorio_nao_configurado);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new SourceError('repositorio_invalido', ERROR_MESSAGES.repositorio_invalido);
  }
  return repo;
}

/** Headers da API do GitHub. O token nunca aparece em logs ou erros. */
function headers(raw = false) {
  const h = {
    'User-Agent': 'manifest-gate',
    Accept: raw
      ? 'application/vnd.github.raw+json'
      : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (config.github.token) h.Authorization = `Bearer ${config.github.token}`;
  return h;
}

/** GET com timeout, mapeando falhas e limites do GitHub para SourceError. */
async function ghGet(pathname, { raw = false, signal } = {}) {
  const url = `${config.github.apiUrl}${pathname}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.github.timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let res;
  try {
    res = await fetch(url, { headers: headers(raw), signal: controller.signal });
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
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    if (res.status === 429 || remaining === '0') {
      throw new SourceError('github_rate_limit', ERROR_MESSAGES.github_rate_limit, {
        reset: reset ? new Date(Number(reset) * 1000).toISOString() : undefined,
      });
    }
    throw new SourceError('github_indisponivel', ERROR_MESSAGES.github_indisponivel, 'http 403');
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
export async function branchHead(appid, { signal } = {}) {
  const repo = repository();
  const branch = branchNameFor(appid, config.github.branchTemplate);
  if (!branch) throw new SourceError('branch_invalida', ERROR_MESSAGES.branch_invalida);

  const enc = encodeURIComponent(branch);
  const { status, res } = await ghGet(`/repos/${repo}/branches/${enc}`, { signal });
  if (status === 404) {
    throw new SourceError('branch_nao_encontrada', ERROR_MESSAGES.branch_nao_encontrada, {
      branch,
    });
  }
  const body = await res.json().catch(() => null);
  const sha = body?.commit?.sha;
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new SourceError('github_erro', ERROR_MESSAGES.github_erro, 'resposta sem commit sha');
  }
  return { branch, sha };
}

/** Lista os .manifest da branch (arvore recursiva no commit informado). */
export async function listManifestsAt(appid, sha, { signal } = {}) {
  const repo = repository();
  const { status, res } = await ghGet(
    `/repos/${repo}/git/trees/${encodeURIComponent(sha)}?recursive=1`,
    { signal },
  );
  if (status === 404) {
    throw new SourceError('branch_nao_encontrada', ERROR_MESSAGES.branch_nao_encontrada);
  }
  const body = await res.json().catch(() => null);
  const tree = Array.isArray(body?.tree) ? body.tree : null;
  if (!tree) throw new SourceError('github_erro', ERROR_MESSAGES.github_erro, 'arvore invalida');

  const ext = config.allowedExtension;
  const files = [];
  for (const entry of tree) {
    if (entry.type !== 'blob') continue;
    if (typeof entry.path !== 'string') continue;
    if (!entry.path.toLowerCase().endsWith(ext)) continue;
    if (!isSafeRepoPath(entry.path)) continue;
    const size = Number(entry.size);
    if (!Number.isFinite(size) || size < 0) continue;
    if (size > config.limits.maxFileBytes) continue; // ignorado por exceder limite
    files.push({ path: entry.path, name: safeBaseName(entry.path), size, gitSha: entry.sha });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, truncated: body.truncated === true };
}

/** Baixa um arquivo do repositorio no commit informado, validando integridade. */
export async function fetchFile(appid, file, sha, { signal } = {}) {
  const repo = repository();
  if (!isSafeRepoPath(file.path)) {
    throw new SourceError('caminho_invalido', ERROR_MESSAGES.caminho_invalido);
  }
  if (file.size > config.limits.maxFileBytes) {
    throw new SourceError('arquivo_grande_demais', ERROR_MESSAGES.arquivo_grande_demais, file.name);
  }
  const pathname =
    `/repos/${repo}/contents/${file.path.split('/').map(encodeURIComponent).join('/')}` +
    `?ref=${encodeURIComponent(sha)}`;
  const { status, res } = await ghGet(pathname, { raw: true, signal });
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
export async function ping() {
  const started = Date.now();
  await ghGet('/rate_limit');
  return { ok: true, latencyMs: Date.now() - started };
}
