import { REGISTRY, resolveOrder, withFallback } from './providers/index.js';
import { SourceError, ERROR_MESSAGES } from './githubSource.js';
import { normalizeAppId } from './validate.js';
import { generateLua } from './luaGenerator.js';
import { config } from './config.js';

/** Generate from AppID JSON when available; otherwise deliver an existing Lua. */
export async function getLua(appid, { source, signal } = {}) {
  appid = normalizeAppId(appid);
  if (!appid) throw new SourceError('appid_invalido', ERROR_MESSAGES.appid_invalido);
  const result = await withFallback(resolveOrder(source), async (id) => {
    const provider = REGISTRY[id];
    const listing = await provider.list(appid, { signal });
    const jsonFiles = listing.configFiles.filter((f) => f.name.toLowerCase() === `${appid}.json`);
    const jsonRoot = jsonFiles.find((f) => f.path.toLowerCase() === `${appid}.json`);
    if (jsonFiles.length > 1 && !jsonRoot) {
      throw new SourceError('lua_ambiguo', ERROR_MESSAGES.lua_ambiguo);
    }
    if (jsonFiles.length) {
      const file = jsonRoot || jsonFiles[0];
      const input = await provider.download(appid, file, { signal, ref: listing.version, format: 'lua-json' });
      const generated = generateLua(appid, input.buffer);
      if (generated.buffer.length > config.limits.maxFileBytes) {
        throw new SourceError('arquivo_grande_demais', ERROR_MESSAGES.arquivo_grande_demais);
      }
      return {
        appid, source: id, origin: provider.describe().repository,
        version: listing.version, commit: listing.version, fetchedAt: listing.fetchedAt,
        filename: `${appid}.lua`, path: file.path, size: generated.buffer.length,
        mode: 'generated', ...generated,
      };
    }
    const candidates = listing.configFiles.filter((f) => /\.lua$/i.test(f.name));
    const exact = candidates.filter((f) => f.name.toLowerCase() === `${appid}.lua`);
    const root = exact.find((f) => f.path.toLowerCase() === `${appid}.lua`);
    const matches = exact.length ? exact : candidates;
    if (!matches.length) throw new SourceError('sem_lua', ERROR_MESSAGES.sem_lua);
    if (!root && matches.length !== 1) {
      throw new SourceError('lua_ambiguo', ERROR_MESSAGES.lua_ambiguo);
    }
    const file = root || matches[0];
    const contents = await provider.download(appid, file, { signal, ref: listing.version, format: 'lua' });
    return {
      appid, source: id, origin: provider.describe().repository,
      version: listing.version, commit: listing.version, fetchedAt: listing.fetchedAt,
      filename: `${appid}.lua`, path: file.path, size: file.size, mode: 'existing', ...contents,
    };
  });
  return { ...result.value, attempts: result.attempts };
}
