/**
 * Painel interativo (TUI) do Manifest Gate.
 *
 * Abre quando se roda `node src/cli.js` (ou `npm run key`) SEM
 * argumentos. Com argumentos, o cli.js continua no modo de
 * máquina que o instalador consome (KEY_ID=/KEY_VALUE=).
 *
 * Zero dependências: apenas readline + ANSI + child_process.
 * Navegação por setas, atalhos numéricos, Esc volta e
 * Ctrl+C encerra.
 */
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import { fileURLToPath } from 'node:url';
import { createKey, listKeys, revokeKey } from './store.js';
import { cacheStats, getManifests, invalidate } from './cache.js';
import { searchGames } from './search.js';
import { assertZipPolicy, validateZipEntries, zipFilename } from './zip.js';
import { SourceError } from './providers/index.js';
import { describeSources } from './providers/index.js';
import { config, PROJECT_NAME } from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '1.0.0';
  }
})();

/* ------------------------------------------------------------------ */
/* Estilo                                                              */
/* ------------------------------------------------------------------ */

const TTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);
const COLOR = TTY && !process.env.NO_COLOR;
const A = {
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  reset: '\x1b[0m',
};
const s = (code, text) => (COLOR ? `${code}${text}${A.reset}` : String(text));
const bold = (t) => s(A.bold, t);
const dim = (t) => s(A.dim, t);
const red = (t) => s(A.red, t);
const green = (t) => s(A.green, t);
const yellow = (t) => s(A.yellow, t);
const cyan = (t) => s(A.cyan, t);
const magenta = (t) => s(A.magenta, t);

/** Largura do quadro, sempre dentro do terminal. */
const WIDTH = () => Math.min(76, Math.max(48, process.stdout.columns || 64));

