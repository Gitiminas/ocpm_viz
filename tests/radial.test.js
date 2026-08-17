import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadObjectGraph } from '../src/data/loadObjectGraph.js';
import { indexObjectGraph } from '../src/model/objectGraph.js';
import { deriveBursts } from '../src/model/bursts.js';
import { LANE_TYPES } from '../src/model/activities.js';
import { buildStructuralNodes, buildStructuralEdges } from '../src/layout/structural.js';
import { layoutRadial, circularMean } from '../src/layout/radial.js';

/**
 * The radial layout: the alternative arrangement for the off time mode.
 *
 * What it has to prove is that the rings are a rule rather than an accident, that a node
 * lands in its parents' wedge — which is what makes clusters legible — and that a commit
 * claimed by two pull requests sits between them rather than being duplicated.
 */

const fileTransport = async (query) =>
  JSON.parse(
    await readFile(new URL(`./fixtures/${query.fixture || 'F1'}.json`, import.meta.url), 'utf8'),
  );

const BOX = { width: 1100, height: 620, padding: 60 };
const CENTRE = { x: BOX.width / 2, y: BOX.height / 2 };

async function radialFor(fixture, { expandedBursts = new Set() } = {}) {
  const graph = await loadObjectGraph({ fixture }, { transport: fileTransport });
  const index = indexObjectGraph(graph);
  const bursts = deriveBursts(index.objectsOfType('commit'));
  const nodes = buildStructuralNodes({ index, bursts, expandedBursts, laneTypes: LANE_TYPES });
  const edges = buildStructuralEdges(graph.links, nodes);
  return { graph, index, nodes, edges, ...layoutRadial(nodes, edges, BOX) };
}

const distanceFromCentre = (at) => Math.hypot(at.x - CENTRE.x, at.y - CENTRE.y);
const bearing = (at) => Math.atan2(at.y - CENTRE.y, at.x - CENTRE.x);

/** Shortest angular distance between two bearings, in radians. */
function angleBetween(a, b) {
  const diff = Math.abs(a - b) % (Math.PI * 2);
  return diff > Math.PI ? Math.PI * 2 - diff : diff;
}

describe('the circular mean, which the whole angle rule rests on', () => {
  test('it wraps: the mean of 350° and 10° is 0°, not 180°', () => {
    const mean = circularMean([(350 * Math.PI) / 180, (10 * Math.PI) / 180]);
    const degrees = (mean * 180) / Math.PI;
    assert.ok(
      degrees < 1 || degrees > 359,
      `got ${degrees.toFixed(1)}° — an arithmetic mean would say 180 and fling the node ` +
        'to the opposite side of the picture from both its parents',
    );
  });

  test('an ordinary pair averages as expected', () => {
    const mean = circularMean([0, Math.PI / 2]);
    assert.ok(Math.abs(mean - Math.PI / 4) < 1e-9);
  });

  test('nothing to average, and nothing meaningful to average, both say so', () => {
    assert.equal(circularMean([]), null);
    // Diametrically opposite parents have no midpoint; picking one would be a coin toss.
    assert.equal(circularMean([0, Math.PI]), null);
  });
});

describe('rings are a rule, not an accident', () => {
  test('issues sit inside pull requests, which sit inside commits', async () => {
    for (const fixture of ['F1', 'F10', 'F13']) {
      const { nodes, positions } = await radialFor(fixture);
      const ringOf = (lane) =>
        nodes
          .filter((node) => node.lane === lane)
          .map((node) => distanceFromCentre(positions.get(node.id)));

      const issues = ringOf('issue');
      const prs = ringOf('pull_request');
      const commits = ringOf('commit');

      if (issues.length && prs.length) {
        assert.ok(Math.max(...issues) < Math.min(...prs), `${fixture}: an issue is outside a PR`);
      }
      if (prs.length && commits.length) {
        assert.ok(Math.max(...prs) < Math.min(...commits), `${fixture}: a PR is outside a commit`);
      }
    }
  });

  test('every node on a ring is the same distance from the centre', async () => {
    const { nodes, positions } = await radialFor('F10');
    for (const lane of LANE_TYPES) {
      const distances = nodes
        .filter((node) => node.lane === lane)
        .map((node) => distanceFromCentre(positions.get(node.id)));
      if (distances.length < 2) continue;
      const spread = Math.max(...distances) - Math.min(...distances);
      assert.ok(spread < 1, `${lane} is spread over ${spread.toFixed(1)}px of radius`);
    }
  });

  test('a lone issue goes exactly in the middle, not on a tiny circle', async () => {
    const { nodes, positions } = await radialFor('F1');
    const issues = nodes.filter((node) => node.lane === 'issue');
    assert.equal(issues.length, 1, 'sanity: F1 has one issue');
    assert.ok(
      distanceFromCentre(positions.get(issues[0].id)) < 1e-6,
      'a ring of one is a point; drawing it on a circle leaves a hole with nothing in it',
    );
  });

  test('several issues share the innermost ring', async () => {
    // F4 has two overlapping issues. Neither can be *the* centre, so both go on a ring.
    const { nodes, positions } = await radialFor('F4');
    const issues = nodes.filter((node) => node.lane === 'issue');
    assert.ok(issues.length > 1, 'sanity: F4 has several issues');
    for (const issue of issues) {
      assert.ok(distanceFromCentre(positions.get(issue.id)) > 0, 'no issue may take the centre');
    }
  });
});

