import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { SourceError, ERROR_MESSAGES } from './githubSource.js';
import { resolveOrder, withFallback, REGISTRY } from './providers/index.js';
import { parseManifestName } from './validate.js';

/**
 * Cache persistente de manifests, compartilhado pela API e pelo bot
 * (mesmo diretorio no disco / volume do Docker).
 *
 * Estrutura:
 *   <cacheDir>/<source>/<appid>/meta.json       lista, commit e proveniencia
 *   <cacheDir>/<source>/<appid>/files/<nome>    conteudo dos .manifest
 *
 * A fonte faz parte do caminho: a mesma entrada so vale para a fonte que a
 * produziu. Consultar `source=manifesthub` nunca serve conteudo que veio do
 * `github`, e trocar de fonte nao reescreve a cache da outra.
 *
 * Proveniencia: `meta.source` (fonte), `meta.origin` (repositorio),
 * `meta.version`/`meta.commit` (commit da fonte) e `meta.fetchedAt`
 * (data da consulta). Isso acompanha a resposta da API e os cabecalhos do
 * ZIP, para dar para rastrear de onde veio cada pacote.
 *
 * Invalidacao: a entrada guarda o SHA do commit da branch. Quando o commit
 * muda, os arquivos sao baixados novamente. `refresh` força a checagem antes
 * do TTL. Se a fonte cair, serve cache velho (stale) ate CACHE_STALE_MAX_SECONDS.
 *
 * Nada aqui baixa `.lua`, `.json` ou `*.vdf` — so `.manifest` (ver
 * `validate.js` > politica de entrega).
 */

const SOURCE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const APPID_RE = /^\d{1,12}$/;

/** Chave de lock e caminho precisam da fonte junto. */
const lockKey = (source, appid) => `${source}:${appid}`;

const inflight = new Map(); // source:appid -> Promise (evita rajada de iguais)
const fileInflight = new Map(); // caminho absoluto -> Promise (mesmo arquivo)

let migrated = false;
let evicted = 0;

function assertPath(source, appid) {
  if (!SOURCE_RE.test(String(source || ''))) {
    throw new SourceError('fonte_desconhecida', 'Fonte desconhecida');
  }
  if (!APPID_RE.test(String(appid || ''))) {
    throw new SourceError('appid_invalido', ERROR_MESSAGES.appid_invalido);
  }
}

function appDir(source, appid) {
  assertPath(source, appid);
  return path.join(config.cacheDir, source, appid);
}

function metaPath(source, appid) {
  return path.join(appDir(source, appid), 'meta.json');
}

