import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from './config.js';
import { SourceError, ERROR_MESSAGES } from './githubSource.js';
import { isSafeRepoPath, fileKind, safeBaseName } from './validate.js';

/**
 * Montagem e validacao do ZIP entregue ao cliente.
 *
 * Politica do pacote: o ZIP contem EXCLUSIVAMENTE `.manifest`. `.lua` e
 * `.json` sao listados pela API com aviso e link direto, mas nao entram
 * aqui (contem chaves de depot). `*.vdf` nem aparece na listagem.
 *
 * Tudo que entra no ZIP e verificado antes de ser servido:
 *
 *   caminho    nome sem separador de diretorio, sem `..`, sem controle
 *   tipo       apenas `fileKind === 'manifest'`
 *   tamanho    confere com o disco e com a meta, e cabe no limite do ZIP
 *   integridade sha256 registrado na meta bate com o conteudo do disco
 *   duplicidade dois arquivos nunca disputam o mesmo nome no ZIP
 *
 * Se qualquer uma dessas checagens falhar, o ZIP nao e servido: a resposta
 * e um codigo de erro claro, nunca um arquivo pela metade.
 */

const SAFE_NAME = /^[A-Za-z0-9._-]{1,200}$/;

/**
 * Verifica os arquivos de uma entrada de cache para ir ao ZIP.
 *
 * @param {object} meta entrada de cache (ja com `source`)
 * @returns {Array<{full: string, name: string, size: number}>}
 * @throws {SourceError}
 */
export function validateZipEntries(meta) {
  const source = meta?.source;
  const appid = meta?.appid;
  if (!source || !appid) {
    throw new SourceError('cache_indisponivel', ERROR_MESSAGES.cache_indisponivel);
  }
  if (!Array.isArray(meta.files) || meta.files.length === 0) {
    throw new SourceError('sem_manifests', ERROR_MESSAGES.sem_manifests);
  }

  const filesDir = `${config.cacheDir}/${source}/${appid}/files`;
  const entries = [];
  const seen = new Set();

  for (const file of meta.files) {
    // 1. tipo: so .manifest sai por aqui
    const rel = file.path || file.name;
    if (fileKind(rel) !== 'manifest') {
      throw new SourceError('arquivo_invalido', ERROR_MESSAGES.arquivo_invalido, file.name);
    }

    // 2. caminho: sem diretorio, sem traversal, sem caractere estranho
    if (!isSafeRepoPath(rel)) {
      throw new SourceError('caminho_invalido', ERROR_MESSAGES.caminho_invalido, file.name);
    }
    const name = safeBaseName(rel);
    if (!SAFE_NAME.test(name) || name.includes('..')) {
      throw new SourceError('arquivo_invalido', ERROR_MESSAGES.arquivo_invalido, file.name);
    }

    // 3. tamanho declarado
    const declared = Number(file.size);
    if (!Number.isFinite(declared) || declared < 0 || declared > config.limits.maxFileBytes) {
      throw new SourceError('arquivo_grande_demais', ERROR_MESSAGES.arquivo_grande_demais, file.name);
    }

    // 4. no disco, com integridade
    const full = `${filesDir}/${name}`;
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      throw new SourceError('cache_indisponivel', ERROR_MESSAGES.cache_indisponivel, file.name);
    }
    if (!stat.isFile() || stat.size !== declared) {
      throw new SourceError('cache_indisponivel', ERROR_MESSAGES.cache_indisponivel, file.name);
    }
    if (file.sha256) {
      const actual = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      if (actual !== file.sha256) {
        throw new SourceError('falha_integridade', ERROR_MESSAGES.falha_integridade, file.name);
      }
    }

    // 5. duplicidade de nome
    let finalName = name;
    let n = 1;
    while (seen.has(finalName)) {
      finalName = name.replace(/(\.manifest)$/i, `-${n}$1`);
      n += 1;
      if (n > 999) {
        throw new SourceError('arquivo_invalido', ERROR_MESSAGES.arquivo_invalido, file.name);
      }
    }
    seen.add(finalName);

    entries.push({ full, name: finalName, size: stat.size });
  }

  // 6. tamanho total do ZIP
  let total = 0;
  for (const e of entries) total += e.size;
  if (total > config.limits.maxZipBytes) {
    throw new SourceError('zip_grande_demais', ERROR_MESSAGES.zip_grande_demais, {
      bytes: total,
      limite: config.limits.maxZipBytes,
    });
  }

  return entries;
}

/**
 * Garantia de conteudo: nada alem de `.manifest` pode estar no ZIP.
 * Chamada antes de emitir e nos testes.
 *
 * @param {Array<{name: string}>} entries
 */
export function assertZipPolicy(entries) {
  for (const e of entries) {
    const n = String(e.name || '');
    if (!n.toLowerCase().endsWith('.manifest')) {
      throw new SourceError('arquivo_invalido', ERROR_MESSAGES.arquivo_invalido, n);
    }
    if (n.includes('/') || n.includes('\\') || n.includes('..')) {
      throw new SourceError('caminho_invalido', ERROR_MESSAGES.caminho_invalido, n);
    }
  }
}

/** Nome de arquivo sugerido para o download. */
export function zipFilename(appid, { source } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = source ? `-${String(source).replace(/[^\w-]/g, '')}` : '';
  return `${appid}-manifests${suffix}-${stamp}.zip`;
}
