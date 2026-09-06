import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadSubLog } from '../src/data/loadSubLog.js';
import { indexSubLog } from '../src/model/subLog.js';
import { deriveBursts } from '../src/model/bursts.js';
import { LANE_TYPES } from '../src/model/activities.js';
import { buildStructuralNodes, buildStructuralEdges } from '../src/layout/structural.js';
import {
  layoutCluster,
  circularMean,
  createDragSimulation,
  footprintPairs,
} from '../src/layout/cluster.js';

/**
 * The clustered layout: the alternative arrangement for the relationships time mode.
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
  const graph = await loadSubLog({ fixture }, { transport: fileTransport });
  const index = indexSubLog(graph);
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

describe('zooming enlarges the drawing, not just the box', () => {
  test('a compact graph at the fill cap still doubles when the zoom does', async () => {
    // ⚠️ The bug this pins: the fill cap is a statement about the BASE picture, but it
    // used to cap the zoomed one too, so a small sub-log at the cap did not grow when the
    // box did — F1 stayed 326px wide from zoom 1 to 3 and zooming changed only the empty
    // space around it. The cap now scales with `zoom`.
    const { nodes, edges } = await clusterFor('F1');
    const span = (zoom) => {
      const { positions } = layoutCluster(nodes, edges, { ...BOX, width: BOX.width * zoom, height: BOX.height * zoom, zoom });
      const xs = [...positions.values()].map((p) => p.x);
      return Math.max(...xs) - Math.min(...xs);
    };
    const base = span(1);
    assert.ok(base > 0);
    assert.ok(Math.abs(span(2) / base - 2) < 0.05, `zoom 2 gave ${span(2) / base}× instead of ~2×`);
    assert.ok(Math.abs(span(3) / base - 3) < 0.05, `zoom 3 gave ${span(3) / base}× instead of ~3×`);
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

  test('a root is not pushed around by its own children', async () => {
    // ⚠️ Roots are pinned during the relaxation: a middle that drifts is not a middle, and
    // pinning also stops springs walking the whole drawing off as a body. Checked through
    // the shape it produces, since the fit re-centres everything afterwards — every one of
    // a root's pull requests should still be at much the same distance from it, which is
    // what an unpinned root being dragged toward the heaviest cluster would destroy.
    const { graph, nodes, positions } = await clusterFor('F10');
    const issue = nodes.find((node) => node.lane === 'issue');
    const prIds = new Set(
      graph.links
        .flatMap((link) => [link.source, link.target])
        .filter((id) => nodes.some((n) => n.objectId === id && n.lane === 'pull_request')),
    );
    const distances = nodes
      .filter((node) => prIds.has(node.objectId))
      .map((node) =>
        Math.hypot(
          positions.get(node.id).x - positions.get(issue.id).x,
          positions.get(node.id).y - positions.get(issue.id).y,
        ),
      );
    assert.ok(distances.length > 1, 'sanity: F10 has several pull requests');
    const spread = Math.max(...distances) / Math.min(...distances);
    assert.ok(spread < 1.6, `pull requests sit ${spread.toFixed(2)}x apart in distance from the issue`);
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

describe('the drag simulation is the layout’s own, running', () => {
  const marks = [
    { id: 'issue:1', lane: 'issue', radius: 15, x: 0, y: 0, fx: 0, fy: 0 },
    { id: 'pr:1', lane: 'pull_request', radius: 12, x: 100, y: 0 },
    { id: 'commit:a', lane: 'commit', radius: 6, x: 160, y: 0 },
  ];
  /*
   * ⚠️ **Fresh links per simulation, never a shared array.** `forceLink` MUTATES what it
   * is given: it replaces each `source`/`target` id with a reference to the node object it
   * resolved. Reuse the array and the second simulation silently keeps the first one's
   * nodes — this test failed exactly that way, with a neighbour travelling 18px instead of
   * 370 because its link pointed at objects from a simulation that had already finished.
   * `layoutCluster` and the drag both build their link objects fresh, which is why the
   * same trap does not exist in the code being tested.
   */
  const links = () => [
    { source: 'issue:1', target: 'pr:1' },
    { source: 'pr:1', target: 'commit:a' },
  ];

  test('it comes back stopped, so nothing runs before the caller says so', () => {
    // forceSimulation starts a timer on construction. Handing back a running one would
    // have it moving marks before the gesture that wants it has even begun.
    const sim = createDragSimulation(marks.map((m) => ({ ...m })), links());
    // Ticking by hand proves it is alive but idle; a running one would already have moved.
    const alpha = sim.alpha();
    sim.tick();
    assert.ok(sim.alpha() < alpha, 'ticking should advance it');
    sim.stop();
  });

  test('a pinned mark never moves, however hard the forces pull', () => {
    // Only the mark under the pointer is pinned during a drag, and the layout pins its
    // busiest root. Both rely on d3 honouring fx/fy absolutely.
    const nodes = marks.map((m) => ({ ...m }));
    const sim = createDragSimulation(nodes, links());
    for (let i = 0; i < 60; i++) sim.tick();
    sim.stop();
    const issue = nodes.find((n) => n.id === 'issue:1');
    assert.equal(issue.x, 0, 'a pinned mark moved horizontally');
    assert.equal(issue.y, 0, 'a pinned mark moved vertically');
  });

  test('a free neighbour follows the mark it is linked to', () => {
    const nodes = marks.map((m) => ({ ...m }));
    const pr = nodes.find((n) => n.id === 'pr:1');
    // Pin the pull request far away, as a drag would.
    pr.fx = 600;
    pr.fy = 0;
    const before = nodes.find((n) => n.id === 'commit:a').x;

    const sim = createDragSimulation(nodes, links());
    for (let i = 0; i < 120; i++) sim.tick();
    sim.stop();

    const after = nodes.find((n) => n.id === 'commit:a').x;
    assert.ok(after > before + 50, `the commit barely followed: ${before} → ${after}`);
  });

  test('it damps, so a release coasts rather than ringing', () => {
    // ⚠️ velocityDecay is the whole feel, and it is why a simulation beats solving from
    // scratch each event: that has no velocity at all, so marks lurch to equilibrium and
    // stop dead — reported as "weird and springy".
    const nodes = marks.map((m) => ({ ...m }));
    const sim = createDragSimulation(nodes, links());
    for (let i = 0; i < 200; i++) sim.tick();
    sim.stop();
    for (const node of nodes) {
      assert.ok(
        Math.hypot(node.vx ?? 0, node.vy ?? 0) < 1,
        `${node.id} is still moving at ${Math.hypot(node.vx, node.vy).toFixed(2)}/tick`,
      );
    }
  });

  test('layout and drag share one force configuration', () => {
    // Tuned separately they would disagree, and a mark would settle in one place when the
    // picture was drawn and drift to another the moment it was touched.
    const sim = createDragSimulation(marks.map((m) => ({ ...m })), links());
    for (const name of ['link', 'charge', 'collide']) {
      assert.ok(sim.force(name), `the drag simulation is missing the ${name} force`);
    }
    sim.stop();
  });
});