function filesDir(source, appid) {
  return path.join(appDir(source, appid), 'files');
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Entradas antigas (antes de a fonte entrar no caminho) ficavam em
 * <cacheDir>/<appid>. Sao movidas para a fonte principal uma unica vez, para
 * nao re-baixar tudo em quem ja tem cache. Se der errado, paciencia: a
 * entrada e refeita no proximo acesso.
 */
function migrateLegacyCache() {
  if (migrated) return;
  migrated = true;
  let names;
  try {
    names = fs.readdirSync(config.cacheDir);
  } catch {
    return; // diretorio ainda nao existe
  }
  let primary = null;
  for (const id of Object.keys(REGISTRY)) {
    const d = REGISTRY[id].describe();
    if (d.enabled && d.configured) {
      primary = id;
      if (config.sources.priority[0] === id) break;
    }
  }
  if (!primary) return;

  for (const name of names) {
    if (!APPID_RE.test(name)) continue;
    const from = path.join(config.cacheDir, name);
    try {
      if (!fs.statSync(from).isDirectory()) continue;
      if (!fs.existsSync(path.join(from, 'meta.json'))) continue;
      const to = path.join(config.cacheDir, primary, name);
      if (fs.existsSync(to)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      const mp = path.join(to, 'meta.json');
      const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
      meta.source = primary;
      fs.writeFileSync(mp, JSON.stringify(meta, null, 2));
    } catch {
      // deixa a antiga onde esta; sera ignorada e refeita
    }
  }
}

function readMeta(source, appid) {
  try {
    const raw = fs.readFileSync(metaPath(source, appid), 'utf8');
    const meta = JSON.parse(raw);
    if (!meta || !Array.isArray(meta.files) || typeof meta.commit !== 'string') return null;
    // Entrada de outra fonte (ou migrada sem fonte) nao serve aqui.
    if (meta.source && meta.source !== source) return null;
    meta.source = source;
    if (!Array.isArray(meta.configFiles)) meta.configFiles = [];
    return meta;
  } catch {
    return null;
  }
}

function writeMeta(source, appid, meta) {
  fs.mkdirSync(filesDir(source, appid), { recursive: true });
  const tmp = metaPath(source, appid) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, metaPath(source, appid)); // escrita atomica
}

function clearEntry(source, appid) {
  try {
    fs.rmSync(appDir(source, appid), { recursive: true, force: true });
  } catch {
    // ja removido
  }
}

function ageSeconds(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (Date.now() - t) / 1000 : Infinity;
}

/** Remove arquivos de uma entrada que nao estao mais listados. */
function pruneMissingFiles(source, appid, keepNames) {
  const dir = filesDir(source, appid);
  if (!fs.existsSync(dir)) return;
  const keep = new Set(keepNames);
  for (const name of fs.readdirSync(dir)) {
    if (!keep.has(name)) fs.rmSync(path.join(dir, name), { force: true });
  }
}

export function cachedFilePath(source, appid, name) {
  return path.join(filesDir(source, appid), name);
}

function verifyCachedFile(source, appid, file) {
  const full = cachedFilePath(source, appid, file.name);
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size !== file.size) return false;
    // Integridade completa quando temos o sha256 registrado na meta.
    if (file.sha256) {
      const actual = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      if (actual !== file.sha256) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Baixa um arquivo uma unica vez mesmo com varias requisicoes pedindo ele.
 * Retorna a promessa compartilhada.
 */
function downloadOnce(provider, source, appid, file, { signal } = {}) {
  const key = cachedFilePath(source, appid, file.name);
  const running = fileInflight.get(key);
  if (running) return running;

  const p = (async () => {
    const { buffer, sha256 } = await provider.download(appid, file, { signal, ref: file.ref });
    fs.mkdirSync(filesDir(source, appid), { recursive: true });
    const tmp = key + '.tmp';
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, key); // escrita atomica
    return { sha256 };
  })().finally(() => fileInflight.delete(key));

  fileInflight.set(key, p);
  return p;
}

/** Garante que todos os arquivos da meta existem e conferem; baixa os faltantes. */
async function ensureFiles(provider, source, appid, meta, { signal } = {}) {
  const missing = meta.files.filter((f) => !verifyCachedFile(source, appid, f));
  if (missing.length === 0) return meta;

  let changed = false;
  for (const file of missing) {
    const { sha256 } = await downloadOnce(provider, source, appid, file, { signal });
    file.sha256 = sha256;
    changed = true;
  }
  if (changed) writeMeta(source, appid, meta);
  return meta;
}

/** Baixa a listagem da fonte e monta a entrada de cache. */
async function buildEntry(provider, source, appid, { signal, head } = {}) {
  const listing = await provider.list(appid, { signal, head });
  const { files, configFiles, truncated } = listing;

  if (files.length === 0) {
    clearEntry(source, appid);
    throw new SourceError('sem_manifests', ERROR_MESSAGES.sem_manifests, {
      branch: listing.ref,
      truncated: truncated || undefined,
      /** Informa que so havia arquivos de configuracao (que nao entregamos). */
      configOnly: configFiles.length > 0 || undefined,
      ...(configFiles.length > 0 ? { configuracao: configFiles.map((f) => f.name) } : {}),
    });
  }

  let total = 0;
  for (const f of files) total += f.size;
  if (total > config.limits.maxZipBytes) {
    throw new SourceError('zip_grande_demais', ERROR_MESSAGES.zip_grande_demais, {
      bytes: total,
      limite: config.limits.maxZipBytes,
    });
  }

  const described = provider.describe();
  const meta = {
    appid,
    source,
    /** Proveniencia: de onde, em que commit, quando. */
    origin: described.repository || null,
    version: listing.version,
    branch: listing.ref,
    commit: listing.version,
    fetchedAt: nowIso(),
    checkedAt: nowIso(),
    lastAccessAt: nowIso(),
    stale: false,
    truncated: truncated === true,
    totalBytes: total,
    manifestCount: files.length,
    configCount: configFiles.length,
    files: files.map((f) => ({
      ...f,
      ref: listing.version,
      sha256: null,
      ...parseManifestName(f.path || f.name),
    })),
    // So metadados. Estes arquivos NUNCA sao baixados (contem chaves).
    configFiles,
  };

  // Baixa conteudo antes de gravar meta: entrada incompleta nunca e publicada.
  for (const file of meta.files) {
    const { sha256 } = await downloadOnce(provider, source, appid, file, { signal });
    file.sha256 = sha256;
  }

  pruneMissingFiles(source, appid, meta.files.map((f) => f.name));
  writeMeta(source, appid, meta);
  enforceCacheLimit(source, appid);
  return meta;
}

async function withLock(source, appid, fn) {
  const key = lockKey(source, appid);
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => fn())().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/* ------------------------------------------------------------------ */
/* Limite de armazenamento                                             */
/* ------------------------------------------------------------------ */

/** Varre a cache inteira: entradas com bytes e data de busca. */
function listEntries() {
  const out = [];
  let roots;
  try {
    roots = fs.readdirSync(config.cacheDir);
  } catch {
    return out;
  }
  for (const source of roots) {
    if (!SOURCE_RE.test(source)) continue;
    let appids;
    try {
      appids = fs.readdirSync(path.join(config.cacheDir, source));
    } catch {
      continue;
    }
    for (const appid of appids) {
      if (!APPID_RE.test(appid)) continue;
      const meta = readMeta(source, appid);
      if (!meta) continue;
      out.push({
        source,
        appid,
        bytes: Number(meta.totalBytes) || 0,
        at: meta.fetchedAt,
      });
    }
  }
  return out;
}

/**
 * Mantem o total do cache dentro de CACHE_MAX_BYTES, removendo primeiro as
 * entradas mais antigas (por data de busca). A entrada recem-escrita nunca e
 * removida, mesmo que ela sozinha ja estoure o teto — apagar o que acabou de
 * chegar so faria re-baixar em loop.
 */
function enforceCacheLimit(justBuiltSource = null, justBuiltAppid = null) {
  const max = Number(config.cache.maxBytes) || 0;
  if (max <= 0) return;

  const entries = listEntries();
  let total = 0;
  for (const e of entries) total += e.bytes;
  if (total <= max) return;

  entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const e of entries) {
    if (total <= max) break;
    if (e.source === justBuiltSource && e.appid === justBuiltAppid) continue;
    clearEntry(e.source, e.appid);
    total -= e.bytes;
    evicted += 1;
  }
}

