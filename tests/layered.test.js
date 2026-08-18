import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadObjectGraph } from '../src/data/loadObjectGraph.js';
import { indexObjectGraph } from '../src/model/objectGraph.js';
import { deriveBursts } from '../src/model/bursts.js';
import { LANE_TYPES } from '../src/model/activities.js';
import { buildStructuralNodes, buildStructuralEdges } from '../src/layout/structural.js';
import {
  layoutLayered,
  assignLayers,
  orderLayers,
  positionLayers,
  countCrossings,
  totalCrossings,
  dedupeEdges,
  insertDummies,
  LAYER_ORDER,
} from '../src/layout/layered.js';

/**
 * The layered layout behind the off time mode.
 *
 * The properties that matter are the ones a force layout could not give: rows are a
 * *rule* rather than an accident, the arrangement is a pure function of the graph, and a
 * commit claimed by two pull requests sits between them instead of being duplicated.
 */

const fileTransport = async (query) =>
  JSON.parse(
    await readFile(new URL(`./fixtures/${query.fixture || 'F1'}.json`, import.meta.url), 'utf8'),
  );

const BOX = { width: 1100, height: 620, padding: 60 };

async function layeredFor(fixture, { expandedBursts = new Set() } = {}) {
  const graph = await loadObjectGraph({ fixture }, { transport: fileTransport });
  const index = indexObjectGraph(graph);
  const bursts = deriveBursts(index.objectsOfType('commit'));
  const nodes = buildStructuralNodes({ index, bursts, expandedBursts, laneTypes: LANE_TYPES });
  const edges = buildStructuralEdges(graph.links, nodes);
  return { graph, index, bursts, nodes, edges, ...layoutLayered(nodes, edges, BOX) };
}

const nodeAt = (positions, node) => positions.get(node.id);

describe('rows are a rule, not an accident', () => {
  test('every issue sits above every pull request, which sits above every commit', async () => {
    for (const fixture of ['F1', 'F10', 'F13']) {
      const { nodes, positions } = await layeredFor(fixture);
      const yOf = (lane) =>
        nodes.filter((node) => node.lane === lane).map((node) => nodeAt(positions, node).y);

      const issues = yOf('issue');
      const prs = yOf('pull_request');
      const commits = yOf('commit');

      if (issues.length && prs.length) {
        assert.ok(Math.max(...issues) < Math.min(...prs), `${fixture}: an issue is not above a PR`);
      }
      if (prs.length && commits.length) {
        assert.ok(
          Math.max(...prs) < Math.min(...commits),
          `${fixture}: a PR is not above a commit`,
        );
      }
    }
  });

  test('every node in a row shares exactly one y', async () => {
    const { nodes, positions } = await layeredFor('F10');
    for (const lane of LAYER_ORDER) {
      const ys = new Set(
        nodes.filter((node) => node.lane === lane).map((node) => nodeAt(positions, node).y),
      );
      assert.ok(ys.size <= 1, `${lane} is spread across ${ys.size} heights; a row is one height`);
    }
  });

  test('the row order is the timeline lane order, so the reader can carry it across', () => {
    assert.deepEqual(LAYER_ORDER, LANE_TYPES);
  });

  test('an empty row takes no space rather than leaving a gap', async () => {
    // F6 has no commits. Two rows, not three with a hole where the third would be.
    const { nodes } = await layeredFor('F6');
    assert.equal(nodes.filter((node) => node.lane === 'commit').length, 0, 'sanity: F6 has none');
    const rows = assignLayers(nodes);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.length > 0));
  });
});

describe('the layout is a pure function of the graph', () => {
  test('the same sub-log lays out bit-identically every time', async () => {
    const first = await layeredFor('F13');
    const second = await layeredFor('F13');
    for (const node of first.nodes) {
      const a = nodeAt(first.positions, node);
      const b = nodeAt(second.positions, node);
      assert.equal(a.x, b.x, `${node.id} moved horizontally between runs`);
      assert.equal(a.y, b.y, `${node.id} moved vertically between runs`);
    }
  });

  test('the order nodes and edges arrive in cannot change the result', async () => {
    const { nodes, edges } = await layeredFor('F10');
    const forwards = layoutLayered(nodes, edges, BOX);
    const backwards = layoutLayered(nodes.slice().reverse(), edges.slice().reverse(), BOX);
    for (const node of nodes) {
      assert.equal(
        nodeAt(forwards.positions, node).x,
        nodeAt(backwards.positions, node).x,
        `${node.id} depends on input order`,
      );
    }
  });

  test('no warm start is needed, because there is no state to carry', async () => {
    // The force layout it replaces had to be fed its own previous output to stay still.
    // A pure function of the graph cannot drift, so the whole mechanism is gone.
    const { nodes, edges } = await layeredFor('F1');
    const a = layoutLayered(nodes, edges, BOX);
    const b = layoutLayered(nodes, edges, BOX);
    assert.deepEqual([...a.positions.entries()], [...b.positions.entries()]);
  });
});

