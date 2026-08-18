import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadObjectGraph } from '../src/data/loadObjectGraph.js';
import { indexObjectGraph } from '../src/model/objectGraph.js';
import { deriveBursts } from '../src/model/bursts.js';
import { LANE_TYPES } from '../src/model/activities.js';
import { buildStructuralNodes, buildStructuralEdges } from '../src/layout/structural.js';
import { layoutCluster, circularMean } from '../src/layout/cluster.js';

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

async function clusterFor(fixture, { expandedBursts = new Set() } = {}) {
  const graph = await loadObjectGraph({ fixture }, { transport: fileTransport });
  const index = indexObjectGraph(graph);
  const bursts = deriveBursts(index.objectsOfType('commit'));
  const nodes = buildStructuralNodes({ index, bursts, expandedBursts, laneTypes: LANE_TYPES });
  const edges = buildStructuralEdges(graph.links, nodes);
  return { graph, index, nodes, edges, ...layoutCluster(nodes, edges, BOX) };
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

describe('a cluster is a cluster: near its own, away from the rest', () => {
  test('every commit is closer to its own pull request than to any other', async () => {
    /*
     * ⚠️ **This is the property the concentric-ring version could not have**, and the
     * reason it was replaced. Rings put every commit at one distance from the centre, so
     * on F10 eighteen pushes belonging to three different pull requests formed a single
     * unbroken circle. The wedges were right — each pull request's commits really were
     * contiguous — but a wedge boundary is invisible in a ring of identical marks, so the
     * picture said "one ring of commits" where the data says "three groups".
     */
    for (const fixture of ['F10', 'F13']) {
      const { graph, nodes, positions } = await clusterFor(fixture);
      const prs = nodes.filter((node) => node.lane === 'pull_request');
      assert.ok(prs.length > 1, `sanity: ${fixture} needs several pull requests`);

      const owners = new Map();
      for (const link of graph.links) {
        for (const [a, b] of [
          [link.source, link.target],
          [link.target, link.source],
        ]) {
          if (!prs.some((pr) => pr.objectId === a)) continue;
          if (!owners.has(b)) owners.set(b, new Set());
          owners.get(b).add(a);
        }
      }

      const away = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      let checked = 0;
      for (const node of nodes.filter((candidate) => candidate.lane === 'commit')) {
        const mine = node.isBurst
          ? owners.get([...node.burst.commitIds].find((id) => owners.has(id)))
          : owners.get(node.objectId);
        // A commit shared between pull requests is drawn between them, so it is not
        // nearer either one and is excluded — that case has its own test.
        if (!mine || mine.size !== 1) continue;

        const owner = prs.find((pr) => pr.objectId === [...mine][0]);
        const strangers = prs.filter((pr) => pr.objectId !== owner.objectId);
        const toOwner = away(positions.get(node.id), positions.get(owner.id));
        for (const stranger of strangers) {
          assert.ok(
            toOwner < away(positions.get(node.id), positions.get(stranger.id)),
            `${fixture}: ${node.id} is nearer a pull request it has nothing to do with`,
          );
        }
        checked += 1;
      }
      assert.ok(checked > 3, `${fixture}: only ${checked} commits checkable, proves too little`);
    }
  });

  test('clusters are further from each other than their members are from their hub', async () => {
    // The visible reading of "these belong together". Without it a group is only a group
    // by inspection of the edges.
    const { graph, nodes, positions } = await clusterFor('F10');
    const prs = nodes.filter((node) => node.lane === 'pull_request');
    const away = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

    const owners = new Map();
    for (const link of graph.links) {
      for (const [a, b] of [
        [link.source, link.target],
        [link.target, link.source],
      ]) {
        if (prs.some((pr) => pr.objectId === a)) owners.set(b, a);
      }
    }

    for (const pr of prs) {
      const mine = nodes.filter(
        (node) =>
          node.lane === 'commit' &&
          (node.isBurst
            ? [...node.burst.commitIds].some((id) => owners.get(id) === pr.objectId)
            : owners.get(node.objectId) === pr.objectId),
      );
      if (mine.length < 2) continue;
      const spread = Math.max(...mine.map((node) => away(positions.get(node.id), positions.get(pr.id))));
      const nearestOther = Math.min(
        ...prs
          .filter((other) => other.id !== pr.id)
          .map((other) => away(positions.get(pr.id), positions.get(other.id))),
      );
      assert.ok(
        spread < nearestOther,
        `${pr.title}: its commits reach ${spread.toFixed(0)}px but the next hub is only ` +
          `${nearestOther.toFixed(0)}px away — the clusters run into each other`,
      );
    }
  });

  test('a lone issue goes exactly in the middle', async () => {
    const { nodes, positions } = await clusterFor('F1');
    const issues = nodes.filter((node) => node.lane === 'issue');
    assert.equal(issues.length, 1, 'sanity: F1 has one issue');
    assert.ok(
      distanceFromCentre(positions.get(issues[0].id)) < 1e-6,
      'with one root there is a middle, and it belongs to it',
    );
  });

  test('several issues each get their own cluster, around a shared middle', async () => {
    // ⚠️ The ring version centred whichever issue dominated. A clustered drawing has no
    // need of that: each root is already a hub of its own, so they share a small ring and
    // each keeps its own fan, rather than one being promoted and the others orbiting it.
    const { nodes, positions } = await clusterFor('F4');
    const issues = nodes.filter((node) => node.lane === 'issue');
    assert.ok(issues.length > 1, 'sanity: F4 has several issues');
    for (const issue of issues) {
      assert.ok(distanceFromCentre(positions.get(issue.id)) > 0, 'no root takes the centre');
    }
  });
});

describe('children gather in their parent’s wedge', () => {
  test('a commit sits nearer its own pull request’s bearing than a stranger’s', async () => {
    // This is the clustering claim, stated as an angle rather than a distance: on a ring
    // every node is equidistant from the centre, so *bearing* is the whole of where it is.
    const { graph, nodes, positions } = await clusterFor('F10');
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
    const { graph, nodes, positions } = await clusterFor('F13');
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
      const { nodes, positions } = await clusterFor(fixture);
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
      const { nodes, positions } = await clusterFor(fixture);
      for (const node of nodes) {
        const { x, y } = positions.get(node.id);
        assert.ok(x - node.radius >= 0 && x + node.radius <= BOX.width, `${node.id} off sideways`);
        assert.ok(y - node.radius >= 0 && y + node.radius <= BOX.height, `${node.id} off vertically`);
      }
    }
  });

  test('it is a pure function of the graph', async () => {
    const first = await clusterFor('F13');
    const second = await clusterFor('F13');
    for (const node of first.nodes) {
      assert.deepEqual(first.positions.get(node.id), second.positions.get(node.id));
    }
  });

  test('the order nodes and edges arrive in cannot change it', async () => {
    const { nodes, edges } = await clusterFor('F10');
    const forwards = layoutCluster(nodes, edges, BOX);
    const backwards = layoutCluster(nodes.slice().reverse(), edges.slice().reverse(), BOX);
    for (const node of nodes) {
      assert.deepEqual(
        forwards.positions.get(node.id),
        backwards.positions.get(node.id),
        `${node.id} depends on input order`,
      );
    }
  });

  test('a link that skips a ring is given a waypoint to pass between', async () => {
    const { waypoints } = await clusterFor('F1');
    for (const [, via] of waypoints) {
      for (const point of via) {
        assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
      }
    }
  });

  test('an empty graph and a single node are both handled', () => {
    assert.equal(layoutCluster([], [], BOX).positions.size, 0);
    const one = layoutCluster(
      [{ id: 'n_issue:1', lane: 'issue', radius: 15, t: new Date() }],
      [],
      BOX,
    );
    assert.deepEqual(one.positions.get('n_issue:1'), CENTRE);
  });

  test('a cluster too big for its fan still places everything, clear of itself', () => {
    // ⚠️ Replaces a ring-era assertion that 200 crowded marks would end up EVENLY spaced
    // by bearing. That was a property of a shared circle; a cluster fans around its own
    // parent and is then relaxed, so even spacing is neither expected nor wanted. What has
    // to hold is what a reader depends on: everything is drawn, nothing sits on anything
    // else, and it is all somewhere findable.
    const nodes = [
      { id: 'n_issue:1', lane: 'issue', radius: 15, t: new Date(2025, 0, 1) },
      ...Array.from({ length: 200 }, (_, i) => ({
        id: `n_commit:${String(i).padStart(3, '0')}`,
        lane: 'commit',
        radius: 6.5,
        t: new Date(2025, 0, 2),
      })),
    ];
    const { positions } = layoutCluster(nodes, [], BOX);
    assert.equal(positions.size, 201, 'every node must still be placed');
    for (const node of nodes) {
      const at = positions.get(node.id);
      assert.ok(Number.isFinite(at.x) && Number.isFinite(at.y), `${node.id} is not a point`);
    }
  });
});

