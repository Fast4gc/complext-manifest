import express from 'express';
import archiver from 'archiver';
import crypto from 'node:crypto';
import path from 'node:path';
import { config, PROJECT_NAME } from './config.js';
import { createKey, listKeys, revokeKey, validateKey, consumeUse, KEY_FORMAT } from './store.js';
import { allow } from './rateLimit.js';
import { normalizeAppId } from './validate.js';
import { getManifests, cacheStats } from './cache.js';
import { getLua } from './lua.js';
import { SourceError, ERROR_MESSAGES, ping } from './githubSource.js';
import { describeSources, REGISTRY } from './providers/index.js';
import { searchGames, searchCacheStats, SEARCH_CODES } from './search.js';
import { validateZipEntries, assertZipPolicy, zipFilename } from './zip.js';
import { createLink, readLink, linksEnabled, linksStatus, LINK_CODES } from './links.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json());

/** Log sem credenciais: nunca registra query string (onde fica a chave). */
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

/** Status HTTP para cada codigo de erro claro. */
const STATUS_BY_CODE = {
  appid_invalido: 400,
  branch_invalida: 400,
  caminho_invalido: 400,
  arquivo_invalido: 400,
  formato_de_chave_invalido: 400,
  chave_nao_encontrada: 401,
  chave_revogada: 401,
  chave_expirada: 401,
  limite_de_usos_atingido: 403,
  limite_de_requisicoes: 429,
  branch_nao_encontrada: 404,
  sem_manifests: 404,
  sem_lua: 404,
  lua_ambiguo: 409,
  formato_invalido: 400,
  arquivo_nao_encontrado: 404,
  arquivo_grande_demais: 413,
  zip_grande_demais: 413,
  github_timeout: 504,
  github_indisponivel: 502,
  github_erro: 502,
  github_rate_limit: 503,
  github_auth: 502,
  falha_integridade: 502,
  repositorio_nao_configurado: 503,
  repositorio_invalido: 503,
  cache_indisponivel: 503,
  admin_nao_configurado: 503,

  // escolha de fonte
  fonte_desconhecida: 400,
  fonte_desabilitada: 503,
  nenhuma_fonte: 503,

  // busca por nome
  busca_desabilitada: 503,
  busca_invalida: 400,
  busca_indisponivel: 502,
  busca_timeout: 504,

  // links temporarios
  link_desabilitado: 503,
  link_sem_segredo: 503,
  link_invalido: 400,
  link_ttl_invalido: 400,
  link_expirado: 410,
};

/** Mensagens das rotas locais; erros de origem usam ERROR_MESSAGES. */
const LOCAL_MESSAGES = {
  formato_de_chave_invalido: 'Chave de API em formato invalido',
  chave_nao_encontrada: 'Chave de API nao encontrada',
  chave_revogada: 'Chave de API revogada',
  chave_expirada: 'Chave de API expirada',
  limite_de_usos_atingido: 'Limite de usos da chave atingido',
  limite_de_requisicoes: 'Limite de requisicoes por minuto atingido',
  admin_nao_configurado: 'ADMIN_TOKEN nao configurado no servidor',
  ...SEARCH_CODES,
  ...LINK_CODES,
};

function fail(res, code, detail, extra) {
  const status = STATUS_BY_CODE[code] || 500;
  const message = LOCAL_MESSAGES[code] || ERROR_MESSAGES[code] || code;
  return res.status(status).json({
    error: code,
    message,
    ...(detail !== undefined ? { detail } : {}),
    ...(extra || {}),
  });
}

/**
 * `attempts` do erro: quais fontes foram consultadas e qual codigo cada uma
 * devolveu. Acompanha a resposta de erro do mesmo jeito que acompanha a de
 * sucesso — autenticacao e rate limit nao podem sumir so porque falhou tudo.
 */
function attemptsOf(err) {
  const list = err?.attempts;
  return Array.isArray(list) && list.length > 0 ? { attempts: list } : {};
}

/** Atalho: responde um SourceError ja com attempts. */
function failSource(res, err) {
  return fail(res, err.code, err.detail, attemptsOf(err));
}

/** Extrai a chave de API do query param `key` ou do header `X-API-Key`. */
function apiKeyFrom(req) {
  const value = req.get('X-API-Key') || req.query.key;
  return typeof value === 'string' ? value : '';
}