describe('children gather in their parent’s wedge', () => {
  test('a commit sits nearer its own pull request’s bearing than a stranger’s', async () => {
    // This is the clustering claim, stated as an angle rather than a distance: on a ring
    // every node is equidistant from the centre, so *bearing* is the whole of where it is.
    const { graph, nodes, positions } = await radialFor('F10');
    const prs = nodes.filter((node) => node.lane === 'pull_request');
    assert.ok(prs.length > 1, 'sanity: F10 has several pull requests');

    const owner = new Map();
    for (const link of graph.links) {
      for (const [a, b] of [
        [link.source, link.target],
        [link.target, link.source],
      ]) {
        if (!prs.some((pr) => pr.objectId === a)) continue;
        owner.set(b, a);
      }
    }

    let checked = 0;
    for (const node of nodes.filter((n) => n.lane === 'commit')) {
      const ownerId = node.isBurst
        ? owner.get([...node.burst.commitIds].find((id) => owner.has(id)))
        : owner.get(node.objectId);
      if (!ownerId) continue;
      const mine = prs.find((pr) => pr.objectId === ownerId);
      const stranger = prs.find((pr) => pr.objectId !== ownerId);
      if (!mine || !stranger) continue;

      const toMine = angleBetween(bearing(positions.get(node.id)), bearing(positions.get(mine.id)));
      const toStranger = angleBetween(
        bearing(positions.get(node.id)),
        bearing(positions.get(stranger.id)),
      );
      assert.ok(toMine <= toStranger + 1e-9, `${node.id} sits in the wrong wedge`);
      checked += 1;
    }
    assert.ok(checked > 5, `only ${checked} commits were checkable; that proves too little`);
  });

  test('a commit claimed by two pull requests lands between them, and stays one node', async () => {
    const { graph, nodes, positions } = await radialFor('F13');
    const prIds = new Set(
      nodes.filter((node) => node.lane === 'pull_request').map((node) => node.objectId),
    );

    const claims = new Map();
    for (const link of graph.links) {
      for (const [a, b] of [
        [link.source, link.target],
        [link.target, link.source],
      ]) {
        if (!prIds.has(a)) continue;
        if (!claims.has(b)) claims.set(b, new Set());
        claims.get(b).add(a);
      }
    }

    const sharedId = [...claims.entries()].find(([, prs]) => prs.size > 1)?.[0];
    assert.ok(sharedId, 'sanity: F13 must contain a commit claimed by two pull requests');
    assert.equal(
      nodes.filter((node) => node.objectId === sharedId).length,
      1,
      'the shared commit must stay a single node — duplicating it would let it be counted twice',
    );

    const shared = bearing(positions.get(nodes.find((n) => n.objectId === sharedId).id));
    const owners = [...claims.get(sharedId)].map((id) =>
      bearing(positions.get(nodes.find((n) => n.objectId === id).id)),
    );

    // Between them: no further from either owner than they are from each other.
    const apart = angleBetween(owners[0], owners[1]);
    for (const owner of owners) {
      assert.ok(
        angleBetween(shared, owner) <= apart + 1e-6,
        'the shared commit sits outside the wedge between its two pull requests',
      );
    }
  });
});

