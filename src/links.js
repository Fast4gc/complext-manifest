import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Links temporarios de download.
 *
 * Um link e um token HMAC que embute a requisicao inteira — fonte, AppID,
 * inclusao e expiracao. Nao ha estado no servidor: qualquer adulteracao
 * invalida a assinatura, e data vencida nao abre. O token e o proprio
 * controle de acesso: quem tem o link, baixa; quem nao tem, nada.
 *
 * Formato:  v1.<base64url(payload)>.<base64url(hmac)>
 * payload:  { s: source, a: appid, e: expiraEm, c: criadoEm, u: criadoPor }
 *
 * O link so e util com PUBLIC_BASE_URL preenchido — a API escuta em
 * 127.0.0.1, entao sem URL publica ninguem de fora alcanca /links/:token.
 */

const PREFIX = 'v1';

export const LINK_CODES = {
  link_desabilitado: 'Links temporarios desabilitados (PUBLIC_BASE_URL nao definido)',
  link_invalido: 'Link invalido ou adulterado',
  link_expirado: 'Link expirado. Solicite um novo link temporario.',
  link_ttl_invalido: 'Tempo de validade invalido',
  link_sem_segredo: 'LINK_SECRET/ADMIN_TOKEN nao definidos no servidor',
};

function secretKey() {
  const s = config.links.secret;
  if (!s) return null;
  return crypto.createHash('sha256').update(String(s)).digest();
}

function b64(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payloadB64) {
  return b64(crypto.createHmac('sha256', secretKey()).update(payloadB64).digest());
}

/** true quando o servidor consegue emitir e validar links. */
export function linksEnabled() {
  return Boolean(config.links.publicBaseUrl && secretKey());
}

/**
 * Emite um link temporario.
 *
 * @param {{source: string, appid: string, ttlSeconds?: number, createdBy?: string}} req
 * @returns {{token, url, expiresAt, ttlSeconds}}
 * @throws {Error} com `.code` link_*
 */
export function createLink({ source, appid, ttlSeconds, createdBy }) {
  if (!config.links.publicBaseUrl) throw linkError('link_desabilitado');
  const key = secretKey();
  if (!key) throw linkError('link_sem_segredo');

  const max = config.links.ttlMaxSeconds;
  const ttl = ttlSeconds === undefined ? config.links.ttlSeconds : Number(ttlSeconds);
  if (!Number.isFinite(ttl) || ttl < 60 || ttl > max) throw linkError('link_ttl_invalido');

  const now = Date.now();
  const payload = {
    s: String(source),
    a: String(appid),
    e: Math.floor(now / 1000) + Math.floor(ttl),
    c: Math.floor(now / 1000),
    ...(createdBy ? { u: String(createdBy).slice(0, 64) } : {}),
  };
  const payloadB64 = b64(JSON.stringify(payload));
  const token = `${PREFIX}.${payloadB64}.${sign(payloadB64)}`;

  return {
    token,
    url: `${config.links.publicBaseUrl}/links/${token}`,
    expiresAt: new Date(payload.e * 1000).toISOString(),
    ttlSeconds: Math.floor(ttl),
  };
}

/**
 * Valida um token e devolve o que ele autoriza.
 * @param {string} token
 * @returns {{source, appid, expiresAt, createdAt, createdBy?}}
 * @throws {Error} com `.code` link_invalido | link_expirado
 */
export function readLink(token) {
  const key = secretKey();
  if (!key) throw linkError('link_sem_segredo');
  if (typeof token !== 'string' || token.length > 2048) throw linkError('link_invalido');

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) throw linkError('link_invalido');
  const [, payloadB64, macB64] = parts;

  let expected;
  try {
    expected = Buffer.from(sign(payloadB64));
    const got = Buffer.from(macB64);
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
      throw linkError('link_invalido');
    }
  } catch (e) {
    if (e?.code) throw e;
    throw linkError('link_invalido');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw linkError('link_invalido');
  }
  if (!payload || typeof payload.s !== 'string' || !/^\d{1,12}$/.test(String(payload.a))) {
    throw linkError('link_invalido');
  }
  if (!Number.isFinite(payload.e)) throw linkError('link_invalido');

  if (payload.e * 1000 <= Date.now()) throw linkError('link_expirado');

  return {
    source: payload.s,
    appid: String(payload.a),
    expiresAt: new Date(payload.e * 1000).toISOString(),
    createdAt: new Date(payload.c * 1000).toISOString(),
    ...(payload.u ? { createdBy: payload.u } : {}),
  };
}

function linkError(code) {
  const e = new Error(LINK_CODES[code] || code);
  e.code = code;
  return e;
}

/** Estado para /status. */
export function linksStatus() {
  return {
    enabled: linksEnabled(),
    publicBaseUrl: config.links.publicBaseUrl || null,
    defaultTtlSeconds: config.links.ttlSeconds,
    maxTtlSeconds: config.links.ttlMaxSeconds,
    secretConfigured: Boolean(config.links.secret),
  };
}
