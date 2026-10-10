import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-downloads-'));
process.env.ENV_FILE = '/nonexistent/download-tests.env';
process.env.DATA_DIR = path.join(root, 'persistent-data');
const { luaDownloadPath } = await import('../src/downloadFiles.js');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('Lua fica no diretorio persistente de dados e nao no cwd do aplicativo', () => {
  const destination = luaDownloadPath('730.lua');
  assert.equal(destination, path.join(root, 'persistent-data', 'downloads', '730.lua'));
  fs.writeFileSync(destination, 'addappid(730)\n');
  assert.equal(fs.readFileSync(destination, 'utf8'), 'addappid(730)\n');
  assert.equal(luaDownloadPath('730.lua'), destination);
});
test('recusa ZIP, traversal e nomes de caminho antes de criar diretorio', () => {
  const destination = path.join(root, 'invalid');
  for (const name of ['730.zip', '../730.lua', '/app/730.lua', '730.lua/other']) {
    assert.throws(() => luaDownloadPath(name, destination), /invalido/);
  }
  assert.equal(fs.existsSync(destination), false);
});
