import test from 'node:test';
import assert from 'node:assert/strict';
import { apiDestination, checkBotApi } from '../src/bot/diagnostics.js';

test('destino remove credenciais, query e fragmento', () => {
  assert.equal(apiDestination('https://user:secret@example.test/api?key=secret#secret'), 'https://example.test/api');
  assert.equal(apiDestination('secret'), '(URL invalida)');
});
test('diagnostico testa a chave no destino e nao imprime segredo', async () => {
  const result = await checkBotApi({
    baseUrl: 'http://api:3000', key: 'secret',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://api:3000/sources');
      assert.equal(options.headers['X-API-Key'], 'secret');
      return new Response(JSON.stringify({ error: 'chave_nao_encontrada' }), {
        status: 401, headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.deepEqual(result, { destination: 'http://api:3000/', ok: false, code: 'chave_nao_encontrada' });
  assert.ok(!JSON.stringify(result).includes('secret'));
});
test('diagnostico diferencia sucesso de falha de rede', async () => {
  const options = { baseUrl: 'http://api:3000', key: 'secret' };
  const ok = await checkBotApi({ ...options, fetchImpl: async () => new Response('{}', {
    headers: { 'content-type': 'application/json' },
  }) });
  assert.equal(ok.ok, true);
  const bad = await checkBotApi({ ...options, fetchImpl: async () => { throw new Error('secret'); } });
  assert.equal(bad.code, 'api_indisponivel');
  assert.ok(!JSON.stringify(bad).includes('secret'));
});