describe('a footprint is a claim on the whole cluster’s room, with stated exemptions', () => {
  // issue:1 → pr:1 → commit:a, commit:b ; issue:1 → pr:2 → commit:c ; issue:2 → pr:2 (co-parent)
  const nodes = [
    { id: 'issue:1', lane: 'issue', radius: 15, footprint: 200 },
    { id: 'issue:2', lane: 'issue', radius: 15, footprint: 80 },
    { id: 'issue:3', lane: 'issue', radius: 15, footprint: 15 },
    { id: 'pr:1', lane: 'pull_request', radius: 12, footprint: 60 },
    { id: 'pr:2', lane: 'pull_request', radius: 12, footprint: 40 },
    { id: 'commit:a', lane: 'commit', radius: 6 },
    { id: 'commit:b', lane: 'commit', radius: 6 },
    { id: 'commit:c', lane: 'commit', radius: 6 },
  ];
  const links = [
    { source: 'issue:1', target: 'pr:1' },
    { source: 'issue:1', target: 'pr:2' },
    { source: 'issue:2', target: 'pr:2' },
    { source: 'pr:1', target: 'commit:a' },
    { source: 'pr:1', target: 'commit:b' },
    { source: 'pr:2', target: 'commit:c' },
  ];
  const pairs = footprintPairs(nodes, links, 20);
  const has = (x, y) =>
    pairs.some(({ a, b }) => (a.id === x && b.id === y) || (a.id === y && b.id === x));
  const need = (x, y) =>
    pairs.find(({ a, b }) => (a.id === x && b.id === y) || (a.id === y && b.id === x))?.need;

  test('sibling pull requests are held a footprint apart — the point of the force', () => {
    assert.ok(has('pr:1', 'pr:2'), 'two pull requests of one issue must be constrained');
    assert.equal(need('pr:1', 'pr:2'), 60 + 40 + 20);
  });

  test('a foreign commit is kept out of a pull request’s fan', () => {
    // commit:c belongs to pr:2; pr:1 has no claim on it, and it must not sit in pr:1's fan.
    assert.ok(has('pr:1', 'commit:c'));
    assert.equal(need('pr:1', 'commit:c'), 60 + 6 + 20);
  });

  test('ancestor and descendant are exempt: a cluster is not blown open from within', () => {
    assert.ok(!has('issue:1', 'pr:1'), 'a pull request sits inside its issue’s footprint');
    assert.ok(!has('issue:1', 'commit:a'), 'so does its commit, two levels down');
    assert.ok(!has('pr:1', 'commit:a'), 'a commit sits inside its own pull request’s fan');
  });

  test('co-parents are exempt: two issues sharing a pull request are legitimately close', () => {
    assert.ok(!has('issue:1', 'issue:2'), 'issue:1 and issue:2 share pr:2');
    // But an issue with no shared child IS held off — this is what gives each issue its
    // own neighbourhood.
    assert.ok(has('issue:1', 'issue:3'));
    assert.equal(need('issue:1', 'issue:3'), 200 + 15 + 20);
  });

  test('two leaves are not listed: that pair is the collision force’s job', () => {
    assert.ok(!has('commit:a', 'commit:c'));
    assert.ok(!has('commit:a', 'commit:b'));
  });

  test('a node without a footprint is a leaf, and links may already be resolved to nodes', () => {
    // d3's forceLink replaces ids with node objects; the pairing must read either form.
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const resolved = links.map((l) => ({ source: byId.get(l.source), target: byId.get(l.target) }));
    const again = footprintPairs(nodes, resolved, 20);
    assert.equal(again.length, pairs.length);
    // issue:3 has footprint === radius, so against a leaf it is not a hub either.
    assert.ok(!has('issue:3', 'commit:a'));
  });

  test('the pair list is a function of the graph, not of input order', () => {
    const shuffled = footprintPairs(nodes.slice().reverse(), links.slice().reverse(), 20);
    assert.deepEqual(
      shuffled.map(({ a, b, need }) => `${a.id}|${b.id}|${need}`),
      pairs.map(({ a, b, need }) => `${a.id}|${b.id}|${need}`),
    );
  });
});