describe('marks do not overlap and stay inside the box', () => {
  test('nothing in a row touches its neighbour', async () => {
    for (const fixture of ['F1', 'F10', 'F13']) {
      const { nodes, positions } = await layeredFor(fixture);
      for (const lane of LAYER_ORDER) {
        const row = nodes
          .filter((node) => node.lane === lane)
          .sort((a, b) => nodeAt(positions, a).x - nodeAt(positions, b).x);
        for (let i = 1; i < row.length; i++) {
          const gap =
            nodeAt(positions, row[i]).x -
            nodeAt(positions, row[i - 1]).x -
            row[i].radius -
            row[i - 1].radius;
          assert.ok(gap > 0, `${fixture}/${lane}: ${row[i].id} overlaps ${row[i - 1].id}`);
        }
      }
    }
  });

  test('nothing escapes the drawing box', async () => {
    for (const fixture of ['F1', 'F10', 'F13']) {
      const { nodes, positions } = await layeredFor(fixture);
      for (const node of nodes) {
        const { x, y } = nodeAt(positions, node);
        assert.ok(x - node.radius >= 0, `${fixture}: ${node.id} runs off the left`);
        assert.ok(x + node.radius <= BOX.width, `${fixture}: ${node.id} runs off the right`);
        assert.ok(y >= 0 && y <= BOX.height, `${fixture}: ${node.id} is outside vertically`);
      }
    }
  });

  test('a row too crowded to fit tightens its gaps rather than reordering or truncating', () => {
    // Density is a legible complaint; a reordered or silently shortened row is a wrong
    // picture. 60 commits in a 400px box cannot all have their preferred spacing.
    const nodes = Array.from({ length: 60 }, (_, i) => ({
      id: `n_commit:${String(i).padStart(3, '0')}`,
      lane: 'commit',
      radius: 6.5,
      t: new Date(2025, 0, 1 + i),
    }));
    const { positions, rows } = layoutLayered(nodes, [], {
      width: 400,
      height: 300,
      padding: 20,
    });
    assert.equal(positions.size, 60, 'every node must still be placed');
    const order = rows[0].map((node) => node.id);
    assert.deepEqual(order, [...order].sort(), 'the row order must survive the squeeze');
  });

  test('a wide row hanging off one hub is compressed INTO the box, gaps and order intact', () => {
    // ⚠️ The case the previous test does not cover: a row that fits at minimum spacing
    // but has been spread wider than the box by alignment. kubernetes #68026 — one issue,
    // 34 pull requests — came out 1400px wide in a 980px box with the leftmost mark on
    // the edge, so nothing could slide and the right-hand third was simply lost. Off mode
    // cannot scroll sideways; what runs off is gone. The forward chain only closes gaps
    // that are too small, so the fix is the right-to-left sweep `separateRow` always
    // said it had.
    const box = { width: 1100, height: 620, padding: 60 };
    const issue = { id: 'n_issue:1', lane: 'issue', radius: 15 };
    const prs = Array.from({ length: 34 }, (_, i) => ({
      id: `n_pr:${String(i).padStart(2, '0')}`,
      lane: 'pull_request',
      radius: 12,
    }));
    // The trigger is an ORDER-versus-ALIGNMENT conflict: a commit shared by a pull
    // request near the left end of the row and one near the right end sits in the middle,
    // so the upward alignment pass drags the left-hand owner toward the centre while the
    // ordering keeps it second from the left — and the forward chain then pushes the other
    // 32 marks after it. Sharing between the very first mark and the last does not
    // trigger it (the first has nothing to its left to conflict with); second and last do.
    const commit = { id: 'n_commit:a', lane: 'commit', radius: 6.5 };
    const edges = [
      ...prs.map((pr) => ({ source: issue.id, target: pr.id })),
      { source: prs[1].id, target: commit.id },
      { source: prs[33].id, target: commit.id },
    ];
    const { positions, rows } = layoutLayered([issue, ...prs, commit], edges, box);

    const row = rows.find((r) => r[0].lane === 'pull_request');
    const xs = row.map((node) => positions.get(node.id).x);
    assert.ok(
      Math.min(...xs) - 12 >= box.padding - 0.5 && Math.max(...xs) + 12 <= box.width - box.padding + 0.5,
      `the row runs from ${Math.min(...xs).toFixed(0)} to ${Math.max(...xs).toFixed(0)} in a box of ${box.width}`,
    );
    for (let i = 1; i < xs.length; i++) {
      assert.ok(xs[i] - xs[i - 1] >= 24 + 2 - 1e-6, `marks ${i - 1} and ${i} are ${(xs[i] - xs[i - 1]).toFixed(1)}px apart`);
    }
    assert.deepEqual(
      row.map((n) => n.id),
      [...row.map((n) => n.id)].sort(),
      'compression must not reorder the row',
    );
  });
});

