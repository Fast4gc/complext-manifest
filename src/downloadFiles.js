import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/** Downloads belong in persistent writable data, not the application directory. */
export function luaDownloadPath(filename, directory = path.join(config.dataDir, 'downloads')) {
  if (!/^[0-9]{1,12}\.lua$/.test(filename)) throw new Error('Nome de arquivo Lua invalido');
  fs.mkdirSync(directory, { recursive: true });
  return path.resolve(directory, filename);
}
