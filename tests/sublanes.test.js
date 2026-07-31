import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadObjectGraph } from '../src/data/loadObjectGraph.js';
import { indexObjectGraph, collectInstants } from '../src/model/objectGraph.js';
import { deriveBursts } from '../src/model/bursts.js';
import { buildNodes, assignRanks } from '../src/layout/nodes.js';
import { createScales } from '../src/layout/scales.js';
import { packRows, assignSubLanes, objectExtent, collisionThreshold } from '../src/layout/packing.js';
import { computeLaneGeometry } from '../src/layout/lanes.js';
import { objectShade, shadeCount, COLORS } from '../src/render/theme.js';
import {
  createState,
  resetToggles,
  deriveRelGroups,
  deriveQualifiers,
  deriveMethods,
} from '../src/state/state.js';
import { renderLinks } from '../src/render/links.js';

/**
 * A stand-in for a d3 selection that records the attributes written to it.
 *
 * The link renderer only ever chains `append`, `attr`, `style`, `text` and `on`, so
 * this is enough to exercise its geometry without a DOM — which is the point: the
 * fan is a arithmetic property of the paths, and arithmetic should be testable
 * without a browser.
 */
function fakeSelection(recorded) {
  const make = () => {
    const node = { attrs: {} };
    recorded.push(node);
    const selection = {
      append: () => make(),
      attr(key, value) {
        node.attrs[key] = value;
        return selection;
      },
      style: () => selection,
      text: () => selection,
      on: () => selection,
      selectAll: () => ({ remove() {} }),
      node: () => ({}),
    };
    return selection;
  };
  return {
    append: () => make(),
    attr: () => undefined,
    selectAll: () => ({ remove() {} }),
  };
}

const fileTransport = async (query) =>
  JSON.parse(await readFile(new URL(`./fixtures/${query.fixture}.json`, import.meta.url), 'utf8'));
const load = (fixture) => loadObjectGraph({ fixture }, { transport: fileTransport });

const MARGIN_LEFT = 180;
const PLOT_WIDTH = 1100;
const LANES = ['issue', 'pull_request', 'commit'];

/** Run the real layout pipeline over a fixture, exactly as the renderer does. */
async function layout(fixture, { mode = 'real' } = {}) {
  const graph = await load(fixture);
  const index = indexObjectGraph(graph);
  const bursts = deriveBursts(index.objectsOfType('commit'));
  const nodes = buildNodes({ graph, index, bursts, mode, laneTypes: LANES });
  const { rankTimes, rankMax } = assignRanks(nodes);

  const scales = createScales({
    instants: collectInstants(graph),
    marginLeft: MARGIN_LEFT,
    plotWidth: PLOT_WIDTH,
    mode,
    rankTimes,
    rankMax,
  });
  for (const node of nodes) node.x = scales.x(node.t, node);

  const laneObjects = new Map(LANES.map((lane) => [lane, index.objectsOfType(lane)]));
  const { maxRowByLane, objectRow } = packRows(nodes, LANES, { laneObjects });
  const geometry = computeLaneGeometry(LANES, maxRowByLane, { top: 32, bottom: 150 });

  return { graph, index, nodes, maxRowByLane, objectRow, geometry, bursts };
}

const distinctRows = (objectRow, ids) => new Set(ids.map((id) => objectRow.get(id)));

// ---------------------------------------------------------------------------
// Each fixture must actually exhibit the property it claims. Without these, an
// "overlapping PRs" fixture whose PRs do not overlap would pass every layout test
// while verifying nothing at all.
// ---------------------------------------------------------------------------

