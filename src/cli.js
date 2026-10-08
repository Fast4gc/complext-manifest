#!/usr/bin/env node
/**
 * CLI administrativo: criacao/revogacao de chaves sem subir a API.
 * Usado pelo instalador (dentro do container Docker) para gerar a chave do bot.
 *
 * Modo comando (uma linha por chave — o instalador consome assim):
 *   node src/cli.js key:create [--name nome] [--uses N] [--expires ISO] [--rate N]
 *   node src/cli.js key:list
 *   node src/cli.js key:revoke <id>
 *   node src/cli.js cache:stats
 *   node src/cli.js cache:invalidate <appid>
 *
 * Sem argumentos abre o painel interativo (menu bonito com todas
 * as acoes do backend):  node src/cli.js   ·   npm run key
 */
import { createKey, listKeys, revokeKey } from './store.js';
import { cacheStats, invalidate } from './cache.js';
import { runMenu } from './menu.js';

const [command, ...args] = process.argv.slice(2);

function flag(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`flag --${name} exige um valor`);
    process.exit(2);
  }
  return value;
}

function runCommand(command, args) {
  switch (command) {
  case 'key:create': {
    const name = flag('name', 'sem-nome');
    const uses = flag('uses');
    const expires = flag('expires');
    const rate = flag('rate');
    const created = createKey({
      name,
      maxUses: uses ? Number(uses) : null,
      expiresAt: expires,
      rateLimitPerMinute: rate ? Number(rate) : undefined,
    });
    // Unico formato consumido pelo instalador (uma linha por chave).
    console.log(`KEY_ID=${created.id}`);
    console.log(`KEY_VALUE=${created.key}`);
    break;
  }
  case 'key:list': {
    const keys = listKeys();
    if (keys.length === 0) console.log('(nenhuma chave)');
    for (const k of keys) {
      console.log(
        `${k.id}  nome=${k.name}  usos=${k.uses}/${k.maxUses ?? 'inf'}  ` +
          `revogada=${k.revoked}  expira=${k.expiresAt ?? 'nunca'}`,
      );
    }
    break;
  }
  case 'key:revoke': {
    const id = args[0];
    if (!id) {
      console.error('uso: key:revoke <id>');
      process.exit(2);
    }
    if (!revokeKey(id)) {
      console.error('chave nao encontrada');
      process.exit(1);
    }
    console.log('chave revogada');
    break;
  }
  case 'cache:stats': {
    const stats = cacheStats();
    console.log(`entradas=${stats.entries} bytes=${stats.bytes} stale=${stats.stale}`);
    console.log(`dir=${stats.dir}`);
    break;
  }
  case 'cache:invalidate': {
    const appid = args[0];
    if (!appid || !/^\d{1,12}$/.test(appid)) {
      console.error('uso: cache:invalidate <appid>');
      process.exit(2);
    }
    invalidate(appid);
    console.log(`cache de ${appid} removido`);
    break;
  }
  default:
    console.error('comando desconhecido. uso: key:create|key:list|key:revoke|cache:stats|cache:invalidate');
    process.exit(2);
  }
}

/** Sem argumento: painel interativo. Com argumento: modo de máquina. */
if (!command) {
  runMenu();
} else {
  runCommand(command, args);
}