/* ------------------------------------------------------------------ */
/* API publica do cache                                                */
/* ------------------------------------------------------------------ */

/**
 * Consulta de manifests com fallback entre fontes.
 *
 * @param {string} appid
 * @param {{source?: string|null, refresh?: boolean, signal?: AbortSignal}} opts
 *   `source` explícito => SEM fallback: ou a fonte responde, ou o erro dela.
 * @returns {Promise<object>} meta + source + attempts (proveniencia)
 */
export async function getManifests(appid, { source = null, refresh = false, signal } = {}) {
  migrateLegacyCache();
  const order = resolveOrder(source);
  const { source: winner, value, attempts } = await withFallback(order, (id) =>
    getFromSource(id, appid, { refresh, signal }),
  );
  return { ...value, source: winner, attempts };
}

async function getFromSource(source, appid, { refresh = false, signal } = {}) {
  const provider = REGISTRY[source];
  if (!provider) {
    throw new SourceError('fonte_desconhecida', 'Fonte desconhecida');
  }

  return withLock(source, appid, async () => {
    let meta = readMeta(source, appid);
    const ttl = config.cache.ttlSeconds;

    // 1. Cache novo o suficiente: serve sem tocar na fonte.
    if (meta && !refresh && ageSeconds(meta.checkedAt) < ttl) {
      await ensureFiles(provider, source, appid, meta, { signal });
      return { ...meta, cached: true, stale: false };
    }

    // 2. Precisa checar o commit na fonte.
    try {
      const head = await provider.availability(appid, { signal });

      // 2a. Commit igual: apenas estende a validade do cache.
      if (meta && head.commit === meta.commit) {
        meta.checkedAt = nowIso();
        meta.lastAccessAt = nowIso();
        meta.stale = false;
        writeMeta(source, appid, meta);
        await ensureFiles(provider, source, appid, meta, { signal });
        return { ...meta, cached: true, stale: false };
      }

      // 2b. Commit mudou (ou primeiro acesso): invalida e reconstrói.
      const built = await buildEntry(provider, source, appid, { signal, head });
      return { ...built, cached: false, stale: false };
    } catch (err) {
      // 3. Fonte fora do ar: serve cache velho enquanto estiver dentro do limite.
      const usable =
        meta &&
        err instanceof SourceError &&
        ['github_timeout', 'github_indisponivel', 'github_rate_limit', 'github_erro'].includes(
          err.code,
        ) &&
        ageSeconds(meta.fetchedAt) < config.cache.staleMaxSeconds;
      if (usable) {
        meta.stale = true;
        meta.lastAccessAt = nowIso();
        await ensureFiles(provider, source, appid, meta, { signal }).catch(() => {});
        return { ...meta, cached: true, stale: true };
      }
      if (err instanceof SourceError && err.code === 'falha_integridade') {
        // Arquivo corrompido no cache: reconstrui uma vez (ja estamos sob o lock).
        clearEntry(source, appid);
        const rebuilt = await buildEntry(provider, source, appid, { signal });
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
export async function ensureFile(appid, file, { source = null, signal } = {}) {
  migrateLegacyCache();
  const order = resolveOrder(source);
  const src = order[0];
  const meta = await getFromSource(src, appid, { signal });
  const entry = meta.files.find((f) => f.name === file.name);
  if (!entry) {
    throw new SourceError('arquivo_nao_encontrado', ERROR_MESSAGES.arquivo_nao_encontrado);
  }
  if (!verifyCachedFile(src, appid, entry)) {
    await ensureFiles(REGISTRY[src], src, appid, meta, { signal });
  }
  return { path: cachedFilePath(src, appid, entry.name), meta, source: src };
}

/** Estatisticas para o health check. */
export function cacheStats() {
  migrateLegacyCache();
  let entries = 0;
  let bytes = 0;
  let stale = 0;
  const bySource = {};
  for (const e of listEntries()) {
    entries += 1;
    bytes += e.bytes;
    bySource[e.source] = (bySource[e.source] || 0) + 1;
    const meta = readMeta(e.source, e.appid);
    if (meta?.stale) stale += 1;
  }
  return {
    entries,
    bytes,
    stale,
    evicted,
    maxBytes: config.cache.maxBytes,
    dir: config.cacheDir,
    bySource,
  };
}

/**
 * Remove uma entrada de cache.
 * @param {string} appid
 * @param {{source?: string|null}} opts  fonte especifica; sem isso, todas
 */
export function invalidate(appid, { source = null } = {}) {
  migrateLegacyCache();
  const src = source || null;
  const targets = src ? [src] : (() => {
    try {
      return fs.readdirSync(config.cacheDir).filter((n) => SOURCE_RE.test(n));
    } catch {
      return [];
    }
  })();
  for (const s of targets) clearEntry(s, appid);
  // Entrada legada (formato antigo, sem a fonte no caminho).
  if (APPID_RE.test(String(appid))) {
    try {
      if (fs.existsSync(path.join(config.cacheDir, appid, 'meta.json'))) {
        fs.rmSync(path.join(config.cacheDir, appid), { recursive: true, force: true });
      }
    } catch {
      // ja removido
    }
  }
}
