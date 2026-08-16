import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadObjectGraph } from '../src/data/loadObjectGraph.js';
import { indexObjectGraph } from '../src/model/objectGraph.js';
import { deriveBursts } from '../src/model/bursts.js';
import { LANE_TYPES } from '../src/model/activities.js';
import {
  buildStructuralNodes,
  buildStructuralEdges,
  bundleEdges,
  edgeDirection,
  timeExtent,
  rampExtent,
  timeFraction,
  STRUCTURAL_RADIUS,
  burstRadius,
} from '../src/layout/structural.js';

/**
 * The off-mode node and edge model.
 *
 * The property under test throughout is that **one node is one object**, which is the
 * substantive difference from every other mode: the timeline draws one node per event in
 * the issue and PR lanes, and this does not.
 */

/** Read fixtures from disk, standing in for the browser's fetch transport. */
const fileTransport = async (query) => {
  const url = new URL(`./fixtures/${query.fixture || 'F1'}.json`, import.meta.url);
  return JSON.parse(await readFile(url, 'utf8'));
};

async function structuralFor(fixture, { expandedBursts = new Set() } = {}) {
  const graph = await loadObjectGraph({ fixture }, { transport: fileTransport });
  const index = indexObjectGraph(graph);
  const bursts = deriveBursts(index.objectsOfType('commit'));
  const nodes = buildStructuralNodes({ index, bursts, expandedBursts, laneTypes: LANE_TYPES });
  const edges = buildStructuralEdges(graph.links, nodes);
  return { graph, index, bursts, nodes, edges };
}

describe('one node stands for one object', () => {
  test('an object with many events contributes exactly one node (F1)', async () => {
    const { graph, index, nodes } = await structuralFor('F1');

    for (const type of ['issue', 'pull_request']) {
      const objects = index.objectsOfType(type);
      const laneNodes = nodes.filter((node) => node.lane === type);
      assert.equal(
        laneNodes.length,
        objects.length,
        `${type}: expected one node per object, got ${laneNodes.length} for ${objects.length}`,
      );
    }

    // And the point of the rule: the issue carries far more events than it has nodes.
    const issue = index.objectsOfType('issue')[0];
    assert.ok(
      index.eventsOf(issue.id).length > 1,
      'sanity: F1 issue must have several events for this to prove anything',
    );
    assert.equal(nodes.filter((node) => node.objectId === issue.id).length, 1);

    // Nothing may be dropped: every node resolves to an object in the bundle.
    const objectIds = new Set(graph.objects.map((object) => object.id));
    for (const node of nodes) {
      if (node.isBurst) continue;
      assert.ok(objectIds.has(node.objectId), `${node.id} names an object not in the bundle`);
    }
  });

  test('actors get no node — they have no lane, in any mode', async () => {
    const { index, nodes } = await structuralFor('F1');
    assert.ok(index.objectsOfType('actor').length > 0, 'sanity: F1 has actors');
    const actorIds = new Set(index.objectsOfType('actor').map((actor) => actor.id));
    for (const node of nodes) {
      assert.ok(!actorIds.has(node.objectId), `${node.id} is an actor and must not be a node`);
    }
  });

  test('the lifecycle is carried on the node, not thrown away', async () => {
    const { index, nodes } = await structuralFor('F9'); // opened, closed, reopened, closed
    const issue = index.objectsOfType('issue')[0];
    const node = nodes.find((candidate) => candidate.objectId === issue.id);

    const events = index.eventsOf(issue.id);
    const nonComments = events.filter((event) => !event.comment);
    assert.equal(node.lifecycle.length, nonComments.length, 'every non-comment event is carried');
    assert.equal(node.commentCount, events.length - nonComments.length);
    assert.equal(node.eventCount, events.length);

    // The hovercard lists these, so they must be in the order they happened.
    const times = node.lifecycle.map((entry) => +entry.time);
    assert.deepEqual(times, times.slice().sort((a, b) => a - b), 'lifecycle must be in time order');

    assert.ok(
      node.lifecycle.some((entry) => entry.activity === 'IssueReopened'),
      'F9 reopens, and the collapsed node must still be able to say so',
    );
  });

  test('comments are counted, never dropped and never their own node', async () => {
    const { index, nodes } = await structuralFor('F1');
    const totalComments = nodes.reduce((sum, node) => sum + node.commentCount, 0);
    const expected = [...index.objectsByType.keys()]
      .filter((type) => LANE_TYPES.includes(type))
      .flatMap((type) => index.objectsOfType(type))
      .flatMap((object) => index.eventsOf(object.id))
      .filter((event) => event.comment).length;
    assert.equal(totalComments, expected, 'every comment must be accounted for on some node');
    assert.ok(!nodes.some((node) => node.isComment), 'no node may be a comment in this mode');
  });

  test('a node knows when it first appeared and when it last did anything', async () => {
    const { index, nodes } = await structuralFor('F1');
    for (const node of nodes) {
      if (node.isBurst) continue;
      assert.ok(node.t, `${node.id} has no first instant, so the ramp cannot place it`);
      assert.ok(+node.tLast >= +node.t, `${node.id} ends before it starts`);
    }

    const pr = index.objectsOfType('pull_request')[0];
    const node = nodes.find((candidate) => candidate.objectId === pr.id);
    assert.equal(+node.t, +pr.intervals[0].start, 'a PR first appears when it was opened');
  });

  test('landmark and abandoned-outcome facts survive the collapse', async () => {
    const { index, nodes } = await structuralFor('F1');
    const pr = index.objectsOfType('pull_request')[0];
    const node = nodes.find((candidate) => candidate.objectId === pr.id);
    // F1's PR merges, so the node must carry the landmark that the timeline draws as a ring.
    assert.equal(node.landmark, true, 'a merged PR must still read as a landmark');
  });
});

