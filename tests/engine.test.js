import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadSubLog } from '../src/data/loadSubLog.js';
import { indexSubLog, collectInstants } from '../src/model/subLog.js';
import { deriveBursts } from '../src/model/bursts.js';
import { deriveCommentBursts } from '../src/model/commentBursts.js';
import { LANE_TYPES } from '../src/model/activities.js';
import { createLayout, isStructuralMode, STRUCTURAL_MODES } from '../src/layout/engine.js';
import { buildNodes, assignRanks, filterNodes } from '../src/layout/nodes.js';
import { createScales } from '../src/layout/scales.js';
import { packRows } from '../src/layout/packing.js';
import { computeLaneGeometry, rowY } from '../src/layout/lanes.js';

/**
 * The layout seam.
 *
 * `createLayout` was extracted from the middle of `render/timeline.js` so a second engine
 * could be added behind the same interface. The extraction had to be behaviour-preserving,
 * and **the existing suite cannot show that**: it is DOM-free by design, and every test in
 * it stops short of the render pass, so all 519 of them pass whether or not the move
 * changed a single coordinate.
 *
 * So this file runs the pipeline the old way — the same modules in the same order, as
 * `render()` sequenced them — and requires the engine to reproduce it exactly, for every
 * fixture in every temporal mode. Anything the extraction perturbed shows up as a
 * coordinate that differs.
 */

const fileTransport = async (query) =>
  JSON.parse(
    await readFile(new URL(`./fixtures/${query.fixture || 'F1'}.json`, import.meta.url), 'utf8'),
  );

const FIXTURES = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13', 'F14'];
const TEMPORAL_MODES = ['absolute', 'discrete'];

const MARGIN = { top: 32, right: 120, bottom: 150, left: 180 };
const PLOT_WIDTH = 1100;

async function contextFor(fixture) {
  const graph = await loadSubLog({ fixture }, { transport: fileTransport });
  const index = indexSubLog(graph);
  return {
    graph,
    index,
    bursts: deriveBursts(index.objectsOfType('commit')),
    commentBursts: deriveCommentBursts(index, LANE_TYPES, { windowDays: 1 }),
    instants: collectInstants(graph),
  };
}

/**
 * The pipeline exactly as `render()` used to sequence it, before the extraction.
 *
 * Kept as a literal transcription rather than tidied: its value is being the *previous*
 * arrangement, so any cleanup would weaken it into a second implementation of the new one.
 */
function referenceLayout({ graph, index, bursts, commentBursts, instants, mode }) {
  const visibleLanes = LANE_TYPES.slice();

  const allNodes = buildNodes({
    graph,
    index,
    bursts,
    commentBursts,
    expandedBursts: new Set(),
    expandedCommentBursts: new Set(),
    mode,
    laneTypes: LANE_TYPES,
  });
  const nodes = filterNodes(allNodes, () => true);
  const { rankMax, rankTimes } = assignRanks(nodes);

  const scales = createScales({
    instants,
    marginLeft: MARGIN.left,
    plotWidth: PLOT_WIDTH,
    mode,
    rankTimes,
    rankMax,
  });
  for (const node of nodes) node.x = scales.x(node.t, node);
  for (const node of nodes) {
    if (!node.observations?.length) continue;
    node.observations.forEach((observation, i) => {
      observation.x = i === 0 ? node.x : scales.x(observation.time, observation);
    });
  }

  const laneObjects = new Map(visibleLanes.map((lane) => [lane, index.objectsOfType(lane)]));
  const { maxRowByLane, objectRow, repeatRow } = packRows(nodes, visibleLanes, { laneObjects });
  const { lanes: geometry, height } = computeLaneGeometry(visibleLanes, maxRowByLane, MARGIN);
  for (const node of nodes) node.y = rowY(geometry, node.lane, node.row);

  const repeatY = repeatRow == null ? null : rowY(geometry, 'commit', repeatRow);
  for (const node of nodes) {
    if (!node.observations?.length) continue;
    node.observations.forEach((observation, i) => {
      observation.y = i === 0 || repeatY == null ? node.y : repeatY;
    });
  }

  return { nodes, geometry, height, objectRow, repeatRow };
}