/** Valida chave de API; responde 4xx e retorna null quando invalida. */
function requireApiKey(req, res) {
  const raw = apiKeyFrom(req);
  if (!raw || !KEY_FORMAT.test(raw)) {
    fail(res, 'formato_de_chave_invalido');
    return null;
  }
  const check = validateKey(raw);
  if (!check.ok) {
    fail(res, check.reason);
    return null;
  }
  if (!allow(check.key.id, check.key.rateLimitPerMinute)) {
    fail(res, 'limite_de_requisicoes');
    return null;
  }
  return check.key;
}

/**
 * Normaliza uma fonte pedida pelo cliente (`?source=` ou `{source}` no
 * corpo). Sem fonte, devolve null e a ordem de prioridade decide.
 * Fonte desconhecida/desabilitada vira erro claro — nunca cai para outra
 * fonte as cegas.
 */
function pickSource(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const v = String(raw).trim();
  return v === '' ? null : v;
}

function requestedSource(req) {
  return pickSource(req.query.source);
}

/* ------------------------------------------------------------------ */
/* Health check e documentacao                                         */
/* ------------------------------------------------------------------ */

app.get('/health', async (req, res) => {
  const stats = cacheStats();
  const sources = describeSources();
  // `available` sao as fontes que realmente serao usadas (habilitadas +
  // configuradas + com repositorio no formato valido), nao a lista de todas.
  const gh = sources.sources.find((s) => s.id === 'github') || {};
  const invalid = sources.sources
    .filter((s) => s.enabled && s.valid === false)
    .map((s) => ({ source: s.id, code: s.invalid }));
  const payload = {
    ok: true,
    service: PROJECT_NAME,
    uptimeSec: Math.round(process.uptime()),
    github: {
      configured: Boolean(config.github.repository),
      /** null = nada escrito; false = escrito no formato errado (nao vai funcionar). */
      valid: gh.valid ?? null,
      ...(gh.invalid ? { invalid: gh.invalid } : {}),
      repository: config.github.repository || null,
    },
    sources: {
      order: sources.order,
      available: sources.order,
      ...(invalid.length > 0 ? { invalid } : {}),
    },
    cache: stats,
  };
  if (req.query.deep === '1') {
    const results = [];
    for (const id of sources.order) {
      try {
        results.push({ source: id, ...(await REGISTRY[id].ping()) });
      } catch (err) {
        results.push({
          source: id,
          ok: false,
          code: err instanceof SourceError ? err.code : 'erro_desconhecido',
        });
      }
    }
    payload.deep = results;
    payload.ok = results.length === 0 || results.some((r) => r.ok !== false);
  }
  res.status(payload.ok ? 200 : 503).json(payload);
});

/**
 * Status do servico (autenticado): fontes, cache, busca, links e limites.
 * E a rota que um operador consulta para saber o que esta ligado.
 */
app.get('/status', (req, res) => {
  const key = requireApiKey(req, res);
  if (!key) return;
  res.json({
    service: PROJECT_NAME,
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
    sources: describeSources(),
    cache: cacheStats(),
    search: {
      enabled: config.search.enabled,
      source: 'steam-store',
      resultsLimit: config.search.limit,
      ...searchCacheStats(),
    },
    links: linksStatus(),
    limits: {
      maxFileBytes: config.limits.maxFileBytes,
      maxZipBytes: config.limits.maxZipBytes,
      defaultRatePerMinute: config.limits.defaultRatePerMinute,
      cacheTtlSeconds: config.cache.ttlSeconds,
      cacheStaleMaxSeconds: config.cache.staleMaxSeconds,
    },
    /** O que este servico NAO faz, para nao prometer de graça. */
    doesNot: [
      'gerar manifests a partir de um AppID',
      'gerar chaves de depot ou arquivos Lua a partir de manifests',
      'executar arquivos recebidos (Lua e tratado como dado)',
      'consultar fontes que exigem login de terceiros',
    ],
  });
});

/** Lista as fontes configuradas e a ordem efetiva. */
app.get('/sources', (req, res) => {
  const key = requireApiKey(req, res);
  if (!key) return;
  res.json(describeSources());
});

/**
 * Pesquisa por nome de jogo -> AppID.
 * Fonte publica verificada (loja da Steam), com cache e timeout proprio.
 */
