/** Validacoes compartilhadas por API e bot. */

/** AppID da Steam: 1 a 12 digitos. */
export function isValidAppId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const s = String(value).trim();
  return /^\d{1,12}$/.test(s);
}

/** Normaliza e valida um AppID vindo de query string. */
export function normalizeAppId(value) {
  const s = String(value ?? '').trim();
  return isValidAppId(s) ? s : null;
}

const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]');

/**
 * Caminho de arquivo dentro do repositorio.
 * Rejeita traversal, caminho absoluto, caracteres de controle e tamanhos excesivos.
 */
export function isSafeRepoPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 512) return false;
  if (p.startsWith('/') || p.includes('\\')) return false;
  if (CONTROL_CHARS.test(p)) return false;
  const parts = p.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false;
  if (parts.some((part) => part.length > 255)) return false;
  return true;
}

/** Nome de branch resultante do template, com charset restrito. */
export function branchNameFor(appid, template = '{appid}') {
  const branch = template.replaceAll('{appid}', appid);
  if (!/^[\w./-]{1,240}$/.test(branch) || branch.includes('..')) return null;
  return branch;
}

/** Formato da chave de API: mk_ + 32 caracteres alfanumericos. */
export const KEY_FORMAT = /^mk_[A-Za-z0-9]{32}$/;

/** Nome de arquivo seguro para o ZIP (sem diretorios). */
export function safeBaseName(p) {
  const base = p.split('/').pop() || '';
  return base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'arquivo';
}
