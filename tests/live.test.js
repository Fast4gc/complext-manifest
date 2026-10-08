import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Consulta REAL a um repositorio publico neutro (nao usa ManifestHub).
// O template "main" faz o AppID ser irrelevante: exercita branch + arvore + filtro.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-live-test-'));
process.env.ENV_FILE = '/nonexistent/mg-tests.env'; // ignora o .env local: testes isolados
process.env.DATA_DIR = tmp;
process.env.GITHUB_REPOSITORY = 'expressjs/express';
process.env.BRANCH_TEMPLATE = 'master';
delete process.env.GITHUB_TOKEN;
delete process.env.GITHUB_API_URL;

const { branchHead, listManifestsAt, SourceError } = await import('../src/githubSource.js');

test('consulta real a API do GitHub: branch, arvore e filtro de manifests', async (t) => {
  let head;
  try {
    head = await branchHead('1');
  } catch (err) {
    if (
      err instanceof SourceError &&
      ['github_timeout', 'github_indisponivel', 'github_rate_limit'].includes(err.code)
    ) {
      return t.skip(`sem acesso ao GitHub agora (${err.code})`);
    }
    throw err;
  }

  assert.equal(head.branch, 'master');
  assert.match(head.sha, /^[0-9a-f]{40}$/);

  const { files, truncated } = await listManifestsAt('1', head.sha);
  assert.ok(Array.isArray(files));
  assert.equal(typeof truncated, 'boolean');
  // repositorio de exemplo nao tem arquivos .manifest -> lista vazia e valida
  assert.equal(files.length, 0);
  assert.ok(files.every((f) => f.name.endsWith('.manifest')));
});

/* ------------------------------------------------------------------ */
/* ManifestHub de verdade                                              */
/* ------------------------------------------------------------------ */

test('consulta real ao ManifestHub pela branch do AppID (nunca lista branches)', async (t) => {
  const { REGISTRY } = await import('../src/providers/index.js');
  const { SourceError: SE } = await import('../src/githubSource.js');
  const provider = REGISTRY.manifesthub;

  const APPID = '730'; // Counter-Strike 2: branch que existe la

  // 1. Disponibilidade: uma chamada, pela branch do AppID.
  let head;
  try {
    head = await provider.availability(APPID);
  } catch (err) {
    if (
      err instanceof SE &&
      ['github_timeout', 'github_indisponivel', 'github_rate_limit'].includes(err.code)
    ) {
      return t.skip(`sem acesso ao ManifestHub agora (${err.code})`);
    }
    throw err;
  }
  assert.equal(head.available, true);
  assert.equal(head.branch, APPID, 'a branch e o proprio AppID');
  assert.match(head.commit, /^[0-9a-f]{40}$/);

  // 2. Listagem: mesma chamada de arvore, sem varrer as ~62 mil branches.
  const listing = await provider.list(APPID);
  assert.equal(listing.source, 'manifesthub');
  assert.equal(listing.appid, APPID);
  assert.equal(listing.ref, APPID);
  assert.equal(listing.version, head.commit, 'proveniencia: mesmo commit');
  assert.ok(!Number.isNaN(Date.parse(listing.fetchedAt)), 'data da consulta registrada');
  assert.equal(typeof listing.truncated, 'boolean');

  if (listing.files.length === 0) {
    // O repositorio mudou? Nao e erro: o servico so reporta o que existe.
    assert.ok(Array.isArray(listing.configFiles));
    return t.skip('branch 730 nao tem .manifest hoje');
  }

  // 3. Só .manifest é baixável; nomes reais batem com o formato esperado.
  const { parseManifestName } = await import('../src/validate.js');
  for (const f of listing.files) {
    assert.equal(f.kind, 'manifest');
    assert.ok(f.name.endsWith('.manifest'), f.name);
    assert.ok(typeof f.ref === 'string' && f.ref.length === 40, 'cada arquivo leva o commit');
    assert.ok(Number.isFinite(f.size) && f.size > 0);
    // Formato real do ManifestHub: <depotid>_<manifestid>.manifest
    const parsed = parseManifestName(f.path || f.name);
    if (parsed.depotId !== null) {
      assert.ok(typeof parsed.manifestId === 'string', 'ManifestID e sempre string');
      assert.match(parsed.manifestId, /^\d+$/);
    }
  }

  // 4. Nenhuma chave aparece em lugar nenhum da listagem.
  const raw = JSON.stringify(listing);
  assert.ok(!raw.includes('key.vdf'), 'arquivo de chave nem listado');
  assert.ok(!raw.includes('DecryptionKey'), 'conteudo de chave nunca aparece');
  assert.ok(!raw.includes('depotkeys'), 'depotkeys fora');
  assert.ok(!raw.includes('mk_'), 'sem chave de API');

  // 5. Config (.lua/.json): SO descrita, com aviso e link direto.
  for (const c of listing.configFiles) {
    assert.equal(c.kind, 'config');
    assert.equal(c.containsKeys, true, 'avisa que contem chaves');
    assert.ok(c.warning && /chaves/i.test(c.warning), 'aviso em portugues');
    assert.ok(/^https:\/\/raw\.githubusercontent\.com\//.test(c.rawUrl), c.rawUrl);
    assert.ok(!Object.prototype.hasOwnProperty.call(c, 'content'), 'conteudo nunca vem junto');
  }

  // 6. O link que entregamos ao cliente aponta para um arquivo que existe.
  const target = listing.configFiles.find((c) => c.rawUrl.endsWith('.lua'));
  if (target) {
    const res = await fetch(target.rawUrl, { method: 'HEAD' }).catch(() => null);
    if (res) {
      assert.equal(res.status, 200, `rawUrl deve resolver: ${target.rawUrl}`);
      // Confirmamos so o CABECALHO: o corpo (que tem chave) nao e baixado aqui.
      assert.ok(Number(res.headers.get('content-length')) > 0, 'arquivo tem tamanho');
    }
  }
});