describe('crossing minimisation', () => {
  test('it counts a crossing when endpoints are in opposite order', () => {
    const upper = [{ id: 'a' }, { id: 'b' }];
    const lower = [{ id: 'x' }, { id: 'y' }];
    // a→y and b→x cross; a→x and b→y do not.
    assert.equal(
      countCrossings(upper, lower, [
        { source: 'a', target: 'y' },
        { source: 'b', target: 'x' },
      ]),
      1,
    );
    assert.equal(
      countCrossings(upper, lower, [
        { source: 'a', target: 'x' },
        { source: 'b', target: 'y' },
      ]),
      0,
    );
  });

  test('ordering reduces crossings on a deliberately tangled graph', () => {
    // Three PRs whose commits are listed in the reverse order, so the initial
    // arrangement crosses and a barycentre sweep can untangle it completely.
    const prs = ['pr:1', 'pr:2', 'pr:3'].map((id, i) => ({
      id,
      lane: 'pull_request',
      radius: 10,
      t: new Date(2025, 0, 1 + i),
    }));
    const commits = ['commit:c', 'commit:b', 'commit:a'].map((id, i) => ({
      id,
      lane: 'commit',
      radius: 6,
      t: new Date(2025, 0, 1 + i),
    }));
    const edges = [
      { source: 'pr:1', target: 'commit:a' },
      { source: 'pr:2', target: 'commit:b' },
      { source: 'pr:3', target: 'commit:c' },
    ];

    const rows = assignLayers([...prs, ...commits]);
    const before = totalCrossings(rows, edges);
    const { crossings } = orderLayers(rows, edges);
    assert.ok(before > 0, 'sanity: the starting arrangement must actually cross');
    assert.equal(crossings, 0, 'a sweep must untangle a graph this simple');
  });

  test('it never returns an arrangement worse than the one it started from', async () => {
    // Barycentre sweeps are not monotonic — they can make things worse before better —
    // so the best arrangement SEEN is kept, not the last one computed.
    for (const fixture of ['F1', 'F10', 'F13']) {
      const { nodes, edges } = await layeredFor(fixture);
      const start = assignLayers(nodes);
      const before = totalCrossings(start, edges);
      const { crossings } = orderLayers(start, edges);
      assert.ok(crossings <= before, `${fixture}: ordering made it worse (${before} → ${crossings})`);
    }
  });
});

