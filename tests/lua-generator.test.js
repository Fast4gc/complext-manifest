import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLua } from '../src/luaGenerator.js';

const key = 'ab'.repeat(32);
function fixture() {
  return { appid: 4001890, depot: {
    4001891: { decryptionkey: key, manifests: { public: { gid: '6932805931423228382' } } },
    branches: { public: { buildid: '1' } },
  } };
}
const generate = (data) => generateLua('4001890', Buffer.from(JSON.stringify(data)));
test('referencias vazias e compartilhadas nao bloqueiam depots completos e ficam documentadas', () => {
  const data = fixture();
  data.depot['228988'] = { depotfromapp: '228980', sharedinstall: '1' };
  data.depot['4001892'] = {};
  const result = generate(data);
  assert.equal(result.depotCount, 1);
  assert.equal(result.skippedDepots.length, 2);
  assert.match(result.buffer.toString(), /Omitted depot 228988: shared \(AppID 228980\)/);
  assert.match(result.buffer.toString(), /Omitted depot 4001892: empty/);
  assert.doesNotMatch(result.buffer.toString(), /addappid\(228988/);
});
test('apenas referencias nao geram um script vazio', () => {
  assert.throws(() => generate({ appid: 4001890, depot: {
    228988: { depotfromapp: '228980' }, 4001892: {},
  } }), (e) => e.code === 'lua_dados_incompletos');
});
test('gera sintaxe do exemplo, preserva Manifest ID de 64 bits e nao emite metadados como codigo', () => {
  const data = fixture();
  data.name = '\nrequire("evil")';
  const result = generate(data);
  assert.equal(result.depotCount, 1);
  assert.match(result.buffer.toString(), /addappid\(4001890\)/);
  assert.ok(result.buffer.toString().includes(`addappid(4001891, 1, "${key}")`));
  assert.match(result.buffer.toString(), /setManifestid\(4001891, "6932805931423228382"\)/);
  assert.doesNotMatch(result.buffer.toString(), /evil|require/);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});
test('dados faltantes nao geram Lua parcial nem expoem keys no erro', () => {
  const data = fixture();
  data.depot['4001892'] = { manifests: { public: { gid: '2' } } };
  assert.throws(() => generate(data), (err) => {
    assert.equal(err.code, 'lua_dados_incompletos');
    assert.equal(err.detail.depots[0].depot, '4001892');
    assert.ok(!JSON.stringify(err).includes(key));
    return true;
  });
});
test('rejeita manifest numerico, uint64 invalido, key invalida e AppID divergente', () => {
  for (const gid of [6932805931423228382, '18446744073709551616', '0', '1"); evil()']) {
    const data = fixture();
    data.depot['4001891'].manifests.public.gid = gid;
    assert.throws(() => generate(data), (e) => e.code.startsWith('lua_dados_'));
  }
  const data = fixture();
  data.depot['4001891'].decryptionkey = 'invalid';
  assert.throws(() => generate(data), (e) => e.code === 'lua_dados_invalidos');
  data.appid = 42;
  assert.throws(() => generate(data), (e) => e.code === 'lua_dados_invalidos');
});
test('exige depots e branch public, sem substituir por beta', () => {
  const data = fixture();
  data.depot['4001891'].manifests = { beta: { gid: '1234' } };
  assert.throws(() => generate(data), (e) => e.code === 'lua_dados_incompletos');
  assert.throws(() => generate({ appid: 4001890, depot: {} }), (e) => e.code === 'lua_dados_incompletos');
  assert.throws(() => generateLua('4001890', Buffer.from('{')), (e) => e.code === 'lua_dados_invalidos');
});