app.get('/search', async (req, res) => {
  const key = requireApiKey(req, res);
  if (!key) return;
  // Bucket proprio: nao deixa uma chuva de buscas estourar a cota da loja.
  if (!allow(`search:${key.id}`, Math.min(key.rateLimitPerMinute, config.search.ratePerMinute))) {
    return fail(res, 'limite_de_requisicoes');
  }
  try {
    const payload = await searchGames(req.query.q, { refresh: req.query.refresh === '1' });
    res.json(payload);
  } catch (err) {
    if (err instanceof SourceError) return failSource(res, err);
    console.error('erro inesperado em /search:', err?.message || err);
    return fail(res, 'busca_indisponivel');
  }
});

const DOCS_HTML = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Manifest Gate - Rotas</title>
<style>body{font-family:system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;line-height:1.5}
code,pre{background:#f2f2f2;padding:.15rem .35rem;border-radius:4px}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #ddd;padding:.5rem;text-align:left}th{background:#fafafa}</style></head><body>
<h1>Manifest Gate &mdash; documentacao das rotas</h1>
<p>Autenticacao: chave de API no header <code>X-API-Key: &lt;chave&gt;</code> ou
query <code>key=&lt;chave&gt;</code>. Rotas <code>/admin/*</code> usam
<code>X-Admin-Token: &lt;ADMIN_TOKEN&gt;</code>.</p>
<h2>Publicas</h2>
<table><tr><th>Rota</th><th>Descricao</th></tr>
<tr><td><code>GET /health</code></td><td>Health check. <code>?deep=1</code> testa todas as fontes.</td></tr>
<tr><td><code>GET /docs</code></td><td>Esta pagina.</td></tr>
<tr><td><code>GET /links/&lt;token&gt;</code></td><td>Lua ou ZIP via link temporario (token assinado, sem chave). Expira sozinho.</td></tr></table>
<h2>Com chave de API</h2>
<table><tr><th>Rota</th><th>Descricao</th></tr>
<tr><td><code>GET /manifests?id=&lt;appid&gt;&amp;source=&lt;fonte&gt;&amp;refresh=1</code></td>
<td>Lista os <code>.manifest</code> (baixaveis) e os <code>.lua/.json</code> (so descritos, com link direto).
Cache com invalidacao por commit e proveniencia por pacote.</td></tr>
<tr><td><code>GET /download?id=&lt;appid&gt;&amp;source=&lt;fonte&gt;</code></td>
<td>Arquivo <code>&lt;appid&gt;.lua</code> original da fonte. Para ZIP de manifests, use <code>&amp;format=manifests</code>. Consome 1 uso da chave.</td></tr>
<tr><td><code>GET /sources</code></td><td>Fontes disponiveis, prioridade e o que cada uma NAO faz.</td></tr>
<tr><td><code>GET /search?q=&lt;nome&gt;</code></td><td>Pesquisa de nome &rarr; AppID (loja da Steam, fonte publica).</td></tr>
<tr><td><code>GET /status</code></td><td>Status completo: fontes, cache, busca, links, limites.</td></tr>
<tr><td><code>POST /links</code></td><td>Emite link temporario: <code>{id, source, ttl, format} (format: lua por padrao, ou manifests)</code>. Consome 1 uso.</td></tr></table>
<h2>Admin (X-Admin-Token)</h2>
<table><tr><th>Rota</th><th>Descricao</th></tr>
<tr><td><code>POST /admin/keys</code></td><td>Cria chave: <code>{name, expiresAt, maxUses, rateLimitPerMinute}</code></td></tr>
<tr><td><code>GET /admin/keys</code></td><td>Lista chaves (sem o valor)</td></tr>
<tr><td><code>DELETE /admin/keys/:id</code></td><td>Revoga chave</td></tr></table>
<h2>Escolha de fonte</h2>
<p><code>source=manifesthub</code> ou <code>source=github</code> consulta UMA fonte so.
Se ela falhar, o erro dela e o erro da resposta — nao cai para outra as cegas.
Sem <code>source</code>, vale a ordem de <code>SOURCE_PRIORITY</code> com fallback.
A resposta traz <code>attempts</code> (quem foi consultado e qual codigo voltou)
e os cabecalhos <code>X-Manifest-Gate-*</code> com fonte, origem, commit e data.</p>
<h2>Exemplos</h2>
<pre>curl -H "X-API-Key: SUA_CHAVE" "{{BASE}}/manifests?id=123456"
curl -H "X-API-Key: SUA_CHAVE" "{{BASE}}/manifests?id=123456&source=manifesthub"
curl -H "X-API-Key: SUA_CHAVE" "{{BASE}}/search?q=counter-strike"
curl -H "X-API-Key: SUA_CHAVE" "{{BASE}}/sources"
curl -OJ -H "X-API-Key: SUA_CHAVE" "{{BASE}}/download?id=123456"

curl -X POST {{BASE}}/links \\
  -H "Content-Type: application/json" -H "X-API-Key: SUA_CHAVE" \\
  -d '{"id":"123456","source":"manifesthub","ttl":600}'

curl -X POST {{BASE}}/admin/keys \\
  -H "Content-Type: application/json" -H "X-Admin-Token: SEU_TOKEN" \\
  -d '{"name":"cliente-1","maxUses":100}'</pre>
<h2>Politica do pacote</h2>
<p>O ZIP contem <strong>apenas <code>.manifest</code></strong>. Os arquivos
<code>.lua</code> e <code>.json</code> aparecem na listagem como
<code>kind: "config"</code>, com <code>containsKeys: true</code>, o aviso
<code>warning</code> e um <code>rawUrl</code> direto para o repositorio
publico. O download padrao entrega o Lua existente; JSON permanece apenas listado.
<code>*.vdf</code> nem e listado. Nada do conteudo recebido e executado.</p>
<p>Codigos de erro claros: <code>branch_nao_encontrada</code>,
<code>sem_lua</code>, <code>lua_ambiguo</code>, <code>sem_manifests</code>, <code>fonte_desconhecida</code>,
<code>fonte_desabilitada</code>, <code>nenhuma_fonte</code>,
<code>github_auth</code>, <code>github_rate_limit</code>,
<code>github_timeout</code>, <code>zip_grande_demais</code> entre outros.</p>
</body></html>`;

/**
 * A pagina usa o host QUEM ABRIU para montar os exemplos: `localhost:3000`
 * escrito no codigo so funciona na maquina da API e confunde quem acessa de
 * fora (ou via Docker). `PUBLIC_BASE_URL` (se definido) manda na hora de
 * mostrar a URL base; sem ele, vale o host da propria requisicao.
 */
app.get('/docs', (req, res) => {
  const configured = config.links.publicBaseUrl;
  const base = configured || `${req.protocol}://${req.get('host') || `localhost:${config.port}`}`;
  res.type('html').send(DOCS_HTML.replaceAll('{{BASE}}', base));
});

/* ------------------------------------------------------------------ */
/* Admin: gestao de chaves                                             */
/* ------------------------------------------------------------------ */

function adminOnly(req, res, next) {
  if (!config.adminToken) return fail(res, 'admin_nao_configurado');
  const sent = Buffer.from(req.get('X-Admin-Token') || '');
  const expected = Buffer.from(config.adminToken);
  if (sent.length !== expected.length || !crypto.timingSafeEqual(sent, expected)) {
    return res.status(401).json({ error: 'token_admin_invalido', message: 'Token de admin invalido' });
  }
  next();
}

app.post('/admin/keys', adminOnly, (req, res) => {
  const { name, expiresAt, maxUses, rateLimitPerMinute } = req.body || {};
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
    return res.status(400).json({ error: 'expiresAt_invalido', message: 'Data de expiracao invalida' });
  }
  if (maxUses !== undefined && maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) {
    return res.status(400).json({ error: 'maxUses_invalido', message: 'maxUses deve ser inteiro >= 1' });
  }
  const created = createKey({ name, expiresAt, maxUses, rateLimitPerMinute });
  res.status(201).json({ ...created, note: 'Guarde a chave: ela nao sera exibida novamente.' });
});

