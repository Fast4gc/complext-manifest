import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockGitHub } from './mockGitHub.js';

process.env.ENV_FILE = '/nonexistent/mg-tests.env'; // ignora o .env local: testes isolados
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-limit-test-'));
process.env.DATA_DIR = tmp;
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.GITHUB_REPOSITORY = 'teste/manifests';
process.env.CACHE_TTL_SECONDS = '600';
// Cada manifesto tem 60 bytes; com teto de 100, a segunda entrada expulsa a primeira.
process.env.CACHE_MAX_BYTES = '100';

const A = '111';
const B = '222';
const gh = await startMockGitHub({ branch: A, commit: 'd'.repeat(40) });
process.env.GITHUB_API_URL = gh.url;

gh.setFiles({ [`${A}.manifest`]: 'm'.repeat(60) });

const { getManifests, cacheStats, invalidate } = await import('../src/cache.js');

const filesDir = (source, appid) => path.join(tmp, 'cache', source, appid, 'files');
const entryDir = (source, appid) => path.join(tmp, 'cache', source, appid);

/* ------------------------------------------------------------------ */
/* Sem downloads duplicados                                            */
/* ------------------------------------------------------------------ */

test('varias requisicoes ao mesmo tempo baixam o arquivo uma vez so', async () => {
  invalidate(A);
  gh.resetCalls();
  gh.setBranch(A, 'd'.repeat(40));
  gh.setFiles({ [`${A}.manifest`]: 'm'.repeat(60) });

  const results = await Promise.all(
    Array.from({ length: 6 }, () => getManifests(A)),
  );

  assert.equal(results.length, 6);
  for (const r of results) assert.equal(r.appid, A);

  // O bloqueio de mesma chave + o dedup por arquivo garantem uma unica ida.
  assert.equal(gh.calls.branches, 1, 'uma checagem de branch para 6 pedidos');
  assert.equal(gh.calls.trees, 1, 'uma listagem de arvore');
  assert.equal(gh.calls.contents, 1, 'UM download do arquivo, nao seis');

  const onDisk = fs.readdirSync(filesDir('github', A));
  assert.deepEqual(onDisk, [`${A}.manifest`], 'sem arquivo duplicado no disco');
});

test('segunda consulta dentro do TTL nao volta a baixar', async () => {
  gh.resetCalls();
  const r = await getManifests(A);
  assert.equal(r.cached, true);
  assert.equal(gh.calls.contents, 0, 'nada foi baixado de novo');
  assert.equal(gh.calls.branches, 0, 'nem o commit foi checado');
});

test('arquivo apagado do disco e recuperado na proxima consulta', async () => {
  fs.rmSync(path.join(filesDir('github', A), `${A}.manifest`));
  gh.resetCalls();
  const r = await getManifests(A);
  assert.equal(r.cached, true, 'a meta continua valida');
  assert.equal(gh.calls.contents, 1, 'mas o conteudo foi baixado de volta');
  assert.ok(fs.existsSync(path.join(filesDir('github', A), `${A}.manifest`)));
});

test('arquivo corrompido (tamanho diferente) e trocado pelo original', async () => {
  const file = path.join(filesDir('github', A), `${A}.manifest`);
  fs.writeFileSync(file, 'curto'); // nao bate com o tamanho declarado
  gh.resetCalls();
  await getManifests(A);
  assert.equal(gh.calls.contents, 1, 'baixou de novo');
  assert.equal(fs.readFileSync(file, 'utf8').length, 60, 'conteudo original restaurado');
});

/* ------------------------------------------------------------------ */
/* Limite de armazenamento                                              */
/* ------------------------------------------------------------------ */

test('CACHE_MAX_BYTES expulsa a entrada mais antiga', async () => {
  // Garante A (60 bytes) ja no disco.
  invalidate(A);
  invalidate(B);
  gh.setBranch(A, 'd'.repeat(40));
  gh.setFiles({ [`${A}.manifest`]: 'm'.repeat(60) });
  await getManifests(A);
  assert.ok(fs.existsSync(entryDir('github', A)));

  // Nova entrada, outro AppID: agora o total passa do teto de 100.
  gh.setBranch(B, 'e'.repeat(40));
  gh.setFiles({ [`${B}.manifest`]: 'n'.repeat(60) });
  const metaB = await getManifests(B);
  assert.equal(metaB.appid, B);

  assert.equal(
    fs.existsSync(entryDir('github', A)),
    false,
    'a entrada mais antiga foi removida',
  );
  assert.ok(fs.existsSync(entryDir('github', B)), 'a nova fica');

  const stats = cacheStats();
  assert.equal(stats.entries, 1, 'sob uma entrada');
  assert.ok(stats.bytes <= 100, `bytes=${stats.bytes} dentro do teto`);
  assert.equal(stats.maxBytes, 100);
  assert.ok(stats.evicted >= 1, 'registra que expulsou');
  assert.equal(stats.bySource.github, 1);
});

test('entrada unica maior que o teto nao e apagada em loop', async () => {
  // Se apagasse, o proximo pedido baixaria de novo e apagaria outra vez:
  // o cache nunca encheria e nunca serviria nada. Preferimos ultrapassar o
  // teto uma vez e manter o que acabou de chegar.
  invalidate(B);
  gh.setBranch(B, 'e'.repeat(40));
  gh.setFiles({ [`${B}.manifest`]: 'o'.repeat(150) }); // 150 > teto de 100

  const meta = await getManifests(B);
  assert.equal(meta.totalBytes, 150);
  assert.ok(
    fs.existsSync(entryDir('github', B)),
    'a entrada recem-criada sobrevive, mesmo acima do teto',
  );
  assert.equal(fs.readdirSync(filesDir('github', B)).length, 1);

  // E continua servindo sem baixar de novo (prova de que nao ha loop).
  gh.resetCalls();
  const again = await getManifests(B);
  assert.equal(again.cached, true);
  assert.equal(gh.calls.contents, 0);

  invalidate(B);
});

test('cacheStats mostra a origem do disco sem vazar conteudo', () => {
  const stats = cacheStats();
  assert.equal(stats.dir, path.join(tmp, 'cache'));
  assert.equal(typeof stats.bytes, 'number');
  assert.equal(typeof stats.stale, 'number');
  assert.ok(!JSON.stringify(stats).includes('mk_'));
});

// Fecha o mock: sem isso o servidor fica no event loop e o processo nao sai.
test.after(async () => {
  await gh.close();
});