const visible = (str) => String(str).replace(/\x1b\[[0-9;]*m/g, '');
const padRow = (text, width) =>
  `${text}${' '.repeat(Math.max(1, width - 2 - visible(text).length))}`;

function clear() {
  if (TTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

/* ------------------------------------------------------------------ */
/* Molduras                                                            */
/* ------------------------------------------------------------------ */

function banner() {
  const inner = WIDTH() - 4;
  const line = '═'.repeat(inner);
  const title = ` ⚡ ${PROJECT_NAME.toUpperCase()} — PAINEL DE CONTROLE`;
  const sub = ` API de download de manifests · v${VERSION}`;
  return [
    `╔${line}╗`,
    `║${padRow(cyan(title), inner)}║`,
    `║${padRow(dim(sub), inner)}║`,
    `╚${line}╝`,
  ].join('\n');
}

/** Faixa de status sob o banner: o que o operador precisa ver de relance. */
function dashboard() {
  const keys = listKeys();
  const active = keys.filter((k) => !k.revoked).length;
  const cache = cacheStats();
  const parts = [
    `porta ${config.port}`,
    `fontes ${describeSources().order.join(' → ') || 'nenhuma'}`,
    `chaves ${green(String(active))}/${keys.length} ativas`,
    `cache ${cache.entries} entr. · ${fmtBytes(cache.bytes)}`,
  ];
  return `  ${dim('●')} ${dim(parts.join('   ·   '))}`;
}

function frame(title) {
  clear();
  console.log(banner());
  console.log(dashboard());
  console.log();
  console.log(`  ${cyan('◆')} ${bold(title)}`);
  console.log();
}

/** Bloco "cartão" de label → valor. */
function cards(rows) {
  const labelW = Math.max(...rows.map(([l]) => visible(l).length)) + 2;
  for (const [label, value] of rows) {
    console.log(`  ${cyan(bold(String(label).padEnd(labelW)))} ${value}`);
  }
}

/** Bloco emoldurado (título + pares label/valor). */
function box(title, rows = []) {
  const inner = WIDTH() - 4;
  const line = '─'.repeat(inner);
  const row = (content) => `  ${cyan('│')} ${padRow(content, inner)}${cyan('│')}`;
  console.log(`  ${cyan('┌')}${cyan(line)}${cyan('┐')}`);
  if (title) {
    console.log(row(bold(title)));
    console.log(`  ${cyan('├')}${cyan(line)}${cyan('┤')}`);
  }
  for (const [label, value] of rows) {
    console.log(row(`${bold(String(label).padEnd(12))} ${value}`));
  }
  console.log(`  ${cyan('└')}${cyan(line)}${cyan('┘')}`);
}

/* ------------------------------------------------------------------ */
/* Entrada                                                             */
/* ------------------------------------------------------------------ */

let inSpawn = false;

/**
 * Pergunta com fallback e validação em loop.
 * Tudo em raw mode + keypress: eco próprio, backspace,
 * Enter envia, Esc aceita o padrao, Ctrl+C encerra.
 */
function ask(question, { fallback = '', validate } = {}) {
  return new Promise((resolve) => {
    if (!process.stdin.isRaw) process.stdin.setRawMode(true);
    const hint = fallback !== '' ? dim(` [${fallback}]`) : '';
    const prompt = `  ${question}${hint}: `;
    let buf = '';
    const redraw = () => {
      process.stdout.write(`\r\x1b[K${prompt}${buf}`);
    };
    const cleanup = () => {
      process.stdin.removeListener('keypress', onKey);
    };
    const submit = () => {
      cleanup();
      const value = buf.trim();
      const final = value === '' ? fallback : value;
      process.stdout.write('\r\n');
      if (validate) {
        const err = validate(final);
        if (err) {
          console.log(`    ${red('✗')} ${red(err)}`);
          resolve(ask(question, { fallback, validate }));
          return;
        }
      }
      resolve(final);
    };
    const onKey = (ch, key) => {
      const name = key?.name;
      if (key?.ctrl && name === 'c') {
        cleanup();
        shutdown();
      } else if (name === 'return' || name === 'enter') {
        submit();
      } else if (name === 'backspace' || name === 'delete') {
        buf = buf.slice(0, -1);
        redraw();
      } else if (name === 'escape') {
        // Esc: aceita o valor padrao e segue.
        cleanup();
        process.stdout.write('\r\n');
        resolve(fallback);
      } else if (ch && ch.length === 1 && !key.ctrl && !key.meta) {
        buf += ch;
        redraw();
      }
    };
    process.stdin.on('keypress', onKey);
    process.stdout.write(prompt);
  });
}

async function confirm(question, { def = false } = {}) {
  const ans = await ask(`${question} ${dim(`(${def ? 'S/n' : 's/N'})`)}`);
  const v = (ans === '' ? (def ? 's' : 'n') : ans).toLowerCase();
  return ['s', 'sim', 'y', 'yes'].includes(v);
}

async function pause() {
  await ask(dim('Enter para continuar...'));
}

/**
 * Seletor com setas. Resolve o item escolhido, null (Esc = voltar)
 * ou encerra o painel (Ctrl+C). Atalhos 1-9.
 */
function select(title, items) {
  return new Promise((resolve) => {
    let cursor = 0;
    const draw = () => {
      frame(title);
      items.forEach((it, i) => {
        const icon = it.icon ?? '•';
        const hint = it.hint ? dim(`   ${it.hint}`) : '';
        if (i === cursor) {
          console.log(`  ${green('❯')} ${bold(icon)}  ${bold(it.label)}${hint}`);
        } else {
          console.log(`    ${dim(icon)}  ${it.label}${hint}`);
        }
      });
      console.log();
      const nums = items.length <= 9 ? ` · 1-${items.length} atalho` : '';
      console.log(`  ${dim('↑ ↓ navegar · Enter escolher · Esc voltar' + nums + ' · Ctrl+C sair')}`);
    };
    const finish = (i) => {
      process.stdin.removeListener('keypress', onKey);
      if (process.stdin.isRaw) process.stdin.setRawMode(false);
      if (i === -2) shutdown();
      else resolve(i === -1 ? null : items[i]);
    };
    const onKey = (ch, key) => {
      const name = key?.name;
      if (name === 'up') {
        cursor = (cursor - 1 + items.length) % items.length;
        draw();
      } else if (name === 'down') {
        cursor = (cursor + 1) % items.length;
        draw();
      } else if (name === 'return' || name === 'enter') {
        finish(cursor);
      } else if (name === 'escape') {
        finish(-1);
      } else if (key?.ctrl && name === 'c') {
        finish(-2);
      } else if (/^[1-9]$/.test(ch ?? '')) {
        const i = Number(ch) - 1;
        if (i < items.length) finish(i);
      }
    };
    process.stdin.on('keypress', onKey);
    if (!process.stdin.isRaw) process.stdin.setRawMode(true);
    draw();
  });
}

function shutdown() {
  clear();
  console.log(banner());
  console.log(`\n  ${green('✓')} Painel encerrado. Até logo!\n`);
  process.exit(0);
}

/**
 * Ctrl+C limpo em QUALQUER ponto do painel. No seletor (raw
 * mode) ele chega como keypress e nao como sinal; nos campos
 * de texto chega como SIGHINT/SIGINT — aqui tratamos os dois.
 * Durante um script filho (API/bot) quem manda e o runScript.
 */
process.on('SIGINT', () => {
  if (inSpawn) return;
  shutdown();
});

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const shortId = (id) => String(id).slice(0, 8);

const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleString('pt-BR') : 'nunca';

/** Mostra um erro de fonte (SourceError) com as tentativas. */
function showError(err) {
  console.log(`  ${red('✗')} ${red(err?.code || 'erro_desconhecido')}: ${err?.message || err}`);
  if (Array.isArray(err?.attempts) && err.attempts.length > 0) {
    console.log(dim('  tentativas:'));
    for (const a of err.attempts) {
      console.log(dim(`    · ${a.source}: ${a.code}${a.detail ? ` (${a.detail})` : ''}`));
    }
  }
}

/** Roda um script do projeto (API/bot) com saída no terminal. */
function runScript(rel, label) {
  return new Promise((resolve) => {
    if (process.stdin.isRaw) process.stdin.setRawMode(false);
    inSpawn = true;
    clear();
    console.log(banner());
    console.log();
    console.log(`  ${bold('▶')} Iniciando ${label}...`);
    console.log(`  ${dim('Ctrl+C no terminal encerra e volta ao painel')}`);
    console.log();
    const child = spawn(process.execPath, [path.join(ROOT, rel)], {
      stdio: 'inherit',
      cwd: ROOT,
    });
    const forward = () => {
      try {
        child.kill('SIGINT');
      } catch {
        /* já saiu */
      }
    };
    process.on('SIGINT', forward);
    child.on('exit', (code) => {
      process.removeListener('SIGINT', forward);
      inSpawn = false;
      console.log();
      console.log(`  ${dim(`${label} encerrado${code ? ` (código ${code})` : ''}`)}`);
      console.log();
      resolve();
    });
  });
}

/* ------------------------------------------------------------------ */
/* Fluxos: chaves                                                      */
/* ------------------------------------------------------------------ */

async function createKeyFlow() {
  frame('CRIAR CHAVE DE API');
  console.log('  Preencha os campos (Enter aceita o valor entre colchetes).\n');
  const name = await ask('Nome da chave', { fallback: 'sem-nome' });
  const usesRaw = await ask('Máximo de usos (vazio = ilimitado)', {
    validate: (v) =>
      v === '' || (/^\d+$/.test(v) && Number(v) >= 1)
        ? null
        : 'número inteiro ≥ 1, ou deixe vazio',
  });
  const daysRaw = await ask('Validade em dias (vazio = nunca)', {
    validate: (v) =>
      v === '' || (/^\d+$/.test(v) && Number(v) >= 1)
        ? null
        : 'número inteiro ≥ 1, ou deixe vazio',
  });
  const rateRaw = await ask('Requisições por minuto', {
    fallback: String(config.limits.defaultRatePerMinute),
    validate: (v) =>
      /^\d+$/.test(v) && Number(v) >= 1 ? null : 'número inteiro ≥ 1',
  });

  const created = createKey({
    name,
    maxUses: usesRaw === '' ? null : Number(usesRaw),
    expiresAt:
      daysRaw === ''
        ? null
        : new Date(Date.now() + Number(daysRaw) * 86_400_000).toISOString(),
    rateLimitPerMinute: Number(rateRaw),
  });

  frame('CHAVE CRIADA');
  box('RESUMO', [
    ['ID', created.id],
    ['NOME', created.name],
    ['USOS', created.maxUses ? `${created.uses}/${created.maxUses}` : 'ilimitado'],
    ['TAXA', `${created.rateLimitPerMinute} req/min`],
    ['EXPIRA', created.expiresAt ? fmtDate(created.expiresAt) : 'nunca'],
  ]);
  console.log();
  const inner = WIDTH() - 4;
  const line = '━'.repeat(inner);
  console.log(`  ${cyan('┌')}${cyan(line)}${cyan('┐')}`);
  console.log(`  ${cyan('│')} ${bold('CHAVE:')} ${green(bold(created.key))}`);
  console.log(`  ${cyan('└')}${cyan(line)}${cyan('┘')}`);
  console.log();
  console.log(`  ${yellow('⚠')} ${yellow('Guarde a chave agora: ela não será exibida novamente.')}`);
  await pause();
}

async function listKeysFlow() {
  const keys = listKeys();
  frame('CHAVES DE API');
  if (keys.length === 0) {
    console.log(`  ${dim('(nenhuma chave criada ainda)')}`);
  } else {
    console.log(`  ${dim(`${keys.length} chave(s) — ${keys.filter((k) => !k.revoked).length} ativa(s)\n`)}`);
    for (const k of keys) {
      const expired = k.expiresAt && Date.parse(k.expiresAt) < Date.now();
      const exhausted = k.maxUses !== null && k.uses >= k.maxUses;
      const status = k.revoked
        ? red('REVOGADA')
        : expired
          ? red('EXPIRADA')
          : exhausted
            ? yellow('LIMITE ATINGIDO')
            : green('ATIVA');
      const uses = k.maxUses ? `${k.uses}/${k.maxUses}` : `${k.uses}/∞`;
      const expira = k.expiresAt ? new Date(k.expiresAt).toLocaleDateString('pt-BR') : 'nunca';
      console.log(
        `  ${bold(shortId(k.id))}  ${String(k.name).padEnd(18)}  usos ${String(uses).padEnd(10)}  expira ${String(expira).padEnd(12)}  ${status}`,
      );
    }
  }
  await pause();
}

async function revokeKeyFlow() {
  const active = listKeys().filter((k) => !k.revoked);
  if (active.length === 0) {
    frame('REVOGAR CHAVE');
    console.log(`  ${dim('nenhuma chave ativa para revogar')}`);
    await pause();
    return;
  }
  const chosen = await select(
    'REVOGAR CHAVE — escolha a chave',
    active.map((k) => ({
      icon: '🔑',
      label: `${k.name} ${dim(`(${shortId(k.id)})`)}`,
      hint: `usos ${k.maxUses ? `${k.uses}/${k.maxUses}` : '∞'} · expira ${
        k.expiresAt ? new Date(k.expiresAt).toLocaleDateString('pt-BR') : 'nunca'
      }`,
      ref: k,
    })),
  );
  if (!chosen) return;
  const key = chosen.ref;
  const ok = await confirm(`Revogar "${key.name}" (${shortId(key.id)})?`, { def: false });
  if (!ok) return;
  revokeKey(key.id);
  console.log(`\n  ${green('✓')} chave ${bold(key.name)} revogada`);
  await pause();
}

/* ------------------------------------------------------------------ */
/* Fluxos: manifests                                                   */
/* ------------------------------------------------------------------ */

/** Pergunta AppID + fonte, com validação. */
async function askAppIdAndSource() {
  const appid = await ask('AppID', {
    validate: (v) => (/^\d{1,12}$/.test(v) ? null : 'AppID: de 1 a 12 dígitos'),
  });
  const order = describeSources().order;
  if (order.length === 0) return { appid, source: null };
  const items = [
    {
      icon: '🎯',
      label: 'Padrão (ordem do servidor)',
      hint: order.join(' → '),
      ref: null,
    },
    ...order.map((id) => ({ icon: '🌐', label: id, ref: id })),
  ];
  const chosen = await select('FONTE DOS MANIFESTS', items);
  if (!chosen) return null;
  return { appid, source: chosen.ref };
}

async function searchFlow() {
  frame('BUSCAR JOGO POR NOME');
  console.log(`  ${dim('Consulta a loja da Steam (fonte pública) e devolve o AppID.\n')}`);
  const q = await ask('Nome do jogo', {
    validate: (v) => (v.length >= 2 ? null : 'mínimo de 2 caracteres'),
  });
  console.log();
  console.log(`  ${dim('consultando a loja da Steam...')}`);
  try {
    const res = await searchGames(q);
    const items = res?.items || [];
    frame(`RESULTADOS PARA "${q.toUpperCase()}"`);
    if (items.length === 0) {
      console.log(`  ${dim('nada encontrado')}`);
    } else {
      console.log(`  ${dim(`${res?.total ?? items.length} resultado(s)${res?.cached ? ' (cache)' : ''}\n`)}`);
      for (const it of items) {
        console.log(`  ${bold(cyan(String(it.id)))}  ${it.name}${it.type ? dim(`  (${it.type})`) : ''}`);
      }
    }
  } catch (err) {
    frame('BUSCA FALHOU');
    showError(err);
  }
  await pause();
}

async function manifestsFlow() {
  frame('CONSULTAR MANIFESTS DE UM APPID');
  const picked = await askAppIdAndSource();
  if (!picked) return;
  const refresh = await confirm('Forçar atualização (refresh=1)?');
  frame('CONSULTANDO...');
  console.log(`  ${dim('buscando na fonte — pode demorar alguns segundos...\n')}`);
  try {
    const meta = await getManifests(picked.appid, {
      source: picked.source,
      refresh,
    });
    frame(`MANIFESTS DO APPID ${picked.appid}`);
    cards([
      ['Fonte', meta.source],
      ['Origem', meta.origin || '—'],
      ['Commit', shortId(meta.commit || '')],
      ['Branch', meta.branch || '—'],
      ['Arquivos', `${meta.files.length} manifest(s) · ${fmtBytes(meta.totalBytes)}`],
      ['Configs', `${meta.configFiles?.length || 0} (só listadas, nunca entregues)`],
      ['Buscado em', fmtDate(meta.fetchedAt)],
      ['Cache', meta.stale ? yellow('stale') : meta.cached ? green('hit') : 'miss'],
    ]);
    if (meta.files.length > 0) {
      console.log(dim('\n  primeiros arquivos:'));
      for (const f of meta.files.slice(0, 8)) {
        console.log(`    ${dim('·')} ${f.name} ${dim(fmtBytes(f.size))}`);
      }
      if (meta.files.length > 8) {
        console.log(dim(`    ... e mais ${meta.files.length - 8}`));
      }
    }
  } catch (err) {
    frame('CONSULTA FALHOU');
    showError(err);
  }
  await pause();
}

async function downloadZipFlow() {
  frame('BAIXAR ZIP DE MANIFESTS');
  const picked = await askAppIdAndSource();
  if (!picked) return;
  const ok = await confirm(
    `Baixar os manifests do AppID ${picked.appid}${picked.source ? ` (fonte ${picked.source})` : ''} como ZIP?`,
    { def: true },
  );
  if (!ok) return;
  frame('BAIXANDO...');
  console.log(`  ${dim('resolvendo a fonte e montando o ZIP...\n')}`);
  try {
    const meta = await getManifests(picked.appid, { source: picked.source });
    const entries = validateZipEntries(meta);
    assertZipPolicy(entries);
    const out = path.resolve(process.cwd(), zipFilename(meta.appid, { source: meta.source }));
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(out);
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', reject);
      output.on('error', reject);
      output.on('close', resolve);
      archive.pipe(output);
      for (const entry of entries) archive.file(entry.full, { name: entry.name });
      archive.finalize();
    });
    frame('ZIP PRONTO');
    console.log(`  ${green('✓')} ${meta.files.length} manifest(s) · ${fmtBytes(meta.totalBytes)}`);
    console.log(`  ${bold('arquivo:')} ${out}`);
  } catch (err) {
    if (err instanceof SourceError) {
      frame('DOWNLOAD FALHOU');
      showError(err);
    } else {
      frame('DOWNLOAD FALHOU');
      console.log(`  ${red('✗')} ${err?.message || err}`);
    }
  }
  await pause();
}

/* ------------------------------------------------------------------ */
/* Fluxos: cache                                                       */
/* ------------------------------------------------------------------ */

async function cacheStatsFlow() {
  const stats = cacheStats();
  frame('ESTATÍSTICAS DO CACHE');
  cards([
    ['Entradas', String(stats.entries)],
    ['Tamanho', fmtBytes(stats.bytes)],
    ['Stale', String(stats.stale)],
    ['Teto de disco', stats.maxBytes ? fmtBytes(stats.maxBytes) : 'sem teto'],
    ['Diretório', stats.dir],
    [
      'Por fonte',
      Object.entries(stats.bySource)
        .map(([k, v]) => `${k}: ${v}`)
        .join('  ·  ') || 'vazio',
    ],
  ]);
  await pause();
}

async function invalidateFlow() {
  frame('INVALIDAR CACHE POR APPID');
  const appid = await ask('AppID', {
    validate: (v) => (/^\d{1,12}$/.test(v) ? null : 'AppID: de 1 a 12 dígitos'),
  });
  const sources = Object.keys(cacheStats().bySource);
  let source = null;
  if (sources.length > 1) {
    const chosen = await select(
      'INVALIDAR EM QUAL FONTE?',
      [
        { icon: '🌐', label: 'Todas as fontes', hint: 'remove a entrada de todas', ref: null },
        ...sources.map((id) => ({ icon: '🌐', label: id, ref: id })),
      ],
    );
    if (!chosen) return;
    source = chosen.ref;
  }
  const ok = await confirm(
    `Invalidar o cache do AppID ${appid}${source ? ` (fonte ${source})` : ' em todas as fontes'}?`,
    { def: false },
  );
  if (!ok) return;
  invalidate(appid, { source });
  console.log(`\n  ${green('✓')} cache do AppID ${bold(appid)} removida — será baixada de novo na próxima consulta`);
  await pause();
}

/* ------------------------------------------------------------------ */
/* Fluxos: serviço                                                     */
/* ------------------------------------------------------------------ */

async function serviceStatusFlow() {
  const sources = describeSources();
  frame('STATUS DO SERVIÇO');
  cards([
    ['Projeto', PROJECT_NAME],
    ['Versão', VERSION],
    ['Escuta', `http://${config.host}:${config.port}`],
    ['Admin token', config.adminToken ? green('configurado') : red('não configurado (/admin desabilitado)')],
    ['Fontes (ordem)', sources.order.join(' → ') || red('nenhuma habilitada')],
    ...sources.sources.map((s) => [
      `  · ${s.id}`,
      `${s.enabled ? green('habilitada') : dim('desabilitada')} · ${
        s.configured ? green('configurada') : yellow('não configurada')
      }${s.repository ? dim(` · ${s.repository}`) : ''}`,
    ]),
    ['Busca por nome', config.search.enabled ? green(`ligada (máx ${config.search.limit})`) : dim('desligada')],
    ['Links temporários', config.links.publicBaseUrl ? green(config.links.publicBaseUrl) : dim('desligados (PUBLIC_BASE_URL vazio)')],
    ['Discord', config.discord.token ? green('configurado') : dim('não configurado')],
    ['Limites', `arquivo ${fmtBytes(config.limits.maxFileBytes)} · ZIP ${fmtBytes(config.limits.maxZipBytes)} · ${config.limits.defaultRatePerMinute} req/min`],
    ['Cache', `teto ${fmtBytes(config.cache.maxBytes)} · TTL ${config.cache.ttlSeconds}s · stale máx ${config.cache.staleMaxSeconds}s`],
  ]);
  await pause();
}

/** Roda o update do host (git pull + rebuild + restart) com saída no terminal. */
function runHostUpdate() {
  return new Promise((resolve) => {
    if (process.stdin.isRaw) process.stdin.setRawMode(false);
    inSpawn = true;
    clear();
    console.log(banner());
    console.log();
    console.log(`  ${bold('▶')} Atualizando via GitHub...`);
    console.log(`  ${dim('Ctrl+C no terminal interrompe e volta ao painel')}`);
    console.log();
    const child = spawn('bash', [path.join(ROOT, 'install.sh'), 'update'], {
      stdio: 'inherit',
      cwd: ROOT,
    });
    const forward = () => {
      try {
        child.kill('SIGINT');
      } catch {
        /* já saiu */
      }
    };
    process.on('SIGINT', forward);
    child.on('exit', (code) => {
      process.removeListener('SIGINT', forward);
      inSpawn = false;
      console.log();
      console.log(`  ${dim(`atualização encerrada${code ? ` (código ${code})` : ''}`)}`);
      console.log();
      resolve(code ?? 0);
    });
  });
}

async function updateFlow() {
  const inContainer = fs.existsSync('/.dockerenv') || !fs.existsSync(path.join(ROOT, 'install.sh'));
  if (inContainer) {
    frame('ATUALIZAR VIA GITHUB');
    console.log(`  ${yellow('⚠')} ${yellow('Este painel está rodando DENTRO do container.')}`);
    console.log(`  ${dim('O container é efêmero e não tem git nem Docker: o update precisa rodar no HOST.')}`);
    console.log();
    console.log(`  No host, na pasta do projeto, rode:`);
    console.log(`    ${bold('cd ' + ROOT)}`);
    console.log(`    ${bold('./install.sh update')}`);
    console.log();
    console.log(`  ${dim('Isso faz git pull + rebuild das imagens + restart, preservando .env e ./data.')}`);
    await pause();
    return;
  }
  frame('ATUALIZAR VIA GITHUB');
  console.log('  Faz: git pull (se tiver .git) + rebuild das imagens + restart.');
  console.log(`  ${dim('.env e ./data são preservados.')}\n`);
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    console.log(`  ${yellow('⚠')} ${yellow('Sem .git aqui: vai só rebuildar/reiniciar com o código atual.')}\n`);
  }
  const ok = await confirm('Atualizar agora?', { def: false });
  if (!ok) return;
  const code = await runHostUpdate();
  if (code === 0) {
    console.log(`  ${green('✓')} atualizado. Se o painel mostrar dados antigos, saia e abra de novo.`);
  } else {
    console.log(`  ${red('✗')} update saiu com código ${code} — veja as mensagens acima.`);
  }
  await pause();
}

