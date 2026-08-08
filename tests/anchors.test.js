/**
 * Link anchoring: an edge must meet an object where that object is *drawn*.
 *
 * The defect these tests exist for: the anchor resolver answered "the top of the
 * lane" for every issue and pull request, while the lifecycle bar is drawn at the
 * row the object's band was packed into. With one object per lane those are the
 * same y and nothing looked wrong. With three PRs packed into two bands — F10 —
 * every commit of the second-band PR sent its link past that PR to the top of the
 * lane, where it appeared to arrive at a different pull request. Colour was the
 * only thing still telling the truth.
 *
 * So the invariant asserted here is a *relation between two renderers*, not a
 * number: `anchors.y(id)` and the y `renderLifecycleBars` uses must agree, for
 * every object in every fixture. A single formula could not have drifted; two
 * copies of it did.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadObjectGraph } from '../src/data/loadObjectGraph.js';
import { indexObjectGraph, collectInstants } from '../src/model/objectGraph.js';
import { deriveBursts, indexBurstsByCommit } from '../src/model/bursts.js';
import { buildNodes, assignRanks } from '../src/layout/nodes.js';
import { createScales } from '../src/layout/scales.js';
import { packRows, ROW_HEIGHT } from '../src/layout/packing.js';
import { computeLaneGeometry, rowY } from '../src/layout/lanes.js';
import { createAnchors } from '../src/layout/anchors.js';

const fileTransport = async (query) =>
  JSON.parse(await readFile(new URL(`./fixtures/${query.fixture}.json`, import.meta.url), 'utf8'));
const load = (fixture) => loadObjectGraph({ fixture }, { transport: fileTransport });

const MARGIN = { top: 32, bottom: 150 };
const MARGIN_LEFT = 180;
const PLOT_WIDTH = 1100;
const LANES = ['issue', 'pull_request', 'commit'];
const ALL = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13'];

/**
 * The renderer's own pipeline, up to the point where anchors are created —
 * `timeline.js` lines 140–186, with the drawing left out.
 */
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
  const { lanes: geometry } = computeLaneGeometry(LANES, maxRowByLane, MARGIN);
  for (const node of nodes) {
    const lane = geometry.get(node.lane);
    node.y = lane ? lane.contentTop + node.row * ROW_HEIGHT : 0;
  }

  const nodeByObject = new Map();
  for (const node of nodes) {
    if (node.isGroup) for (const member of node.members) nodeByObject.set(member.objectId, node);
    else if (node.objectId) nodeByObject.set(node.objectId, node);
  }

  const anchors = createAnchors({ nodes, nodeByObject, geometry, scales, objectRow });
  return { graph, index, nodes, objectRow, geometry, bursts, anchors, scales };
}

/** The y `renderLifecycleBars` draws this object's bar at (`render/nodes.js`). */
const barY = (geometry, objectRow, object) =>
  rowY(geometry, object.type, objectRow.get(object.id) ?? 0);

describe('an edge meets an object where the object is drawn', () => {
  for (const fixture of ALL) {
    test(`${fixture}: every issue and PR anchors to its own band, in every mode`, async () => {
      for (const mode of ['real', 'highlights', 'ordinal']) {
        const { index, objectRow, geometry, anchors } = await layout(fixture, { mode });
        for (const laneType of ['issue', 'pull_request']) {
          for (const object of index.objectsOfType(laneType)) {
            assert.equal(
              anchors.y(object.id, object),
              barY(geometry, objectRow, object),
              `${fixture}/${mode}: ${object.id} anchors off its lifecycle bar`,
            );
          }
        }
      }
    });
  }

  test('F10: the three PRs pack into two bands, and each is anchored separately', async () => {
    // The reported case. 1001 (t5–45) and 1003 (t75–115) do not overlap and share
    // band 0; 1002 (t40–80) overlaps both and takes band 1. If the fixture ever
    // stops exhibiting that, this test is verifying nothing — so assert it first.
    const { index, objectRow, geometry, anchors } = await layout('F10');
    const prs = index.objectsOfType('pull_request');
    assert.equal(prs.length, 3);
    assert.equal(new Set(prs.map((p) => objectRow.get(p.id))).size, 2, 'F10 needs two PR bands');

    const yOf = (id) => anchors.y(id, index.byId.get(id));
    assert.equal(yOf('pr:1001'), yOf('pr:1003'), 'sequential PRs share a band');
    assert.notEqual(yOf('pr:1002'), yOf('pr:1001'), 'the overlapping PR has its own band');
    assert.equal(
      yOf('pr:1002') - yOf('pr:1001'),
      ROW_HEIGHT * objectRow.get('pr:1002'),
      'the second band sits exactly one packed row below the first',
    );
    // And it is not the lane top, which is what it used to be.
    assert.notEqual(yOf('pr:1002'), geometry.get('pull_request').contentTop);
  });

  test('F10: a commit links to the band of the PR it actually reaches', async () => {
    const { graph, index, objectRow, geometry, anchors } = await layout('F10');
    const links = graph.links.filter((l) => l.qualifier === 'contains_commit');
    assert.ok(links.length > 0);

    const seen = new Set();
    for (const link of links) {
      // PR → commit, so the pull request whose band this must reach is the SOURCE.
      const pr = index.byId.get(link.source);
      seen.add(link.source);
      assert.equal(
        anchors.y(link.source, pr),
        barY(geometry, objectRow, pr),
        `${link.source} → ${link.target} lands off that PR's band`,
      );
    }
    assert.equal(seen.size, 3, 'all three PRs must be reached by commits');
  });

  test('F1 is unmoved: one object per band means band 0 is still the lane top', async () => {
    // The regression guard for the fix. F1 is the only fixture built from real data
    // and the visual baseline, so its anchors must be exactly what they were.
    const { index, geometry, anchors } = await layout('F1');
    for (const laneType of ['issue', 'pull_request']) {
      for (const object of index.objectsOfType(laneType)) {
        assert.equal(anchors.y(object.id, object), geometry.get(laneType).contentTop);
      }
    }
  });
});

describe('the commit lane keeps its own rule', () => {
  test('a commit anchors to its drawn node, not to a band', async () => {
    const { nodes, index, anchors } = await layout('F1');
    const byId = new Map(nodes.map((n) => [n.objectId, n]));
    let checked = 0;
    for (const commit of index.objectsOfType('commit')) {
      const node = byId.get(commit.id);
      if (!node || node.lane !== 'commit') continue; // folded into a burst
      assert.equal(anchors.y(commit.id, commit), node.y);
      assert.equal(anchors.x(commit.id, commit), node.x);
      checked++;
    }
    assert.ok(checked > 0, 'F1 must draw some unfolded commits');
  });

  test('a folded commit anchors to the burst standing in for it', async () => {
    const { nodes, index, bursts, anchors } = await layout('F1');
    const burstsByCommit = indexBurstsByCommit(bursts);
    const folded = index
      .objectsOfType('commit')
      .find((c) => burstsByCommit.get(c.id) && burstsByCommit.get(c.id).size > 5);
    assert.ok(folded, 'F1 must contain a folded burst');
    const burst = burstsByCommit.get(folded.id);
    const burstNode = nodes.find((n) => n.objectId === burst.id);
    assert.ok(burstNode, 'the burst must be drawn');
    // The renderer resolves the commit to its burst before asking for an anchor,
    // which is why the burst id is what is passed here.
    assert.equal(anchors.y(burst.id, folded), burstNode.y);
  });
});