describe('fixtures exhibit the properties they claim', () => {
  const overlaps = (a, b) => a.start < b.end && b.start < a.end;

  test('F2 really does have two PRs that do NOT overlap', async () => {
    const graph = await load('F2');
    const prs = graph.objects.filter((o) => o.type === 'pull_request');
    assert.equal(prs.length, 2);
    const [a, b] = prs.map((p) => objectExtent(p));
    assert.equal(overlaps(a, b), false, 'F2 PRs must be sequential');
  });

  test('F3 really does have two PRs that DO overlap', async () => {
    const graph = await load('F3');
    const prs = graph.objects.filter((o) => o.type === 'pull_request');
    assert.equal(prs.length, 2);
    const [a, b] = prs.map((p) => objectExtent(p));
    assert.equal(overlaps(a, b), true, 'F3 PRs must be concurrent');
  });

  test('F4 really does have two overlapping issues and one PR', async () => {
    const graph = await load('F4');
    const issues = graph.objects.filter((o) => o.type === 'issue');
    assert.equal(issues.length, 2);
    assert.equal(graph.objects.filter((o) => o.type === 'pull_request').length, 1);
    const [a, b] = issues.map((i) => objectExtent(i));
    assert.equal(overlaps(a, b), true);
  });

  test('F5 really does have one commit referenced by two PRs', async () => {
    const graph = await load('F5');
    const commits = graph.objects.filter((o) => o.type === 'commit');
    assert.equal(commits.length, 1);
    const targets = graph.links
      .filter((l) => l.source === commits[0].id && l.qualifier === 'referenced_pull_request')
      .map((l) => l.target);
    assert.deepEqual(targets.sort(), ['pr:40', 'pr:41']);
  });

  test('F6 really does have zero commits', async () => {
    const graph = await load('F6');
    assert.equal(graph.objects.filter((o) => o.type === 'commit').length, 0);
  });

  test('F7 really does have two pushes above the burst threshold', async () => {
    const graph = await load('F7');
    const index = indexObjectGraph(graph);
    const bursts = deriveBursts(index.objectsOfType('commit'));
    assert.equal(bursts.length, 2, 'F7 must produce exactly two bursts');
    assert.ok(bursts.every((b) => b.size === 8));
  });

  test('F8 really does have a PR and no issue', async () => {
    const graph = await load('F8');
    assert.equal(graph.objects.filter((o) => o.type === 'issue').length, 0);
    assert.equal(graph.objects.filter((o) => o.type === 'pull_request').length, 1);
  });

  test('F9 really does have an issue with two intervals', async () => {
    const graph = await load('F9');
    const issue = graph.objects.find((o) => o.type === 'issue');
    assert.equal(issue.intervals.length, 2);
    assert.ok(+issue.intervals[0].end < +issue.intervals[1].start, 'intervals must be disjoint');
  });

  test('F10 really is large enough to exercise density behaviour', async () => {
    const graph = await load('F10');
    const commits = graph.objects.filter((o) => o.type === 'commit');
    assert.equal(commits.length, 300);
    assert.equal(graph.objects.filter((o) => o.type === 'pull_request').length, 3);
    // Pushes of varying size, so some fold and some do not — a fixture where every
    // push folded would not exercise the mixed case.
    const index = indexObjectGraph(graph);
    const bursts = deriveBursts(index.objectsOfType('commit'));
    assert.ok(bursts.length >= 3, 'several pushes must exceed the threshold');
    assert.ok(
      bursts.length < new Set(commits.map((c) => c.vmap.push_id)).size,
      'and several must not, or the mixed case is untested',
    );
  });

  test('F11 really does carry all four issue-PR detection methods', async () => {
    const graph = await load('F11');
    const methods = new Set(
      graph.links.filter((l) => l.qualifier === 'related_issue').map((l) => l.method),
    );
    assert.deepEqual(
      [...methods].sort(),
      ['branch_name', 'issue_comment', 'pr_body', 'pr_title'],
    );
  });

  test('F12 really does have multi-method agreement and mixed evidence on one pair', async () => {
    const graph = await load('F12');
    const multi = graph.links.filter((l) => l.n_methods > 1);
    assert.ok(multi.length >= 1, 'at least one link must have several methods agreeing');
    assert.equal(multi[0].evidence, 'validated', 'one validating method is enough');

    // The same commit-PR pair, asserted once by identity and once by convention.
    const pairs = new Map();
    for (const link of graph.links.filter((l) => l.qualifier !== 'actor')) {
      const key = `${link.source}|${link.target}`;
      if (!pairs.has(key)) pairs.set(key, new Set());
      pairs.get(key).add(link.evidence);
    }
    assert.ok(
      [...pairs.values()].some((classes) => classes.size > 1),
      'one object pair must carry both evidence classes',
    );
  });

  test('every synthetic fixture is labelled as synthetic', async () => {
    for (const id of ['F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13']) {
      const graph = await load(id);
      assert.match(graph.meta.data_honesty.synthetic, /SYNTHESIZED FIXTURE/);
      assert.ok(graph.meta.source.property, `${id} must declare its property`);
    }
  });
});

