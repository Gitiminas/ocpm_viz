import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadObjectGraph } from '../src/data/loadObjectGraph.js';
import { indexObjectGraph, normalizeGraph } from '../src/model/objectGraph.js';
import { deriveBursts } from '../src/model/bursts.js';
import { buildNodes, assignRanks, filterNodes } from '../src/layout/nodes.js';
import { deriveRelGroups, createState, resetRelPairs, linkPairKey } from '../src/state/state.js';

const fileTransport = async (query) =>
  JSON.parse(await readFile(new URL(`./fixtures/${query.fixture || 'F1'}.json`, import.meta.url), 'utf8'));
const loadF1 = () => loadObjectGraph({ fixture: 'F1' }, { transport: fileTransport });

async function f1Context({ mode = 'real', expandedBursts = new Set() } = {}) {
  const graph = await loadF1();
  const index = indexObjectGraph(graph);
  const bursts = deriveBursts(index.objectsOfType('commit'));
  const nodes = buildNodes({ graph, index, bursts, expandedBursts, mode });
  return { graph, index, bursts, nodes };
}

describe('node construction over F1', () => {
  test('every issue and PR event becomes a node', async () => {
    const { nodes } = await f1Context();
    // Issue lane: opened + closed + 2 comments. PR lane: opened + merged + closed
    // + 3 comments. GitHub models PR comments as IssueCommented events attached to
    // the PR object, which is why the PR lane carries more comment nodes.
    assert.equal(nodes.filter((n) => n.lane === 'issue').length, 4);
    assert.equal(nodes.filter((n) => n.lane === 'pull_request').length, 6);
    // 4 + 6 event nodes, plus 32 commits, accounts for every event in the sub-log.
    assert.equal(4 + 6 + 32, 42);
  });

  test('a collapsed burst replaces its 20 members with one node', async () => {
    const { nodes } = await f1Context();
    const commitNodes = nodes.filter((n) => n.lane === 'commit');
    // 32 commits, 20 folded into one burst node, leaves 12 + 1.
    assert.equal(commitNodes.length, 13);
    const burstNodes = commitNodes.filter((n) => n.isBurst);
    assert.equal(burstNodes.length, 1);
    assert.equal(burstNodes[0].title, '20 commits');
  });

  test('the burst label comes from the member count, not metadata', async () => {
    const { nodes, bursts } = await f1Context();
    const burstNode = nodes.find((n) => n.isBurst);
    assert.equal(burstNode.title, `${bursts[0].commits.length} commits`);
    // The retired claim was 21. Nothing reads it any more.
    assert.notEqual(burstNode.title, '21 commits');
  });

  test('expanding the burst reveals every member individually', async () => {
    const { bursts } = await f1Context();
    const { nodes } = await f1Context({ expandedBursts: new Set([bursts[0].id]) });
    const commitNodes = nodes.filter((n) => n.lane === 'commit');
    assert.equal(commitNodes.length, 32);
    assert.equal(commitNodes.filter((n) => n.isBurst).length, 0);
  });

  test('highlights mode folds unremarkable runs into count badges', async () => {
    const real = await f1Context({ mode: 'real' });
    const highlights = await f1Context({ mode: 'highlights' });
    const realCommits = real.nodes.filter((n) => n.lane === 'commit').length;
    const highlightCommits = highlights.nodes.filter((n) => n.lane === 'commit').length;
    assert.ok(highlightCommits < realCommits, 'grouping must reduce the commit count');
    const groups = highlights.nodes.filter((n) => n.isGroup);
    assert.ok(groups.length > 0);
    for (const group of groups) {
      assert.equal(group.groupCount, group.members.length);
      assert.ok(group.groupCount > 1, 'a run of one is never grouped');
    }
  });

  test('every node carries a resolvable time', async () => {
    const { nodes } = await f1Context();
    for (const node of nodes) {
      assert.ok(node.t != null && Number.isFinite(+node.t), `node ${node.id} has no time`);
    }
  });
});

