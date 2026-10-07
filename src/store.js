import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');

/** Formato aceito para a chave entregue ao cliente: mk_ + 32 chars alfanuméricos. */
export const KEY_FORMAT = /^mk_[A-Za-z0-9]{32}$/;

function load() {
  if (!fs.existsSync(KEYS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function save(keys) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = KEYS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(keys, null, 2));
  fs.renameSync(tmp, KEYS_FILE);
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Cria uma chave. A chave em texto só é retornada uma vez;
 * em seguida apenas o hash fica armazenado.
 */
export function createKey({ name = '', expiresAt = null, maxUses = null, rateLimitPerMinute = 60 } = {}) {
  const raw = 'mk_' + crypto.randomBytes(16).toString('hex').slice(0, 32);
  const keys = load();
  const record = {
    id: crypto.randomUUID(),
    hash: hash(raw),
    name,
    createdAt: new Date().toISOString(),
    expiresAt,
    maxUses,
    uses: 0,
    rateLimitPerMinute: Math.max(1, Number(rateLimitPerMinute) || 60),
    revoked: false,
  };
  keys.push(record);
  save(keys);
  return { key: raw, ...record, hash: undefined };
}

export function listKeys() {
  return load().map(({ hash: _hash, ...rest }) => rest);
}

export function revokeKey(id) {
  const keys = load();
  const found = keys.find((k) => k.id === id);
  if (!found) return false;
  found.revoked = true;
  save(keys);
  return true;
}

function constantTimeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Valida a chave enviada pelo cliente.
 * Retorna { ok: true, key } ou { ok: false, status, reason }.
 */
export function validateKey(rawKey) {
  if (typeof rawKey !== 'string' || !KEY_FORMAT.test(rawKey)) {
    return { ok: false, status: 400, reason: 'formato_de_chave_invalido' };
  }

  const target = hash(rawKey);
  const record = load().find((k) => constantTimeEqual(k.hash, target));

  if (!record) return { ok: false, status: 401, reason: 'chave_nao_encontrada' };
  if (record.revoked) return { ok: false, status: 401, reason: 'chave_revogada' };
  if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) {
    return { ok: false, status: 401, reason: 'chave_expirada' };
  }
  if (record.maxUses !== null && record.uses >= record.maxUses) {
    return { ok: false, status: 403, reason: 'limite_de_usos_atingido' };
  }

  return { ok: true, key: record };
}

/** Registra o uso da chave (após uma entrega bem-sucedida). */
export function consumeUse(id) {
  const keys = load();
  const record = keys.find((k) => k.id === id);
  if (!record) return;
  record.uses += 1;
  save(keys);
}
