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

import { resolveSeed, searchSeeds } from '../src/data/fixtures.js';
import {
  parseSeedRef,
  matchesSeedRef,
  scoreSeedRef,
  describeSeedRef,
} from '../src/data/seedQuery.js';
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

  test('a seed carries only what a search could cheaply return', async () => {
    const cat = await catalogue();
    for (const repo of cat.repos.filter((entry) => entry.available)) {
      for (const seed of repo.seeds) {
        assert.ok(seed.type, `${seed.id} must state its object type`);
        assert.ok(seed.label, `${seed.id} must have a label`);
        // Deliberately absent: what the seed *yields*. Computing that means running
        // the traversal, and no system can do that for every candidate in a
        // repository holding hundreds of thousands of objects. A catalogue that
        // summarised its results would be a design that quietly cannot scale.
        assert.equal('yields' in seed, false, `${seed.id} must not precompute a traversal`);
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


describe('the seed box is a search, because there is no list to enumerate', () => {
  const ref = (text) => parseSeedRef(text);

  test('a bare number is read as a number', () => {
    assert.equal(ref('242864').number, 242864);
    assert.equal(ref('#242864').number, 242864);
    assert.equal(ref('242864').type, null, 'an unstated type stays unstated');
  });

  test('a stated type constrains the search', () => {
    assert.equal(ref('issue 242864').type, 'issue');
    assert.equal(ref('PR #243221').type, 'pull_request');
    assert.equal(ref('pull request 12').type, 'pull_request');
    assert.equal(ref('commit dcc7479').type, 'commit');
  });

  test('a bare hex string is read as a SHA prefix', () => {
    assert.equal(ref('dcc7479').shaPrefix, 'dcc7479');
    assert.equal(ref('dcc7479').number, null);
  });

  test('a digit string is both a plausible number and a plausible SHA', () => {
    // Refusing to guess between them is better than picking one.
    const parsed = ref('123456');
    assert.equal(parsed.number, 123456);
    assert.equal(parsed.shaPrefix, '123456');
  });

  test('empty input names nothing', () => {
    assert.equal(ref(''), null);
    assert.equal(ref('   '), null);
  });

  test('a partial number finds the object, as a typeahead should', async () => {
    const cat = await catalogue();
    // Nothing auto-loads: results appear in a list and the user picks one, so a
    // surplus candidate costs a glance while a missing one costs the search.
    assert.equal(searchSeeds(cat, 'microsoft/vscode', '242')[0].id, 'issue:242864');
    assert.equal(searchSeeds(cat, 'microsoft/vscode', '2428')[0].id, 'issue:242864');
    assert.equal(searchSeeds(cat, 'microsoft/vscode', '2864')[0].id, 'issue:242864');
    assert.equal(searchSeeds(cat, 'microsoft/vscode', '242864')[0].id, 'issue:242864');
  });

  test('a number that appears nowhere still finds nothing', async () => {
    const cat = await catalogue();
    assert.equal(searchSeeds(cat, 'microsoft/vscode', '999999').length, 0);
  });

  test('an exact match outranks a prefix, which outranks a substring', () => {
    const seeds = [
      { id: 'issue:1242864', type: 'issue', label: '#1242864' },
      { id: 'issue:242864', type: 'issue', label: '#242864' },
      { id: 'issue:2428640', type: 'issue', label: '#2428640' },
    ];
    const ref = parseSeedRef('242864');
    const ranked = seeds
      .map((seed) => ({ seed, score: scoreSeedRef(ref, seed) }))
      .sort((a, b) => b.score - a.score);
    assert.equal(ranked[0].seed.id, 'issue:242864', 'the exact match must come first');
    assert.equal(ranked[1].seed.id, 'issue:2428640', 'then the prefix match');
    assert.equal(ranked[2].seed.id, 'issue:1242864', 'then the substring match');
  });

  test('a SHA is still matched from the front, as git abbreviates them', () => {
    const seed = { id: 'commit:aaaa111bbbb222ccc', type: 'commit', label: 'aaaa111' };
    assert.ok(scoreSeedRef(parseSeedRef('aaaa'), seed) >= 0);
    // A mid-SHA hit is noise rather than intent.
    assert.equal(scoreSeedRef(parseSeedRef('bbbb'), seed), -1);
  });

  test('searching finds a seed by number, by type, and by title', async () => {
    const cat = await catalogue();
    assert.equal(searchSeeds(cat, 'microsoft/vscode', '#242864')[0].id, 'issue:242864');
    assert.equal(searchSeeds(cat, 'microsoft/vscode', 'issue 242864')[0].id, 'issue:242864');
    // The title is cheap for a search to return, so it is searchable.
    assert.equal(searchSeeds(cat, 'microsoft/vscode', 'MCP')[0].id, 'issue:242864');
  });

  test('a stated type excludes objects of other types', async () => {
    const cat = await catalogue();
    assert.equal(searchSeeds(cat, 'microsoft/vscode', 'commit 242864').length, 0);
  });

  test('a commit is findable by SHA prefix', async () => {
    const cat = await catalogue();
    const hits = searchSeeds(cat, 'synthetic/fixture', 'aaaa111');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].type, 'commit');
  });

  test('an empty search offers what is servable rather than nothing', async () => {
    const cat = await catalogue();
    assert.ok(searchSeeds(cat, 'synthetic/fixture', '').length > 1);
  });

  test('results are capped, because a real search returns top matches', async () => {
    const cat = await catalogue();
    assert.ok(searchSeeds(cat, 'synthetic/fixture', '', { limit: 2 }).length <= 2);
  });

  test('an unavailable repository yields no results at all', async () => {
    const cat = await catalogue();
    assert.deepEqual(searchSeeds(cat, 'kubernetes/kubernetes', '123'), []);
  });

  test('a failed search can say what was looked for', () => {
    assert.equal(describeSeedRef(ref('issue 12')), 'issue #12');
    assert.equal(describeSeedRef(ref('dcc7479')), 'commit dcc7479');
    assert.match(describeSeedRef(ref('mcp')), /matching "mcp"/);
  });
});

describe('a type word on its own narrows rather than matching everything', () => {
  test('"pr" returns only pull requests', async () => {
    const cat = await catalogue();
    const hits = searchSeeds(cat, 'synthetic/fixture', 'pr');
    assert.ok(hits.length > 0);
    assert.equal(hits.every((seed) => seed.type === 'pull_request'), true);
  });

  test('"commit" returns only commits', async () => {
    const cat = await catalogue();
    const hits = searchSeeds(cat, 'synthetic/fixture', 'commit');
    assert.ok(hits.length > 0);
    assert.equal(hits.every((seed) => seed.type === 'commit'), true);
  });

  test('a bare type word parses to a type filter, not to nothing', () => {
    assert.equal(parseSeedRef('pr').type, 'pull_request');
    assert.equal(parseSeedRef('issue').type, 'issue');
    assert.equal(describeSeedRef(parseSeedRef('pr')), 'any pull request');
  });
});