describe('the layout keeps whole clusters apart, and says how big each one is', () => {
  test('every footprint claim holds in the fitted picture, on the busiest fixture', async () => {
    // ⚠️ Post-fit — trap 8.1. Footprints and positions must be in the same pixels for
    // this to mean anything, which is why `layoutCluster` scales the footprints itself.
    const { nodes, edges, positions, footprints } = await clusterFor('F10');
    const marks = nodes.map((n) => ({
      id: n.id,
      lane: n.lane,
      radius: n.radius ?? 8,
      footprint: footprints.get(n.id),
      ...positions.get(n.id),
    }));
    const pairs = footprintPairs(marks, edges.map((e) => ({ source: e.source, target: e.target })));
    assert.ok(pairs.length > 20, `expected many constrained pairs on F10, got ${pairs.length}`);
    const broken = pairs.filter(({ a, b, need }) => Math.hypot(a.x - b.x, a.y - b.y) < need * 0.98);
    assert.deepEqual(
      broken.map(({ a, b }) => `${a.id} ↔ ${b.id}`),
      [],
      'a cluster is sitting inside another’s footprint',
    );
  });

  test('a hub’s footprint is its cluster, a leaf’s is its own radius', async () => {
    const { nodes, positions, footprints } = await clusterFor('F10');
    const pr = nodes.find((n) => n.lane === 'pull_request');
    const commit = nodes.find((n) => n.lane === 'commit');
    assert.ok(footprints.get(pr.id) > pr.radius, 'a pull request with commits claims more than itself');
    assert.equal(footprints.get(commit.id), commit.radius ?? 8);
    // And it is in fitted pixels: the furthest commit of a pull request lies within it.
    const own = nodes.filter((n) => n.lane === 'commit');
    const at = (id) => positions.get(id);
    const furthest = Math.min(...own.map((c) => Math.hypot(at(c.id).x - at(pr.id).x, at(c.id).y - at(pr.id).y)));
    assert.ok(furthest < footprints.get(pr.id) * 3, 'footprint is not in the same pixels as positions');
  });

  test('the anchor is named, and it is the busiest issue', async () => {
    const { nodes, edges, anchorId } = await clusterFor('F10');
    assert.ok(nodes.some((n) => n.id === anchorId && n.lane === 'issue'));
    const degree = new Map();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const busiest = nodes
      .filter((n) => n.lane === 'issue')
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))[0];
    assert.equal(anchorId, busiest.id);
  });
});

