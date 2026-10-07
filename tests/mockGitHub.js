import http from 'node:http';
import crypto from 'node:crypto';

/**
 * GitHub API simulado para testes.
 * Implementa: /repos/:o/:r/branches/:b, /git/trees/:sha, /contents/:path
 *
 * Recursos de teste:
 *   - setBranch(name, sha)      troca o commit (simula push/change)
 *   - setFiles(files)           troca os arquivos da branch
 *   - setMode('ok'|'down'|'rate_limit'|'slow')
 *   - calls                     contagem de chamadas (para provar cache)
 */
export async function startMockGitHub({ branch = '123456', commit = 'a'.repeat(40) } = {}) {
  const state = {
    branch,
    commit,
    files: new Map(), // path -> Buffer
    mode: 'ok',
    calls: { branches: 0, trees: 0, contents: 0 },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body, headers = {}) => {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(payload);
    };

    if (state.mode === 'slow') {
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (state.mode === 'down') {
      res.destroy();
      return;
    }
    if (state.mode === 'rate_limit') {
      send(
        429,
        { message: 'rate limited' },
        {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
        },
      );
      return;
    }

    // /repos/:owner/:repo/branches/:branch
    let m = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/branches\/(.+)$/);
    if (m) {
      state.calls.branches += 1;
      const name = decodeURIComponent(m[1]);
      if (name !== state.branch) return send(404, { message: 'Branch not found' });
      return send(200, { name, commit: { sha: state.commit } });
    }

    // /repos/:owner/:repo/git/trees/:sha
    m = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/git\/trees\/([^/]+)$/);
    if (m) {
      state.calls.trees += 1;
      if (m[1] !== state.commit) return send(404, { message: 'Tree not found' });
      const tree = [...state.files.entries()].map(([path, buf]) => ({
        path,
        type: 'blob',
        size: buf.length,
        sha: gitSha1(buf),
      }));
      return send(200, { sha: state.commit, tree, truncated: false });
    }

    // /repos/:owner/:repo/contents/:path
    m = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
    if (m) {
      state.calls.contents += 1;
      const path = decodeURIComponent(m[1]);
      const buf = state.files.get(path);
      if (!buf) return send(404, { message: 'Not Found' });
      const ref = url.searchParams.get('ref');
      if (ref && ref !== state.commit) return send(404, { message: 'Not Found' });
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(buf);
    }

    // /rate_limit (usado pelo health deep)
    if (url.pathname === '/rate_limit') {
      return send(200, { resources: { core: { remaining: 5000 } } });
    }

    send(404, { message: 'Not Found' });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    calls: state.calls,
    setBranch: (name, sha) => {
      state.branch = name;
      if (sha) state.commit = sha;
    },
    setCommit: (sha) => {
      state.commit = sha;
    },
    setFiles: (files) => {
      state.files.clear();
      for (const [path, content] of Object.entries(files)) {
        state.files.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content));
      }
    },
    setMode: (mode) => {
      state.mode = mode;
    },
    resetCalls: () => {
      state.calls.branches = 0;
      state.calls.trees = 0;
      state.calls.contents = 0;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

/** SHA1 de blob git (mesmo calculo usado pela API real). */
export function gitSha1(buf) {
  return crypto
    .createHash('sha1')
    .update(Buffer.from(`blob ${buf.length}\0`))
    .update(buf)
    .digest('hex');
}