/* ------------------------------------------------------------------ */
/* Menus                                                               */
/* ------------------------------------------------------------------ */

const MAIN_MENU = [
  { id: 'keys', icon: '🔑', label: 'Chaves de API', hint: 'criar · listar · revogar' },
  { id: 'manifests', icon: '📦', label: 'Manifests', hint: 'buscar jogo · consultar AppID · baixar ZIP' },
  { id: 'cache', icon: '🧠', label: 'Cache', hint: 'estatísticas · invalidar por AppID' },
  { id: 'service', icon: '🌐', label: 'Serviço', hint: 'status · API · bot · atualizar' },
  { id: 'exit', icon: '🚪', label: 'Sair', hint: 'fechar o painel' },
];

const KEYS_MENU = [
  { id: 'create', icon: '✚', label: 'Criar nova chave' },
  { id: 'list', icon: '☰', label: 'Listar chaves' },
  { id: 'revoke', icon: '✖', label: 'Revogar chave' },
  { id: 'back', icon: '⤺', label: 'Voltar ao menu principal' },
];

const MANIFESTS_MENU = [
  { id: 'search', icon: '🔍', label: 'Buscar jogo por nome', hint: 'nome → AppID (loja da Steam)' },
  { id: 'consult', icon: '📋', label: 'Consultar manifests de um AppID' },
  { id: 'download', icon: '⬇️', label: 'Baixar ZIP de manifests' },
  { id: 'back', icon: '⤺', label: 'Voltar ao menu principal' },
];

