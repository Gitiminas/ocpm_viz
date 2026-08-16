import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadObjectGraph } from '../src/data/loadObjectGraph.js';
import { indexObjectGraph, collectInstants } from '../src/model/objectGraph.js';
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

const FIXTURES = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13'];
const TEMPORAL_MODES = ['real', 'highlights', 'ordinal'];

const MARGIN = { top: 32, right: 120, bottom: 150, left: 180 };
const PLOT_WIDTH = 1100;

async function contextFor(fixture) {
  const graph = await loadObjectGraph({ fixture }, { transport: fileTransport });
  const index = indexObjectGraph(graph);
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
    expandedGroups: new Set(),
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

const engineLayout = (context, mode) =>
  createLayout({
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
    expandedGroups: new Set(),
    isVisible: () => true,
    margin: MARGIN,
    plotWidth: PLOT_WIDTH,
  });

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

        // `objectRow` is what tells a link which band its object was packed into —
        // decision 37's defect lived exactly here.
        assert.deepEqual([...engine.objectRow.entries()].sort(), [...reference.objectRow.entries()].sort());
        assert.equal(engine.repeatRow, reference.repeatRow);
      });
    }
  }
});

describe('the layout the engine hands back is complete', () => {
  test('a temporal layout carries everything the render pass needs', async () => {
    const context = await contextFor('F1');
    const layout = engineLayout(context, 'real');
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

  test('anchors resolve through the layout, not through the renderer', async () => {
    // The interface is `{x, y, xAt, clampToLifecycle, xOfTime}` — an endpoint resolver
    // keyed on `(anchorId, object)`, not a position lookup. Pinned here because the
    // structural engine has to hand back the same shape, or `render/links.js` would need
    // to learn which engine ran.
    const context = await contextFor('F1');
    const layout = engineLayout(context, 'real');
    const pr = context.index.objectsOfType('pull_request')[0];

    for (const method of ['x', 'y', 'xAt', 'clampToLifecycle', 'xOfTime']) {
      assert.equal(typeof layout.anchors[method], 'function', `anchors must expose ${method}`);
    }
    assert.ok(Number.isFinite(layout.anchors.x(pr.id, pr)), 'a link must find its object');
    assert.ok(Number.isFinite(layout.anchors.y(pr.id, pr)));
  });

  test('hiding a lane removes its nodes and shortens the chart', async () => {
    const context = await contextFor('F1');
    const all = engineLayout(context, 'real');
    const withoutCommits = createLayout({
      mode: 'real',
      graph: context.graph,
      index: context.index,
      laneTypes: LANE_TYPES,
      visibleLanes: ['issue', 'pull_request'],
      bursts: context.bursts,
      commentBursts: context.commentBursts,
      instants: context.instants,
      expandedBursts: new Set(),
      expandedCommentBursts: new Set(),
      expandedGroups: new Set(),
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
  test('the three temporal modes are temporal', () => {
    for (const mode of TEMPORAL_MODES) {
      assert.equal(isStructuralMode(mode), false, `${mode} must use the scale-based engine`);
    }
  });

  test('off is the structural one', () => {
    assert.deepEqual(STRUCTURAL_MODES, ['off']);
    assert.equal(isStructuralMode('off'), true);
  });

  test('an unbuilt engine throws rather than returning an empty picture', async () => {
    // Until the structural engine is wired up it must fail loudly. An empty layout would
    // draw a blank chart with no error, which reads as "this sub-log has nothing in it" —
    // the wrong-picture-no-error failure decisions 60, 74 and 87 all exist to prevent.
    const context = await contextFor('F1');
    assert.throws(() => engineLayout(context, 'off'), /not wired up yet/);
  });
});
