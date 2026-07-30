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

  test('every synthetic fixture is labelled as synthetic', async () => {
    for (const id of ['F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9']) {
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

describe('layout invariants across all fixtures and modes', () => {
  const ALL = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9'];

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
