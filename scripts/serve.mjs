/**
 * A zero-dependency static file server for local development.
 *
 *   npm start            # http://localhost:8000
 *   npm start -- 9000    # a different port
 *
 * This exists because moving off the `.dc.html` format to native ES modules means
 * the app can no longer be opened straight from disk: browsers block both
 * `<script type="module">` and `fetch()` on `file://` origins. That is a
 * consequence of decision 13, not a new dependency — no bundler and no build step
 * are involved, and the same server will do once the data comes from PostgREST.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2]) || 8000;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${PORT}`);
  const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);

  // Resolve inside ROOT and reject anything that escapes it, so a `..` in the path
  // cannot read arbitrary files off the developer's machine.
  const filePath = join(ROOT, normalize(requested));
  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(`Not found: ${requested}`);
  }
});

server.listen(PORT, () => {
  console.log(`Serving ${ROOT}\n  →  http://localhost:${PORT}`);
});