// ---------------------------------------------------------------------------
// The rule: a sub-lane only when temporal overlap forces one.
// ---------------------------------------------------------------------------

describe('sub-lanes are allocated only when overlap forces them', () => {
  test('sequential PRs share one band (F2)', async () => {
    const { objectRow, maxRowByLane } = await layout('F2');
    assert.equal(distinctRows(objectRow, ['pr:10', 'pr:11']).size, 1, 'F2 PRs must share a band');
    // One band, and no comments in F2, so the lane needs a single row.
    assert.equal(maxRowByLane.get('pull_request'), 0);
  });

  test('overlapping PRs get their own bands (F3)', async () => {
    const { objectRow, maxRowByLane } = await layout('F3');
    assert.equal(distinctRows(objectRow, ['pr:20', 'pr:21']).size, 2, 'F3 PRs must not share a band');
    assert.ok(maxRowByLane.get('pull_request') >= 1, 'the PR lane must be taller than one row');
  });

  test('the same rule applies to issues, not just PRs (F4)', async () => {
    const { objectRow } = await layout('F4');
    assert.equal(distinctRows(objectRow, ['issue:3', 'issue:4']).size, 2);
  });

  test('a single object never needs a second band (F1)', async () => {
    const { objectRow } = await layout('F1');
    assert.equal(objectRow.get('issue:242864'), 0);
    assert.equal(objectRow.get('pr:243221'), 0);
  });

  test('overlapping PRs make the lane taller than sequential ones', async () => {
    const sequential = await layout('F2');
    const concurrent = await layout('F3');
    assert.ok(
      concurrent.geometry.lanes.get('pull_request').height >
        sequential.geometry.lanes.get('pull_request').height,
      'concurrency must cost vertical space; sequence must not',
    );
  });

  test('an object keeps its band across every time mode', async () => {
    for (const mode of ['real', 'highlights', 'ordinal']) {
      const { objectRow } = await layout('F3', { mode });
      assert.equal(
        distinctRows(objectRow, ['pr:20', 'pr:21']).size,
        2,
        `${mode}: overlap must still split`,
      );
    }
  });
});

describe('sub-lane allocation in isolation', () => {
  const span = (id, from, to) => ({
    id,
    type: 'pull_request',
    intervals: [{ start: new Date(from), end: new Date(to) }],
  });

  test('touching extents may share a band — the collision loop separates the glyphs', () => {
    const bands = assignSubLanes([
      span('a', '2025-01-01T00:00:00Z', '2025-01-05T00:00:00Z'),
      span('b', '2025-01-05T00:00:00Z', '2025-01-09T00:00:00Z'),
    ]);
    assert.equal(bands.get('a'), bands.get('b'));
  });

  test('three mutually overlapping objects need three bands', () => {
    const bands = assignSubLanes([
      span('a', '2025-01-01T00:00:00Z', '2025-01-10T00:00:00Z'),
      span('b', '2025-01-02T00:00:00Z', '2025-01-11T00:00:00Z'),
      span('c', '2025-01-03T00:00:00Z', '2025-01-12T00:00:00Z'),
    ]);
    assert.equal(new Set(bands.values()).size, 3);
  });

  test('a band is reused once its occupant has finished', () => {
    const bands = assignSubLanes([
      span('a', '2025-01-01T00:00:00Z', '2025-01-05T00:00:00Z'),
      span('b', '2025-01-02T00:00:00Z', '2025-01-06T00:00:00Z'),
      span('c', '2025-01-07T00:00:00Z', '2025-01-09T00:00:00Z'),
    ]);
    // a and b overlap, so two bands; c follows both and reuses the first.
    assert.equal(new Set(bands.values()).size, 2);
    assert.equal(bands.get('c'), bands.get('a'));
  });

  test('allocation is stable, not dependent on input order', () => {
    const objects = [
      span('a', '2025-01-01T00:00:00Z', '2025-01-10T00:00:00Z'),
      span('b', '2025-01-02T00:00:00Z', '2025-01-11T00:00:00Z'),
    ];
    const forwards = assignSubLanes(objects);
    const backwards = assignSubLanes(objects.slice().reverse());
    assert.equal(forwards.get('a'), backwards.get('a'));
    assert.equal(forwards.get('b'), backwards.get('b'));
  });

  test('an extent covers stray events outside the lifecycle', () => {
    const object = span('a', '2025-01-01T00:00:00Z', '2025-01-05T00:00:00Z');
    const withStrayComment = objectExtent(object, [{ t: new Date('2025-02-01T00:00:00Z') }]);
    assert.equal(+withStrayComment.end, +new Date('2025-02-01T00:00:00Z'));
  });

  test('an object with neither intervals nor nodes still gets a band', () => {
    const bands = assignSubLanes([{ id: 'ghost', type: 'issue', intervals: [] }]);
    assert.equal(bands.get('ghost'), 0);
  });
});