describe('nothing collapses except by push_id', () => {
  /**
   * ⚠️ **The off mode introduces no folding rule of its own, and this pins that.**
   *
   * `push_id` is a fact in the data and decision 94 folds on it, always. Anything further
   * — clustering by PR, by time, by density — would be a *new* research decision about
   * what a mark means, not a rendering choice, and it would be invisible in a diff. The
   * arithmetic below is the whole of it, so a future "just group these too" has to break
   * a test and be argued for rather than slipped in.
   */
  test('every commit is either its own node or in exactly one folded push (F10)', async () => {
    const { index, bursts, nodes } = await structuralFor('F10');
    const commits = index.objectsOfType('commit');

    const foldedIds = new Set(bursts.flatMap((burst) => [...burst.commitIds]));
    const drawnIndividually = new Set(
      nodes.filter((node) => node.lane === 'commit' && !node.isBurst).map((node) => node.objectId),
    );

    for (const commit of commits) {
      const folded = foldedIds.has(commit.id);
      const drawn = drawnIndividually.has(commit.id);
      assert.ok(
        folded !== drawn,
        `${commit.id} must be exactly one of folded or drawn, not ${folded && drawn ? 'both' : 'neither'}`,
      );
    }

    // And the count follows from the push rule alone — no residue to explain.
    const pushSizes = new Map();
    for (const commit of commits) {
      const pushId = commit.vmap?.push_id;
      if (pushId == null) continue;
      pushSizes.set(pushId, (pushSizes.get(pushId) || 0) + 1);
    }
    const multiCommitPushes = [...pushSizes.values()].filter((size) => size > 1).length;
    const loneCommits = commits.length - [...pushSizes.values()].filter((s) => s > 1).reduce((a, b) => a + b, 0);

    const commitLaneNodes = nodes.filter((node) => node.lane === 'commit');
    assert.equal(
      commitLaneNodes.length,
      multiCommitPushes + loneCommits,
      'the commit-lane node count must be exactly (multi-commit pushes) + (commits in none)',
    );
    // The measured shape of F10, stated so a change to it is visible rather than silent.
    assert.equal(commits.length, 300);
    assert.equal(multiCommitPushes, 18);
    assert.equal(loneCommits, 6);
    assert.equal(commitLaneNodes.length, 24);
  });

  test('the only nodes that are not one-per-object are the folded pushes', async () => {
    const { index, nodes } = await structuralFor('F10');
    const objectNodes = nodes.filter((node) => !node.isBurst);
    const ids = objectNodes.map((node) => node.objectId);
    assert.equal(new Set(ids).size, ids.length, 'no object may be drawn twice');

    for (const node of objectNodes) {
      assert.ok(
        index.byId.has(node.objectId),
        `${node.id} is not a burst and must therefore name a real object`,
      );
    }
  });
});

