import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { layoutDfg, dfgEdgeWidth, DFG_NODE_RADIUS } from '../src/layout/dfg.js';

/*
 * The same hand-built bundle the validator suite uses: two issues, one merged pull
 * request, one twice-observed commit, one cross edge — plus a rework edge here
 * (IssueClosed → IssueCommented) so the backward-arc side has something to assert.
 * Pure-layout properties only; what the numbers mean is the validator's business.
 */
function dfg() {
  return {
    meta: { repo: 'r', dfg_contract_version: 1, generated_at: '2026-09-01T00:00:00+00:00' },
    nodes: [
      { object_type: 'issue', activity: 'IssueOpened', events: 2, objects: 2, starts: 2, ends: 0 },
      { object_type: 'issue', activity: 'IssueCommented', events: 3, objects: 2, starts: 0, ends: 0 },
      { object_type: 'issue', activity: 'IssueClosed', events: 2, objects: 2, starts: 0, ends: 2 },
      { object_type: 'pull_request', activity: 'PullRequestOpened', events: 1, objects: 1, starts: 1, ends: 0 },
      { object_type: 'pull_request', activity: 'PullRequestMerged', events: 1, objects: 1, starts: 0, ends: 1 },
      { object_type: 'commit', activity: 'CommitObserved', events: 2, objects: 1, starts: 1, ends: 1 },
    ],
    edges: [
      { object_type: 'issue', from_activity: 'IssueOpened', to_activity: 'IssueCommented', successions: 2, objects: 2 },
      { object_type: 'issue', from_activity: 'IssueCommented', to_activity: 'IssueClosed', successions: 2, objects: 2 },
      { object_type: 'issue', from_activity: 'IssueClosed', to_activity: 'IssueCommented', successions: 1, objects: 1 },
      { object_type: 'pull_request', from_activity: 'PullRequestOpened', to_activity: 'PullRequestMerged', successions: 40000, objects: 1 },
      { object_type: 'commit', from_activity: 'CommitObserved', to_activity: 'CommitObserved', successions: 1, objects: 1 },
    ],
    cross_edges: [
      { from_type: 'pull_request', from_activity: 'PullRequestMerged', to_type: 'issue', to_activity: 'IssueClosed', successions: 1, pairs: 1, link_qualifier: 'resolves', link_evidence: 'validated', link_method: 'pr_body' },
    ],
  };
}

const BOX = { width: 960 };

describe('the DFG arrangement is finite, boxed and deterministic', () => {
  test('every coordinate is finite and inside the box', () => {
    const layout = layoutDfg(dfg(), BOX);
    for (const node of layout.nodes) {
      assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), node.activity);
      assert.ok(node.x >= 0 && node.x <= layout.width);
      assert.ok(node.y >= 0 && node.y <= layout.height);
    }
    for (const edge of [...layout.edges, ...layout.crossEdges]) {
      for (const point of edge.points) {
        assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
      }
      assert.ok(Number.isFinite(edge.labelAt.x) && Number.isFinite(edge.labelAt.y));
    }
  });

  test('the arrangement is a pure function', () => {
    assert.deepEqual(layoutDfg(dfg(), BOX), layoutDfg(dfg(), BOX));
  });

  test('rows appear in lane order, and no two nodes in a row collide', () => {
    const layout = layoutDfg(dfg(), BOX);
    const y = (type) => layout.lanes.find((l) => l.type === type).y;
    assert.ok(y('issue') < y('pull_request'));
    assert.ok(y('pull_request') < y('commit'));
    for (const lane of layout.lanes) {
      const row = layout.nodes.filter((n) => n.object_type === lane.type).sort((a, b) => a.x - b.x);
      for (let i = 1; i < row.length; i++) {
        assert.ok(row[i].x - row[i - 1].x > 2 * DFG_NODE_RADIUS, `${lane.type} row overlaps`);
      }
    }
  });

  test('a lane with nothing in it takes no space', () => {
    const bundle = dfg();
    bundle.nodes = bundle.nodes.filter((n) => n.object_type !== 'commit');
    bundle.edges = bundle.edges.filter((e) => e.object_type !== 'commit');
    const layout = layoutDfg(bundle, BOX);
    assert.equal(layout.lanes.length, 2);
    assert.ok(layout.height < layoutDfg(dfg(), BOX).height);
  });
});

