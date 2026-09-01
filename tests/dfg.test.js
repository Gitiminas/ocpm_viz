import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  findDfgProblems,
  assertValidDfg,
  normalizeDfg,
  DFG_CONTRACT_VERSION,
} from '../src/model/dfg.js';

/*
 * The hand-built bundle is the primary fixture, the way the fold suites build synthetic
 * graphs: two issues (open → comments → close), one merged pull request, one commit
 * observed twice, and one cross edge. Its counts satisfy the conservation the validator
 * demands — every object one start and one end, successions = events − starts per type —
 * so any assertion failure below is about the validator, never about the arithmetic.
 */
function validDfg() {
  return {
    meta: {
      repo: 'r',
      repo_id: 1,
      repo_ambiguous: false,
      dfg_contract_version: DFG_CONTRACT_VERSION,
      generated_at: '2026-09-01T00:00:00+00:00',
    },
    nodes: [
      { object_type: 'issue', activity: 'IssueOpened', events: 2, objects: 2, starts: 2, ends: 0 },
      { object_type: 'issue', activity: 'IssueCommented', events: 3, objects: 2, starts: 0, ends: 0 },
      { object_type: 'issue', activity: 'IssueClosed', events: 2, objects: 2, starts: 0, ends: 2 },
      { object_type: 'pull_request', activity: 'PullRequestOpened', events: 1, objects: 1, starts: 1, ends: 0 },
      { object_type: 'pull_request', activity: 'PullRequestMerged', events: 1, objects: 1, starts: 0, ends: 1 },
      { object_type: 'commit', activity: 'CommitObserved', events: 2, objects: 1, starts: 1, ends: 1 },
    ],
    edges: [
      { object_type: 'issue', from_activity: 'IssueOpened', to_activity: 'IssueCommented', successions: 2, objects: 2 },
      { object_type: 'issue', from_activity: 'IssueCommented', to_activity: 'IssueCommented', successions: 1, objects: 1 },
      { object_type: 'issue', from_activity: 'IssueCommented', to_activity: 'IssueClosed', successions: 2, objects: 2 },
      { object_type: 'pull_request', from_activity: 'PullRequestOpened', to_activity: 'PullRequestMerged', successions: 1, objects: 1 },
      { object_type: 'commit', from_activity: 'CommitObserved', to_activity: 'CommitObserved', successions: 1, objects: 1 },
    ],
    cross_edges: [
      { from_type: 'pull_request', from_activity: 'PullRequestMerged', to_type: 'issue', to_activity: 'IssueClosed', successions: 1, pairs: 1 },
    ],
  };
}

describe('the DFG validator accepts an honest bundle and names every fault', () => {
  test('the hand-built bundle is clean', () => {
    assert.deepEqual(findDfgProblems(validDfg()), []);
  });

  test('a missing top-level key is fatal on its own', () => {
    const dfg = validDfg();
    delete dfg.cross_edges;
    assert.match(findDfgProblems(dfg).join('\n'), /missing "cross_edges"/);
  });

  test('a foreign contract version is refused, not rendered subtly wrong', () => {
    const dfg = validDfg();
    dfg.meta.dfg_contract_version = 2;
    assert.match(findDfgProblems(dfg).join('\n'), /dfg_contract_version is 2/);
  });

  test('an unknown activity is named', () => {
    const dfg = validDfg();
    dfg.nodes[0].activity = 'IssueLabelled';
    assert.match(findDfgProblems(dfg).join('\n'), /unknown activity "IssueLabelled"/);
  });

  test('an activity on a type it never occurs on is named', () => {
    const dfg = validDfg();
    dfg.nodes[0].activity = 'PullRequestMerged';
    assert.match(findDfgProblems(dfg).join('\n'), /"PullRequestMerged" on "issue"/);
  });

  test('a negative or fractional count is named', () => {
    const dfg = validDfg();
    dfg.edges[0].successions = -1;
    dfg.nodes[0].events = 2.5;
    const text = findDfgProblems(dfg).join('\n');
    assert.match(text, /bad successions count/);
    assert.match(text, /bad events count/);
  });

  test('a same-type cross edge is refused', () => {
    const dfg = validDfg();
    dfg.cross_edges[0].to_type = 'pull_request';
    dfg.cross_edges[0].to_activity = 'PullRequestOpened';
    assert.match(findDfgProblems(dfg).join('\n'), /joins two objects of the same type/);
  });

  test('an evidence field on any edge is refused by name', () => {
    const dfg = validDfg();
    dfg.edges[0].evidence = 'validated';
    assert.match(findDfgProblems(dfg).join('\n'), /not a traceability link/);
  });

  test('broken conservation is a counting fault, and says which type', () => {
    const dfg = validDfg();
    dfg.edges[0].successions = 5;
    assert.match(findDfgProblems(dfg).join('\n'), /issue: 8 successions but 7 events/);
  });

  test('assertValidDfg throws with every problem listed', () => {
    const dfg = validDfg();
    dfg.nodes[0].activity = 'IssueLabelled';
    dfg.edges[0].evidence = 'validated';
    assert.throws(() => assertValidDfg(dfg), /Malformed DFG \(\d+ problems\)/);
  });
});

describe('normalizeDfg parses the one timestamp and nothing else', () => {
  test('generated_at becomes a Date, the input is untouched', () => {
    const raw = validDfg();
    const dfg = normalizeDfg(raw);
    assert.ok(dfg.meta.generated_at instanceof Date);
    assert.equal(dfg.meta.generated_at.toISOString(), '2026-09-01T00:00:00.000Z');
    assert.equal(typeof raw.meta.generated_at, 'string', 'the shared input is never mutated');
    assert.equal(dfg.nodes, raw.nodes, 'counts need no parsing, so the arrays pass through');
  });
});

describe('the pulled sample is a shape, never a count', () => {
  // DFG1 is a live sample (scripts/pull-dfg.mjs): the validator must accept it, and no
  // test may assert a number against it — the same rule the LIVE sub-logs live under.
  test('DFG1 passes the validator', async () => {
    const raw = JSON.parse(
      await readFile(new URL('./fixtures/DFG1.json', import.meta.url), 'utf8'),
    );
    assert.deepEqual(findDfgProblems(raw), []);
  });
});