describe('size encodes type, because the lanes are gone', () => {
  test('issue > pull request > commit', () => {
    assert.ok(STRUCTURAL_RADIUS.issue > STRUCTURAL_RADIUS.pull_request);
    assert.ok(STRUCTURAL_RADIUS.pull_request > STRUCTURAL_RADIUS.commit);
  });

  test('every node carries the radius the force simulation reads', async () => {
    const { nodes } = await structuralFor('F1');
    for (const node of nodes) {
      assert.ok(node.radius > 0, `${node.id} has no radius`);
    }
  });

  test('a burst grows with its commit count, sub-linearly', () => {
    assert.ok(burstRadius(20) > burstRadius(2), 'a bigger push must be a bigger node');
    assert.ok(burstRadius(20) < burstRadius(2) * 10, 'but not proportionally, or it swamps');
  });
});

describe('bursts fold, and folding moves the links with them', () => {
  test('a collapsed push is one node and its members are not drawn (F7)', async () => {
    const { bursts, nodes } = await structuralFor('F7');
    assert.ok(bursts.length > 0, 'sanity: F7 has bursts');

    const burstNodes = nodes.filter((node) => node.isBurst);
    assert.equal(burstNodes.length, bursts.length);

    const drawn = new Set(nodes.map((node) => node.objectId));
    for (const burst of bursts) {
      for (const commitId of burst.commitIds) {
        assert.ok(!drawn.has(commitId), `${commitId} is folded and must not be drawn separately`);
      }
    }
  });

  test('expanding one burst draws its members and leaves the others folded', async () => {
    const { bursts } = await structuralFor('F7');
    const [first] = bursts;
    const { nodes } = await structuralFor('F7', { expandedBursts: new Set([first.id]) });

    const drawn = new Set(nodes.map((node) => node.objectId));
    for (const commitId of first.commitIds) {
      assert.ok(drawn.has(commitId), `${commitId} was expanded and must be drawn`);
    }
    for (const burst of bursts.slice(1)) {
      assert.ok(!drawn.has([...burst.commitIds][0]), 'other bursts must stay folded');
    }
  });

  test('a link into a folded commit arrives at the push instead (F10)', async () => {
    // ⚠️ F10, not F7. F7 exercises burst *shape* and carries **no links at all**, so the
    // sanity check below caught it standing in for a property it cannot exhibit — the
    // failure mode `tests/fixtures/README.md` warns about, in the other direction.
    // F10 has 294 of its 303 links reaching a commit inside a collapsed push.
    const { graph, bursts, nodes, edges } = await structuralFor('F10');
    assert.ok(bursts.length > 0, 'sanity: F10 has bursts');

    const foldedIds = new Set(bursts.flatMap((burst) => [...burst.commitIds]));
    const linksIntoFolded = graph.links.filter(
      (link) => foldedIds.has(link.source) || foldedIds.has(link.target),
    );
    assert.ok(linksIntoFolded.length > 0, 'sanity: F10 must link to some folded commit');

    // Every edge must land on something that is actually drawn — that is what folding a
    // link means. A link resolving to nothing would silently never appear, which is the
    // wrong-picture-no-error failure decision 49 exists to catch one layer up.
    const nodeIds = new Set(nodes.map((node) => node.id));
    for (const edge of edges) {
      assert.ok(nodeIds.has(edge.source), `${edge.id} starts at a node that is not drawn`);
      assert.ok(nodeIds.has(edge.target), `${edge.id} ends at a node that is not drawn`);
    }

    // And specifically: a link naming a folded commit becomes an edge on its burst.
    const burstNodeIds = new Set(nodes.filter((node) => node.isBurst).map((node) => node.id));
    const sample = linksIntoFolded[0];
    const foldedEnd = foldedIds.has(sample.source) ? 'source' : 'target';
    const edge = edges.find((candidate) => candidate.link === sample);
    assert.ok(edge, 'a link into a folded commit must still produce an edge');
    assert.ok(
      burstNodeIds.has(edge[foldedEnd]),
      'the folded end must resolve to the push, not to the commit',
    );
  });

  test('a link whose both ends fold into the same push yields no edge', async () => {
    // A self-edge says nothing and cannot be drawn. Left in, it would also make the force
    // simulation pull a node toward itself, which is a silent NaN waiting to happen.
    const nodes = [
      {
        id: 'n_burst:1',
        objectId: 'burst:1',
        isBurst: true,
        burst: { commitIds: new Set(['commit:a', 'commit:b']) },
      },
    ];
    const edges = buildStructuralEdges(
      [{ source: 'commit:a', target: 'commit:b', evidence: 'validated', qualifier: 'x' }],
      nodes,
    );
    assert.equal(edges.length, 0);
  });

  test('a link to something not drawn yields no edge', async () => {
    const nodes = [{ id: 'n_pr:1', objectId: 'pr:1' }];
    const edges = buildStructuralEdges(
      [{ source: 'pr:1', target: 'issue:99', evidence: 'validated', qualifier: 'resolves' }],
      nodes,
    );
    assert.equal(edges.length, 0, 'an endpoint that is filtered out cannot be drawn');
  });
});

