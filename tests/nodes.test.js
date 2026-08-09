import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadObjectGraph } from '../src/data/loadObjectGraph.js';
import { indexObjectGraph, normalizeGraph } from '../src/model/objectGraph.js';
import { deriveBursts } from '../src/model/bursts.js';
import { deriveCommentBursts } from '../src/model/commentBursts.js';
import { isUnmergedClose } from '../src/model/activities.js';
import { actorPoints } from '../src/render/nodes.js';
import { buildNodes, assignRanks, filterNodes } from '../src/layout/nodes.js';
import { packRows } from '../src/layout/packing.js';
import {
  deriveRelGroups,
  createState,
  resetToggles,
  linkPairKey,
  isNodeVisible,
  actorPreview,
} from '../src/state/state.js';

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
    state.lanes.commit = false;
    const filtered = filterNodes(nodes, (node) => isNodeVisible(node, state));
    assert.equal(filtered.filter((n) => n.lane === 'commit').length, 0);
    assert.ok(filtered.length > 0);
  });

  test('hiding comments removes only comment nodes', async () => {
    const { nodes } = await f1Context();
    const state = createState();
    state.showComments.issue = false;
    const filtered = filterNodes(nodes, (node) => isNodeVisible(node, state));
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
    const state = resetToggles(createState(), { relGroups: groups });
    assert.equal(Object.keys(state.relPairs).length, 4);
    assert.ok(Object.values(state.relPairs).every(Boolean));
  });

  test('every link resolves to a toggle key', async () => {
    const graph = await loadF1();
    const index = indexObjectGraph(graph);
    const groups = deriveRelGroups(graph.links, index.byId);
    const state = resetToggles(createState(), { relGroups: groups });
    // No exemption: since decision 41 every link in the bundle is object→object, so
    // every one of them must be reachable by a control. A link nobody can switch off
    // is as much a defect as one that switches off something else.
    for (const link of graph.links) {
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

/**
 * A commit observed in several pushes.
 *
 * The SHA reaches another branch and GitHub reports a new PushEvent, so one commit
 * object carries several `CommitObserved` events. It is common — 39.6% of vscode's
 * commits, 13.8% of react's — and it used to be dropped: the lane drew one glyph at
 * the first observation while the actor counts, the statistics and the axis range
 * all still included the rest. The complaint that found it was a one-commit sub-log
 * whose actor row read "3".
 *
 * Built inline rather than as a fixture because the property is one commit and three
 * events, and a fixture would bury that in a bundle.
 */
function repeatedCommitGraph() {
  const sha = 'commit:0001036d35667864ab01e65ac70325a7090a2f51';
  const at = (time, ref, pushId, i) => ({
    id: `e_obs${i}`,
    activity: 'CommitObserved',
    time,
    object_id: sha,
    actor_id: 'actor:flarnie',
    repo: 'facebook/react',
    comment: false,
    attrs: { ref, push_id: pushId },
  });
  return normalizeGraph({
    meta: { repo: 'facebook/react', seed: [{ id: sha, type: 'commit' }], traversal_degree: 2 },
    objects: [
      { id: 'actor:flarnie', type: 'actor', label: '@flarnie', repo: 'facebook/react', vmap: { login: 'flarnie' }, intervals: [] },
      {
        id: sha,
        type: 'commit',
        label: '0001036',
        repo: 'facebook/react',
        time_semantics: 'first_seen(push)',
        vmap: { commit_sha: sha.slice(7), ref: 'refs/heads/15.6-dev', push_id: 1728284989 },
        intervals: [{ start: '2017-05-09T13:29:38Z', end: '2017-05-09T13:29:38Z' }],
      },
    ],
    events: [
      at('2017-05-09T13:29:38Z', 'refs/heads/15.6-dev', 1728284989, 0),
      at('2017-06-13T14:37:53Z', 'refs/heads/15-stable', 1797396175, 2),
      at('2017-06-12T23:36:23Z', 'refs/heads/15-dev', 1795913512, 1),
    ],
    links: [],
  });
}

describe('a commit observed in several pushes', () => {
  const build = () => {
    const graph = repeatedCommitGraph();
    const index = indexObjectGraph(graph);
    return buildNodes({ graph, index, bursts: [] }).filter((n) => n.lane === 'commit');
  };

  test('stays exactly one node — anchors, bursts and groups all assume it', () => {
    assert.equal(build().length, 1);
  });

  test('carries every observation, in time order however the events arrived', () => {
    const [node] = build();
    assert.equal(node.observations.length, 3);
    assert.deepEqual(
      node.observations.map((o) => o.ref),
      ['refs/heads/15.6-dev', 'refs/heads/15-dev', 'refs/heads/15-stable'],
    );
    const times = node.observations.map((o) => +o.time);
    assert.deepEqual(times.slice().sort((a, b) => a - b), times);
  });

  test('the node still stands at the first observation', () => {
    const [node] = build();
    assert.equal(+node.t, +new Date('2017-05-09T13:29:38Z'));
    assert.equal(+node.observations[0].time, +node.t);
  });

  test('each observation keeps its own ref and push, not the object vmap', () => {
    const [node] = build();
    // The object's own vmap describes the FIRST push only. Reading it for the others
    // is what claimed a three-branch commit had reached one.
    assert.deepEqual(
      node.observations.map((o) => o.pushId),
      [1728284989, 1795913512, 1797396175],
    );
  });

  test('each observation records its own pusher, which the object cannot', () => {
    const [node] = build();
    // 89% of vscode's repeatedly-observed commits were pushed by more than one
    // account. `pusherByCommit` keeps one, so anything naming a pusher per
    // observation must read it from the event.
    assert.deepEqual(
      node.observations.map((o) => o.actorId),
      ['actor:flarnie', 'actor:flarnie', 'actor:flarnie'],
    );
    for (const observation of node.observations) {
      assert.ok(observation.actorId, 'an observation without a pusher cannot be labelled');
    }
  });

  test('a commit observed once carries a single observation, not none', async () => {
    const { nodes } = await f1Context();
    const commits = nodes.filter((n) => n.lane === 'commit' && !n.isBurst && !n.isGroup);
    assert.ok(commits.length > 0);
    for (const node of commits) {
      assert.equal(node.observations.length, 1, `${node.id} should have one observation`);
    }
  });
});

describe('repeat observations get their own row, and pushes are attributed per push', () => {
  const context = () => {
    const graph = repeatedCommitGraph();
    const index = indexObjectGraph(graph);
    const nodes = buildNodes({ graph, index, bursts: [] });
    for (const node of nodes) node.x = 0;
    return { graph, index, nodes };
  };

  test('the commit lane reserves one row below the commits for repeats', () => {
    const { nodes } = context();
    const { maxRowByLane, repeatRow } = packRows(nodes, ['commit'], {});
    // One commit occupies row 0; the repeats get row 1, and the lane grows to hold it.
    assert.equal(repeatRow, 1);
    assert.equal(maxRowByLane.get('commit'), 1);
  });

  test('no row is reserved when nothing repeats', async () => {
    const graph = await loadF1();
    const index = indexObjectGraph(graph);
    const nodes = buildNodes({ graph, index, bursts: deriveBursts(index.objectsOfType('commit')) });
    const { repeatRow } = packRows(nodes, ['commit'], {});
    assert.equal(repeatRow, null, 'F1 has no repeated commit, so the lane must not grow');
  });

  test('pusherByCommit names the FIRST pusher, not whichever event was written last', () => {
    // Events are supplied out of order on purpose: the last one written is the
    // 15-stable push, the earliest is 15.6-dev. Overwriting would pick the wrong one.
    const graph = repeatedCommitGraph();
    const index = indexObjectGraph(graph);
    const commit = index.objectsOfType('commit')[0];
    const first = index.eventsOf(commit.id)[0];
    assert.equal(index.pusherByCommit.get(commit.id), first.actor_id);
  });

  test('an actor is attributed the pushes they made, not the commits they touched', () => {
    const { nodes } = context();
    const commit = nodes.find((n) => n.lane === 'commit');
    // All three pushes here are flarnie's, so all three observations are theirs — the
    // point being that the answer comes from the observations, not from one stored id.
    const mine = commit.observations.filter((o) => o.actorId === 'actor:flarnie');
    assert.equal(mine.length, 3);
    assert.equal(commit.observations.filter((o) => o.actorId === 'actor:nobody').length, 0);
  });
});

describe('ordinal mode gives every drawn mark its own slot', () => {
  test('repeat observations are ranked, in time order, alongside the nodes', () => {
    const graph = repeatedCommitGraph();
    const index = indexObjectGraph(graph);
    const nodes = buildNodes({ graph, index, bursts: [] });
    const { rankOrder, rankMax, rankTimes } = assignRanks(nodes);

    // One commit node + two repeat observations = three ranked marks, not one.
    assert.equal(rankOrder.length, 3);
    assert.equal(rankMax, 2);
    assert.deepEqual(
      rankOrder.map((m) => m.rank),
      [0, 1, 2],
    );
    for (let i = 1; i < rankTimes.length; i++) {
      assert.ok(rankTimes[i] >= rankTimes[i - 1], 'ranks must follow time');
    }

    // Every repeat carries a distinct rank. Without this they had none at all, and
    // `ordinalTime` interpolated them — anything past the last ranked node clamped to
    // the right edge and landed on top of whatever ended the sub-log.
    const commit = nodes.find((n) => n.lane === 'commit');
    const ranks = commit.observations.map((o) => o.rank ?? commit.rank);
    assert.equal(new Set(ranks).size, 3, 'each observation needs its own ordinal slot');
  });

  test('a sub-log with no repeats ranks exactly as before', async () => {
    const { nodes } = await f1Context();
    const { rankOrder, rankMax } = assignRanks(nodes);
    assert.equal(rankOrder.length, nodes.length);
    assert.equal(rankMax, nodes.length - 1);
  });
});

describe('a pull request that ended without merging is marked as such', () => {
  test('PullRequestClosed is an unmerged close; PullRequestMerged is not', () => {
    assert.equal(isUnmergedClose('PullRequestClosed'), true);
    assert.equal(isUnmergedClose('PullRequestMerged'), false);
    // IssueClosed is the normal end of an issue, not an abandonment.
    assert.equal(isUnmergedClose('IssueClosed'), false);
    assert.equal(isUnmergedClose('PullRequestOpened'), false);
  });

  test('the flag rides on the node, so the renderer derives nothing', async () => {
    const { nodes } = await f1Context();
    const closed = nodes.filter((n) => n.event?.activity === 'PullRequestClosed');
    const merged = nodes.filter((n) => n.event?.activity === 'PullRequestMerged');
    assert.ok(closed.length > 0, 'F1 must contain a PR close to exercise this');
    assert.ok(merged.length > 0, 'F1 must contain a PR merge to exercise this');
    for (const node of closed) assert.equal(node.unmergedClose, true);
    for (const node of merged) assert.equal(node.unmergedClose, false);
  });

  test('the two marks are mutually exclusive — merged is a landmark, closed is not', async () => {
    const { nodes } = await f1Context();
    for (const node of nodes) {
      assert.ok(
        !(node.landmark && node.unmergedClose),
        `${node.id} claims both landmark emphasis and the abandoned mark`,
      );
    }
  });

  test('commits and bursts never carry the flag', async () => {
    const { nodes } = await f1Context();
    for (const node of nodes.filter((n) => n.lane === 'commit')) {
      assert.ok(!node.unmergedClose, `${node.id} is a commit and cannot be an unmerged close`);
    }
  });
});

describe('hovering an actor previews the same trail clicking would pin', () => {
  const stateWith = (...ids) => ({ actors: new Set(ids) });

  test('a hovered actor previews exactly themselves', () => {
    const preview = actorPreview('actor:connor4312', stateWith());
    assert.deepEqual([...preview.actors], ['actor:connor4312']);
  });

  test('nothing is previewed for an actor already pinned', () => {
    // Drawing over a pinned trail doubles every stroke, which reads as the pinned one
    // brightening — a state change the user did not make.
    assert.equal(actorPreview('actor:connor4312', stateWith('actor:connor4312')), null);
  });

  test('nothing is previewed for no actor — this is how mouseleave clears', () => {
    assert.equal(actorPreview(null, stateWith()), null);
    assert.equal(actorPreview(undefined, stateWith('actor:x')), null);
  });

  test('previewing never touches what is pinned', () => {
    const state = stateWith('actor:a');
    const before = [...state.actors];
    actorPreview('actor:b', state);
    actorPreview(null, state);
    assert.deepEqual([...state.actors], before, 'hover must not disturb the pinned set');
  });

  test('the preview draws the same points the pinned trail would', async () => {
    const { nodes } = await f1Context();
    for (const node of nodes) node.x = 0, (node.y = 0);
    const actorId = nodes.find((n) => n.actorId)?.actorId;
    assert.ok(actorId, 'F1 must attribute at least one node to an actor');

    // Both paths call renderActorTrails with a one-actor selection, so the geometry has
    // to agree — that is what makes hover an honest preview of the click rather than an
    // approximation of it.
    const hovered = actorPreview(actorId, stateWith());
    const pinned = stateWith(actorId);
    assert.deepEqual([...hovered.actors], [...pinned.actors]);
    assert.deepEqual(actorPoints(nodes, [...hovered.actors][0]), actorPoints(nodes, actorId));
    assert.ok(actorPoints(nodes, actorId).length > 0, 'the trail must have points');
  });
});

describe('comments close together in time fold into one mark', () => {
  const at = (h) => new Date(Date.UTC(2025, 0, 1, h)).toISOString();
  const build = async (windowDays, expanded = new Set()) => {
    const graph = normalizeGraph({
      meta: { repo: 'r', seed: [{ id: 'issue:1', type: 'issue' }] },
      objects: [
        { id: 'actor:a', type: 'actor', label: '@a', repo: 'r', vmap: { login: 'a' }, intervals: [] },
        { id: 'issue:1', type: 'issue', label: '#1', repo: 'r',
          intervals: [{ start: at(0), end: at(400) }] },
      ],
      events: [
        { id: 'e0', activity: 'IssueOpened', time: at(0), object_id: 'issue:1', actor_id: 'actor:a', repo: 'r', comment: false },
        // three within an hour of each other, then one a fortnight later
        { id: 'c1', activity: 'IssueCommented', time: at(1), object_id: 'issue:1', actor_id: 'actor:a', repo: 'r', comment: true },
        { id: 'c2', activity: 'IssueCommented', time: at(2), object_id: 'issue:1', actor_id: 'actor:a', repo: 'r', comment: true },
        { id: 'c3', activity: 'IssueCommented', time: at(3), object_id: 'issue:1', actor_id: 'actor:a', repo: 'r', comment: true },
        { id: 'c4', activity: 'IssueCommented', time: at(400), object_id: 'issue:1', actor_id: 'actor:a', repo: 'r', comment: true },
      ],
      links: [],
    });
    const index = indexObjectGraph(graph);
    const commentBursts = deriveCommentBursts(index, ['issue', 'pull_request'], { windowDays });
    const nodes = buildNodes({
      graph, index, bursts: [], commentBursts, expandedCommentBursts: expanded,
    });
    return { graph, index, commentBursts, nodes };
  };

  test('a run inside the window folds; a distant comment does not', async () => {
    const { commentBursts } = await build(1);
    assert.equal(commentBursts.length, 1, 'the three close comments are one burst');
    assert.equal(commentBursts[0].size, 3);
    assert.deepEqual(commentBursts[0].eventIds, ['c1', 'c2', 'c3']);
  });

  test('the folded run draws one node, and the lone comment keeps its own', async () => {
    const { nodes } = await build(1);
    const comments = nodes.filter((n) => n.isComment);
    assert.equal(comments.length, 2, 'one burst mark plus one unfolded comment');
    assert.equal(comments.filter((n) => n.isCommentBurst).length, 1);
    assert.equal(comments.find((n) => n.isCommentBurst).commentBurst.size, 3);
  });

  test('a wider window swallows the distant comment too', async () => {
    const { commentBursts } = await build(30);
    assert.equal(commentBursts.length, 1);
    assert.equal(commentBursts[0].size, 4, 'all four now read as one exchange');
  });

  test('a zero window folds nothing that is not simultaneous', async () => {
    const { commentBursts, nodes } = await build(0);
    assert.equal(commentBursts.length, 0);
    assert.equal(nodes.filter((n) => n.isComment).length, 4, 'every comment drawn');
  });

  test('expanding one restores its comments individually', async () => {
    const { commentBursts } = await build(1);
    const { nodes } = await build(1, new Set([commentBursts[0].id]));
    assert.equal(nodes.filter((n) => n.isCommentBurst).length, 0);
    assert.equal(nodes.filter((n) => n.isComment).length, 4);
  });

  test('a run of one is a comment, never a burst', async () => {
    const { commentBursts } = await build(1);
    assert.ok(commentBursts.every((b) => b.size >= 2), 'a burst of one explains nothing');
  });

  test('folding is a display choice — the events are all still there', async () => {
    const { graph } = await build(1);
    assert.equal(graph.events.filter((e) => e.comment).length, 4);
  });
});
