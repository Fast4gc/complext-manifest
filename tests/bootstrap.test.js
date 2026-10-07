import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOTSTRAP = path.join(ROOT, 'bootstrap.sh');
const ADMIN_RE = /^[0-9a-f]{64}$/;

/* ------------------------------------------------------------------ */
/* Cenarios: tarball do projeto + servidor local + docker simulado     */
/* ------------------------------------------------------------------ */

function makeTarball(dir) {
  const top = path.join(dir, 'manifest-gate-main');
  fs.mkdirSync(top, { recursive: true });
  for (const f of ['package.json', 'docker-compose.yml', 'install.sh', 'uninstall.sh', '.env.example']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(top, f));
  }
  fs.cpSync(path.join(ROOT, 'src'), path.join(top, 'src'), { recursive: true });
  const tarball = path.join(dir, 'repo.tar.gz');
  execSync(`tar -czf "${tarball}" -C "${dir}" manifest-gate-main`);
  return tarball;
}

function makeStubBin(dir) {
  const bin = path.join(dir, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'docker'),
    `#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
case "$*" in
  "compose version"*) echo "Docker Compose v2-stub"; exit 0 ;;
  *"cli.js key:create"*) echo "KEY_ID=stub"; echo "KEY_VALUE=mk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; exit 0 ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
  return bin;
}

/** Servidor estatico em processo separado (ver static-server.mjs). */
function startServerProcess(dir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'tests', 'static-server.mjs'), dir, BOOTSTRAP], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    let err = '';
    const timer = setTimeout(() => reject(new Error(`servidor nao iniciou: ${err}`)), 10_000);
    proc.stderr.on('data', (d) => {
      err += d;
    });
    proc.stdout.on('data', (d) => {
      buf += d;
      const line = buf.split('\n').find((l) => l.trim().startsWith('{'));
      if (line) {
        clearTimeout(timer);
        const { port } = JSON.parse(line);
        resolve({
          url: `http://127.0.0.1:${port}`,
          proc,
          close: () =>
            new Promise((r) => {
              proc.once('exit', r);
              proc.kill('SIGTERM');
              setTimeout(() => {
                proc.kill('SIGKILL');
                r();
              }, 2000).unref();
            }),
        });
      }
    });
  });
}

/** Simula `curl ... | bash -s -- args` (script lido do stdin). */
function runPipe(args, { cwd, stubBin, logFile, extraEnv = {} }) {
  const res = spawnSync('bash', ['-s', '--', ...args], {
    cwd,
    input: fs.readFileSync(BOOTSTRAP, 'utf8'),
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: `${stubBin}:${process.env.PATH}`,
      STUB_LOG: logFile,
      TMPDIR: cwd,
      ...extraEnv,
    },
  });
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  return { ...res, log };
}