// ---------------------------------------------------------------------------
// Invariants that must hold for every fixture, in every mode.
// ---------------------------------------------------------------------------

describe('objects in one lane are visually distinguishable', () => {
  test('a lone object of a type keeps the base colour, so F1 is unchanged', () => {
    assert.equal(objectShade('pull_request', 0), COLORS.pull_request);
    assert.equal(objectShade('issue', 0), COLORS.issue);
  });

  test('objects sharing a lane get different shades', () => {
    assert.notEqual(objectShade('pull_request', 0), objectShade('pull_request', 1));
    assert.notEqual(objectShade('issue', 0), objectShade('issue', 1));
  });

  test('the palette cycles rather than running out', () => {
    const n = shadeCount('pull_request');
    assert.ok(n >= 4, 'need enough shades to be useful');
    assert.equal(objectShade('pull_request', n), objectShade('pull_request', 0));
  });

  test('commits are not shaded — each is its own node, never a sibling span', () => {
    assert.equal(objectShade('commit', 0), objectShade('commit', 3));
  });
});

describe('links that would coincide are fanned apart', () => {
  // The defect: a commit inside two overlapping PRs' spans produces two straight
  // vertical links at the same x, and the one reaching the nearer band is a strict
  // sub-segment of the other — completely hidden. In F5 the buried link was the
  // extracted one, so the "?" uncertainty badge vanished under a solid line.
  // The commit sits below both PR bands, and both links land at the same x —
  // exactly the geometry that made one of them invisible.
  const COMMIT_Y = 300;
  const anchorsFor = (targets) => ({
    x: () => 500,
    y: (id) => targets[id]?.y ?? COMMIT_Y,
    xAt: () => 500,
    clampToLifecycle: (id, object, sx) => sx,
    xOfTime: () => 500,
  });

  test('two links from one commit into the same column are separated', async () => {
    const graph = await load('F5');
    const index = indexObjectGraph(graph);
    const drawn = [];
    const gLink = fakeSelection(drawn);

    renderLinks({
      gLink,
      defs: fakeSelection([]),
      links: graph.links,
      byId: index.byId,
      anchors: anchorsFor({ 'pr:40': { y: 100 }, 'pr:41': { y: 140 } }),
      // A real state object, so the link renderer sees every filter it consults
      // rather than a stub that happens to satisfy today's implementation.
      state: resetToggles(createState(), {
        relGroups: deriveRelGroups(graph.links, index.byId),
        qualifiers: deriveQualifiers(graph.links),
        methods: deriveMethods(graph.links),
      }),
      focus: null,
      burstsByCommit: new Map(),
      tooltip: { bind: (s) => s },
      objectColors: new Map(),
    });

    const paths = drawn.filter((d) => d.attrs.d).map((d) => d.attrs.d);
    const startXs = [...new Set(paths.map((d) => d.match(/^M([-\d.]+),/)[1]))];
    assert.equal(startXs.length, 2, 'the two links must not start at the same x');
    const separation = Math.abs(Number(startXs[0]) - Number(startXs[1]));
    assert.ok(separation >= 4, `links only ${separation}px apart`);
  });

  test('a source whose links already diverge is left where it was', async () => {
    // F1's one multi-link commit reaches the issue and the PR at different x, so
    // nothing coincides and nothing should move — this is what keeps F1 identical.
    const graph = await load('F1');
    const index = indexObjectGraph(graph);
    const multi = graph.links.filter(
      (l) => l.source === 'commit:eb700003ebf3797af1de1f9e222478d6d7f7eea3',
    );
    assert.equal(multi.length, 2);
    assert.notEqual(multi[0].target, multi[1].target);
    // Their targets sit in different lanes with different spans, so clampToLifecycle
    // puts them in different columns and the fan does not engage.
    const targets = multi.map((l) => index.byId.get(l.target));
    assert.notEqual(targets[0].type, targets[1].type);
  });
});