const engineLayoutOptions = (context, mode) => ({
  mode,
  graph: context.graph,
  index: context.index,
  laneTypes: LANE_TYPES,
  visibleLanes: LANE_TYPES.slice(),
  bursts: context.bursts,
  commentBursts: context.commentBursts,
  instants: context.instants,
  expandedBursts: new Set(),
  expandedCommentBursts: new Set(),
  isVisible: () => true,
  margin: MARGIN,
  plotWidth: PLOT_WIDTH,
});

const engineLayout = (context, mode) => createLayout(engineLayoutOptions(context, mode));

describe('the extraction did not move anything', () => {
  for (const fixture of FIXTURES) {
    for (const mode of TEMPORAL_MODES) {
      test(`${fixture} in ${mode} lays out exactly as it did before`, async () => {
        const context = await contextFor(fixture);
        // Reference first: both paths mutate the node objects they build, and they build
        // their own, so the order is irrelevant — but building them separately is what
        // makes this a comparison rather than a tautology.
        const reference = referenceLayout({ ...context, mode });
        const engine = engineLayout(context, mode);

        assert.equal(engine.kind, 'temporal');
        assert.equal(engine.nodes.length, reference.nodes.length, 'node count changed');
        assert.equal(engine.height, reference.height, 'svg height changed');
        assert.equal(engine.width, MARGIN.left + PLOT_WIDTH + MARGIN.right);

        const referenceById = new Map(reference.nodes.map((node) => [node.id, node]));
        for (const node of engine.nodes) {
          const before = referenceById.get(node.id);
          assert.ok(before, `${node.id} did not exist before the extraction`);
          assert.equal(node.x, before.x, `${fixture}/${mode}: ${node.id} moved horizontally`);
          assert.equal(node.y, before.y, `${fixture}/${mode}: ${node.id} moved vertically`);
          assert.equal(node.row, before.row, `${fixture}/${mode}: ${node.id} changed row`);

          // Repeat observations carry their own coordinates and were positioned by two
          // separate loops in the old code; both had to come across.
          (node.observations || []).forEach((observation, i) => {
            const was = before.observations[i];
            assert.equal(observation.x, was.x, `${node.id} observation ${i} moved horizontally`);
            assert.equal(observation.y, was.y, `${node.id} observation ${i} moved vertically`);
          });
        }

        // Lane geometry drives every bar, caption and anchor.
        for (const lane of LANE_TYPES) {
          assert.deepEqual(
            engine.geometry.get(lane),
            reference.geometry.get(lane),
            `${fixture}/${mode}: ${lane} lane geometry changed`,
          );
        }

        // `objectRow` is what tells a link which band its object was packed into, and a
        // link must meet its object at the row that object is drawn at.
        assert.deepEqual([...engine.objectRow.entries()].sort(), [...reference.objectRow.entries()].sort());
        assert.equal(engine.repeatRow, reference.repeatRow);
      });
    }
  }
});