app.get('/admin/keys', adminOnly, (_req, res) => {
  res.json({ keys: listKeys() });
});

app.delete('/admin/keys/:id', adminOnly, (req, res) => {
  if (!revokeKey(req.params.id)) {
    return res.status(404).json({ error: 'chave_nao_encontrada', message: 'Chave nao encontrada' });
  }
  res.json({ ok: true, revoked: true });
});

/* ------------------------------------------------------------------ */
/* Manifests                                                           */
/* ------------------------------------------------------------------ */

/**
 * Monta a resposta de /manifests: manifests baixaveis + arquivos de
 * configuracao apenas descritos + proveniencia do pacote.
 */
function listingPayload(appid, meta) {
  const source = meta.source;
  return {
    appid,
    /** Proveniencia: de onde, em que commit, quando. */
    source,
    origin: meta.origin || null,
    version: meta.version || meta.commit,
    commit: meta.commit,
    branch: meta.branch,
    fetchedAt: meta.fetchedAt,
    checkedAt: meta.checkedAt,
    stale: meta.stale === true,

    count: meta.files.length,
    manifestCount: meta.files.length,
    configCount: (meta.configFiles || []).length,
    totalBytes: meta.totalBytes,
    cached: meta.cached === true,
    truncated: meta.truncated === true,

    files: meta.files.map((f) => ({
      name: f.name,
      path: f.path,
      size: f.size,
      sha256: f.sha256,
      kind: f.kind || 'manifest',
      depotId: f.depotId ?? null,
      /** ManifestID SEMPRE string: ultrapassa 2^53. */
      manifestId: f.manifestId ?? null,
    })),

    /** So descrito, nunca entregue. `rawUrl` aponta para o repositorio. */
    configFiles: (meta.configFiles || []).map((f) => ({
      name: f.name,
      path: f.path,
      size: f.size,
      kind: f.kind || 'config',
      containsKeys: f.containsKeys === true,
      warning: f.warning,
      rawUrl: f.rawUrl,
    })),

    /** Quem foi consultado e qual codigo cada fonte devolveu. */
    attempts: meta.attempts || [],
    download: `/download?id=${appid}${source ? `&source=${source}` : ''}&format=manifests`,
  };
}

