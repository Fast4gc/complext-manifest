import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import {
  SourceError,
  ERROR_MESSAGES,
  branchHead,
  listManifestsAt,
  fetchFile,
} from './githubSource.js';

/**
 * Cache persistente de manifests, compartilhado pela API e pelo bot
 * (mesmo diretorio no disco / volume do Docker).
 *
 * Estrutura:
 *   <cacheDir>/<appid>/meta.json          lista, commit e metadados
 *   <cacheDir>/<appid>/files/<nome>       conteudo dos .manifest
 *
 * Invalidacao: a entrada guarda o SHA do commit da branch. Quando o commit
 * muda, os arquivos sao baixados novamente. `refresh` força a checagem antes
 * do TTL. Se o GitHub cair, serve cache velho (stale) ate CACHE_STALE_MAX_SECONDS.
 */

const inflight = new Map(); // appid -> Promise (evita rajada de requisições iguais)

function appDir(appid) {
  return path.join(config.cacheDir, appid);
}

function metaPath(appid) {
  return path.join(appDir(appid), 'meta.json');
}

function filesDir(appid) {
  return path.join(appDir(appid), 'files');
}

function readMeta(appid) {
  try {
    const raw = fs.readFileSync(metaPath(appid), 'utf8');
    const meta = JSON.parse(raw);
    if (!meta || !Array.isArray(meta.files) || typeof meta.commit !== 'string') return null;
    return meta;
  } catch {
    return null;
  }
}

function writeMeta(appid, meta) {
  fs.mkdirSync(filesDir(appid), { recursive: true });
  const tmp = metaPath(appid) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, metaPath(appid)); // escrita atomica
}

function clearEntry(appid) {
  fs.rmSync(appDir(appid), { recursive: true, force: true });
}

function ageSeconds(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (Date.now() - t) / 1000 : Infinity;
}

/** Remove arquivos de uma entrada que nao estao mais listados. */
function pruneMissingFiles(appid, keepNames) {
  const dir = filesDir(appid);
  if (!fs.existsSync(dir)) return;
  const keep = new Set(keepNames);
  for (const name of fs.readdirSync(dir)) {
    if (!keep.has(name)) fs.rmSync(path.join(dir, name), { force: true });
  }
}

export function cachedFilePath(appid, name) {
  return path.join(filesDir(appid), name);
}

