import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('committed fixtures are reproducible from their source', () => {
  test('F1.json is exactly what build-f1.mjs produces today', async () => {
    // Guards against two failure modes that are invisible in review: someone
    // hand-editing the fixture, and someone changing the conversion rules without
    // regenerating. Either would silently invalidate the regression baseline.
    await assert.doesNotReject(
      run(process.execPath, ['scripts/build-f1.mjs', '--check'], { cwd: ROOT }),
      /stale|missing/,
      'tests/fixtures/F1.json is out of date — run: npm run build:fixtures',
    );
  });
});