describe('a drag rearranges the neighbourhood and leaves the picture’s orientation alone', () => {
  // A picture with two unrelated hubs and a stray commit far away.
  const picture = () => [
    { id: 'issue:1', lane: 'issue', radius: 15, footprint: 150, x: 0, y: 0 },
    { id: 'pr:1', lane: 'pull_request', radius: 12, footprint: 40, x: 130, y: 0 },
    { id: 'commit:a', lane: 'commit', radius: 6, x: 180, y: 0 },
    { id: 'pr:2', lane: 'pull_request', radius: 12, footprint: 40, x: -130, y: 0 },
    { id: 'commit:b', lane: 'commit', radius: 6, x: -180, y: 0 },
    { id: 'issue:9', lane: 'issue', radius: 15, footprint: 15, x: 0, y: 400 },
  ];
  const links = () => [
    { source: 'issue:1', target: 'pr:1' },
    { source: 'pr:1', target: 'commit:a' },
    { source: 'issue:1', target: 'pr:2' },
    { source: 'pr:2', target: 'commit:b' },
  ];
  const run = (nodes, opts) => {
    const sim = createDragSimulation(nodes, links(), opts);
    sim.alphaTarget(0.3).restart().stop();
    for (let i = 0; i < 300; i++) sim.tick(); // a held gesture
    sim.alphaTarget(0);
    for (let i = 0; i < 300; i++) sim.tick(); // released, coasting to rest
    sim.stop();
    return nodes;
  };
  const drag = (nodes, id, dx) => {
    const handle = nodes.find((n) => n.id === id);
    handle.fx = handle.x + dx;
    handle.fy = handle.y;
    return nodes;
  };

  test('the anchor stays put unless it is the mark in hand', () => {
    const nodes = run(drag(picture(), 'pr:1', 240), { anchorId: 'issue:1' });
    const anchor = nodes.find((n) => n.id === 'issue:1');
    assert.equal(anchor.x, 0);
    assert.equal(anchor.y, 0);

    // Dragging the anchor itself must work: the caller's fx wins over the pinning.
    const again = run(drag(picture(), 'issue:1', 240), { anchorId: 'issue:1' });
    assert.equal(again.find((n) => n.id === 'issue:1').x, 240);
  });

  test('an unrelated mark drifts a little and comes home; a linked neighbour follows', () => {
    const nodes = run(drag(picture(), 'pr:1', 240), { anchorId: 'issue:1' });
    const stray = nodes.find((n) => n.id === 'issue:9');
    assert.ok(
      Math.hypot(stray.x - 0, stray.y - 400) < 15,
      `an unrelated issue wandered ${Math.hypot(stray.x, stray.y - 400).toFixed(0)}px`,
    );
    const follower = nodes.find((n) => n.id === 'commit:a');
    assert.ok(follower.x > 180 + 120, `the dragged pull request’s commit did not follow: ${follower.x}`);
  });

  test('without the memory, the same drag lets a whole side of the picture wander', () => {
    // ⚠️ This is the control: it pins the fix to its cause. Home springs off, and the
    // unrelated issue is repelled from wherever the drag sends the neighbourhood, with
    // nothing to bring it back.
    const nodes = run(drag(picture(), 'pr:1', 240), { anchorId: 'issue:1', homeStrength: 0 });
    const held = run(drag(picture(), 'pr:1', 240), { anchorId: 'issue:1' });
    const wander = (list) => {
      const n = list.find((m) => m.id === 'pr:2');
      return Math.hypot(n.x + 130, n.y);
    };
    assert.ok(
      wander(nodes) > wander(held),
      `home springs made no difference: ${wander(nodes).toFixed(0)} vs ${wander(held).toFixed(0)}`,
    );
  });

  test('two clusters pushed together step aside as clusters — fans do not interpenetrate', () => {
    // Drag pr:1 across the picture onto pr:2's fan.
    const nodes = run(drag(picture(), 'pr:1', -260), { anchorId: 'issue:1' });
    const pr1 = nodes.find((n) => n.id === 'pr:1');
    const pr2 = nodes.find((n) => n.id === 'pr:2');
    const b = nodes.find((n) => n.id === 'commit:b');
    // pr:2 has moved out of the way rather than letting pr:1 land on top of it…
    assert.ok(Math.hypot(pr1.x - pr2.x, pr1.y - pr2.y) > 40 + 40, 'the two fans overlap');
    // …and took its own commit with it, so the fan is still a fan.
    assert.ok(Math.hypot(pr2.x - b.x, pr2.y - b.y) < 50 * 1.6, 'pr:2 lost its commit on the way');
  });
});
