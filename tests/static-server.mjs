/**
 * Servidor estatico em processo separado.
 *
 * Motivo: os testes usam spawnSync (bloqueia o event loop do processo pai).
 * Se o HTTP server rodasse no proprio teste, o curl do bootstrap nunca seria
 * atendido e o teste travaria. Em processo separado, o servidor responde
 * enquanto o pai espera o filho.
 *
 * Uso: node static-server.mjs <dirDoTarball> <caminhoDoBootstrap.sh>
 * Imprime {"port":N} no stdout quando pronto.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [, , root, bootstrapPath] = process.argv;
if (!root || !bootstrapPath) {
  console.error('uso: node static-server.mjs <dir> <bootstrap.sh>');
  process.exit(2);
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  try {
    if (pathname === '/bootstrap.sh') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(fs.readFileSync(bootstrapPath));
    }
    if (pathname === '/repo.tar.gz') {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      return res.end(fs.readFileSync(path.join(root, 'repo.tar.gz')));
    }
    // Caminho do codeload: /<owner>/<repo>/tar.gz/<ref> (testes do caminho padrao)
    if (/^\/[^/]+\/[^/]+\/tar.gz\/[^/]+$/.test(pathname)) {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      return res.end(fs.readFileSync(path.join(root, 'repo.tar.gz')));
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    res.writeHead(500).end(String(err?.message || err));
  }
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