/** Cabecalhos de proveniencia usados nas respostas de download. */
function provenanceHeaders(res, meta) {
  const ascii = (v) => String(v ?? '').replace(/[^\w.:/@ -]/g, '_').slice(0, 200);
  res.setHeader('X-Manifest-Gate-Source', ascii(meta.source));
  if (meta.origin) res.setHeader('X-Manifest-Gate-Origin', ascii(meta.origin));
  res.setHeader('X-Manifest-Gate-Version', ascii(meta.version || meta.commit));
  res.setHeader('X-Manifest-Gate-Fetched-At', ascii(meta.fetchedAt));
}

async function handleManifests(req, res) {
  const key = requireApiKey(req, res);
  if (!key) return;

  const appid = normalizeAppId(req.query.id);
  if (!appid) return fail(res, 'appid_invalido');

  try {
    const meta = await getManifests(appid, {
      source: requestedSource(req),
      refresh: req.query.refresh === '1',
    });
    res.json(listingPayload(appid, meta));
  } catch (err) {
    if (err instanceof SourceError) return failSource(res, err);
    console.error('erro inesperado em /manifests:', err?.message || err);
    return fail(res, 'github_erro');
  }
}

/**
 * Emite o ZIP. Compartilhado entre /download (com chave) e /links/:token
 * (com token assinado) — mesma validacao, mesmo conteudo.
 */
function streamZip(res, meta) {
  const entries = validateZipEntries(meta);
  assertZipPolicy(entries);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipFilename(meta.appid, { source: meta.source })}"`);
  res.setHeader('X-Cache', meta.stale ? 'stale' : meta.cached ? 'hit' : 'miss');
  provenanceHeaders(res, meta);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('warning', (err) => console.warn('aviso do archive:', err?.message || err));
  archive.on('error', (err) => {
    console.error('erro no archive:', err?.message || err);
    res.destroy(err);
  });
  archive.pipe(res);
  for (const entry of entries) archive.file(entry.full, { name: entry.name });
  archive.finalize();
}

function requestedFormat(value) {
  const format = value ?? 'lua';
  if (format !== 'lua' && format !== 'manifests') {
    throw new SourceError('formato_invalido', ERROR_MESSAGES.formato_invalido);
  }
  return format;
}

function sendLua(res, file) {
  provenanceHeaders(res, file);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.setHeader('X-Content-SHA256', file.sha256);
  res.send(file.buffer);
}

async function handleDownload(req, res) {
  const key = requireApiKey(req, res);
  if (!key) return;

  const appid = normalizeAppId(req.query.id);
  if (!appid) return fail(res, 'appid_invalido');

  let meta;
  try {
    if (requestedFormat(req.query.format) === 'lua') {
      const file = await getLua(appid, { source: requestedSource(req) });
      sendLua(res, file);
      consumeUse(key.id);
      return;
    }
    meta = await getManifests(appid, {
      source: requestedSource(req),
      refresh: req.query.refresh === '1',
    });
  } catch (err) {
    if (err instanceof SourceError) return failSource(res, err);
    console.error('erro inesperado em /download:', err?.message || err);
    return fail(res, 'github_erro');
  }

  try {
    streamZip(res, meta);
  } catch (err) {
    if (err instanceof SourceError) return failSource(res, err);
    throw err;
  }
  consumeUse(key.id);
}

