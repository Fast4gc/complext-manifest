import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockGitHub } from './mockGitHub.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-cache-test-'));
process.env.ENV_FILE = '/nonexistent/mg-tests.env'; // ignora o .env local: testes isolados
process.env.DATA_DIR = tmp;
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.GITHUB_REPOSITORY = 'teste/manifests';
process.env.CACHE_TTL_SECONDS = '60';
process.env.CACHE_STALE_MAX_SECONDS = '604800';
process.env.REQUEST_TIMEOUT_MS = '400';
process.env.MAX_FILE_BYTES = '100';
process.env.MAX_ZIP_BYTES = '50';

const APPID = '123456';
/** Fonte que estes testes usam: GITHUB_REPOSITORY vem primeiro na prioridade. */
const SOURCE = 'github';
const gh = await startMockGitHub({ branch: APPID, commit: 'a'.repeat(40) });
process.env.GITHUB_API_URL = gh.url;

const { getManifests, cacheStats, invalidate } = await import('../src/cache.js');
const { SourceError } = await import('../src/githubSource.js');

const metaFile = path.join(tmp, 'cache', SOURCE, APPID, 'meta.json');

function rewriteMeta(patch) {
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  Object.assign(meta, patch);
  fs.writeFileSync(metaFile, JSON.stringify(meta));
}

test.beforeEach(() => {
  invalidate(APPID);
  gh.resetCalls();
  gh.setBranch(APPID, 'a'.repeat(40));
  gh.setMode('ok');
  gh.setFiles({
    '730.manifest': 'manifest-a',
    'sub/123456.manifest': 'manifest-b',
    'ignorado.txt': 'nao deve entrar',
  });
});

test.after(async () => {
  await gh.close();
});

test('primeiro acesso baixa do GitHub e persiste no cache', async () => {
  const meta = await getManifests(APPID);
  assert.equal(meta.cached, false);
  assert.equal(meta.stale, false);
  assert.equal(meta.commit, 'a'.repeat(40));
  assert.equal(meta.files.length, 2, 'so .manifest entra');
  assert.equal(gh.calls.branches, 1);
  assert.equal(gh.calls.trees, 1);
  assert.equal(gh.calls.contents, 2);

  assert.ok(fs.existsSync(metaFile), 'meta.json gravado');
  const onDisk = fs.readFileSync(path.join(tmp, 'cache', SOURCE, APPID, 'files', '730.manifest'), 'utf8');
  assert.equal(onDisk, 'manifest-a');
  assert.ok(meta.files.every((f) => typeof f.sha256 === 'string' && f.sha256.length === 64));
});

test('segunda consulta dentro do TTL vem do cache, sem tocar no GitHub', async () => {
  await getManifests(APPID);
  gh.resetCalls();
  const meta = await getManifests(APPID);
  assert.equal(meta.cached, true);
  assert.equal(gh.calls.branches, 0, 'nenhuma chamada ao GitHub');
  assert.equal(gh.calls.contents, 0);
});

test('refresh=1 força checagem do commit sob demanda', async () => {
  await getManifests(APPID);
  gh.resetCalls();
  gh.setCommit('b'.repeat(40));
  gh.setFiles({ '730.manifest': 'manifest-novo' });

  const meta = await getManifests(APPID, { refresh: true });
  assert.equal(meta.cached, false);
  assert.equal(meta.commit, 'b'.repeat(40));
  assert.equal(meta.files.length, 1, 'arquivos antigos removidos');
  assert.equal(gh.calls.branches, 1);

  const content = fs.readFileSync(path.join(tmp, 'cache', SOURCE, APPID, 'files', '730.manifest'), 'utf8');
  assert.equal(content, 'manifest-novo');
});

