import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Consulta REAL a um repositorio publico neutro (nao usa ManifestHub).
// O template "main" faz o AppID ser irrelevante: exercita branch + arvore + filtro.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-live-test-'));
process.env.DATA_DIR = tmp;
process.env.GITHUB_REPOSITORY = 'expressjs/express';
process.env.BRANCH_TEMPLATE = 'main';
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

  assert.equal(head.branch, 'main');
  assert.match(head.sha, /^[0-9a-f]{40}$/);

  const { files, truncated } = await listManifestsAt('1', head.sha);
  assert.ok(Array.isArray(files));
  assert.equal(typeof truncated, 'boolean');
  // repositorio de exemplo nao tem arquivos .manifest -> lista vazia e valida
  assert.equal(files.length, 0);
  assert.ok(files.every((f) => f.name.endsWith('.manifest')));
});