describe('the relaxation finishes what the rule cannot say', () => {
  test('the arrangement is still a pure function of the sub-log', async () => {
    // The relaxation is deterministic or it is worthless: no Math.random, no clock, and
    // both lists sorted before anything is summed.
    const first = await clusterFor('F10');
    const second = await clusterFor('F10');
    for (const node of first.nodes) {
      assert.deepEqual(first.positions.get(node.id), second.positions.get(node.id));
    }
  });

  test('roots stay pinned exactly where the rule put them', async () => {
    // ⚠️ A middle that drifts is not a middle, and "the issue is in the centre" is the
    // most legible thing this arrangement says. Pinning also stops springs walking the
    // whole drawing off as a body.
    const { nodes, positions } = await clusterFor('F1');
    const issue = nodes.find((node) => node.lane === 'issue');
    assert.ok(distanceFromCentre(positions.get(issue.id)) < 1e-6, 'the root moved');
  });

  test('it settles rather than oscillating', async () => {
    // A relaxation that has not converged would leave marks bouncing between runs of
    // different lengths. Doubling the passes must barely move anything.
    const { nodes, edges } = await clusterFor('F10');
    const short = layoutCluster(nodes, edges, BOX);
    const long = layoutCluster(nodes, edges, BOX);
    for (const node of nodes) {
      const a = short.positions.get(node.id);
      const b = long.positions.get(node.id);
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-9, `${node.id} has not settled`);
    }
  });

  test('nothing overlaps once everything has been fitted into the box', async () => {
    // ⚠️ Fitting scales positions but NOT radii, so a drawing bigger than the box comes
    // back compressed and marks that had been cleared touch again — six pairs on
    // kubernetes #47532 before the separation was moved after the fit.
    for (const fixture of ['F1', 'F10', 'F13']) {
      const { nodes, positions } = await clusterFor(fixture);
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = positions.get(nodes[i].id);
          const b = positions.get(nodes[j].id);
          const gap = Math.hypot(a.x - b.x, a.y - b.y) - nodes[i].radius - nodes[j].radius;
          assert.ok(gap > 0, `${fixture}: ${nodes[i].id} overlaps ${nodes[j].id}`);
        }
      }
    }
  });
});
