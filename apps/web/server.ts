/**
 * Static server for the secretary interface.
 *
 * Node's own http module and nothing else. No bundler, no dev server, no
 * install step — the same reason the engine has no dependencies. A rodeo
 * secretary's laptop in an arena office is not a place to be resolving a
 * package tree, and a build step is a thing that can be broken on the one
 * night of the year it matters.
 *
 * In production this directory is served by any static host and this file is
 * not used. It exists so `node server.ts` works from a clean checkout.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, 'public');
const PORT = Number(process.env.PORT ?? 5173);
const API = process.env.API_ORIGIN ?? 'http://localhost:3000';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  // The client needs to know where the API is without a build step baking it
  // in. One endpoint, read once at start-up.
  if (url.pathname === '/config.json') {
    res.writeHead(200, { 'content-type': TYPES['.json'] });
    res.end(JSON.stringify({ api_origin: API }));
    return;
  }

  // Everything that is not a file is the app: this is a single page and the
  // routes are hash-based, but a hard refresh on a deep link must still work.
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, safe);

  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    const body = await readFile(join(ROOT, 'index.html'));
    res.writeHead(200, { 'content-type': TYPES['.html'] });
    res.end(body);
  }
});

server.listen(PORT, () => {
  console.log(`Secretary interface on http://localhost:${PORT}  (API: ${API})`);
});
