import express from 'express';
import archiver from 'archiver';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createKey, listKeys, revokeKey, validateKey, consumeUse, KEY_FORMAT } from './store.js';
import { allow } from './rateLimit.js';
import { isValidId, listFilesFor } from './files.js';

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const app = express();
app.use(express.json());

/** Log simples de requisições. */
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
});

/** Middleware de admin: exige header X-Admin-Token igual ao ADMIN_TOKEN. */
function adminOnly(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: 'ADMIN_TOKEN não configurado no servidor' });
  }
  const sent = req.get('X-Admin-Token') || '';
  const a = Buffer.from(sent);
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'token de admin inválido' });
  }
  next();
}

app.get('/health', (_req, res) => res.json({ ok: true }));

/* ------------------------------------------------------------------ */
/* Admin: gestão de chaves (usado pelo frontend)                       */
/* ------------------------------------------------------------------ */

app.post('/admin/keys', adminOnly, (req, res) => {
  const { name, expiresAt, maxUses, rateLimitPerMinute } = req.body || {};
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
    return res.status(400).json({ error: 'expiresAt inválido' });
  }
  if (maxUses !== undefined && maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) {
    return res.status(400).json({ error: 'maxUses deve ser inteiro >= 1' });
  }
  const created = createKey({ name, expiresAt, maxUses, rateLimitPerMinute });
  res.status(201).json({
    ...created,
    note: 'Guarde a chave: ela não será exibida novamente.',
  });
});

app.get('/admin/keys', adminOnly, (_req, res) => {
  res.json({ keys: listKeys() });
});

app.delete('/admin/keys/:id', adminOnly, (req, res) => {
  const ok = revokeKey(req.params.id);
  if (!ok) return res.status(404).json({ error: 'chave não encontrada' });
  res.json({ ok: true, revoked: true });
});

/* ------------------------------------------------------------------ */
/* Download público: GET /download?id=<appid>&key=<apikey>             */
/* ------------------------------------------------------------------ */

app.get('/download', (req, res) => {
  const { id, key } = req.query;

  // 1. Formato do id
  if (!isValidId(id)) {
    return res.status(400).json({ error: 'id_inválido', detail: 'id deve ser numérico' });
  }

  // 2. Formato da chave (validação barata antes de consultar o banco)
  if (typeof key !== 'string' || !KEY_FORMAT.test(key)) {
    return res.status(400).json({ error: 'chave_inválida', detail: 'formato não reconhecido' });
  }

  // 3. Chave existente, ativa, não expirada e com uso disponível
  const check = validateKey(key);
  if (!check.ok) {
    return res.status(check.status).json({ error: check.reason });
  }

  // 4. Rate limit por chave
  if (!allow(check.key.id, check.key.rateLimitPerMinute)) {
    return res.status(429).json({ error: 'limite_de_requisições' });
  }

  // 5. Arquivos: só extensões permitidas, só dentro de FILES_DIR/<id>
  const files = listFilesFor(id);
  if (!files || files.length === 0) {
    return res.status(404).json({ error: 'nenhum_arquivo_encontrado' });
  }

  // Entrega
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${id}-${stamp}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('warning', (err) => console.warn('archive warning:', err));
  archive.on('error', (err) => {
    console.error('archive error:', err);
    res.destroy(err);
  });
  archive.pipe(res);
  for (const file of files) {
    archive.file(file.absolutePath, { name: file.relPath });
  }
  archive.finalize();

  // 6. Consumo do uso só após iniciar a entrega
  consumeUse(check.key.id);
});

/* ------------------------------------------------------------------ */

app.use((req, res) => res.status(404).json({ error: 'rota_não_encontrada' }));

app.listen(PORT, () => {
  if (!ADMIN_TOKEN) {
    console.warn('AVISO: ADMIN_TOKEN não definido — rotas admin ficam indisponíveis.');
  }
  console.log(`API rodando em http://localhost:${PORT}`);
  console.log(`FILES_DIR=${path.resolve(process.env.FILES_DIR || 'files')}`);
  console.log(`ALLOWED_EXTENSIONS=${process.env.ALLOWED_EXTENSIONS || '.lua,.manifest'}`);
});