function verifyCachedFile(appid, file) {
  const full = cachedFilePath(appid, file.name);
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile()) return false;
    if (stat.size !== file.size) return false;
    const fd = fs.openSync(full, 'r');
    try {
      const buf = Buffer.alloc(Math.min(64, file.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/** Garante que todos os arquivos da meta existem e conferem; baixa os faltantes. */
async function ensureFiles(appid, meta, { signal } = {}) {
  const missing = meta.files.filter((f) => !verifyCachedFile(appid, f));
  if (missing.length === 0) return meta;

  for (const file of missing) {
    const { buffer, sha256 } = await fetchFile(appid, file, meta.commit, { signal });
    fs.mkdirSync(filesDir(appid), { recursive: true });
    const tmp = cachedFilePath(appid, file.name) + '.tmp';
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, cachedFilePath(appid, file.name));
    file.sha256 = sha256;
  }
  writeMeta(appid, meta);
  return meta;
}

/** Baixa a lista do GitHub e monta a entrada de cache. */
async function buildEntry(appid, { signal } = {}) {
  const head = await branchHead(appid, { signal });
  const { files, truncated } = await listManifestsAt(appid, head.sha, { signal });

  if (files.length === 0) {
    clearEntry(appid);
    const err = new SourceError('sem_manifests', ERROR_MESSAGES.sem_manifests, {
      branch: head.branch,
      truncated: truncated || undefined,
    });
    throw err;
  }

  let total = 0;
  for (const f of files) total += f.size;
  if (total > config.limits.maxZipBytes) {
    throw new SourceError('zip_grande_demais', ERROR_MESSAGES.zip_grande_demais, {
      bytes: total,
      limite: config.limits.maxZipBytes,
    });
  }

  const meta = {
    appid,
    branch: head.branch,
    commit: head.sha,
    fetchedAt: new Date().toISOString(),
    checkedAt: new Date().toISOString(),
    stale: false,
    truncated: truncated === true,
    totalBytes: total,
    files: files.map((f) => ({ ...f, sha256: null })),
  };

  // Baixa conteudo antes de gravar meta: entrada incompleta nunca e publicada.
  for (const file of meta.files) {
    const { buffer, sha256 } = await fetchFile(appid, file, head.sha, { signal });
    fs.mkdirSync(filesDir(appid), { recursive: true });
    const tmp = cachedFilePath(appid, file.name) + '.tmp';
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, cachedFilePath(appid, file.name));
    file.sha256 = sha256;
  }

  pruneMissingFiles(appid, meta.files.map((f) => f.name));
  writeMeta(appid, meta);
  return meta;
}

async function withLock(appid, fn) {
  if (inflight.has(appid)) return inflight.get(appid);
  const p = (async () => fn()).finally(() => inflight.delete(appid));
  inflight.set(appid, p);
  return p;
}

/**
 * Retorna a lista de manifests do AppID, usando/atualizando o cache.
 *
 * @param {string} appid
 * @param {{ refresh?: boolean, signal?: AbortSignal }} opts
 */
export async function getManifests(appid, { refresh = false, signal } = {}) {
  return withLock(appid, async () => {
    let meta = readMeta(appid);
    const ttl = config.cache.ttlSeconds;

    // 1. Cache novo o suficiente: serve sem tocar no GitHub.
    if (meta && !refresh && ageSeconds(meta.checkedAt) < ttl) {
      await ensureFiles(appid, meta, { signal });
      return { ...meta, cached: true, stale: false };
    }

    // 2. Precisa checar o commit no GitHub.
    try {
      const head = await branchHead(appid, { signal });

      // 2a. Commit igual: apenas estende a validade do cache.
      if (meta && head.sha === meta.commit) {
        meta.checkedAt = new Date().toISOString();
        meta.stale = false;
        writeMeta(appid, meta);
        await ensureFiles(appid, meta, { signal });
        return { ...meta, cached: true, stale: false };
      }

      // 2b. Commit mudou (ou primeiro acesso): invalida e reconstrói.
      const built = await buildEntry(appid, { signal });
      return { ...built, cached: false, stale: false };
    } catch (err) {
      // 3. GitHub fora do ar: serve cache velho enquanto estiver dentro do limite.
      const usable =
        meta &&
        err instanceof SourceError &&
        ['github_timeout', 'github_indisponivel', 'github_rate_limit', 'github_erro'].includes(err.code) &&
        ageSeconds(meta.fetchedAt) < config.cache.staleMaxSeconds;
      if (usable) {
        meta.stale = true;
        await ensureFiles(appid, meta, { signal }).catch(() => {});
        return { ...meta, cached: true, stale: true };
      }
      if (err instanceof SourceError && err.code === 'falha_integridade') {
        // Arquivo corrompido no cache: reconstrui uma vez (ja estamos sob o lock).
        clearEntry(appid);
        const rebuilt = await buildEntry(appid, { signal });
        return { ...rebuilt, cached: false, stale: false };
      }
      throw err;
    }
  });
}

/**
 * Garante que um arquivo especifico da entrada existe (usado antes do ZIP).
 * Retorna o caminho absoluto em cache.
 */
export async function ensureFile(appid, file, { signal } = {}) {
  const meta = await getManifests(appid, { signal });
  const entry = meta.files.find((f) => f.name === file.name);
  if (!entry) {
    throw new SourceError('arquivo_nao_encontrado', ERROR_MESSAGES.arquivo_nao_encontrado);
  }
  if (!verifyCachedFile(appid, entry)) {
    await ensureFiles(appid, meta, { signal });
  }
  return { path: cachedFilePath(appid, entry.name), meta };
}

/** Estatisticas para o health check. */
export function cacheStats() {
  let entries = 0;
  let bytes = 0;
  let stale = 0;
  try {
    for (const name of fs.readdirSync(config.cacheDir)) {
      if (!/^\d{1,12}$/.test(name)) continue;
      const meta = readMeta(name);
      if (!meta) continue;
      entries += 1;
      bytes += Number(meta.totalBytes) || 0;
      if (meta.stale) stale += 1;
    }
  } catch {
    // diretorio ainda nao existe
  }
  return { entries, bytes, stale, dir: config.cacheDir };
}

/** Remove uma entrada de cache (usado pelo CLI/administracao). */
export function invalidate(appid) {
  clearEntry(appid);
}
