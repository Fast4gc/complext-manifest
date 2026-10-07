import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_KEY = 'mk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 32 chars depois do mk_

/** Copia os arquivos do projeto para uma pasta temporaria (testes destrutivos). */
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-installer-test-'));
  for (const f of ['install.sh', 'uninstall.sh', 'docker-compose.yml', 'package.json', '.env.example']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'src', 'server.js'), path.join(dir, 'src', 'server.js'));
  return dir;
}

/** Stub do docker: registra os argumentos e simula sucesso/CLI de chaves. */
/** Stub do docker: registra os argumentos e simula sucesso/CLI de chaves.
 *  mode: 'ok' (padrao) | 'no-info' (socket negado) | 'no-buildx' */
function makeStubBin(dir, mode = 'ok') {
  const bin = path.join(dir, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  const extra = {
    'no-info': `  "info"*) exit 1 ;;
`,
    'no-buildx': `  "buildx version"*) exit 1 ;;
`,
  }[mode] || '';
  const stub = `#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
case "$*" in
  "compose version"*) echo "Docker Compose v2-stub"; exit 0 ;;
${extra}  "buildx version"*) echo "docker buildx v0.20-stub"; exit 0 ;;
  *"cli.js key:create"*)
    echo "KEY_ID=stub-id"
    echo "KEY_VALUE=${BASE_KEY}"
    exit 0 ;;
  *) exit 0 ;;
esac
`;
  fs.writeFileSync(path.join(bin, 'docker'), stub, { mode: 0o755 });
  return bin;
}

function runScript(projectDir, stubBin, script, args = []) {
  const logFile = path.join(projectDir, 'docker-calls.log');
  const res = spawnSync('bash', [path.join(projectDir, script), ...args], {
    cwd: projectDir,
    input: '', // stdin fechado = instalador nao-interativo
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${stubBin}:${process.env.PATH}`,
      STUB_LOG: logFile,
    },
    timeout: 30_000,
  });
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  return { ...res, log };
}

function envValue(projectDir, key) {
  const envFile = path.join(projectDir, '.env');
  if (!fs.existsSync(envFile)) return null;
  const m = fs.readFileSync(envFile, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1] : null;
}

/* ------------------------------------------------------------------ */
/* Sintaxe                                                             */
/* ------------------------------------------------------------------ */

test('install.sh e uninstall.sh passam no bash -n', () => {
  for (const script of ['install.sh', 'uninstall.sh']) {
    const res = spawnSync('bash', ['-n', path.join(ROOT, script)], { encoding: 'utf8' });
    assert.equal(res.status, 0, `${script}: ${res.stderr}`);
  }
});

test('scripts sao executaveis', () => {
  for (const script of ['install.sh', 'uninstall.sh']) {
    assert.ok(fs.statSync(path.join(ROOT, script)).mode & 0o111, `${script} sem +x`);
  }
});

/* ------------------------------------------------------------------ */
/* Instalador                                                          */
/* ------------------------------------------------------------------ */

test('install --api-only: gera .env com ADMIN_TOKEN automatico', () => {
  const dir = makeProject();
  const bin = makeStubBin(dir);
  const res = runScript(dir, bin, 'install.sh', ['install', '--api-only']);

  assert.equal(res.status, 0, `saida: ${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /concluida/);
  assert.match(res.stderr, /GITHUB_REPOSITORY vazio/);

  const admin = envValue(dir, 'ADMIN_TOKEN');
  assert.ok(admin && /^[0-9a-f]{64}$/.test(admin), 'ADMIN_TOKEN gerado (64 hex)');
  assert.equal(envValue(dir, 'INSTALL_MODE'), 'api');
  assert.equal(envValue(dir, 'PORT'), '3000');

  // Usou o compose DESTA pasta, sem copiar para outro lugar.
  assert.match(res.log, /-f .*docker-compose\.yml -p|docker compose -p manifest-gate -f/);
  assert.match(res.log, /up -d api/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reinstalacao preserva .env e ADMIN_TOKEN existentes', () => {
  const dir = makeProject();
  const bin = makeStubBin(dir);
  runScript(dir, bin, 'install.sh', ['install', '--api-only']);

  // Usuario configurou o repositorio entre as instalacoes.
  const envFile = path.join(dir, '.env');
  let raw = fs.readFileSync(envFile, 'utf8');
  raw = raw.replace(/^GITHUB_REPOSITORY=.*$/m, 'GITHUB_REPOSITORY=meu-repo/minha-base');
  fs.writeFileSync(envFile, raw);
  const adminBefore = envValue(dir, 'ADMIN_TOKEN');

  const res = runScript(dir, bin, 'install.sh', ['install', '--api-only']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /existente preservado/);
  assert.equal(envValue(dir, 'GITHUB_REPOSITORY'), 'meu-repo/minha-base');
  assert.equal(envValue(dir, 'ADMIN_TOKEN'), adminBefore, 'token nao foi regerado');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('install --with-discord: exige token do Discord', () => {
  const dir = makeProject();
  const bin = makeStubBin(dir);
  const res = runScript(dir, bin, 'install.sh', ['install', '--with-discord']);
  assert.notEqual(res.status, 0, 'deveria recusar sem DISCORD_TOKEN');
  assert.match(res.stderr, /DISCORD_TOKEN/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('install --with-discord: gera chave da API do bot sem exibi-la', () => {
  const dir = makeProject();
  const bin = makeStubBin(dir);
  // Pre-semente credenciais (no modo nao-interativo nao ha prompt).
  const envFile = path.join(dir, '.env');
  const raw = fs.readFileSync(path.join(dir, '.env.example'), 'utf8');
  fs.writeFileSync(
    envFile,
    raw
      .replace(/^DISCORD_TOKEN=.*$/m, 'DISCORD_TOKEN=dummy-token-para-teste')
      .replace(/^DISCORD_GUILD_ID=.*$/m, 'DISCORD_GUILD_ID=123456789012345678'),
  );

  const res = runScript(dir, bin, 'install.sh', ['install', '--with-discord']);
  assert.equal(res.status, 0, `saida: ${res.stdout}\n${res.stderr}`);

  const key = envValue(dir, 'DISCORD_API_KEY');
  assert.ok(key && /^mk_[A-Za-z0-9]{32}$/.test(key), 'chave do bot gerada');
  assert.equal(key, BASE_KEY, 'veio do CLI, nao de um valor fixo do script');
  assert.equal(envValue(dir, 'INSTALL_MODE'), 'discord');
  assert.equal(res.stdout.includes(key), false, 'chave nao aparece no terminal');
  assert.match(res.log, /--profile discord up -d bot/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('comandos start, logs e update funcionam via compose', () => {
  const dir = makeProject();
  const bin = makeStubBin(dir);
  runScript(dir, bin, 'install.sh', ['install', '--api-only']);

  const start = runScript(dir, bin, 'install.sh', ['start']);
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.log, /up -d/);

  const logs = runScript(dir, bin, 'install.sh', ['logs']);
  assert.equal(logs.status, 0, logs.stderr);
  assert.match(logs.log, /logs --tail=200/);

  const update = runScript(dir, bin, 'install.sh', ['update']);
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.log, /build --pull/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('comando desconhecido retorna erro com uso', () => {
  const dir = makeProject();
  const bin = makeStubBin(dir);
  const res = runScript(dir, bin, 'install.sh', ['voar']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /comando desconhecido/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('acesso negado ao Docker: mensagem com usermod', () => {
  const dir = makeProject();
  const bin = makeStubBin(dir, 'no-info');
  const res = runScript(dir, bin, 'install.sh', ['install', '--api-only']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /permission denied/);
  assert.match(res.stderr, /grupo docker/);
  assert.match(res.stderr, /usermod/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildx ausente: mensagem de instalacao do plugin', () => {
  const dir = makeProject();
  const bin = makeStubBin(dir, 'no-buildx');
  const res = runScript(dir, bin, 'install.sh', ['install', '--api-only']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /buildx/);
  assert.match(res.stderr, /docker-buildx-plugin|cli-plugins/);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Desinstalador (sempre em copias temporarias)                        */
/* ------------------------------------------------------------------ */

function seedData(dir) {
  fs.mkdirSync(path.join(dir, 'data', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'keys.json'), '{"keys":[]}');
  fs.writeFileSync(path.join(dir, 'data', 'cache', 'meta.json'), '{"arquivo":"importante"}');
  const envFile = path.join(dir, '.env');
  if (!fs.existsSync(envFile)) {
    fs.copyFileSync(path.join(dir, '.env.example'), envFile);
  }
}

test('uninstall preserva .env, cache e fonte por padrao', () => {
  const dir = makeProject();
  const bin = makeStubBin(dir);
  seedData(dir);

  const res = runScript(dir, bin, 'uninstall.sh');
  assert.equal(res.status, 0, `saida: ${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /preservados/);

  assert.ok(fs.existsSync(path.join(dir, '.env')), '.env preservado');
  assert.ok(fs.existsSync(path.join(dir, 'data', 'keys.json')), 'chaves preservadas');
  assert.ok(fs.existsSync(path.join(dir, 'data', 'cache', 'meta.json')), 'cache preservado');
  assert.ok(fs.existsSync(path.join(dir, 'install.sh')), 'fonte preservado');
  assert.ok(fs.existsSync(path.join(dir, 'src', 'server.js')), 'fonte preservado');
  assert.match(res.stdout, /rm -rf/, 'explica como remover a pasta depois');
  assert.match(res.log, /down --remove-orphans/, 'derruba os servicos do projeto');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('uninstall --purge apaga .env e cache, mas mantem o codigo', () => {
  const dir = makeProject();
  const bin = makeStubBin(dir);
  seedData(dir);

  const res = runScript(dir, bin, 'uninstall.sh', ['--purge']);
  assert.equal(res.status, 0, res.stderr);

  assert.equal(fs.existsSync(path.join(dir, '.env')), false, '.env removido no purge');
  assert.equal(fs.existsSync(path.join(dir, 'data')), false, 'data removido no purge');
  assert.ok(fs.existsSync(path.join(dir, 'install.sh')), 'fonte continua');
  assert.ok(fs.existsSync(path.join(dir, 'package.json')), 'fonte continua');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('uninstall recusa pasta que nao e deste projeto', () => {
  const dir = makeProject();
  const bin = makeStubBin(dir);
  // Quebra o marcador de projeto.
  const compose = path.join(dir, 'docker-compose.yml');
  fs.writeFileSync(compose, fs.readFileSync(compose, 'utf8').replace('name: manifest-gate', 'name: outro-projeto'));
  seedData(dir);

  const res = runScript(dir, bin, 'uninstall.sh');
  assert.notEqual(res.status, 0, 'deveria recusar');
  assert.match(res.stderr, /nao e de um projeto|nao encontrado/);
  assert.ok(fs.existsSync(path.join(dir, 'data')), 'nada foi apagado');
  assert.equal(res.log.includes('down'), false, 'nao tocou no Docker');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('uninstall recusa argumento desconhecido', () => {
  const dir = makeProject();
  const bin = makeStubBin(dir);
  const res = runScript(dir, bin, 'uninstall.sh', ['--tudo']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /desconhecido/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('uninstall nunca removal Docker (so chama compose down)', () => {
  const dir = makeProject();
  const bin = makeStubBin(dir);
  seedData(dir);
  const res = runScript(dir, bin, 'uninstall.sh', ['--purge']);
  assert.equal(res.status, 0, res.stderr);
  const commands = res.log.trim().split('\n');
  assert.ok(commands.every((line) => line.startsWith('docker compose ')), res.log);
  assert.equal(res.log.includes(' rm '), false, 'nao chama docker rm diretamente');
  fs.rmSync(dir, { recursive: true, force: true });
});