/* ------------------------------------------------------------------ */
/* Links temporarios                                                   */
/* ------------------------------------------------------------------ */

/** Emite um link temporario. Consome 1 uso da chave (e um download). */
app.post('/links', (req, res, next) => {
  handleCreateLink(req, res).catch(next);
});

async function handleCreateLink(req, res) {
  const key = requireApiKey(req, res);
  if (!key) return;

  if (!linksEnabled()) return fail(res, 'link_desabilitado');

  const appid = normalizeAppId(req.body?.id ?? req.query.id);
  if (!appid) return fail(res, 'appid_invalido');

  const source = pickSource(req.body?.source);
  const ttl = req.body?.ttl ?? req.body?.ttlSeconds;

  try {
    // Resolve AGORA para validar a fonte antes de prometer o link.
    const format = requestedFormat(req.body?.format ?? req.query.format);
    const resolved = format === 'lua'
      ? await getLua(appid, { source })
      : await getManifests(appid, { source });
    const link = createLink({
      source: resolved.source,
      appid,
      format,
      ttlSeconds: ttl,
      createdBy: key.id,
    });
    consumeUse(key.id);
    res.status(201).json({
      ...link,
      /** O link so carrega isto. Nada de chave ou credencial nele. */
      scope: { id: appid, source: resolved.source, format },
      note: 'Link assinado e com expiracao. Quem tiver o URL baixa; ele nao da acesso a mais nada.',
    });
  } catch (err) {
    if (err instanceof SourceError) return failSource(res, err);
    if (err?.code && LINK_CODES[err.code]) return fail(res, err.code);
    console.error('erro inesperado em /links:', err?.message || err);
    return fail(res, 'github_erro');
  }
}

/** ZIP via token. A assinatura e o controle de acesso: sem chave. */
app.get('/links/:token', async (req, res, next) => {
  try {
    if (!allow(`link:${req.ip}`, 60)) return fail(res, 'limite_de_requisicoes');

    let scope;
    try {
      scope = readLink(req.params.token);
    } catch (err) {
      return fail(res, err?.code || 'link_invalido');
    }

    let meta;
    try {
      if (scope.format === 'lua') {
        const file = await getLua(scope.appid, { source: scope.source || null });
        sendLua(res, file);
        return;
      }
      meta = await getManifests(scope.appid, { source: scope.source || null });
    } catch (err) {
      if (err instanceof SourceError) return failSource(res, err);
      throw err;
    }

    streamZip(res, meta);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Rotas                                                               */
/* ------------------------------------------------------------------ */

app.get('/manifests', (req, res) => {
  handleManifests(req, res).catch((err) => {
    console.error('erro nao tratado:', err?.message || err);
    fail(res, 'github_erro');
  });
});

app.get('/download', (req, res) => {
  handleDownload(req, res).catch((err) => {
    console.error('erro nao tratado:', err?.message || err);
    fail(res, 'github_erro');
  });
});

app.use((req, res) =>
  res.status(404).json({ error: 'rota_nao_encontrada', message: `Rota ${req.path} nao existe. Veja /docs` }),
);

app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'json_invalido', message: 'JSON invalido no corpo da requisicao' });
  }
  console.error('erro no middleware:', err?.message || err);
  res.status(500).json({ error: 'erro_interno', message: 'Erro interno do servidor' });
});

export function start(port = config.port, host = config.host) {
  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      if (!config.adminToken) {
        console.warn('AVISO: ADMIN_TOKEN nao definido — rotas /admin desabilitadas.');
      }
      const sources = describeSources();
      if (sources.order.length === 0) {
        console.warn('AVISO: nenhuma fonte configurada — /manifests respondera 503.');
      } else {
        console.log(`fontes (ordem): ${sources.order.join(' -> ')}`);
      }
      if (!config.links.publicBaseUrl) {
        console.log('links temporarios: desligados (PUBLIC_BASE_URL vazio)');
      }
      console.log(`API em http://${host}:${server.address().port} (${PROJECT_NAME})`);
      console.log(`cache: ${config.cacheDir}`);
      resolve(server);
    });
  });
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  start();
}