describe('what the layers are for', () => {
  test('a commit shared by two pull requests sits between them (F13)', async () => {
    // The case the mode was illustrated with, and the reason this is a layered graph
    // rather than a tree: a tree would have to duplicate this commit or drop an edge.
    const { graph, nodes, positions } = await layeredFor('F13');

    const prIds = new Set(
      nodes.filter((node) => node.lane === 'pull_request').map((node) => node.objectId),
    );
    const prsOfCommit = new Map();
    for (const link of graph.links) {
      for (const [a, b] of [
        [link.source, link.target],
        [link.target, link.source],
      ]) {
        if (!prIds.has(a)) continue;
        if (!prsOfCommit.has(b)) prsOfCommit.set(b, new Set());
        prsOfCommit.get(b).add(a);
      }
    }

    const sharedId = [...prsOfCommit.entries()].find(([, prs]) => prs.size > 1)?.[0];
    assert.ok(sharedId, 'sanity: F13 must contain a commit claimed by two pull requests');

    const shared = nodes.find((node) => node.objectId === sharedId);
    const owners = [...prsOfCommit.get(sharedId)].map((id) =>
      nodes.find((node) => node.objectId === id),
    );
    assert.equal(owners.length, 2);

    const sharedX = nodeAt(positions, shared).x;
    const [left, right] = owners.map((pr) => nodeAt(positions, pr).x).sort((a, b) => a - b);
    assert.ok(
      sharedX >= left - 1 && sharedX <= right + 1,
      `the shared commit sits at ${sharedX.toFixed(0)}, outside its PRs at ${left.toFixed(0)}–${right.toFixed(0)}`,
    );

    // And it is still one node, not two.
    assert.equal(nodes.filter((node) => node.objectId === sharedId).length, 1);
  });

  test("a pull request's commits form one contiguous block, and the blocks run in PR order", async () => {
    /*
     * ⚠️ **This replaces a test that asserted the wrong thing**, and the wrong thing was
     * plausible: "a commit sits nearer the pull request that carries it than to any
     * other". No layout can promise that, and F10 disproved it — PR #1002's group of
     * commits is *wide*, so its leftmost member is unavoidably nearer the neighbouring
     * pull request's centre than its own. The edge says which PR it belongs to; distance
     * to a centre is not the claim being made.
     *
     * Contiguity is the property that actually matters, and it is stronger: if a PR's
     * commits are interrupted by another PR's, the edges must cross, and the reader can
     * no longer see a pull request's work as one thing. Measured on F10 the commit row
     * reads 0×8, 1×8, 2×8 with zero crossings.
     */
    for (const fixture of ['F10', 'F13']) {
      const { nodes, edges, positions } = await layeredFor(fixture);

      const prRow = nodes
        .filter((node) => node.lane === 'pull_request')
        .sort((a, b) => nodeAt(positions, a).x - nodeAt(positions, b).x);
      const commitRow = nodes
        .filter((node) => node.lane === 'commit')
        .sort((a, b) => nodeAt(positions, a).x - nodeAt(positions, b).x);
      assert.ok(prRow.length > 1, `sanity: ${fixture} needs several pull requests`);

      // Which pull requests claim each commit-row node. A shared commit has several.
      const owners = new Map();
      for (const edge of edges) {
        for (const [a, b] of [
          [edge.source, edge.target],
          [edge.target, edge.source],
        ]) {
          const from = nodes.find((node) => node.id === a);
          const to = nodes.find((node) => node.id === b);
          if (from?.lane !== 'pull_request' || to?.lane !== 'commit') continue;
          if (!owners.has(b)) owners.set(b, new Set());
          owners.get(b).add(prRow.findIndex((pr) => pr.id === a));
        }
      }

      // Walk the row: once a pull request's block has ended, it may not start again.
      const finished = new Set();
      let previous = null;
      for (const node of commitRow) {
        const claim = owners.get(node.id);
        if (!claim || claim.size === 0) continue;
        const key = [...claim].sort().join('/');
        if (previous !== null && key !== previous) {
          for (const pr of previous.split('/').map(Number)) {
            if (!claim.has(pr)) finished.add(pr);
          }
        }
        for (const pr of claim) {
          assert.ok(
            !finished.has(pr),
            `${fixture}: pull request ${prRow[pr]?.title} has commits on both sides of another's`,
          );
        }
        previous = key;
      }
    }
  });

  test('the layout leaves no crossings at all on the fixtures', async () => {
    // Not a bound but the actual measured figure, so a regression is visible rather than
    // absorbed by a generous threshold.
    for (const fixture of ['F1', 'F10', 'F13']) {
      const { crossings } = await layeredFor(fixture);
      assert.equal(crossings, 0, `${fixture} lays out with ${crossings} crossings`);
    }
  });

  test('expanding a push cannot move the rows above it', async () => {
    // The stability requirement, and layers give it for free where the force layout
    // needed a warm start: the issue and PR rows do not depend on the commit row's size.
    const { bursts } = await layeredFor('F10');
    const folded = await layeredFor('F10');
    const expanded = await layeredFor('F10', { expandedBursts: new Set([bursts[0].id]) });

    for (const lane of ['issue', 'pull_request']) {
      for (const node of folded.nodes.filter((n) => n.lane === lane)) {
        const after = expanded.nodes.find((n) => n.id === node.id);
        assert.ok(after, `${node.id} vanished when a push was expanded`);
        assert.equal(
          nodeAt(folded.positions, node).y,
          nodeAt(expanded.positions, after).y,
          `${node.id} changed row when a push was expanded`,
        );
      }
    }
  });

  test('an empty graph and a single node are both handled', () => {
    assert.equal(layoutLayered([], [], BOX).positions.size, 0);
    const one = layoutLayered([{ id: 'n_issue:1', lane: 'issue', radius: 13, t: new Date() }], [], BOX);
    assert.equal(one.positions.size, 1);
    const at = one.positions.get('n_issue:1');
    assert.ok(Number.isFinite(at.x) && Number.isFinite(at.y));
  });
});

