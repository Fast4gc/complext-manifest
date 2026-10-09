import { REGISTRY, resolveOrder, withFallback } from './providers/index.js';
import { SourceError, ERROR_MESSAGES } from './githubSource.js';
import { normalizeAppId } from './validate.js';

/** Select an existing Lua file. Never assemble or execute source contents. */
export async function getLua(appid, { source, signal } = {}) {
  appid = normalizeAppId(appid);
  if (!appid) throw new SourceError('appid_invalido', ERROR_MESSAGES.appid_invalido);
  const result = await withFallback(resolveOrder(source), async (id) => {
    const provider = REGISTRY[id];
    const listing = await provider.list(appid, { signal });
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
      filename: `${appid}.lua`, path: file.path, size: file.size, ...contents,
    };
  });
  return { ...result.value, attempts: result.attempts };
}
