import fs from 'node:fs';
import path from 'node:path';

const FILES_DIR = path.resolve(process.env.FILES_DIR || 'files');
const ALLOWED_EXT = (process.env.ALLOWED_EXTENSIONS || '.lua,.manifest')
  .split(',')
  .map((e) => (e.startsWith('.') ? e : '.' + e))
  .filter(Boolean);

/** id deve ser numérico (ex.: appid da Steam). */
export function isValidId(id) {
  return typeof id === 'string' && /^\d{1,12}$/.test(id);
}

/**
 * Lista os arquivos entregáveis de um id, dentro de FILES_DIR/<id>.
 * Só retorna arquivos com extensão permitida e nenhum caminho fora da raiz.
 */
export function listFilesFor(id) {
  const root = path.resolve(FILES_DIR, id);
  if (root !== path.join(FILES_DIR, id)) return null; // tentativa de traversal
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return null;

  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (ALLOWED_EXT.includes(path.extname(entry.name).toLowerCase())) {
        out.push({
          relPath: path.relative(root, full),
          absolutePath: full,
          size: fs.statSync(full).size,
        });
      }
    }
  };
  walk(root);
  return out;
}
