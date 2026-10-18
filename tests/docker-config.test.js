import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat, access } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The Docker setup is configuration, and configuration drifts silently: a variable compose
 * reads that .env.example never declares, a password typed into compose.yaml, an init step
 * renamed out of order. These checks read the files as text — no Docker, no YAML parser —
 * so they run in `npm test` on any machine. Whether the stack actually comes up is
 * scripts/docker-smoke.sh's job (docs/DOCKER.md).
 */

const ROOT = new URL('..', import.meta.url).pathname;
const read = (path) => readFile(join(ROOT, path), 'utf8');

/** `${VAR}`, `${VAR:-default}`, `${VAR:?message}` — but not `$${VAR}`, which is escaped
 *  for the container's own shell and never interpolated by compose. */
function interpolatedVariables(text) {
  return new Set([...text.matchAll(/(?<!\$)\$\{([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]));
}

/** The keys an env file assigns, ignoring comments and blank lines. */
function declaredVariables(text) {
  return new Set([...text.matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]));
}

describe('compose.yaml and .env.example', () => {
  test('every variable compose interpolates is declared in .env.example', async () => {
    const used = interpolatedVariables(await read('compose.yaml'));
    const declared = declaredVariables(await read('.env.example'));
    assert.ok(used.size > 0, 'expected compose.yaml to interpolate variables');
    const missing = [...used].filter((name) => !declared.has(name));
    assert.deepEqual(missing, [], `declare these in .env.example: ${missing.join(', ')}`);
  });

  test('.env.example declares nothing compose does not read', async () => {
    const used = interpolatedVariables(await read('compose.yaml'));
    const unused = [...declaredVariables(await read('.env.example'))].filter((n) => !used.has(n));
    assert.deepEqual(unused, [], `stale in .env.example: ${unused.join(', ')}`);
  });

  test('compose.yaml takes every secret from the environment, never a literal', async () => {
    const compose = await read('compose.yaml');
    // A key whose name says secret must have an interpolation as its whole value.
    for (const m of compose.matchAll(/^\s*([A-Z_]*PASSWORD[A-Z_]*):\s*(.+)$/gm)) {
      assert.match(m[2], /^\$\{[A-Z_]+(:\?[^}]*)?\}$/, `${m[1]} must be \${VAR}, got: ${m[2]}`);
    }
    // And no connection string carries one: postgres://user:secret@host.
    assert.doesNotMatch(compose, /postgres(ql)?:\/\/[^@\s/]+:[^@\s]+@/);
  });

  test('the secrets in .env.example are placeholders', async () => {
    const env = await read('.env.example');
    for (const m of env.matchAll(/^([A-Z_]*PASSWORD)=(.*)$/gm)) {
      assert.equal(m[2], 'change-me', `${m[1]} in .env.example must stay a placeholder`);
    }
  });

  test('every published port is bound to 127.0.0.1', async () => {
    const compose = await read('compose.yaml');
    const ports = [...compose.matchAll(/^\s*-\s*"([^"]*:\d+)"\s*$/gm)].map((m) => m[1]);
    assert.ok(ports.length >= 3, `expected the three services' ports, found ${ports.length}`);
    for (const port of ports) assert.match(port, /^127\.0\.0\.1:/, `${port} is reachable off-host`);
  });
});

describe('what stays out of git', () => {
  test('.gitignore covers .env and the dump', async () => {
    const lines = (await read('.gitignore')).split('\n').map((l) => l.trim());
    for (const entry of ['.env', 'dump/']) assert.ok(lines.includes(entry), `${entry} not ignored`);
  });

  test('.dockerignore is an allowlist that never admits .env or the dump', async () => {
    const lines = (await read('.dockerignore')).split('\n').map((l) => l.trim());
    assert.equal(lines.find((l) => l && !l.startsWith('#')), '*', 'must start by excluding everything');
    const admitted = lines.filter((l) => l.startsWith('!'));
    for (const forbidden of ['!.env', '!dump', '!dump/']) assert.ok(!admitted.includes(forbidden));
  });
});

describe('the db init steps', () => {
  const DIR = 'docker/db/initdb';

  test('run in the order roles → restore → secure, and nothing else runs', async () => {
    // The image runs them in name order; that order is load-bearing (each file's header).
    const files = (await readdir(join(ROOT, DIR))).sort();
    assert.deepEqual(files, ['10-roles.sh', '20-restore.sh', '30-secure.sh']);
  });

  test('are executable and stop on the first error', async () => {
    for (const file of await readdir(join(ROOT, DIR))) {
      const path = join(ROOT, DIR, file);
      // Executable, or the image *sources* the file into its own shell instead of running it.
      assert.ok((await stat(path)).mode & 0o111, `${file} is not executable`);
      const text = await readFile(path, 'utf8');
      assert.ok(text.startsWith('#!/usr/bin/env bash\n'), `${file}: missing shebang`);
      assert.match(text, /^set -euo pipefail$/m, `${file}: missing set -euo pipefail`);
    }
  });

  test('the last step writes the marker the db healthcheck requires', async () => {
    const secure = await read(`${DIR}/30-secure.sh`);
    const compose = await read('compose.yaml');
    const marker = secure.match(/touch "\$PGDATA\/([^"]+)"/)?.[1];
    assert.ok(marker, '30-secure.sh must touch a marker in $PGDATA');
    assert.ok(compose.includes(`$\${PGDATA}/${marker}`), `healthcheck does not test for ${marker}`);
  });

  test('the SQL they apply exists where compose mounts it', async () => {
    const secure = await read(`${DIR}/30-secure.sh`);
    assert.ok(secure.includes('/sql/postgrest_setup.sql'));
    assert.match(await read('compose.yaml'), /- \.\/sql:\/sql:ro/);
    await access(join(ROOT, 'sql/postgrest_setup.sql'));
  });
});

describe('the web image', () => {
  test('every path the Dockerfile copies exists and is admitted by .dockerignore', async () => {
    const dockerfile = await read('docker/web/Dockerfile');
    const admitted = (await read('.dockerignore'))
      .split('\n')
      .filter((l) => l.startsWith('!'))
      .map((l) => l.slice(1).replace(/\/$/, ''));
    const sources = [...dockerfile.matchAll(/^COPY\s+(.+)\s+\S+$/gm)]
      .flatMap((m) => m[1].split(/\s+/))
      .map((s) => s.replace(/\/$/, ''));
    assert.ok(sources.length > 0);
    for (const source of sources) {
      await access(join(ROOT, source));
      assert.ok(admitted.includes(source), `${source} is copied but excluded by .dockerignore`);
    }
  });

  test('serves through scripts/serve.mjs, pointed at the api service', async () => {
    const dockerfile = await read('docker/web/Dockerfile');
    assert.match(dockerfile, /^ENV POSTGREST_URL=http:\/\/api:3000$/m);
    assert.match(dockerfile, /^CMD \["node", "scripts\/serve\.mjs", "8000"\]$/m);
    assert.match(dockerfile, /^USER node$/m, 'must not run as root');
    // serve.mjs must still read the variable the image sets.
    assert.ok((await read('scripts/serve.mjs')).includes('process.env.POSTGREST_URL'));
  });
});