describe('positionLayers on its own', () => {
  test('a lone row is centred vertically rather than pinned to the top', () => {
    const row = [{ id: 'a', lane: 'commit', radius: 6, t: new Date() }];
    const positions = positionLayers([row], [], { width: 400, height: 300, padding: 20 });
    assert.equal(positions.get('a').y, 150);
  });

  test('rows are spread evenly between the paddings', () => {
    const rows = [
      [{ id: 'i', lane: 'issue', radius: 13 }],
      [{ id: 'p', lane: 'pull_request', radius: 10 }],
      [{ id: 'c', lane: 'commit', radius: 6 }],
    ];
    const positions = positionLayers(rows, [], { width: 400, height: 320, padding: 20 });
    assert.equal(positions.get('i').y, 20);
    assert.equal(positions.get('p').y, 160);
    assert.equal(positions.get('c').y, 300);
  });
});

describe('the drawing sits in the middle of its canvas', () => {
  test('a small sub-log is centred, not jammed against an edge', async () => {
    // ⚠️ Found by looking at F13, not by a check. Repeated barycentre alignment is a
    // contraction — averaging pulls everything toward a common x with nothing pushing
    // outwards — so a small graph collapsed into a narrow column wherever the averaging
    // happened to converge, which was the right-hand quarter of an empty canvas.
    for (const fixture of ['F1', 'F13']) {
      const { nodes, positions } = await layeredFor(fixture);
      const xs = nodes.map((node) => nodeAt(positions, node).x);
      const centre = (Math.min(...xs) + Math.max(...xs)) / 2;
      assert.ok(
        Math.abs(centre - BOX.width / 2) < 2,
        `${fixture}: the drawing is centred on ${centre.toFixed(0)}, not ${BOX.width / 2}`,
      );
    }
  });

  test('a compact graph grows into the space but stays grouped', async () => {
    const { nodes, positions } = await layeredFor('F13');
    const xs = nodes.map((node) => nodeAt(positions, node).x);
    const span = Math.max(...xs) - Math.min(...xs);
    assert.ok(span > 200, `F13 collapsed to ${span.toFixed(0)}px and is lost on the canvas`);
    assert.ok(
      span < BOX.width - 2 * BOX.padding,
      'a small graph must not be stretched to the full width, or proximity stops meaning anything',
    );
  });

  test('filling never reintroduces an overlap', async () => {
    // It only ever scales up, so gaps can only grow — asserted rather than argued.
    for (const fixture of ['F1', 'F10', 'F13']) {
      const { nodes, positions } = await layeredFor(fixture);
      for (const lane of LAYER_ORDER) {
        const row = nodes
          .filter((node) => node.lane === lane)
          .sort((a, b) => nodeAt(positions, a).x - nodeAt(positions, b).x);
        for (let i = 1; i < row.length; i++) {
          const gap =
            nodeAt(positions, row[i]).x -
            nodeAt(positions, row[i - 1]).x -
            row[i].radius -
            row[i - 1].radius;
          assert.ok(gap > 0, `${fixture}/${lane}: filling pushed ${row[i].id} into its neighbour`);
        }
      }
    }
  });
});

describe('the layout counts connections, not links', () => {
  test('a pair carrying six links is one connection', () => {
    // ⚠️ Measured on kubernetes #47532: 77 links over 43 distinct pairs, one pair carrying
    // six. Counting links inflated the crossing figure 4.5x (89 against 20) — but the
    // worse half is that the barycentre is an AVERAGE over neighbours, so that pair pulled
    // six times harder than a pair carrying one, and the ordering was being dragged around
    // by how many detection methods agreed rather than by the shape of the graph.
    const edges = [
      { source: 'a', target: 'b', evidence: 'validated' },
      { source: 'a', target: 'b', evidence: 'extracted' },
      { source: 'b', target: 'a', evidence: 'validated' },
      { source: 'a', target: 'c', evidence: 'validated' },
    ];
    const unique = dedupeEdges(edges);
    assert.equal(unique.length, 2, 'a→b in either direction is one connection');
  });

  test('deduping does not change which nodes are connected', async () => {
    const { nodes, edges } = await layeredFor('F10');
    const unique = dedupeEdges(edges);
    const pairs = (list) =>
      new Set(list.map((e) => [e.source, e.target].sort().join('||')));
    assert.deepEqual(pairs(unique), pairs(edges), 'no connection may be lost or invented');
    assert.ok(unique.length <= edges.length);
    assert.ok(nodes.length > 0);
  });
});