const CACHE_MENU = [
  { id: 'stats', icon: '📊', label: 'Estatísticas do cache' },
  { id: 'invalidate', icon: '🗑️', label: 'Invalidar entrada por AppID' },
  { id: 'back', icon: '⤺', label: 'Voltar ao menu principal' },
];

const SERVICE_MENU = [
  { id: 'status', icon: '📡', label: 'Status do serviço' },
  { id: 'api', icon: '🚀', label: 'Iniciar servidor API', hint: `http://${config.host}:${config.port}` },
  { id: 'bot', icon: '🤖', label: 'Iniciar bot do Discord', hint: '/manifest · /busca' },
  { id: 'update', icon: '🔄', label: 'Atualizar via GitHub', hint: 'git pull + rebuild + restart' },
  { id: 'back', icon: '⤺', label: 'Voltar ao menu principal' },
];

async function keysMenu() {
  for (;;) {
    const item = await select('CHAVES DE API', KEYS_MENU);
    if (!item || item.id === 'back') return;
    if (item.id === 'create') await createKeyFlow();
    else if (item.id === 'list') await listKeysFlow();
    else if (item.id === 'revoke') await revokeKeyFlow();
  }
}

async function manifestsMenu() {
  for (;;) {
    const item = await select('MANIFESTS', MANIFESTS_MENU);
    if (!item || item.id === 'back') return;
    if (item.id === 'search') await searchFlow();
    else if (item.id === 'consult') await manifestsFlow();
    else if (item.id === 'download') await downloadZipFlow();
  }
}