describe('the layout the engine hands back is complete', () => {
  test('a temporal layout carries everything the render pass needs', async () => {
    const context = await contextFor('F1');
    const layout = engineLayout(context, 'absolute');
    for (const field of [
      'kind',
      'nodes',
      'nodeByObject',
      'visibleLanes',
      'geometry',
      'width',
      'height',
      'anchors',
      'objectRow',
      'scales',
      'rankOrder',
      'rankMax',
      'rankTimes',
    ]) {
      assert.ok(field in layout, `a temporal layout must carry ${field}`);
    }
  });

  test('a folded comment run carries its span end in absolute mode only', async () => {
    // Absolute mode can project the run's last comment honestly; discrete gives the run
    // one rank, so there the span is stated as text and no x is invented.
    const context = await contextFor('F1');
    const absolute = engineLayout(context, 'absolute');
    const burst = absolute.nodes.find((node) => node.isCommentBurst);
    assert.ok(burst, 'F1 folds a run at the default window');
    assert.equal(burst.spanEndX, absolute.scales.x(burst.commentBurst.end));
    assert.ok(burst.spanEndX >= burst.x, 'the run ends at or after its first comment');

    const discrete = engineLayout(context, 'discrete');
    assert.equal(discrete.nodes.find((node) => node.isCommentBurst).spanEndX, undefined);
  });

  test('anchors resolve through the layout, not through the renderer', async () => {
    // The interface is `{x, y, xAt, clampToLifecycle, xOfTime}` — an endpoint resolver
    // keyed on `(anchorId, object)`, not a position lookup. Pinned here because the
    // structural engine has to hand back the same shape, or `render/links.js` would need
    // to learn which engine ran.
    const context = await contextFor('F1');
    const layout = engineLayout(context, 'absolute');
    const pr = context.index.objectsOfType('pull_request')[0];

    for (const method of ['x', 'y', 'xAt', 'clampToLifecycle', 'xOfTime']) {
      assert.equal(typeof layout.anchors[method], 'function', `anchors must expose ${method}`);
    }
    assert.ok(Number.isFinite(layout.anchors.x(pr.id, pr)), 'a link must find its object');
    assert.ok(Number.isFinite(layout.anchors.y(pr.id, pr)));
  });

  test('hiding a lane removes its nodes and shortens the chart', async () => {
    const context = await contextFor('F1');
    const all = engineLayout(context, 'absolute');
    const withoutCommits = createLayout({
      mode: 'absolute',
      graph: context.graph,
      index: context.index,
      laneTypes: LANE_TYPES,
      visibleLanes: ['issue', 'pull_request'],
      bursts: context.bursts,
      commentBursts: context.commentBursts,
      instants: context.instants,
      expandedBursts: new Set(),
      expandedCommentBursts: new Set(),
      isVisible: (node) => node.lane !== 'commit',
      margin: MARGIN,
      plotWidth: PLOT_WIDTH,
    });

    assert.ok(withoutCommits.nodes.length < all.nodes.length);
    assert.ok(withoutCommits.height < all.height, 'a hidden lane must give its height back');
    assert.ok(!withoutCommits.nodes.some((node) => node.lane === 'commit'));
  });
});

describe('the engine chooses by mode, and says which it chose', () => {
  test('the temporal modes are temporal', () => {
    for (const mode of TEMPORAL_MODES) {
      assert.equal(isStructuralMode(mode), false, `${mode} must use the scale-based engine`);
    }
  });

  test('relationships is the structural one', () => {
    assert.deepEqual(STRUCTURAL_MODES, ['relationships']);
    assert.equal(isStructuralMode('relationships'), true);
  });

  test('relationships returns a structural layout, and says so', async () => {
    const context = await contextFor('F1');
    assert.equal(engineLayout(context, 'relationships').kind, 'structural');
  });
});