describe('edges that skip a row are routed, not driven through it', () => {
  const issue = { id: 'n_issue:1', lane: 'issue', radius: 15, t: new Date('2025-01-01') };
  const pr = { id: 'n_pr:1', lane: 'pull_request', radius: 12, t: new Date('2025-01-02') };
  const commit = { id: 'n_commit:a', lane: 'commit', radius: 6, t: new Date('2025-01-03') };

  test('an issue→commit edge gains a placeholder in the pull-request row', () => {
    const rows = assignLayers([issue, pr, commit]);
    const { rows: withDummies, segments, routeOf } = insertDummies(rows, [
      { source: 'n_issue:1', target: 'n_commit:a', key: 'k' },
    ]);

    assert.equal(withDummies[1].filter((node) => node.isDummy).length, 1, 'one placeholder');
    assert.equal(segments.length, 2, 'the long edge becomes two ordinary segments');
    assert.equal(routeOf.get('k').length, 1, 'and one waypoint to bend at');

    // The segments chain end to end through the placeholder.
    const dummyId = withDummies[1].find((node) => node.isDummy).id;
    assert.ok(segments.some((s) => s.source === 'n_issue:1' && s.target === dummyId));
    assert.ok(segments.some((s) => s.source === dummyId && s.target === 'n_commit:a'));
  });

  test('an edge between adjacent rows is left alone', () => {
    const rows = assignLayers([issue, pr, commit]);
    const { segments, routeOf } = insertDummies(rows, [
      { source: 'n_issue:1', target: 'n_pr:1', key: 'k' },
    ]);
    assert.equal(segments.length, 1);
    assert.equal(routeOf.size, 0, 'nothing to route');
  });

  test('placeholders are never handed to the renderer', async () => {
    // They stand for nothing in the data. Their positions survive as waypoints, which is
    // the only thing they were for.
    const { nodes, positions, rows } = await layeredFor('F1');
    assert.equal(positions.size, nodes.length, 'exactly the real nodes are positioned');
    for (const row of rows) {
      for (const node of row) assert.ok(!node.isDummy, 'a placeholder reached the drawing');
    }
  });

  test('the crossing count can finally see a skipping edge', () => {
    // Before this, crossings were only counted between ADJACENT rows, so an issue→commit
    // edge scored zero however badly it cut across the pull requests. kubernetes #47532
    // has eight such links and none of them was counted.
    const issues = [issue];
    const prs = ['a', 'b', 'c'].map((k, i) => ({
      id: `n_pr:${k}`,
      lane: 'pull_request',
      radius: 12,
      t: new Date(2025, 0, 2 + i),
    }));
    const commits = ['x', 'y'].map((k, i) => ({
      id: `n_commit:${k}`,
      lane: 'commit',
      radius: 6,
      t: new Date(2025, 0, 5 + i),
    }));

    const edges = [
      { source: 'n_issue:1', target: 'n_pr:a', key: '1' },
      { source: 'n_issue:1', target: 'n_pr:c', key: '2' },
      { source: 'n_pr:a', target: 'n_commit:x', key: '3' },
      { source: 'n_pr:c', target: 'n_commit:y', key: '4' },
      // The skipper.
      { source: 'n_issue:1', target: 'n_commit:y', key: '5' },
    ];

    const rows = assignLayers([...issues, ...prs, ...commits]);
    const plain = totalCrossings(rows, edges);
    const { segments } = insertDummies(rows, edges);
    const routed = totalCrossings(insertDummies(rows, edges).rows, segments);

    assert.ok(
      routed >= plain,
      'routing must expose crossings the flat count could not see, never hide them',
    );
    // And the routed form has something to say about the skipper at all.
    assert.ok(segments.length > edges.length, 'the skipper was split into segments');
  });

  test('a real sub-log routes its skipping edges', async () => {
    const { waypoints } = await layeredFor('F1');
    for (const [, points] of waypoints) {
      for (const point of points) {
        assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), 'a waypoint is a point');
      }
    }
  });
});