test('mudanca de commit invalida a entrada expirada automaticamente', async () => {
  await getManifests(APPID);
  // Simula TTL vencido e um push novo no repositorio.
  rewriteMeta({ checkedAt: '2000-01-01T00:00:00.000Z' });
  gh.resetCalls();
  gh.setCommit('c'.repeat(40));
  gh.setFiles({ '730.manifest': 'terceira-versao' });

  const meta = await getManifests(APPID);
  assert.equal(meta.commit, 'c'.repeat(40));
  assert.equal(meta.cached, false);
  const content = fs.readFileSync(path.join(tmp, 'cache', SOURCE, APPID, 'files', '730.manifest'), 'utf8');
  assert.equal(content, 'terceira-versao');
});

test('GitHub indisponivel: serve cache stale dentro do limite', async () => {
  await getManifests(APPID);
  gh.resetCalls();
  rewriteMeta({ checkedAt: '2000-01-01T00:00:00.000Z' }); // força ir ao GitHub
  gh.setMode('down');

  const meta = await getManifests(APPID);
  assert.equal(meta.stale, true);
  assert.equal(meta.cached, true);
  assert.equal(meta.files.length, 2, 'conteudo antigo preservado');
  assert.equal(gh.calls.trees, 0, 'nao tentou baixar arvore nova');
});

test('GitHub fora do ar sem cache: erro claro', async () => {
  gh.setMode('down');
  await assert.rejects(getManifests(APPID), (err) => {
    assert.ok(err instanceof SourceError);
    assert.equal(err.code, 'github_indisponivel');
    return true;
  });
});

test('timeout do GitHub vira github_timeout', async () => {
  gh.setMode('slow');
  await assert.rejects(getManifests(APPID), (err) => {
    assert.equal(err.code, 'github_timeout');
    return true;
  });
});

test('limite de requisicoes do GitHub: github_rate_limit', async () => {
  gh.setMode('rate_limit');
  await assert.rejects(getManifests(APPID), (err) => {
    assert.equal(err.code, 'github_rate_limit');
    assert.ok(err.detail?.reset, 'informa quando reseta');
    return true;
  });
});

test('branch inexistente: branch_nao_encontrada', async () => {
  gh.setBranch('outro-nome');
  await assert.rejects(getManifests('730'), (err) => {
    assert.equal(err.code, 'branch_nao_encontrada');
    return true;
  });
});

test('branch sem .manifest: sem_manifests', async () => {
  gh.setFiles({ 'leia-me.txt': 'nada aqui' });
  await assert.rejects(getManifests(APPID), (err) => {
    assert.equal(err.code, 'sem_manifests');
    return true;
  });
  assert.equal(fs.existsSync(metaFile), false, 'cache nao fica poluido');
});

test('arquivo maior que MAX_FILE_BYTES e ignorado', async () => {
  gh.setFiles({
    'ok.manifest': 'pequeno',
    'grande.manifest': 'x'.repeat(200),
  });
  const meta = await getManifests(APPID);
  assert.equal(meta.files.length, 1);
  assert.equal(meta.files[0].name, 'ok.manifest');
});

test('soma dos arquivos acima de MAX_ZIP_BYTES: zip_grande_demais', async () => {
  gh.setFiles({ 'grande.manifest': 'y'.repeat(60) });
  await assert.rejects(getManifests(APPID), (err) => {
    assert.equal(err.code, 'zip_grande_demais');
    return true;
  });
});

test('conteudo corrompido no cache e reparado na consulta', async () => {
  await getManifests(APPID);
  gh.resetCalls();
  const file = path.join(tmp, 'cache', SOURCE, APPID, 'files', '730.manifest');
  fs.writeFileSync(file, 'CORROMPIDO'); // tamanho diferente

  const meta = await getManifests(APPID);
  assert.equal(meta.files.length, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), 'manifest-a', 'reparado');
  assert.ok(gh.calls.contents >= 1, 'baixou novamente');
});

test('cacheStats reflete as entradas', async () => {
  await getManifests(APPID);
  const stats = cacheStats();
  assert.equal(stats.entries, 1);
  assert.ok(stats.bytes > 0);
});