/** Simula o `curl -fsSL <url> | bash -s -- args` com curl de verdade. */
function runCurlPipe(bootstrapUrl, args, { cwd, stubBin, logFile }) {
  const res = spawnSync(
    'bash',
    ['-c', 'set -o pipefail; curl -fsSL "$1" | bash -s -- "${@:2}"', 'sh', bootstrapUrl, ...args],
    {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${stubBin}:${process.env.PATH}`,
        STUB_LOG: logFile,
        TMPDIR: cwd,
      },
    },
  );
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  return { ...res, log };
}

function envValue(dir, key) {
  const envFile = path.join(dir, '.env');
  if (!fs.existsSync(envFile)) return null;
  const m = fs.readFileSync(envFile, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1] : null;
}

/* ------------------------------------------------------------------ */

let env; // { dir, tarballDir, server, stubBin, logFile }
let projectCount = 0;

test.before(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-bootstrap-test-'));
  const tarballDir = path.join(base, 'dist');
  fs.mkdirSync(tarballDir, { recursive: true });
  makeTarball(tarballDir);
  const server = await startServerProcess(tarballDir);
  env = {
    base,
    tarballDir,
    server,
    stubBin: makeStubBin(base),
    logFile: path.join(base, 'docker-calls.log'),
  };
});

test.after(async () => {
  await env?.server.close();
  if (env?.base) fs.rmSync(env.base, { recursive: true, force: true });
});

function freshTarget() {
  projectCount += 1;
  return path.join(env.base, `projeto-${projectCount}`);
}

test('bootstrap.sh passa no bash -n', () => {
  const res = spawnSync('bash', ['-n', BOOTSTRAP], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
});

test('pipe: baixa o codigo para a pasta com --no-exec', () => {
  const target = freshTarget();
  const res = runPipe(
    [`--url`, `${env.server.url}/repo.tar.gz`, '--dir', target, '--no-exec'],
    { cwd: env.base, stubBin: env.stubBin, logFile: env.logFile },
  );
  assert.equal(res.status, 0, `saida: ${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /codigo pronto/);
  for (const f of ['install.sh', 'uninstall.sh', 'docker-compose.yml', 'package.json', 'src/server.js']) {
    assert.ok(fs.existsSync(path.join(target, f)), `${f} baixado`);
  }
  assert.equal(fs.existsSync(path.join(target, '.env')), false, 'sem .env no --no-exec');
});

test('pipe: baixa e executa o instalador (docker simulado)', () => {
  const target = freshTarget();
  const res = runPipe(
    [`--url`, `${env.server.url}/repo.tar.gz`, '--dir', target, '--api-only'],
    { cwd: env.base, stubBin: env.stubBin, logFile: env.logFile },
  );
  assert.equal(res.status, 0, `saida: ${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /\[bootstrap\]/);
  assert.match(res.stdout, /concluida/);
  assert.match(res.log, /up -d api/);
  assert.ok(ADMIN_RE.test(envValue(target, 'ADMIN_TOKEN') || ''), 'ADMIN_TOKEN gerado');
  assert.equal(envValue(target, 'INSTALL_MODE'), 'api');
});

test('pipe repetido: preserva .env e so reinstala', () => {
  const target = freshTarget();
  runPipe([`--url`, `${env.server.url}/repo.tar.gz`, '--dir', target, '--api-only'], {
    cwd: env.base,
    stubBin: env.stubBin,
    logFile: env.logFile,
  });
  const before = envValue(target, 'ADMIN_TOKEN');
  fs.appendFileSync(path.join(target, '.env'), '# alteracao do usuario\n');

  const res = runPipe([`--url`, `${env.server.url}/repo.tar.gz`, '--dir', target, '--api-only'], {
    cwd: env.base,
    stubBin: env.stubBin,
    logFile: env.logFile,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /ja existe/);
  assert.equal(envValue(target, 'ADMIN_TOKEN'), before, 'token preservado');
  assert.match(fs.readFileSync(path.join(target, '.env'), 'utf8'), /alteracao do usuario/);
});

test('--update: rebaixa o codigo preservando .env e data', () => {
  const target = freshTarget();
  runPipe([`--url`, `${env.server.url}/repo.tar.gz`, '--dir', target, '--api-only'], {
    cwd: env.base,
    stubBin: env.stubBin,
    logFile: env.logFile,
  });
  const before = envValue(target, 'ADMIN_TOKEN');
  fs.mkdirSync(path.join(target, 'data', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(target, 'data', 'cache', 'x.json'), '{"x":1}');
  // Simula codigo local alterado.
  fs.appendFileSync(path.join(target, 'src', 'server.js'), '\n// alterado localmente\n');

  const res = runPipe(
    [`--url`, `${env.server.url}/repo.tar.gz`, '--dir', target, '--update', '--no-exec'],
    { cwd: env.base, stubBin: env.stubBin, logFile: env.logFile },
  );
  assert.equal(res.status, 0, `saida: ${res.stdout}\n${res.stderr}`);
  const serverJs = fs.readFileSync(path.join(target, 'src', 'server.js'), 'utf8');
  assert.equal(serverJs.includes('// alterado localmente'), false, 'codigo atualizado');
  assert.equal(envValue(target, 'ADMIN_TOKEN'), before, '.env preservado');
  assert.ok(fs.existsSync(path.join(target, 'data', 'cache', 'x.json')), 'cache preservado');
});

test('recusa pasta nao-vazia que nao e deste projeto', () => {
  const target = freshTarget();
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'coisa-do-usuario.txt'), 'nao mexer');

  const res = runPipe([`--url`, `${env.server.url}/repo.tar.gz`, '--dir', target, '--no-exec'], {
    cwd: env.base,
    stubBin: env.stubBin,
    logFile: env.logFile,
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /nao e um projeto/);
  assert.ok(fs.existsSync(path.join(target, 'coisa-do-usuario.txt')), 'arquivo intacto');
  assert.equal(fs.existsSync(path.join(target, 'install.sh')), false, 'nada foi baixado');
});

test('rejeita URL nao-https', () => {
  const target = freshTarget();
  const res = runPipe(['--url', 'http://exemplo.com/repo.tar.gz', '--dir', target, '--no-exec'], {
    cwd: env.base,
    stubBin: env.stubBin,
    logFile: env.logFile,
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /somente https/);
  assert.equal(fs.existsSync(target), false);
});

test('rejeita repositorio com formato errado', () => {
  const res = runPipe(['--repo', 'https://github.com/usuario/repo', '--no-exec'], {
    cwd: env.base,
    stubBin: env.stubBin,
    logFile: env.logFile,
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /repositorio invalido/);
});

test('caminho padrao (repo+ref, sem --url): valida "main" e baixa do codeload', () => {
  // Regressao: bash POSIX nao entende \w em [..]; a regex antiga rejeitava "main"
  // e o usuario recebia "referencia git invalida" logo no inicio.
  const target = freshTarget();
  const res = runPipe(
    [
      '--repo', 'Fast4gc/complext-manifest',
      '--ref', 'main',
      '--dir', target,
      '--no-exec',
    ],
    {
      cwd: env.base,
      stubBin: env.stubBin,
      logFile: env.logFile,
      extraEnv: { INSTALL_CODELOAD_BASE: env.server.url },
    },
  );
  assert.equal(res.status, 0, `saida: ${res.stdout}\n${res.stderr}`);
  assert.equal(/referencia git invalida/.test(res.stdout + res.stderr), false);
  assert.match(res.stdout, /baixando codigo/);
  assert.match(res.stdout, /\/Fast4gc\/complext-manifest\/tar\.gz\/main/);
  assert.ok(fs.existsSync(path.join(target, 'install.sh')), 'codigo baixado');
  assert.ok(fs.existsSync(path.join(target, 'src', 'server.js')));
});

test('rejeita referencia git com caracteres invalidos', () => {
  const res = runPipe(['--ref', 'ref com espaco', '--no-exec'], {
    cwd: env.base,
    stubBin: env.stubBin,
    logFile: env.logFile,
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /referencia git invalida/);
});

test('alvo "." em pasta vazia: instala na pasta atual', () => {
  const target = freshTarget();
  fs.mkdirSync(target, { recursive: true });
  const res = runPipe([`--url`, `${env.server.url}/repo.tar.gz`, '--no-exec'], {
    cwd: target,
    stubBin: env.stubBin,
    logFile: env.logFile,
  });
  assert.equal(res.status, 0, `saida: ${res.stdout}\n${res.stderr}`);
  assert.ok(fs.existsSync(path.join(target, 'install.sh')), 'instalado em cwd');
  assert.equal(fs.existsSync(path.join(target, 'manifest-gate', 'install.sh')), false);
});

test('curl | bash de verdade usa o servidor local', () => {
  const target = freshTarget();
  const res = runCurlPipe(`${env.server.url}/bootstrap.sh`, [
    '--url',
    `${env.server.url}/repo.tar.gz`,
    '--dir',
    target,
    '--api-only',
  ], { cwd: env.base, stubBin: env.stubBin, logFile: env.logFile });

  assert.equal(res.status, 0, `saida: ${res.stdout}\n${res.stderr}`);
  assert.ok(ADMIN_RE.test(envValue(target, 'ADMIN_TOKEN') || ''), 'instalador executou');
  assert.match(res.log, /up -d api/);
});

test('help via pipe nao quebra (sem BASH_SOURCE legivel)', () => {
  const res = spawnSync('bash', ['-s', '--', '--help'], {
    input: fs.readFileSync(BOOTSTRAP, 'utf8'),
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /uso:|Opcoes/);
});
