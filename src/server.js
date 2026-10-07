import express from 'express';
import archiver from 'archiver';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, PROJECT_NAME } from './config.js';
import { createKey, listKeys, revokeKey, validateKey, consumeUse, KEY_FORMAT } from './store.js';
import { allow } from './rateLimit.js';
import { normalizeAppId } from './validate.js';
import { getManifests, cacheStats, cachedFilePath } from './cache.js';
import { SourceError, ERROR_MESSAGES, ping } from './githubSource.js';

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
  chave_nao_encontrada: 401,
  chave_revogada: 401,
  chave_expirada: 401,
  formato_de_chave_invalido: 400,
  limite_de_usos_atingido: 403,
  limite_de_requisicoes: 429,
  branch_nao_encontrada: 404,
  sem_manifests: 404,
  arquivo_nao_encontrado: 404,
  arquivo_grande_demais: 413,
  zip_grande_demais: 413,
  github_timeout: 504,
  github_indisponivel: 502,
  github_erro: 502,
  github_rate_limit: 503,
  falha_integridade: 502,
  repositorio_nao_configurado: 503,
  repositorio_invalido: 503,
  cache_indisponivel: 503,
  admin_nao_configurado: 503,
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
};

function fail(res, code, detail) {
  const status = STATUS_BY_CODE[code] || 500;
  const message = LOCAL_MESSAGES[code] || ERROR_MESSAGES[code] || code;
  return res.status(status).json({ error: code, message, ...(detail !== undefined ? { detail } : {}) });
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

/* ------------------------------------------------------------------ */
/* Health check e documentacao                                         */
/* ------------------------------------------------------------------ */

app.get('/health', async (req, res) => {
  const stats = cacheStats();
  const payload = {
    ok: true,
    service: PROJECT_NAME,
    uptimeSec: Math.round(process.uptime()),
    github: {
      configured: Boolean(config.github.repository),
      repository: config.github.repository || null,
    },
    cache: stats,
  };
  if (req.query.deep === '1') {
    try {
      payload.github.reachable = await ping();
    } catch (err) {
      payload.ok = false;
      payload.github.reachable = false;
      payload.github.error = err instanceof SourceError ? err.code : 'erro_desconhecido';
    }
  }
  res.status(payload.ok ? 200 : 503).json(payload);
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
<tr><td><code>GET /health</code></td><td>Health check. <code>?deep=1</code> testa o GitHub.</td></tr>
<tr><td><code>GET /docs</code></td><td>Esta pagina.</td></tr></table>
<h2>Com chave de API</h2>
<table><tr><th>Rota</th><th>Descricao</th></tr>
<tr><td><code>GET /manifests?id=&lt;appid&gt;&amp;refresh=1</code></td>
<td>Lista os <code>.manifest</code> da branch do AppID (cache com invalidacao por commit).</td></tr>
<tr><td><code>GET /download?id=&lt;appid&gt;</code></td>
<td>Baixa os manifests da branch em ZIP. Consome 1 uso da chave.</td></tr></table>
<h2>Admin (X-Admin-Token)</h2>
<table><tr><th>Rota</th><th>Descricao</th></tr>
<tr><td><code>POST /admin/keys</code></td><td>Cria chave: <code>{name, expiresAt, maxUses, rateLimitPerMinute}</code></td></tr>
<tr><td><code>GET /admin/keys</code></td><td>Lista chaves (sem o valor)</td></tr>
<tr><td><code>DELETE /admin/keys/:id</code></td><td>Revoga chave</td></tr></table>
<h2>Exemplos</h2>
<pre>curl -H "X-API-Key: SUA_CHAVE" "http://localhost:3000/manifests?id=123456"
curl -OJ -H "X-API-Key: SUA_CHAVE" "http://localhost:3000/download?id=123456"

curl -X POST http://localhost:3000/admin/keys \\
  -H "Content-Type: application/json" -H "X-Admin-Token: SEU_TOKEN" \\
  -d '{"name":"cliente-1","maxUses":100}'</pre>
<p>Codigos de erro claros: <code>branch_nao_encontrada</code>,
<code>sem_manifests</code>, <code>github_rate_limit</code>,
<code>github_timeout</code>, <code>zip_grande_demais</code> entre outros.</p>
</body></html>`;

app.get('/docs', (_req, res) => res.type('html').send(DOCS_HTML));

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

async function handleManifests(req, res) {
  const key = requireApiKey(req, res);
  if (!key) return;

  const appid = normalizeAppId(req.query.id);
  if (!appid) return fail(res, 'appid_invalido');

  try {
    const meta = await getManifests(appid, { refresh: req.query.refresh === '1' });
    res.json({
      appid,
      branch: meta.branch,
      commit: meta.commit,
      count: meta.files.length,
      totalBytes: meta.totalBytes,
      cached: meta.cached,
      stale: meta.stale,
      truncated: meta.truncated === true,
      fetchedAt: meta.fetchedAt,
      checkedAt: meta.checkedAt,
      files: meta.files.map((f) => ({
        name: f.name,
        path: f.path,
        size: f.size,
        sha256: f.sha256,
      })),
      download: `/download?id=${appid}`,
    });
  } catch (err) {
    if (err instanceof SourceError) return fail(res, err.code, err.detail);
    console.error('erro inesperado em /manifests:', err?.message || err);
    return fail(res, 'github_erro');
  }
}

async function handleDownload(req, res) {
  const key = requireApiKey(req, res);
  if (!key) return;

  const appid = normalizeAppId(req.query.id);
  if (!appid) return fail(res, 'appid_invalido');

  let meta;
  try {
    meta = await getManifests(appid, { refresh: req.query.refresh === '1' });
  } catch (err) {
    if (err instanceof SourceError) return fail(res, err.code, err.detail);
    console.error('erro inesperado em /download:', err?.message || err);
    return fail(res, 'github_erro');
  }

  if (meta.files.length === 0) return fail(res, 'sem_manifests');
  if (meta.totalBytes > config.limits.maxZipBytes) return fail(res, 'zip_grande_demais');

  // Verifica presenca/integridade basica dos arquivos antes de servir.
  const entries = [];
  for (const file of meta.files) {
    const full = cachedFilePath(appid, file.name);
    const size = fs.existsSync(full) ? fs.statSync(full).size : -1;
    if (size !== file.size) {
      console.error(`cache incompleto para ${appid}/${file.name} (${size} != ${file.size})`);
      return fail(res, 'cache_indisponivel');
    }
    entries.push({ full, name: file.name });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${appid}-manifests-${stamp}.zip"`);
  res.setHeader('X-Cache', meta.stale ? 'stale' : meta.cached ? 'hit' : 'miss');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('warning', (err) => console.warn('aviso do archive:', err?.message || err));
  archive.on('error', (err) => {
    console.error('erro no archive:', err?.message || err);
    res.destroy(err);
  });
  archive.pipe(res);
  const used = new Set();
  for (const entry of entries) {
    // Nomes duplicados ganham sufixo para nao se sobrescreverem no ZIP.
    let name = entry.name;
    let n = 1;
    while (used.has(name)) name = entry.name.replace(/(\.manifest)$/i, `-${n++}$1`);
    used.add(name);
    archive.file(entry.full, { name });
  }
  archive.finalize();

  consumeUse(key.id);
}

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

/* ------------------------------------------------------------------ */

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
      if (!config.github.repository) {
        console.warn('AVISO: GITHUB_REPOSITORY nao definido — /manifests respondera 503.');
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
