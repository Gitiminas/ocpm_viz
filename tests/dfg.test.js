import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  findDfgProblems,
  assertValidDfg,
  normalizeDfg,
  deriveDfgToggles,
  filterDfg,
  aggregateCrossEdges,
  dfgRangeScale,
  DFG_CONTRACT_VERSION,
} from '../src/model/dfg.js';

/*
 * The hand-built bundle is the primary fixture, the way the fold suites build synthetic
 * graphs: two issues (open → comments → close), one merged pull request, one commit
 * pushed twice, and one cross edge. Its counts satisfy the conservation the validator
 * demands — every object one start and one end, successions = occurrences − starts per
 * type — so any assertion failure below is about the validator, never about the
 * arithmetic. Occurrences equal events everywhere here; only a push of several commits
 * separates them, and the push tests below build that shape on purpose.
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
      { object_type: 'issue', activity: 'IssueOpened', events: 2, occurrences: 2, objects: 2, starts: 2, ends: 0 },
      { object_type: 'issue', activity: 'IssueCommented', events: 3, occurrences: 3, objects: 2, starts: 0, ends: 0 },
      { object_type: 'issue', activity: 'IssueClosed', events: 2, occurrences: 2, objects: 2, starts: 0, ends: 2 },
      { object_type: 'pull_request', activity: 'PullRequestOpened', events: 1, occurrences: 1, objects: 1, starts: 1, ends: 0 },
      { object_type: 'pull_request', activity: 'PullRequestMerged', events: 1, occurrences: 1, objects: 1, starts: 0, ends: 1 },
      { object_type: 'commit', activity: 'Push', events: 2, occurrences: 2, objects: 1, starts: 1, ends: 1 },
    ],
    edges: [
      { object_type: 'issue', from_activity: 'IssueOpened', to_activity: 'IssueCommented', successions: 2, objects: 2 },
      { object_type: 'issue', from_activity: 'IssueCommented', to_activity: 'IssueCommented', successions: 1, objects: 1 },
      { object_type: 'issue', from_activity: 'IssueCommented', to_activity: 'IssueClosed', successions: 2, objects: 2 },
      { object_type: 'pull_request', from_activity: 'PullRequestOpened', to_activity: 'PullRequestMerged', successions: 1, objects: 1 },
      { object_type: 'commit', from_activity: 'Push', to_activity: 'Push', successions: 1, objects: 1 },
    ],
    cross_edges: [
      { from_type: 'pull_request', from_activity: 'PullRequestMerged', to_type: 'issue', to_activity: 'IssueClosed', successions: 1, pairs: 1, link_qualifier: 'resolves', link_evidence: 'validated', link_method: 'pr_body' },
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
    dfg.meta.dfg_contract_version = 9;
    assert.match(findDfgProblems(dfg).join('\n'), /dfg_contract_version is 9/);
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

  test('the prefix rule holds in both directions', () => {
    // A cross succession CARRIES its link's class, link_-prefixed; the bare names would
    // claim the succession itself is classified, and a per-type edge rides no link.
    const bare = validDfg();
    bare.cross_edges[0].qualifier = 'resolves';
    assert.match(findDfgProblems(bare).join('\n'), /the link's class is link_qualifier/);

    const perType = validDfg();
    perType.edges[0].link_evidence = 'validated';
    assert.match(findDfgProblems(perType).join('\n'), /a per-type succession rides no link/);
  });

  test('a cross edge without its link class, or with a foreign one, is refused', () => {
    const missing = validDfg();
    delete missing.cross_edges[0].link_qualifier;
    assert.match(findDfgProblems(missing).join('\n'), /has no link_qualifier/);

    const retired = validDfg();
    retired.cross_edges[0].link_evidence = 'inferred';
    assert.match(
      findDfgProblems(retired).join('\n'),
      /link_evidence "inferred"; the only classes are validated and extracted/,
    );

    const unknown = validDfg();
    unknown.cross_edges[0].link_method = 'crystal_ball';
    assert.match(findDfgProblems(unknown).join('\n'), /unknown link_method "crystal_ball"/);
  });

  test('a node without occurrences is refused by name', () => {
    const dfg = validDfg();
    delete dfg.nodes[5].occurrences;
    assert.match(findDfgProblems(dfg).join('\n'), /commit\/Push has a bad occurrences count/);
  });

  test('more events than occurrences is impossible, and is said so', () => {
    const dfg = validDfg();
    dfg.nodes[5].events = 3;
    assert.match(
      findDfgProblems(dfg).join('\n'),
      /commit\/Push has 3 events but 2 occurrences; every event relates to at least one object/,
    );
  });

  test('a push of several commits is one event with several occurrences, conserved per occurrence', () => {
    // One push carrying two commits: two sequences of length one, no succession.
    const dfg = validDfg();
    dfg.nodes[5] = { object_type: 'commit', activity: 'Push', events: 1, occurrences: 2, objects: 2, starts: 2, ends: 2 };
    dfg.edges = dfg.edges.filter((e) => e.object_type !== 'commit');
    assert.deepEqual(findDfgProblems(dfg), []);
  });

  test('broken conservation is a counting fault, and says which type', () => {
    const dfg = validDfg();
    dfg.edges[0].successions = 5;
    assert.match(findDfgProblems(dfg).join('\n'), /issue: 8 successions but 7 occurrences/);
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

describe('the toggle vocabulary is derived from the artifact, never a fixed list', () => {
  test('lanes in lane order with edge counts, pairs sorted, activities in reading order', () => {
    const toggles = deriveDfgToggles(validDfg());
    assert.deepEqual(
      toggles.lanes,
      [
        { type: 'issue', edges: 3 },
        { type: 'pull_request', edges: 1 },
        { type: 'commit', edges: 1 },
      ],
    );
    assert.deepEqual(toggles.pairs, [
      { key: 'issue_pull_request', types: ['issue', 'pull_request'], successions: 1 },
    ]);
    assert.deepEqual(
      toggles.activities.filter((a) => a.type === 'issue').map((a) => a.activity),
      ['IssueOpened', 'IssueCommented', 'IssueClosed'],
      'the lifecycle reading order, not the declaration order',
    );
    assert.equal(toggles.activities.find((a) => a.activity === 'IssueCommented').events, 3);
    assert.equal(toggles.maxSuccessions, 2);
  });

  test('the default range hides the bottom decile, and nothing on a tiny bundle', () => {
    // Six edges cannot carry a decile, so p10 is the smallest count and nothing hides.
    assert.deepEqual(deriveDfgToggles(validDfg()).defaultRange, [1, 2]);
    const wide = validDfg();
    wide.cross_edges = Array.from({ length: 20 }, (_, i) => ({
      from_type: 'pull_request', from_activity: 'PullRequestMerged',
      to_type: 'issue', to_activity: 'IssueClosed', successions: i + 1, pairs: 1,
    }));
    const counts = [...wide.edges, ...wide.cross_edges].map((e) => e.successions).sort((a, b) => a - b);
    assert.equal(deriveDfgToggles(wide).defaultRange[0], counts[Math.floor(0.1 * counts.length)]);
  });
});

describe('filterDfg runs the page view before layout, and counts what it hides', () => {
  test('an all-on view is the identity, with the arithmetic at zero', () => {
    const dfg = validDfg();
    const out = filterDfg(dfg, {});
    assert.deepEqual(out.dfg.edges, dfg.edges);
    assert.deepEqual(out.dfg.nodes, dfg.nodes);
    assert.equal(out.shown, out.total);
    assert.equal(out.hiddenByRange + out.hiddenByToggles, 0);
  });

  test('a lane off removes its edges and its cross pairs, but keeps its nodes', () => {
    const out = filterDfg(validDfg(), { lanes: { issue: false } });
    assert.equal(out.dfg.edges.filter((e) => e.object_type === 'issue').length, 0);
    assert.equal(out.dfg.cross_edges.length, 0, 'the one cross edge touches the issue lane');
    assert.ok(out.dfg.nodes.some((n) => n.object_type === 'issue'), 'nodes stay as context');
    assert.equal(out.hiddenByToggles, 4);
    assert.equal(out.shown + out.hiddenByRange + out.hiddenByToggles, out.total);
  });

  test('a pair off removes exactly that pair', () => {
    const out = filterDfg(validDfg(), { pairs: { issue_pull_request: false } });
    assert.equal(out.dfg.cross_edges.length, 0);
    assert.equal(out.dfg.edges.length, 5, 'per-type edges untouched');
  });

  test('a hidden activity takes its node and every incident succession, cross included', () => {
    const out = filterDfg(validDfg(), { hiddenActivities: new Set(['issue/IssueClosed']) });
    assert.ok(!out.dfg.nodes.some((n) => `${n.object_type}/${n.activity}` === 'issue/IssueClosed'));
    assert.ok(!out.dfg.edges.some((e) => e.to_activity === 'IssueClosed'));
    assert.equal(out.dfg.cross_edges.length, 0, 'the cross edge lands on the hidden activity');
  });

  test('hiding all of a type‘s activities empties its nodes, the layout-collapse precondition', () => {
    const out = filterDfg(validDfg(), { hiddenActivities: new Set(['commit/Push']) });
    assert.equal(out.dfg.nodes.filter((n) => n.object_type === 'commit').length, 0);
  });

  test('the range is inclusive at both bounds', () => {
    const two = filterDfg(validDfg(), { range: [2, 2] });
    assert.ok(two.dfg.edges.every((e) => e.successions === 2));
    assert.equal(two.dfg.edges.length, 2);
    const ones = filterDfg(validDfg(), { range: [1, 1] });
    assert.ok(ones.dfg.edges.every((e) => e.successions === 1));
  });

  test('an edge failing a toggle and the range counts once, under toggles', () => {
    // The commit self-edge (successions 1) fails both the lane toggle and the [2,2]
    // range; it must count once, as a toggle hide, or the readout would overstate.
    const out = filterDfg(validDfg(), { lanes: { commit: false }, range: [2, 2] });
    assert.equal(out.hiddenByToggles, 1);
    assert.equal(out.hiddenByRange, 3, 'the three toggle-passing edges with successions 1');
    assert.equal(out.shown, 2);
    assert.equal(out.shown + out.hiddenByRange + out.hiddenByToggles, out.total);
  });

  test('the input is never mutated', () => {
    const dfg = validDfg();
    const before = JSON.stringify(dfg);
    filterDfg(dfg, { lanes: { issue: false }, range: [2, 2], hiddenActivities: new Set(['commit/Push']) });
    assert.equal(JSON.stringify(dfg), before);
  });
});

describe('the count scale is logarithmic, clamped and round-trippable', () => {
  test('endpoints, round trip, clamping', () => {
    const scale = dfgRangeScale(40000);
    assert.equal(scale.countAt(0), 1);
    assert.equal(scale.countAt(1), 40000);
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      assert.ok(Math.abs(scale.fractionOf(scale.countAt(f)) - f) <= 1 / 1000, `round trip at ${f}`);
    }
    assert.equal(scale.countAt(-1), 1);
    assert.equal(scale.countAt(2), 40000);
    assert.equal(scale.fractionOf(0), 0);
    assert.equal(scale.fractionOf(40005), 1);
  });

  test('a degenerate maximum pins everything to one', () => {
    const scale = dfgRangeScale(1);
    assert.equal(scale.countAt(0.7), 1);
    assert.equal(scale.fractionOf(1), 0);
  });
});

describe('link classes filter, then aggregate to one arrow, then the range applies', () => {
  // Two class rows on one directed edge, one on another — the drawn picture must hold
  // one arrow each, whatever the classes say.
  function classedDfg() {
    const dfg = validDfg();
    dfg.cross_edges = [
      { from_type: 'pull_request', from_activity: 'PullRequestMerged', to_type: 'issue', to_activity: 'IssueClosed', successions: 3, pairs: 2, link_qualifier: 'resolves', link_evidence: 'validated', link_method: 'pr_body' },
      { from_type: 'pull_request', from_activity: 'PullRequestMerged', to_type: 'issue', to_activity: 'IssueClosed', successions: 1, pairs: 1, link_qualifier: 'resolves', link_evidence: 'extracted', link_method: 'commit_message' },
      { from_type: 'commit', from_activity: 'Push', to_type: 'issue', to_activity: 'IssueOpened', successions: 1, pairs: 1, link_qualifier: 'references_issue', link_evidence: 'extracted', link_method: 'commit_message' },
    ];
    return dfg;
  }

  test('aggregation folds class rows into one arrow, members sorted by weight', () => {
    const arrows = aggregateCrossEdges(classedDfg().cross_edges);
    assert.equal(arrows.length, 2);
    const merged = arrows.find((a) => a.to_activity === 'IssueClosed');
    assert.equal(merged.successions, 4);
    assert.equal(merged.pairs, 3);
    assert.deepEqual(
      merged.members.map((m) => m.link_evidence),
      ['validated', 'extracted'],
      'heaviest class first',
    );
  });

  test('a class toggled off leaves the arrow, minus that member', () => {
    const out = filterDfg(classedDfg(), { linkMethods: { commit_message: false } });
    const merged = out.dfg.cross_edges.find((a) => a.to_activity === 'IssueClosed');
    assert.equal(merged.successions, 3, 'the extracted member is gone from the sum');
    assert.equal(merged.members.length, 1);
    assert.ok(!out.dfg.cross_edges.some((a) => a.to_activity === 'IssueOpened'),
      'the arrow whose only class was commit_message disappears entirely');
    assert.equal(out.hiddenByToggles, 1, 'one whole arrow off; the thinned one still shows');
    assert.equal(out.shown + out.hiddenByRange + out.hiddenByToggles, out.total);
  });

  test('every class off hides the arrow and counts it once, under toggles', () => {
    const out = filterDfg(classedDfg(), {
      linkEvidence: { validated: false, extracted: false },
    });
    assert.equal(out.dfg.cross_edges.length, 0);
    assert.equal(out.hiddenByToggles, 2);
    assert.equal(out.shown + out.hiddenByRange + out.hiddenByToggles, out.total);
  });

  test('the range judges the aggregate, never the members', () => {
    // The merged arrow is 3+1=4; a [4,4] range keeps it though no member is 4.
    const out = filterDfg(classedDfg(), { range: [4, 4] });
    assert.equal(out.dfg.cross_edges.length, 1);
    assert.equal(out.dfg.cross_edges[0].successions, 4);
  });

  test('the toggle vocabulary sums per class, and counts arrows for the card', () => {
    const toggles = deriveDfgToggles(classedDfg());
    assert.deepEqual(toggles.linkEvidence, [
      { key: 'extracted', successions: 2 },
      { key: 'validated', successions: 3 },
    ]);
    assert.deepEqual(toggles.linkQualifiers.map((q) => q.key), ['references_issue', 'resolves']);
    assert.deepEqual(toggles.linkMethods.map((m) => m.key), ['commit_message', 'pr_body']);
    assert.equal(toggles.crossArrows, 2);
    // maxSuccessions in arrow units: the merged arrow's 4 beats every raw row.
    assert.equal(toggles.maxSuccessions, 4);
  });
});
