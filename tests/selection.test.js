/**
 * The selection model: a repository, and a seed object to traverse out from.
 *
 * This is the `get_object_graph` contract expressed in the UI. The tests below
 * check the two things that matter: that a query resolves to the sub-log it should,
 * and that a query which *cannot* be honoured fails loudly instead of quietly
 * returning something else.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { resolveSeed } from '../src/data/fixtures.js';
import { loadObjectGraph, describeSubLog, seedObjects } from '../src/data/loadObjectGraph.js';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const readFixture = async (name) =>
  JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const catalogue = () => readFixture('catalogue');

/** The transport a test uses: resolve the query, then read the resolved file. */
const transport = async (query) => {
  const { fixture } = resolveSeed(await catalogue(), query);
  return readFixture(fixture);
};

describe('the catalogue describes what can be asked for', () => {
  test('it is reproducible from the built fixtures', async () => {
    await assert.doesNotReject(
      run(process.execPath, ['scripts/build-catalogue.mjs', '--check'], { cwd: ROOT }),
      /stale|missing/,
    );
  });

  test('every listed seed names a fixture that exists and really has that seed', async () => {
    const cat = await catalogue();
    for (const repo of cat.repos.filter((entry) => entry.available)) {
      for (const seed of repo.seeds) {
        const graph = await readFixture(seed.fixture);
        assert.equal(graph.meta.repo, repo.name, `${seed.fixture} is not in ${repo.name}`);
        assert.ok(
          graph.meta.seed.some((entry) => entry.id === seed.id),
          `${seed.fixture} does not declare ${seed.id} as a seed`,
        );
        assert.ok(
          graph.objects.some((object) => object.id === seed.id),
          `${seed.fixture} has no object ${seed.id}`,
        );
      }
    }
  });

  test('repositories in scope but without data are listed, not omitted', async () => {
    const cat = await catalogue();
    const unavailable = cat.repos.filter((repo) => !repo.available).map((repo) => repo.name);
    // Their absence is itself the RQ2 finding; a picker that never mentioned them
    // would hide the limitation.
    assert.ok(unavailable.includes('facebook/react'));
    assert.ok(unavailable.includes('kubernetes/kubernetes'));
    for (const repo of cat.repos.filter((entry) => !entry.available)) {
      assert.ok(repo.reason, `${repo.name} must say why it is unavailable`);
      assert.deepEqual(repo.seeds, []);
    }
  });

  test('synthetic repositories are flagged so nothing is mistaken for real data', async () => {
    const cat = await catalogue();
    const vscode = cat.repos.find((repo) => repo.name === 'microsoft/vscode');
    const synthetic = cat.repos.find((repo) => repo.name === 'synthetic/fixture');
    assert.equal(vscode.synthetic, false);
    assert.equal(synthetic.synthetic, true);
  });

  test('every seed says what it yields, so the choice is informed', async () => {
    const cat = await catalogue();
    for (const repo of cat.repos.filter((entry) => entry.available)) {
      for (const seed of repo.seeds) {
        assert.match(seed.yields, /\d+ \w/, `${seed.id} must summarise its sub-log`);
        assert.ok(seed.type, `${seed.id} must state its object type`);
      }
    }
  });
});

describe('a query resolves to the sub-log it names', () => {
  test('repo plus seed loads that seed’s sub-log', async () => {
    const graph = await loadObjectGraph(
      { repo: 'microsoft/vscode', seed: 'issue:242864' },
      { transport },
    );
    assert.equal(graph.meta.repo, 'microsoft/vscode');
    assert.equal(seedObjects(graph)[0].id, 'issue:242864');
  });

  test('a seed can be an object of any type, not only an issue', async () => {
    // "commit #123 — a single object" from the intended interaction.
    const graph = await loadObjectGraph(
      { repo: 'synthetic/fixture', seed: 'commit:aaaa111bbbb222ccc' },
      { transport },
    );
    const seed = seedObjects(graph)[0];
    assert.equal(seed.type, 'commit');
    // Seeding from a commit still reaches the PRs it belongs to.
    assert.equal(graph.objects.filter((object) => object.type === 'pull_request').length, 2);
  });

  test('two seeds in one repository give two different sub-logs', async () => {
    const first = await loadObjectGraph(
      { repo: 'synthetic/fixture', seed: 'issue:1' },
      { transport },
    );
    const second = await loadObjectGraph(
      { repo: 'synthetic/fixture', seed: 'issue:100' },
      { transport },
    );
    assert.notEqual(first.objects.length, second.objects.length);
  });

  test('omitting the seed falls back to the repository’s first servable one', async () => {
    const graph = await loadObjectGraph({ repo: 'microsoft/vscode' }, { transport });
    assert.equal(seedObjects(graph)[0].id, 'issue:242864');
  });

  test('the breadcrumb states the query: repo, seed, degree, and what came back', async () => {
    const graph = await loadObjectGraph(
      { repo: 'microsoft/vscode', seed: 'issue:242864' },
      { transport },
    );
    const description = describeSubLog(graph);
    assert.match(description, /microsoft\/vscode/);
    assert.match(description, /from issue #242864/);
    assert.match(description, /degree 2/);
    assert.match(description, /32 commits/);
  });
});

describe('a query that cannot be honoured fails loudly', () => {
  test('an unknown repository is rejected, and the error lists what exists', async () => {
    const cat = await catalogue();
    assert.throws(
      () => resolveSeed(cat, { repo: 'nope/nope' }),
      /No sub-log available for repository "nope\/nope".*microsoft\/vscode/s,
    );
  });

  test('a seed with no pre-built sub-log is rejected, and says why', async () => {
    const cat = await catalogue();
    // The honest failure: without the RPC there is no traversal, so an arbitrary
    // object cannot be seeded from. Returning some other sub-log would be worse.
    assert.throws(
      () => resolveSeed(cat, { repo: 'microsoft/vscode', seed: 'commit:deadbeef' }),
      /No sub-log has been built from seed .*get_object_graph RPC/s,
    );
  });

  test('a repository listed as unavailable cannot be selected', async () => {
    const cat = await catalogue();
    assert.throws(() => resolveSeed(cat, { repo: 'kubernetes/kubernetes' }), /No sub-log available/);
  });

  test('a direct fixture address still works, for tests and existing links', async () => {
    const cat = await catalogue();
    assert.deepEqual(resolveSeed(cat, { fixture: 'F7' }), { fixture: 'F7' });
  });
});