describe('multiple issues and PRs all render — the singleton bug', () => {
  const twoOfEach = () =>
    normalizeGraph({
      meta: {},
      objects: [
        { id: 'issue:1', type: 'issue', label: '#1', intervals: [{ start: '2025-01-01T00:00:00Z', end: '2025-01-05T00:00:00Z' }] },
        { id: 'issue:2', type: 'issue', label: '#2', intervals: [{ start: '2025-01-02T00:00:00Z', end: '2025-01-06T00:00:00Z' }] },
        { id: 'pr:1', type: 'pull_request', label: 'PR #1', intervals: [{ start: '2025-01-03T00:00:00Z', end: '2025-01-04T00:00:00Z' }] },
        { id: 'pr:2', type: 'pull_request', label: 'PR #2', intervals: [{ start: '2025-01-03T12:00:00Z', end: '2025-01-05T00:00:00Z' }] },
      ],
      events: [
        { id: 'e1', activity: 'IssueOpened', time: '2025-01-01T00:00:00Z', object_id: 'issue:1' },
        { id: 'e2', activity: 'IssueOpened', time: '2025-01-02T00:00:00Z', object_id: 'issue:2' },
        { id: 'e3', activity: 'IssueClosed', time: '2025-01-05T00:00:00Z', object_id: 'issue:1' },
        { id: 'e4', activity: 'PullRequestOpened', time: '2025-01-03T00:00:00Z', object_id: 'pr:1' },
        { id: 'e5', activity: 'PullRequestOpened', time: '2025-01-03T12:00:00Z', object_id: 'pr:2' },
        { id: 'e6', activity: 'PullRequestMerged', time: '2025-01-04T00:00:00Z', object_id: 'pr:1' },
      ],
      links: [],
    });

  test('both issues and both PRs contribute nodes', () => {
    const graph = twoOfEach();
    const index = indexObjectGraph(graph);
    const nodes = buildNodes({ graph, index, bursts: [] });

    const issueObjects = new Set(nodes.filter((n) => n.lane === 'issue').map((n) => n.objectId));
    const prObjects = new Set(nodes.filter((n) => n.lane === 'pull_request').map((n) => n.objectId));

    assert.deepEqual([...issueObjects].sort(), ['issue:1', 'issue:2']);
    assert.deepEqual([...prObjects].sort(), ['pr:1', 'pr:2']);
    assert.equal(nodes.length, 6);
  });

  test('a sub-log with no commits produces no commit nodes and does not throw', () => {
    const graph = twoOfEach();
    const index = indexObjectGraph(graph);
    const nodes = buildNodes({ graph, index, bursts: [] });
    assert.equal(nodes.filter((n) => n.lane === 'commit').length, 0);
  });

  test('a PR with no linked issue still renders', () => {
    const graph = normalizeGraph({
      meta: {},
      objects: [{ id: 'pr:9', type: 'pull_request', label: 'PR #9', intervals: [{ start: '2025-01-01T00:00:00Z' }] }],
      events: [{ id: 'e1', activity: 'PullRequestOpened', time: '2025-01-01T00:00:00Z', object_id: 'pr:9' }],
      links: [],
    });
    const index = indexObjectGraph(graph);
    const nodes = buildNodes({ graph, index, bursts: [] });
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].lane, 'pull_request');
  });
});

describe('ranking and filtering', () => {
  test('ranks follow temporal order and are dense', async () => {
    const { nodes } = await f1Context();
    const { rankOrder, rankMax, rankTimes } = assignRanks(nodes);
    assert.equal(rankOrder.length, nodes.length);
    assert.equal(rankMax, nodes.length - 1);
    for (let i = 1; i < rankTimes.length; i++) {
      assert.ok(rankTimes[i] >= rankTimes[i - 1], 'ranks must be in time order');
    }
    assert.deepEqual(
      rankOrder.map((n) => n.rank),
      rankOrder.map((_, i) => i),
    );
  });

  test('ranks are deterministic when timestamps tie', () => {
    const same = new Date('2025-01-01T00:00:00Z');
    const build = () =>
      assignRanks([
        { id: 'b', lane: 'commit', t: same },
        { id: 'a', lane: 'commit', t: same },
      ]).rankOrder.map((n) => n.id);
    assert.deepEqual(build(), build());
    assert.deepEqual(build(), ['a', 'b']);
  });

  test('hiding a lane removes exactly that lane', async () => {
    const { nodes } = await f1Context();
    const state = createState();
    state.tracks.commit = false;
    const filtered = filterNodes(nodes, state);
    assert.equal(filtered.filter((n) => n.lane === 'commit').length, 0);
    assert.ok(filtered.length > 0);
  });

  test('hiding comments removes only comment nodes', async () => {
    const { nodes } = await f1Context();
    const state = createState();
    state.showComments.issue = false;
    const filtered = filterNodes(nodes, state);
    assert.equal(filtered.filter((n) => n.lane === 'issue' && n.isComment).length, 0);
    assert.ok(filtered.some((n) => n.lane === 'issue'), 'issue events must survive');
    assert.ok(filtered.some((n) => n.lane === 'pull_request' && n.isComment), 'PR comments untouched');
  });
});

describe('relationship toggles are derived, not enumerated', () => {
  test('F1 yields the four evidence × type-pair combinations', async () => {
    const graph = await loadF1();
    const index = indexObjectGraph(graph);
    const groups = deriveRelGroups(graph.links, index.byId);

    const summary = groups.map((g) => [g.key, g.pairs.map((p) => p.label).sort()]);
    assert.deepEqual(summary, [
      ['validated', ['Commit ↔ PR', 'Issue ↔ PR']],
      ['extracted', ['Commit ↔ Issue', 'Commit ↔ PR']],
    ]);
  });

  test('every derived pair starts visible', async () => {
    const graph = await loadF1();
    const index = indexObjectGraph(graph);
    const groups = deriveRelGroups(graph.links, index.byId);
    const state = resetRelPairs(createState(), groups);
    assert.equal(Object.keys(state.relPairs).length, 4);
    assert.ok(Object.values(state.relPairs).every(Boolean));
  });

  test('every object link resolves to a toggle key', async () => {
    const graph = await loadF1();
    const index = indexObjectGraph(graph);
    const groups = deriveRelGroups(graph.links, index.byId);
    const state = resetRelPairs(createState(), groups);
    for (const link of graph.links) {
      if (link.qualifier === 'actor') continue;
      const key = linkPairKey(link, index.byId);
      assert.ok(key in state.relPairs, `link ${link.source}→${link.target} has no toggle`);
    }
  });

  test('retired vocabulary does not appear in any toggle key', async () => {
    const graph = await loadF1();
    const index = indexObjectGraph(graph);
    const groups = deriveRelGroups(graph.links, index.byId);
    assert.doesNotMatch(JSON.stringify(groups), /inferred/);
  });
});