describe('the structural layout', () => {
  test('every node gets a finite position inside the drawing box', async () => {
    const context = await contextFor('F1');
    const layout = engineLayout(context, 'relationships');

    assert.ok(layout.nodes.length > 0, 'F1 must lay out something');
    for (const node of layout.nodes) {
      assert.ok(Number.isFinite(node.x), `${node.id} has a non-finite x`);
      assert.ok(Number.isFinite(node.y), `${node.id} has a non-finite y`);
      assert.ok(node.x >= 0 && node.x <= layout.width, `${node.id} escaped horizontally`);
      assert.ok(node.y >= 0 && node.y <= layout.height, `${node.id} escaped vertically`);
    }
  });

  test('it draws one node per object, not one per event', async () => {
    // The same property `structural.test.js` proves of the model, asserted here through
    // the engine, because this is the seam the renderer actually calls.
    const context = await contextFor('F1');
    const temporal = engineLayout(context, 'absolute');
    const structural = engineLayout(context, 'relationships');

    const issueNodes = (layout) => layout.nodes.filter((node) => node.lane === 'issue');
    assert.ok(
      issueNodes(temporal).length > issueNodes(structural).length,
      'the timeline draws an issue once per event; relationships mode draws it once',
    );
    assert.equal(issueNodes(structural).length, context.index.objectsOfType('issue').length);
  });

  test('it is deterministic across renders', async () => {
    // Acceptance criterion 2. A layout that re-rolls itself on every render is an
    // animation, not a layout.
    const context = await contextFor('F13');
    const first = engineLayout(context, 'relationships');
    const second = engineLayout(context, 'relationships');
    for (const node of first.nodes) {
      const other = second.nodes.find((candidate) => candidate.id === node.id);
      assert.equal(node.x, other.x, `${node.id} moved horizontally between renders`);
      assert.equal(node.y, other.y, `${node.id} moved vertically between renders`);
    }
  });

  test('it carries the time span the ramp and the brush read', async () => {
    const context = await contextFor('F1');
    const layout = engineLayout(context, 'relationships');
    assert.ok(layout.extent, 'time is demoted, not deleted — the span must survive');
    assert.ok(layout.extent.max > layout.extent.min);
    for (const node of layout.nodes) {
      assert.ok(node.t, `${node.id} has no timestamp, so the ramp cannot place it`);
    }
  });

  test('the clustered arrangement names its anchor and sizes every cluster, in canvas pixels', async () => {
    // What a drag needs from the layout, threaded through the engine: which root the
    // relaxation pinned (so a drag keeps it pinned) and how much room each hub's cluster
    // claims (so a drag keeps whole fans apart). Both are cluster-only notions; the
    // layered arrangement pins nothing and simulates nothing, and reports neither.
    const context = await contextFor('F10');
    const clustered = createLayout({
      ...engineLayoutOptions(context, 'relationships'),
      structuralLayout: 'cluster',
    });
    assert.ok(
      clustered.nodes.some((node) => node.id === clustered.anchorId && node.lane === 'issue'),
      'the anchor is one of the drawn issues',
    );
    const pr = clustered.nodes.find((node) => node.lane === 'pull_request');
    const commit = clustered.nodes.find((node) => node.lane === 'commit');
    assert.ok(pr.footprint > pr.radius, 'a pull request with commits claims its fan');
    assert.equal(commit.footprint, commit.radius, 'a leaf claims only itself');
    // Canvas pixels: the pull request's own commits fall inside its footprint, measured
    // against the positions the renderer draws at (margin included on both sides).
    const own = clustered.edges
      .filter((edge) => edge.source === pr.id || edge.target === pr.id)
      .map((edge) => (edge.source === pr.id ? edge.target : edge.source))
      .map((id) => clustered.nodes.find((node) => node.id === id))
      .filter((node) => node?.lane === 'commit');
    assert.ok(own.length > 0);
    for (const c of own) {
      assert.ok(
        Math.hypot(c.x - pr.x, c.y - pr.y) <= pr.footprint + c.radius + 1,
        `${c.id} lies ${Math.hypot(c.x - pr.x, c.y - pr.y).toFixed(0)}px from ${pr.id}, outside its footprint of ${pr.footprint.toFixed(0)}`,
      );
    }

    const layered = engineLayout(context, 'relationships');
    assert.equal(layered.anchorId, null);
    assert.ok(layered.nodes.every((node) => node.footprint === undefined));
  });

  test('it reports the rows and what the ordering achieved', async () => {
    const context = await contextFor('F1');
    const layout = engineLayout(context, 'relationships');
    assert.ok(Array.isArray(layout.rows), 'the rows are part of the answer');
    assert.ok(layout.rows.every((row) => row.length > 0), 'an empty row is dropped, not drawn');
    assert.equal(
      layout.rows.reduce((sum, row) => sum + row.length, 0),
      layout.nodes.length,
      'every node belongs to exactly one row',
    );
    // Reported rather than kept private: how tangled a sub-log is, is a finding.
    assert.equal(typeof layout.crossings, 'number');
  });

  test('there is no warm start to keep, because the layout is a pure function', async () => {
    // ⚠️ The force layout this replaced had to be fed its own previous output to stay
    // still between renders, and `previousPositions` existed for that. A layered layout
    // depends only on the graph, so re-rendering is not merely stable — it is identical,
    // and there is no state that could go stale.
    const context = await contextFor('F13');
    const first = engineLayout(context, 'relationships');
    const second = engineLayout(context, 'relationships');
    for (const node of first.nodes) {
      const other = second.nodes.find((candidate) => candidate.id === node.id);
      assert.equal(node.x, other.x, `${node.id} moved horizontally on a re-render`);
      assert.equal(node.y, other.y, `${node.id} moved vertically on a re-render`);
    }
  });

  test('edges reflect the links, and hiding one rearranges rather than merely erasing', async () => {
    const context = await contextFor('F1');
    const all = engineLayout(context, 'relationships');
    assert.ok(all.edges.length > 0, 'F1 has links');

    const validatedOnly = createLayout({
      mode: 'relationships',
      graph: context.graph,
      index: context.index,
      laneTypes: LANE_TYPES,
      visibleLanes: LANE_TYPES.slice(),
      bursts: context.bursts,
      commentBursts: context.commentBursts,
      instants: context.instants,
      expandedBursts: new Set(),
      expandedCommentBursts: new Set(),
      isVisible: () => true,
      isLinkVisible: (link) => link.evidence === 'validated',
      margin: MARGIN,
      plotWidth: PLOT_WIDTH,
    });

    assert.ok(validatedOnly.edges.length < all.edges.length, 'the filter must reach the edges');
    assert.ok(
      validatedOnly.edges.every((edge) => edge.evidence === 'validated'),
      'a hidden evidence class must not shape the layout',
    );
  });

  test('anchors expose the same interface as the temporal ones', async () => {
    // So `render/links.js` never learns which engine ran.
    const context = await contextFor('F1');
    const layout = engineLayout(context, 'relationships');
    const pr = context.index.objectsOfType('pull_request')[0];

    for (const method of ['x', 'y', 'xAt', 'clampToLifecycle', 'xOfTime']) {
      assert.equal(typeof layout.anchors[method], 'function', `anchors must expose ${method}`);
    }
    const node = layout.nodes.find((candidate) => candidate.objectId === pr.id);
    assert.equal(layout.anchors.x(pr.id, pr), node.x, 'an edge must meet the node it names');
    assert.equal(layout.anchors.y(pr.id, pr), node.y);
    assert.equal(layout.anchors.clampToLifecycle(pr.id, pr, 999), node.x, 'nothing to slide along');
  });

  test('a link into a folded push anchors on the push', async () => {
    const context = await contextFor('F10');
    const layout = engineLayout(context, 'relationships');
    const burst = context.bursts[0];
    const member = [...burst.commitIds][0];
    const burstNode = layout.nodes.find((node) => node.id === `n_${burst.id}`);

    assert.ok(burstNode, 'a collapsed push must be drawn');
    assert.equal(
      layout.anchors.x(member, { id: member, type: 'commit' }),
      burstNode.x,
      'a folded commit resolves to its push',
    );
  });

  test('xOfTime refuses rather than inventing a position', async () => {
    // There is no time axis here, so any number it returned would be fiction — and it
    // would flow into a translate() and put a mark somewhere wrong with no error.
    const context = await contextFor('F1');
    const layout = engineLayout(context, 'relationships');
    assert.throws(() => layout.anchors.xOfTime(new Date()), /no time axis/);
  });

  test('an empty picture is empty, not broken', async () => {
    // Everything switched off is a legitimate state — it must be reachable and
    // declared, not prevented.
    const context = await contextFor('F1');
    const layout = createLayout({
      mode: 'relationships',
      graph: context.graph,
      index: context.index,
      laneTypes: LANE_TYPES,
      visibleLanes: [],
      bursts: context.bursts,
      commentBursts: context.commentBursts,
      instants: context.instants,
      expandedBursts: new Set(),
      expandedCommentBursts: new Set(),
      isVisible: () => false,
      margin: MARGIN,
      plotWidth: PLOT_WIDTH,
    });
    assert.equal(layout.nodes.length, 0);
    assert.equal(layout.edges.length, 0);
    assert.equal(layout.extent, null);
    assert.ok(Number.isFinite(layout.height), 'an empty layout still needs a height');
  });

  test('folding and unfolding a push changes what is drawn, not where everything is', async () => {
    // Acceptance criterion 2's second half, and the reason `layoutForce` warm-starts.
    const context = await contextFor('F10');
    const folded = engineLayout(context, 'relationships');
    const burst = context.bursts[0];

    const expanded = createLayout({
      mode: 'relationships',
      graph: context.graph,
      index: context.index,
      laneTypes: LANE_TYPES,
      visibleLanes: LANE_TYPES.slice(),
      bursts: context.bursts,
      commentBursts: context.commentBursts,
      instants: context.instants,
      expandedBursts: new Set([burst.id]),
      expandedCommentBursts: new Set(),
      isVisible: () => true,
      margin: MARGIN,
      plotWidth: PLOT_WIDTH,
    });

    // The members appear...
    const drawn = new Set(expanded.nodes.map((node) => node.objectId));
    for (const commitId of burst.commitIds) {
      assert.ok(drawn.has(commitId), `${commitId} must be drawn once its push is expanded`);
    }
    assert.ok(!drawn.has(burst.id), 'and the meta-node goes away');

    // ...and everything that was already on screen stays roughly put.
    const survivors = folded.nodes.filter(
      (node) => node.id !== `n_${burst.id}` && expanded.nodes.some((n) => n.id === node.id),
    );
    assert.ok(survivors.length > 5, 'sanity: there must be survivors to measure');
    const moved = survivors.map((node) => {
      const after = expanded.nodes.find((candidate) => candidate.id === node.id);
      return Math.hypot(node.x - after.x, node.y - after.y);
    });
    const median = moved.slice().sort((a, b) => a - b)[Math.floor(moved.length / 2)];
    assert.ok(median < 120, `expanding a push shifted the typical node by ${Math.round(median)}px`);
  });
});