describe('edges keep what the other modes encode', () => {
  test('every link that can be drawn becomes an edge, evidence intact (F1)', async () => {
    const { graph, nodes, edges } = await structuralFor('F1');
    const drawnObjects = new Set();
    for (const node of nodes) {
      if (node.isBurst) for (const id of node.burst.commitIds) drawnObjects.add(id);
      else drawnObjects.add(node.objectId);
    }

    const drawable = graph.links.filter(
      (link) => drawnObjects.has(link.source) && drawnObjects.has(link.target),
    );
    assert.equal(edges.length, drawable.length, 'no drawable link may be lost');

    for (const edge of edges) {
      assert.ok(['validated', 'extracted'].includes(edge.evidence), 'evidence must survive');
      assert.equal(edge.evidence, edge.link.evidence);
      assert.equal(edge.qualifier, edge.link.qualifier);
    }
  });

  test('two links on one pair stay two edges', async () => {
    // Decision 25's case: the same pair carrying both evidence classes. Collapsing them
    // here would bury the extracted one before the renderer could keep it visible.
    const nodes = [
      { id: 'n_pr:1', objectId: 'pr:1' },
      { id: 'n_issue:1', objectId: 'issue:1' },
    ];
    const edges = buildStructuralEdges(
      [
        { source: 'pr:1', target: 'issue:1', evidence: 'validated', qualifier: 'resolves' },
        { source: 'pr:1', target: 'issue:1', evidence: 'extracted', qualifier: 'resolves' },
      ],
      nodes,
    );
    assert.equal(edges.length, 2);
    assert.notEqual(edges[0].id, edges[1].id, 'edges on one pair need distinct ids');

    const bundles = bundleEdges(edges);
    assert.equal(bundles.length, 1, 'but they are one bundle for drawing purposes');
    assert.equal(bundles[0].edges.length, 2);
  });

  test('bundling is unordered — a→b and b→a are the same two marks', () => {
    const bundles = bundleEdges([
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'a' },
    ]);
    assert.equal(bundles.length, 1);
  });
});

describe('the arrowhead is a time cue, not a link direction', () => {
  const nodesById = new Map([
    ['early', { t: new Date('2025-01-01T00:00:00Z') }],
    ['late', { t: new Date('2025-06-01T00:00:00Z') }],
    ['same', { t: new Date('2025-01-01T00:00:00Z') }],
    ['undated', { t: null }],
  ]);

  test('it points from the earlier endpoint to the later one', () => {
    assert.equal(edgeDirection({ source: 'early', target: 'late' }, nodesById), 1);
    // ⚠️ The same relation drawn the other way round still points at the later node.
    // A `resolves` link runs PR→issue in the data; here the arrow answers "which came
    // first", so it must not follow source/target.
    assert.equal(edgeDirection({ source: 'late', target: 'early' }, nodesById), -1);
  });

  test('simultaneous or undated endpoints get no arrowhead at all', () => {
    assert.equal(edgeDirection({ source: 'early', target: 'same' }, nodesById), 0);
    assert.equal(edgeDirection({ source: 'early', target: 'undated' }, nodesById), 0);
  });
});

