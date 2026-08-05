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
 * are involved.
 *
 * It also **proxies `/rpc/*` to PostgREST**, so the app and the API share an origin.
 * Without that the browser treats `localhost:8000` and `localhost:3000` as different
 * origins and every RPC call needs CORS — which works only as long as PostgREST is
 * configured to allow it, and fails as a bare "fetch failed" when it is not. Sharing an
 * origin is also what a real deployment does (the PostgREST docs' nginx section), so
 * proxying here keeps development and deployment the same shape rather than papering
 * over a difference. Still zero dependencies: it is one `fetch` forwarded.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2]) || 8000;

/** Where PostgREST is listening. Override with `POSTGREST_URL` if it moves. */
const POSTGREST = process.env.POSTGREST_URL || 'http://localhost:3000';

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

  // ---- the API, same origin -------------------------------------------------------
  if (url.pathname.startsWith('/rpc/')) {
    try {
      const upstream = await fetch(`${POSTGREST}${url.pathname}${url.search}`, {
        method: request.method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request,
        duplex: 'half',
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      response.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store',
      });
      response.end(body);
    } catch (error) {
      // 502 rather than 500: the failure is upstream, and saying so is what tells the
      // reader to go and start PostgREST rather than to debug this server.
      response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(
        JSON.stringify({
          message: `Could not reach PostgREST at ${POSTGREST}`,
          hint: 'Start it with:  postgrest postgrest.conf',
          details: String(error.message),
        }),
      );
    }
    return;
  }

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
  console.log(
    `Serving ${ROOT}\n  →  http://localhost:${PORT}\n` +
      `  /rpc/* proxied to ${POSTGREST}`,
  );
});