describe('the drawing is usable', () => {
  test('marks on a ring do not overlap', async () => {
    for (const fixture of ['F1', 'F10', 'F13']) {
      const { nodes, positions } = await radialFor(fixture);
      for (const lane of LANE_TYPES) {
        const ring = nodes.filter((node) => node.lane === lane);
        for (let i = 0; i < ring.length; i++) {
          for (let j = i + 1; j < ring.length; j++) {
            const a = positions.get(ring[i].id);
            const b = positions.get(ring[j].id);
            const gap = Math.hypot(a.x - b.x, a.y - b.y) - ring[i].radius - ring[j].radius;
            assert.ok(gap > 0, `${fixture}/${lane}: ${ring[i].id} overlaps ${ring[j].id}`);
          }
        }
      }
    }
  });

  test('nothing escapes the box', async () => {
    for (const fixture of ['F1', 'F10', 'F13']) {
      const { nodes, positions } = await radialFor(fixture);
      for (const node of nodes) {
        const { x, y } = positions.get(node.id);
        assert.ok(x - node.radius >= 0 && x + node.radius <= BOX.width, `${node.id} off sideways`);
        assert.ok(y - node.radius >= 0 && y + node.radius <= BOX.height, `${node.id} off vertically`);
      }
    }
  });

  test('it is a pure function of the graph', async () => {
    const first = await radialFor('F13');
    const second = await radialFor('F13');
    for (const node of first.nodes) {
      assert.deepEqual(first.positions.get(node.id), second.positions.get(node.id));
    }
  });

  test('the order nodes and edges arrive in cannot change it', async () => {
    const { nodes, edges } = await radialFor('F10');
    const forwards = layoutRadial(nodes, edges, BOX);
    const backwards = layoutRadial(nodes.slice().reverse(), edges.slice().reverse(), BOX);
    for (const node of nodes) {
      assert.deepEqual(
        forwards.positions.get(node.id),
        backwards.positions.get(node.id),
        `${node.id} depends on input order`,
      );
    }
  });

  test('a link that skips a ring is given a waypoint to pass between', async () => {
    const { waypoints } = await radialFor('F1');
    for (const [, via] of waypoints) {
      for (const point of via) {
        assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
      }
    }
  });

  test('an empty graph and a single node are both handled', () => {
    assert.equal(layoutRadial([], [], BOX).positions.size, 0);
    const one = layoutRadial(
      [{ id: 'n_issue:1', lane: 'issue', radius: 15, t: new Date() }],
      [],
      BOX,
    );
    assert.deepEqual(one.positions.get('n_issue:1'), CENTRE);
  });

  test('a ring too full to honour every preference shares itself out evenly', () => {
    // 200 commits cannot each sit in their parent's wedge. An equal share is the honest
    // answer to a full ring; the alternative is two marks on one spot.
    const nodes = [
      { id: 'n_issue:1', lane: 'issue', radius: 15, t: new Date(2025, 0, 1) },
      ...Array.from({ length: 200 }, (_, i) => ({
        id: `n_commit:${String(i).padStart(3, '0')}`,
        lane: 'commit',
        radius: 6.5,
        t: new Date(2025, 0, 2),
      })),
    ];
    const { positions } = layoutRadial(nodes, [], BOX);
    assert.equal(positions.size, 201, 'every node must still be placed');
    const bearings = nodes
      .filter((n) => n.lane === 'commit')
      .map((n) => bearing(positions.get(n.id)))
      .sort((a, b) => a - b);
    const gaps = bearings.slice(1).map((b, i) => b - bearings[i]);
    const spread = Math.max(...gaps) - Math.min(...gaps);
    assert.ok(spread < 0.01, `an over-full ring must space evenly; spread was ${spread.toFixed(3)}`);
  });
});

describe('a dominant hub goes in the middle', () => {
  /**
   * ⚠️ With several issues nothing was in the centre, so the one owning almost everything
   * sat on the innermost circle while its children — needing nearly the whole turn —
   * spread around the centre point instead of around it. Measured on kubernetes #47532:
   * the issue carrying eight of nine pull requests sat at 138° with its fan elsewhere. A
   * radial drawing whose hub is beside its own fan is doing the opposite of its job.
   */
  const issue = (n, t) => ({ id: `n_issue:${n}`, lane: 'issue', radius: 15, t: new Date(t) });
  const pr = (n, t) => ({ id: `n_pr:${n}`, lane: 'pull_request', radius: 12, t: new Date(t) });

  test('the hub is centred when it owns most of the innermost ring', () => {
    const nodes = [
      issue(1, '2025-01-01'),
      issue(2, '2025-01-02'),
      ...Array.from({ length: 8 }, (_, i) => pr(i, `2025-02-0${(i % 8) + 1}`)),
    ];
    // Every pull request belongs to issue 1; issue 2 has none.
    const edges = nodes
      .filter((node) => node.lane === 'pull_request')
      .map((node) => ({ source: 'n_issue:1', target: node.id }));

    const { positions } = layoutRadial(nodes, edges, BOX);
    assert.ok(
      distanceFromCentre(positions.get('n_issue:1')) < 1e-6,
      'the issue owning every pull request must take the centre',
    );
    assert.ok(
      distanceFromCentre(positions.get('n_issue:2')) > 0,
      'and the one owning none must not',
    );
  });

  test('issues of similar weight leave the centre empty', () => {
    // Picking one would assert a hierarchy the data does not have.
    const nodes = [issue(1, '2025-01-01'), issue(2, '2025-01-02'), pr(1, '2025-02-01'), pr(2, '2025-02-02')];
    const edges = [
      { source: 'n_issue:1', target: 'n_pr:1' },
      { source: 'n_issue:2', target: 'n_pr:2' },
    ];
    const { positions } = layoutRadial(nodes, edges, BOX);
    for (const id of ['n_issue:1', 'n_issue:2']) {
      assert.ok(distanceFromCentre(positions.get(id)) > 0, `${id} must not be centred`);
    }
  });

  test('which node is centred does not depend on input order', () => {
    const nodes = [
      issue(1, '2025-01-01'),
      issue(2, '2025-01-02'),
      ...Array.from({ length: 6 }, (_, i) => pr(i, '2025-02-01')),
    ];
    const edges = nodes
      .filter((node) => node.lane === 'pull_request')
      .map((node) => ({ source: 'n_issue:1', target: node.id }));

    const forwards = layoutRadial(nodes, edges, BOX);
    const backwards = layoutRadial(nodes.slice().reverse(), edges.slice().reverse(), BOX);
    for (const node of nodes) {
      assert.deepEqual(forwards.positions.get(node.id), backwards.positions.get(node.id));
    }
  });
});