describe('edges carry their reading: direction by side, frequency by width', () => {
  test('a forward arc rises above the row, rework dips below it', () => {
    const layout = layoutDfg(dfg(), BOX);
    const rowY = layout.lanes.find((l) => l.type === 'issue').y;
    const forward = layout.edges.find((e) => e.from_activity === 'IssueOpened');
    const rework = layout.edges.find(
      (e) => e.from_activity === 'IssueClosed' && e.to_activity === 'IssueCommented',
    );
    assert.ok(forward.points[1].y < rowY, 'forward apex above the row');
    assert.ok(rework.points[1].y > rowY, 'rework apex below the row');
  });

  test('a self-succession is a loop on its own node', () => {
    const layout = layoutDfg(dfg(), BOX);
    const loop = layout.edges.find((e) => e.object_type === 'commit');
    assert.equal(loop.loop, true);
    assert.equal(loop.points.length, 1);
    const node = layout.nodes.find((n) => n.object_type === 'commit');
    assert.deepEqual(loop.points[0], { x: node.x, y: node.y });
  });

  test('two cross edges sharing endpoints fan apart; a singleton keeps the midpoint', () => {
    // The usual bundle is one succession in each direction; drawn through the same
    // midpoint the later one buries the earlier and two counts read as one arrow.
    const bundle = dfg();
    bundle.cross_edges.push({
      from_type: 'issue', from_activity: 'IssueClosed',
      to_type: 'pull_request', to_activity: 'PullRequestMerged', successions: 3, pairs: 1,
      link_qualifier: 'resolves', link_evidence: 'extracted', link_method: 'commit_message',
    });
    const layout = layoutDfg(bundle, BOX);
    const [one, two] = layout.crossEdges;
    const midpoint = {
      x: (one.points[0].x + one.points[2].x) / 2,
      y: (one.points[0].y + one.points[2].y) / 2,
    };
    const off = (edge) => Math.hypot(edge.points[1].x - midpoint.x, edge.points[1].y - midpoint.y);
    assert.ok(Math.abs(off(one) - 10) < 1e-9 && Math.abs(off(two) - 10) < 1e-9, '±10px each');
    assert.ok(
      Math.hypot(one.points[1].x - two.points[1].x, one.points[1].y - two.points[1].y) > 19,
      'the two controls sit on opposite sides',
    );
    assert.notDeepEqual(one.labelAt, two.labelAt, 'labels separate with their edges');

    const [single] = layoutDfg(dfg(), BOX).crossEdges;
    assert.deepEqual(
      single.points[1],
      { x: (single.points[0].x + single.points[2].x) / 2, y: (single.points[0].y + single.points[2].y) / 2 },
      'nothing to separate from, so the exact midpoint',
    );
  });

  test('a cross edge runs between the two named rows', () => {
    const layout = layoutDfg(dfg(), BOX);
    const [cross] = layout.crossEdges;
    const prY = layout.lanes.find((l) => l.type === 'pull_request').y;
    const issueY = layout.lanes.find((l) => l.type === 'issue').y;
    assert.equal(cross.points[0].y, prY);
    assert.equal(cross.points[2].y, issueY);
  });

  test('width is monotone in successions and clamped at both ends', () => {
    assert.ok(dfgEdgeWidth(1, 40000) < dfgEdgeWidth(100, 40000));
    assert.ok(dfgEdgeWidth(100, 40000) < dfgEdgeWidth(40000, 40000));
    assert.equal(dfgEdgeWidth(40000, 40000), 6);
    assert.equal(dfgEdgeWidth(0, 40000), 1);
    assert.equal(dfgEdgeWidth(5, 0), 1, 'an all-zero picture draws hairlines, not NaN');
    const layout = layoutDfg(dfg(), BOX);
    const heavy = layout.edges.find((e) => e.successions === 40000);
    const light = layout.edges.find((e) => e.successions === 1 && !e.loop);
    assert.ok(heavy.width > light.width);
  });
});

describe('widths hold against the artifact’s own maximum, whatever is filtered', () => {
  test('an override keeps a surviving edge’s width identical after filtering', () => {
    const full = layoutDfg(dfg(), BOX);
    const filtered = dfg();
    filtered.edges = filtered.edges.filter((e) => e.successions !== 40000);
    const stable = layoutDfg(filtered, { ...BOX, maxSuccessions: 40000 });
    const widthOf = (layout) =>
      layout.edges.find((e) => e.object_type === 'issue' && e.from_activity === 'IssueOpened').width;
    assert.equal(widthOf(stable), widthOf(full), 'a stroke means the same count at every filter');
  });

  test('without the override the survivors fatten, which is what it exists to prevent', () => {
    const filtered = dfg();
    filtered.edges = filtered.edges.filter((e) => e.successions !== 40000);
    const drifting = layoutDfg(filtered, BOX);
    const full = layoutDfg(dfg(), BOX);
    const widthOf = (layout) =>
      layout.edges.find((e) => e.object_type === 'issue' && e.from_activity === 'IssueOpened').width;
    assert.ok(widthOf(drifting) > widthOf(full));
  });
});

describe('aggregated cross arrows pass their members through the layout', () => {
  test('members survive the spread untouched', () => {
    const bundle = dfg();
    bundle.cross_edges[0].members = [{ link_qualifier: 'resolves', successions: 1 }];
    const layout = layoutDfg(bundle, BOX);
    assert.deepEqual(layout.crossEdges[0].members, bundle.cross_edges[0].members);
  });
});