async function cacheMenu() {
  for (;;) {
    const item = await select('CACHE DE MANIFESTS', CACHE_MENU);
    if (!item || item.id === 'back') return;
    if (item.id === 'stats') await cacheStatsFlow();
    else if (item.id === 'invalidate') await invalidateFlow();
  }
}

async function serviceMenu() {
  for (;;) {
    const item = await select('SERVIÇO', SERVICE_MENU);
    if (!item || item.id === 'back') return;
    if (item.id === 'status') await serviceStatusFlow();
    else if (item.id === 'api') {
      await runScript('src/server.js', 'servidor API');
      await pause();
    } else if (item.id === 'bot') {
      await runScript('src/bot/index.js', 'bot do Discord');
      await pause();
    } else if (item.id === 'update') {
      await updateFlow();
    }
  }
}

/** Ponto de entrada do painel (chamado por cli.js sem argumentos). */
export async function runMenu() {
  if (!TTY) {
    // Sem terminal interativo (ex.: pipe no Docker): não travar o script.
    console.error('Este comando abre um menu interativo e precisa de um terminal.');
    console.error('Modo de máquina: node src/cli.js <key:create|key:list|key:revoke|cache:stats|cache:invalidate> [args]');
    process.exit(0);
  }
  // Raw mode ligado a sessao toda: seletor e campos de
  // texto trabalham por keypress. Desligado ao sair
  // (e sempre que um script filho roda, ver runScript).
  readline.emitKeypressEvents(process.stdin);
  if (!process.stdin.isRaw) process.stdin.setRawMode(true);
  try {
    for (;;) {
      const item = await select('MENU PRINCIPAL', MAIN_MENU);
      // Esc (null) e "Sair" encerram: break (nao return) para
      // o fluxo alcancar o shutdown() apos o finally.
      if (!item || item.id === 'exit') break;
      if (item.id === 'keys') await keysMenu();
      else if (item.id === 'manifests') await manifestsMenu();
      else if (item.id === 'cache') await cacheMenu();
      else if (item.id === 'service') await serviceMenu();
    }
  } finally {
    if (process.stdin.isRaw) process.stdin.setRawMode(false);
  }
  shutdown();
}
