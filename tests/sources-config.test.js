import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Configuracao de servidor "vazio": nenhuma fonte utilizavel.
// GITHUB_REPOSITORY vazio (fonte nao configurada) + manifesthub desligado.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-sources-test-'));
process.env.ENV_FILE = '/nonexistent/mg-tests.env'; // ignora o .env local: testes isolados
process.env.DATA_DIR = tmp;
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.GITHUB_REPOSITORY = '';
process.env.MANIFESTHUB_ENABLED = 'false';
process.env.SOURCE_PRIORITY = 'github,manifesthub';
// Links publicos "meio ligados": tem URL base, mas nenhum segredo.
process.env.PUBLIC_BASE_URL = 'https://exemplo.test';

const APPID = '123456';

const { resolveOrder, priorityOrder, describeSources } = await import(
  '../src/providers/index.js'
);
const { getManifests } = await import('../src/cache.js');

test('sem nenhuma fonte utilizavel, a prioridade efetiva fica vazia', () => {
  assert.deepEqual(priorityOrder(), []);
});

test('sem fonte: nenhuma_fonte com mensagem clara', () => {
  assert.throws(
    () => resolveOrder(null),
    (err) => {
      assert.equal(err.code, 'nenhuma_fonte');
      assert.match(err.message, /Nenhuma fonte/);
      return true;
    },
  );
});

test('fonte desabilitada pelo operador responde fonte_desabilitada', () => {
  assert.throws(
    () => resolveOrder('manifesthub'),
    (err) => {
      assert.equal(err.code, 'fonte_desabilitada');
      assert.match(err.message, /desabilitada/);
      return true;
    },
  );
});

test('fonte habilitada mas sem repositorio responde repositorio_nao_configurado', () => {
  assert.throws(
    () => resolveOrder('github'),
    (err) => {
      assert.equal(err.code, 'repositorio_nao_configurado');
      assert.match(err.message, /GITHUB_REPOSITORY/);
      return true;
    },
  );
});

test('fonte inexistente responde fonte_desconhecida', () => {
  assert.throws(
    () => resolveOrder('lua'),
    (err) => err.code === 'fonte_desconhecida',
  );
});

test('/sources mostra os motivos, na ordem configurada', () => {
  const d = describeSources();
  assert.deepEqual(d.order, []);
  assert.deepEqual(d.configuredOrder, ['github', 'manifesthub']);

  const gh = d.sources.find((s) => s.id === 'github');
  assert.equal(gh.enabled, true, 'operador nao desligou');
  assert.equal(gh.configured, false, 'falta o repositorio');
  assert.equal(gh.repository, null);
  assert.equal(gh.priority, 0);

  const mh = d.sources.find((s) => s.id === 'manifesthub');
  assert.equal(mh.enabled, false, 'desligado pelo MANIFESTHUB_ENABLED');
  assert.equal(mh.configured, true);
  assert.equal(mh.visibility, 'public');

  // Nao promete o que nao faz.
  for (const s of d.sources) {
    assert.ok(s.cannot.includes('gerar chaves'));
    assert.equal(s.listsAllBranches, false);
  }
});

test('getManifests com o servidor vazio propaga nenhuma_fonte', async () => {
  await assert.rejects(getManifests(APPID), (err) => {
    assert.equal(err.code, 'nenhuma_fonte');
    return true;
  });
  // O diretorio de cache nem chega a ser criado: nada foi baixado.
  const dir = path.join(tmp, 'cache');
  const count = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  assert.equal(count, 0, 'nada foi baixado');
});

test('links sem segredo configurado ficam desligados e dizem por que', async () => {
  const { createLink, linksEnabled, linksStatus, LINK_CODES } = await import('../src/links.js');
  assert.equal(linksEnabled(), false, 'PUBLIC_BASE_URL sem segredo nao liga');

  const st = linksStatus();
  assert.equal(st.enabled, false);
  assert.equal(st.publicBaseUrl, 'https://exemplo.test');
  assert.equal(st.secretConfigured, false);

  assert.throws(
    () => createLink({ source: 'github', appid: '730' }),
    (err) => {
      assert.equal(err.code, 'link_sem_segredo');
      assert.equal(err.message, LINK_CODES.link_sem_segredo);
      return true;
    },
  );
});