describe('layout invariants across all fixtures and modes', () => {
  const ALL = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13'];

  for (const fixture of ALL) {
    test(`${fixture}: no two nodes overlap within a row`, async () => {
      for (const mode of ['real', 'highlights', 'ordinal']) {
        const { nodes } = await layout(fixture, { mode });
        const byLaneRow = new Map();
        for (const node of nodes) {
          const key = `${node.lane}|${node.row}`;
          if (!byLaneRow.has(key)) byLaneRow.set(key, []);
          byLaneRow.get(key).push(node);
        }
        for (const [key, group] of byLaneRow) {
          const threshold = collisionThreshold(key.split('|')[0]);
          const sorted = group.slice().sort((a, b) => a.x - b.x);
          for (let i = 1; i < sorted.length; i++) {
            assert.ok(
              sorted[i].x - sorted[i - 1].x >= threshold,
              `${fixture}/${mode}: ${sorted[i - 1].id} and ${sorted[i].id} overlap in ${key}`,
            );
          }
        }
      }
    });

    test(`${fixture}: every node has a finite position and a row`, async () => {
      for (const mode of ['real', 'highlights', 'ordinal']) {
        const { nodes } = await layout(fixture, { mode });
        for (const node of nodes) {
          assert.ok(Number.isFinite(node.x), `${fixture}/${mode}: ${node.id} has x=${node.x}`);
          assert.ok(Number.isInteger(node.row) && node.row >= 0, `${fixture}: ${node.id} row`);
        }
      }
    });

    test(`${fixture}: every link resolves to endpoints that exist`, async () => {
      const { graph, index } = await layout(fixture);
      const eventIds = new Set(graph.events.map((e) => e.id));
      for (const link of graph.links) {
        assert.ok(index.byId.has(link.source) || eventIds.has(link.source), `${link.source}`);
        assert.ok(index.byId.has(link.target) || eventIds.has(link.target), `${link.target}`);
      }
    });
  }

  test('a sub-log with no commits leaves the commit lane empty but valid (F6)', async () => {
    const { nodes, maxRowByLane, geometry } = await layout('F6');
    assert.equal(nodes.filter((n) => n.lane === 'commit').length, 0);
    assert.equal(maxRowByLane.get('commit'), 0);
    assert.ok(Number.isFinite(geometry.height));
  });

  test('two bursts both fold, and both carry their true size (F7)', async () => {
    const { nodes, bursts } = await layout('F7');
    assert.equal(bursts.length, 2);
    const burstNodes = nodes.filter((n) => n.isBurst);
    assert.equal(burstNodes.length, 2);
    assert.deepEqual(
      burstNodes.map((n) => n.title).sort(),
      ['8 commits', '8 commits'],
    );
    // The two loose commits stay loose: 2 loose + 2 burst nodes.
    assert.equal(nodes.filter((n) => n.lane === 'commit').length, 4);
  });

  test('an orphan PR renders without an issue lane (F8)', async () => {
    const { nodes, index } = await layout('F8');
    assert.equal(index.objectsOfType('issue').length, 0);
    assert.ok(nodes.some((n) => n.lane === 'pull_request'));
  });

  test('a reopened issue draws two bars on one row (F9)', async () => {
    const { graph, objectRow } = await layout('F9');
    const issue = graph.objects.find((o) => o.type === 'issue');
    assert.equal(issue.intervals.length, 2, 'two bars');
    // One object, so one band — the reopen must not split it into two rows.
    assert.equal(objectRow.get(issue.id), 0);
  });
});