describe('the time span the ramp and the brush read', () => {
  test('it spans the sub-log, from earliest to latest', async () => {
    const { nodes } = await structuralFor('F1');
    const extent = timeExtent(nodes);
    assert.ok(extent, 'F1 must have a span');
    assert.ok(extent.max > extent.min);

    for (const node of nodes) {
      if (!node.t) continue;
      assert.ok(+node.t >= extent.min && +node.t <= extent.max, `${node.id} falls outside`);
    }
  });

  test('it describes what is on screen, not the whole bundle', async () => {
    // Decision 12's rule applied to the ramp: hide a lane and the span narrows to what
    // is left, exactly as the statistics recompute over the visible sub-log.
    const { nodes } = await structuralFor('F1');
    const withoutCommits = nodes.filter((node) => node.lane !== 'commit');
    const all = timeExtent(nodes);
    const fewer = timeExtent(withoutCommits);
    assert.ok(fewer.min >= all.min && fewer.max <= all.max);
  });

  test('a fraction is clamped, and a zero span says nothing rather than dividing by zero', () => {
    const extent = { min: 0, max: 100 };
    assert.equal(timeFraction(new Date(0), extent), 0);
    assert.equal(timeFraction(new Date(100), extent), 1);
    assert.equal(timeFraction(new Date(50), extent), 0.5);
    assert.equal(timeFraction(new Date(-10), extent), 0, 'clamped below');
    assert.equal(timeFraction(new Date(110), extent), 1, 'clamped above');

    assert.equal(timeFraction(new Date(5), { min: 5, max: 5 }), 0, 'no spread, no claim');
    assert.equal(timeFraction(null, extent), 0);
    assert.equal(timeFraction(new Date(5), null), 0);
  });

  test('nothing dated at all yields no extent rather than a broken one', () => {
    assert.equal(timeExtent([{ id: 'a', t: null, tLast: null }]), null);
    assert.equal(timeExtent([]), null);
  });
});

describe('the ramp gets the whole scale, not part of it', () => {
  test('first-appearances span the full 0–1 range', async () => {
    // ⚠️ Found by looking at a render, not by a check. The ramp colours a node by when it
    // first appeared, but the extent it was scaled against ran to the LAST activity in
    // the sub-log — so the darkest mark on F13 sat at 0.58 of the ramp and on F1 at 0.38,
    // and the bottom third to half of the scale was reserved for a moment no mark
    // occupies. Two spans, two questions: `rampExtent` for "when did things start",
    // `timeExtent` for "when did anything happen", which is what a brush must cover.
    for (const fixture of ['F1', 'F13', 'F10']) {
      const { nodes } = await structuralFor(fixture);
      const extent = rampExtent(nodes);
      const fractions = nodes.filter((node) => node.t).map((node) => timeFraction(node.t, extent));
      assert.equal(Math.min(...fractions), 0, `${fixture}: nothing sits at the light end`);
      assert.equal(Math.max(...fractions), 1, `${fixture}: nothing reaches the dark end`);
    }
  });

  test('the ramp span is never wider than the activity span', async () => {
    const { nodes } = await structuralFor('F1');
    const ramp = rampExtent(nodes);
    const full = timeExtent(nodes);
    assert.ok(ramp.min >= full.min && ramp.max <= full.max);
    assert.ok(ramp.max < full.max, 'F1 keeps acting after its last object first appeared');
  });

  test('an undated or single-node sub-log yields no ramp rather than a broken one', () => {
    assert.equal(rampExtent([]), null);
    assert.equal(rampExtent([{ id: 'a', t: null }]), null);
    assert.equal(timeFraction(new Date(5), rampExtent([{ id: 'a', t: new Date(5) }])), 0);
  });
});
