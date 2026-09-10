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

import { loadSubLog } from '../src/data/loadSubLog.js';
import { indexSubLog, collectInstants } from '../src/model/subLog.js';
import { deriveBursts, indexBurstsByCommit } from '../src/model/bursts.js';
import { buildNodes, assignRanks } from '../src/layout/nodes.js';
import { createScales } from '../src/layout/scales.js';
import { packRows, ROW_HEIGHT } from '../src/layout/packing.js';
import { computeLaneGeometry, rowY } from '../src/layout/lanes.js';
import { createAnchors } from '../src/layout/anchors.js';

const fileTransport = async (query) =>
  JSON.parse(await readFile(new URL(`./fixtures/${query.fixture}.json`, import.meta.url), 'utf8'));
const load = (fixture) => loadSubLog({ fixture }, { transport: fileTransport });

const MARGIN = { top: 32, bottom: 150 };
const MARGIN_LEFT = 180;
const PLOT_WIDTH = 1100;
const LANES = ['issue', 'pull_request', 'commit'];
const ALL = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13', 'F14', 'F15'];

/**
 * The renderer's own pipeline, up to the point where anchors are created —
 * `timeline.js` lines 140–186, with the drawing left out.
 */
async function layout(fixture, { mode = 'absolute' } = {}) {
  const graph = await load(fixture);
  const index = indexSubLog(graph);
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
      for (const mode of ['absolute', 'discrete']) {
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

/**
 * A link meets the lifecycle interval the other end falls in, or the nearest close
 * or reopen — over EVERY interval, never the first by default.
 *
 * The reported case is vscode #188934: an issue closed, reopened and closed again, with
 * three resolving PRs, one per lifecycle and one after the final close. All three were
 * drawn onto the first interval because the anchor read `intervals[0]` alone. F15 is
 * that shape in miniature, plus a reopened PR with a commit in each of its lifecycles.
 */
describe('a link meets the interval the other end falls in (F15)', () => {
  const t = (day, hour = 0) => new Date(Date.UTC(2025, 0, day, hour));
  const ends = (anchors, index, link) => {
    const source = index.byId.get(link.source);
    const target = index.byId.get(link.target);
    return anchors.endpoints({ source, target, sourceAnchorId: source.id, targetAnchorId: target.id });
  };
  const linkOf = (graph, source, target) =>
    graph.links.find((l) => l.source === source && l.target === target);

  for (const mode of ['absolute', 'discrete']) {
    test(`${mode}: PR → issue meets the issue interval the PR opened in, or the nearest close`, async () => {
      const { graph, index, anchors } = await layout('F15', { mode });
      const issue = index.byId.get('issue:15');
      const xAt = (time) => anchors.xAt(issue, time);
      // Inside the first interval: the PR's own opening.
      assert.equal(ends(anchors, index, linkOf(graph, 'pr:1501', 'issue:15')).tx, xAt(t(2)));
      // Inside the reopen: its own opening, on the SECOND bar.
      const during = ends(anchors, index, linkOf(graph, 'pr:1502', 'issue:15')).tx;
      assert.equal(during, xAt(t(10)));
      assert.ok(during >= xAt(t(9)) && during <= xAt(t(14)), 'lands on the reopen bar');
      assert.ok(during > xAt(t(4)), 'not on the first bar, which is what it used to be');
      // After the final close: the final close mark.
      assert.equal(ends(anchors, index, linkOf(graph, 'pr:1503', 'issue:15')).tx, xAt(t(14)));
    });

    test(`${mode}: commit → issue meets the nearest point of either interval`, async () => {
      const { graph, index, anchors } = await layout('F15', { mode });
      const issue = index.byId.get('issue:15');
      const xAt = (time) => anchors.xAt(issue, time);
      const shas = { early: 'commit:f15early000000001', during: 'commit:f15during00000001', late: 'commit:f15late0000000001' };
      // Between the two intervals: the first close is nearer than the reopen.
      assert.equal(ends(anchors, index, linkOf(graph, shas.early, 'issue:15')).tx, xAt(t(4)));
      // Inside the reopen: the commit's own instant.
      assert.equal(ends(anchors, index, linkOf(graph, shas.during, 'issue:15')).tx, xAt(t(12)));
      // After both: the final close.
      assert.equal(ends(anchors, index, linkOf(graph, shas.late, 'issue:15')).tx, xAt(t(14)));
    });

    test(`${mode}: PR → commit meets the PR at the commit's moment, on the PR's own lifecycles`, async () => {
      const { graph, index, anchors } = await layout('F15', { mode });
      const pr = index.byId.get('pr:1504');
      const xAt = (time) => anchors.xAt(pr, time);
      const shas = { early: 'commit:f15early000000001', during: 'commit:f15during00000001', late: 'commit:f15late0000000001' };
      // The commit is the fixed end; the PR end slides to it.
      const early = ends(anchors, index, linkOf(graph, 'pr:1504', shas.early));
      assert.equal(early.tx, anchors.x(shas.early, index.byId.get(shas.early)));
      assert.equal(early.sx, xAt(t(5, 12)), 'inside the PR’s first lifecycle');
      assert.equal(ends(anchors, index, linkOf(graph, 'pr:1504', shas.during)).sx, xAt(t(12)), 'inside its reopen');
      assert.equal(ends(anchors, index, linkOf(graph, 'pr:1504', shas.late)).sx, xAt(t(13)), 'the merge, after which nothing');
      assert.notEqual(ends(anchors, index, linkOf(graph, 'pr:1504', shas.late)).sx, xAt(t(5)), 'no longer the first opening');
    });
  }

  test('F1–F14 are unmoved: no earlier fixture links into a multi-interval object', async () => {
    for (const fixture of ALL.filter((f) => f !== 'F15')) {
      const { graph, index, anchors } = await layout(fixture);
      for (const link of graph.links) {
        const source = index.byId.get(link.source);
        const target = index.byId.get(link.target);
        const { sx, tx } = ends(anchors, index, link);
        // The previous rule, restated: source at its opening, target clamped into its
        // FIRST interval (or at its start when that interval is open).
        const oldSx = anchors.x(source.id, source);
        const first = target.intervals?.[0];
        let oldTx;
        if (target.type === 'commit' || !first?.start || !first?.end) oldTx = anchors.x(target.id, target);
        else oldTx = Math.max(anchors.xAt(target, first.start), Math.min(anchors.xAt(target, first.end), oldSx));
        if (target.type === 'commit' && source.type !== 'commit') {
          // The one deliberate difference: a PR end now slides to its commit's moment.
          assert.equal(tx, oldTx, `${fixture}: ${link.source} → ${link.target} commit end`);
        } else {
          assert.equal(sx, oldSx, `${fixture}: ${link.source} → ${link.target} source`);
          assert.equal(tx, oldTx, `${fixture}: ${link.source} → ${link.target} target`);
        }
      }
    }
  });
});
