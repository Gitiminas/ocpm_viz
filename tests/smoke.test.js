// Smoke test for the test harness itself.
//
// Asserts only that `node --test` runs, that native ES modules load without a
// build step, and that top-level await works — the three things every later
// test depends on. Replace nothing here; add real tests alongside it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('the test runner executes and node: builtins import as ES modules', () => {
  assert.equal(typeof test, 'function');
});

test('top-level ESM async I/O works, so fixtures can be loaded from disk', async () => {
  const pkg = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(pkg.type, 'module', 'package.json must keep "type": "module"');
});