describe('a dragged mark displaces without disturbing the layout', () => {
  const nudged = (context, nodeNudges) =>
    createLayout({
      mode: 'relationships',
      graph: context.graph,
      index: context.index,
      laneTypes: LANE_TYPES,
      visibleLanes: LANE_TYPES.slice(),
      bursts: context.bursts,
      commentBursts: context.commentBursts,
      instants: context.instants,
      expandedBursts: new Set(),
      expandedCommentBursts: new Set(),
      isVisible: () => true,
      nodeNudges,
      margin: MARGIN,
      plotWidth: PLOT_WIDTH,
    });

  test('the layout position is kept alongside the drawn one', async () => {
    // A drag is measured against `layoutX`, so nudges accumulate against the computed
    // answer rather than against each other — drag twice and you get one displacement,
    // not a compounding one.
    const context = await contextFor('F1');
    for (const node of engineLayout(context, 'relationships').nodes) {
      assert.equal(node.x, node.layoutX, 'unnudged, the two must agree');
      assert.equal(node.y, node.layoutY);
    }
  });

  test('a nudge moves exactly one mark, by exactly the offset given', async () => {
    const context = await contextFor('F1');
    const before = engineLayout(context, 'relationships');
    const target = before.nodes.find((node) => node.lane === 'pull_request');
    const wanted = new Map([[target.id, { dx: 40, dy: -25 }]]);

    const after = nudged(context, wanted);
    for (const node of after.nodes) {
      const was = before.nodes.find((candidate) => candidate.id === node.id);
      if (node.id === target.id) {
        assert.equal(node.x, was.layoutX + 40, 'the dragged mark must move by the offset');
        assert.equal(node.y, was.layoutY - 25);
      } else {
        assert.equal(node.x, was.x, `${node.id} moved when a different mark was dragged`);
        assert.equal(node.y, was.y);
      }
    }
  });

  test('the underlying layout is untouched, so clearing the nudges restores it exactly', async () => {
    // The whole point of storing an offset rather than a position: the arrangement is
    // still the computed one, plus a set of stated displacements.
    const context = await contextFor('F13');
    const plain = engineLayout(context, 'relationships');
    const dragged = nudged(context, new Map([[plain.nodes[0].id, { dx: 90, dy: 90 }]]));

    for (const node of dragged.nodes) {
      const was = plain.nodes.find((candidate) => candidate.id === node.id);
      assert.equal(node.layoutX, was.layoutX, `${node.id}: the layout itself shifted`);
      assert.equal(node.layoutY, was.layoutY);
    }

    const cleared = nudged(context, new Map());
    for (const node of cleared.nodes) {
      const was = plain.nodes.find((candidate) => candidate.id === node.id);
      assert.equal(node.x, was.x, `${node.id} did not return to where the layout put it`);
      assert.equal(node.y, was.y);
    }
  });

  test('a nudge naming a mark that is not drawn is simply ignored', async () => {
    // Hiding a lane, or loading another sub-log, can leave one behind.
    const context = await contextFor('F1');
    const plain = engineLayout(context, 'relationships');
    const stale = nudged(context, new Map([['n_issue:does-not-exist', { dx: 500, dy: 500 }]]));
    assert.equal(stale.nodes.length, plain.nodes.length);
    for (const node of stale.nodes) {
      assert.equal(node.x, plain.nodes.find((c) => c.id === node.id).x);
    }
  });
});
