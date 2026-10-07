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
  if (!isValidAppId(appid)) return null;
  const branch = template.replaceAll('{appid}', String(appid).trim());
  if (!/^[\w./-]{1,240}$/.test(branch) || branch.includes('..')) return null;
  return branch;
}

/** Formato da chave de API: mk_ + 32 caracteres alfanumericos. */
export const KEY_FORMAT = /^mk_[A-Za-z0-9]{32}$/;

/** Nome de arquivo seguro para o ZIP (sem diretorios). */
export function safeBaseName(p) {
  const base = p.split('/').pop() || '';
  const clean = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
  if (!clean || clean === '.' || clean === '..') return 'arquivo';
  return clean;
}

/* ------------------------------------------------------------------ */
/* AppID x DepotID x ManifestID                                        */
/* ------------------------------------------------------------------ */

/**
 * Os tres identificadores da Steam sao coisas diferentes e nunca sao
 * intercambiaveis:
 *
 *   AppID     jogo/application          (ex.: 730)          ate 12 digitos
 *   DepotID   sub-unidade de um jogo    (ex.: 2347770)      ate 12 digitos
 *   ManifestID versao concreta de um depot, muito grande para Number
 *              (ex.: 5023020258185551340) -> SEMPRE string
 *
 * ManifestID ultrapassa 2^53 (Number.MAX_SAFE_INTEGER): se passar por
 * Number/JSON como numero, perde precisao (vira 5023020258185551000).
 * Por isso todo ManifestID entra e sai como string de digitos.
 */

/** AppID: 1 a 12 digitos. Aceita number ou string. */
export function isValidDepotId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  return /^\d{1,12}$/.test(String(value).trim());
}

/** ManifestID: 1 a 20 digitos, SEMPRE tratado como string. */
export function isValidManifestId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const s = String(value).trim();
  if (!/^\d{1,20}$/.test(s)) return false;
  return true;
}

/**
 * Normaliza um ManifestID para string, ou null se invalido.
 * Nunca converte para Number.
 */
export function normalizeManifestId(value) {
  if (!isValidManifestId(value)) return null;
  return String(value).trim();
}

/**
 * Interpreta o nome de um arquivo .manifest do repositorio.
 *
 * Padroes observados (ver `tests/fixtures` e o repositorio real):
 *   <depotId>_<manifestId>.manifest   -> depot + manifest
 *   <manifestId>.manifest             -> so manifest
 *
 * `depotId` aqui e uma INFERENCIA a partir do nome: o repositorio nao
 * declara formalmente o que o primeiro numero e. O nome original SEMPRE
 * acompanha a resposta, para o cliente conferir.
 *
 * @param {string} name
 * @returns {{depotId: string|null, manifestId: string|null}}
 */
export function parseManifestName(name) {
  const empty = { depotId: null, manifestId: null };
  if (typeof name !== 'string') return empty;
  const base = name.split('/').pop();
  let m = base.match(/^(\d{1,12})_(\d{1,20})\.manifest$/i);
  if (m) return { depotId: m[1], manifestId: m[2] }; // string, nunca Number
  m = base.match(/^(\d{1,20})\.manifest$/i);
  if (m) return { depotId: null, manifestId: m[1] };
  return empty;
}

/* ------------------------------------------------------------------ */
/* Classificacao de arquivos da fonte                                  */
/* ------------------------------------------------------------------ */

/**
 * Classifica um arquivo encontrado na fonte.
 *
 *  manifest  .manifest                    -> conteudo principal do ZIP
 *  config    .lua / .json                 -> configuracao (DADOS, nao codigo)
 *  forbidden chaves (key.vdf, depotkeys)   -> NUNCA listado nem entregue
 *  ignored   qualquer outro                -> fora do escopo
 *
 * Trata todo arquivo como DADO: nada aqui executa, interpreta ou avalia
 * scripts Lua (ou qualquer outro conteudo recebido).
 */
const FORBIDDEN_PATTERNS = [
  /(^|\/)key\.vdf$/i,
  /(^|\/)depotkeys?\.json$/i,
  /(^|\/)[^/]*depotkey[^/]*$/i,
  /\.vdf$/i,
  /\.key$/i,
  /\.acf$/i,
];

export function fileKind(p) {
  if (typeof p !== 'string' || p === '') return 'ignored';
  if (FORBIDDEN_PATTERNS.some((re) => re.test(p))) return 'forbidden';
  if (p.toLowerCase().endsWith('.manifest')) return 'manifest';
  if (p.toLowerCase().endsWith('.lua') || p.toLowerCase().endsWith('.json')) return 'config';
  return 'ignored';
}

/** true se o arquivo pode entrar num ZIP (manifest sempre; config so se pedido). */
export function isDeliverable(p, { includeConfig = false } = {}) {
  const kind = fileKind(p);
  if (kind === 'manifest') return true;
  if (kind === 'config') return includeConfig;
  return false;
}
