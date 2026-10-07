import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidAppId,
  normalizeAppId,
  isSafeRepoPath,
  branchNameFor,
  safeBaseName,
  KEY_FORMAT,
} from '../src/validate.js';

test('AppID: aceita apenas 1-12 digitos', () => {
  assert.equal(isValidAppId('730'), true);
  assert.equal(isValidAppId('123456789012'), true);
  assert.equal(isValidAppId(''), false);
  assert.equal(isValidAppId('12a'), false);
  assert.equal(isValidAppId('-5'), false);
  assert.equal(isValidAppId('1234567890123'), false);
  assert.equal(isValidAppId(' 730 '), true, 'normaliza espacos');
  assert.equal(isValidAppId(null), false);
  assert.equal(normalizeAppId(undefined), null);
  assert.equal(normalizeAppId(' 730 '), '730');
});

test('caminhos: bloqueia traversal e caminho absoluto', () => {
  assert.equal(isSafeRepoPath('depots/730/abc.manifest'), true);
  assert.equal(isSafeRepoPath('../etc/passwd'), false);
  assert.equal(isSafeRepoPath('a/../../b'), false);
  assert.equal(isSafeRepoPath('/abs/path'), false);
  assert.equal(isSafeRepoPath('a\\b'), false);
  assert.equal(isSafeRepoPath(''), false);
  assert.equal(isSafeRepoPath('a/\0b'), false);
  assert.equal(isSafeRepoPath('x/'.repeat(300) + 'y'), false, 'profundidade demais');
  assert.equal(isSafeRepoPath('a/b/./c'), false);
});

test('branch: template com AppID e charset restrito', () => {
  assert.equal(branchNameFor('730', '{appid}'), '730');
  assert.equal(branchNameFor('730', 'app-{appid}'), 'app-730');
  assert.equal(branchNameFor('730', 'invalid branch!'), null);
  assert.equal(branchNameFor('730', '../{appid}'), null);
  assert.equal(branchNameFor('abc', '{appid}'), null);
});

test('nome de arquivo seguro para o ZIP', () => {
  assert.equal(safeBaseName('pasta/730.manifest'), '730.manifest');
  assert.equal(safeBaseName('a/../b/x y.manifest'), 'x_y.manifest');
  assert.equal(safeBaseName('../../etc/passwd'), 'passwd');
  assert.equal(safeBaseName('.../..'), 'arquivo');
});

test('formato da chave de API', () => {
  assert.equal(KEY_FORMAT.test('mk_' + 'a'.repeat(32)), true);
  assert.equal(KEY_FORMAT.test('mk_' + 'A1b'.repeat(20)), false, 'tamanho errado');
  assert.equal(KEY_FORMAT.test('mk_' + '-'.repeat(32)), false, 'charset errado');
  assert.equal(KEY_FORMAT.test('sk_' + 'a'.repeat(32)), false, 'prefixo errado');
});
