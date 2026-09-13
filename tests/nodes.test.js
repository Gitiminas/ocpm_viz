import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadSubLog } from '../src/data/loadSubLog.js';
import { subjectEvent, pushEvent } from './support/events.js';
import { indexSubLog, normalizeGraph, actorOf } from '../src/model/subLog.js';
import { deriveBursts } from '../src/model/bursts.js';
import { deriveCommentBursts } from '../src/model/commentBursts.js';
import { isUnmergedClose } from '../src/model/activities.js';
import { actorPoints, expandedCommentRuns, markForEvent, labelledMarks } from '../src/render/nodes.js';
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
const loadF1 = () => loadSubLog({ fixture: 'F1' }, { transport: fileTransport });

async function f1Context({ mode = 'absolute', expandedBursts = new Set() } = {}) {
  const graph = await loadF1();
  const index = indexSubLog(graph);
  const bursts = deriveBursts(index.objectsOfType('commit'));
  const nodes = buildNodes({ graph, index, bursts, expandedBursts, mode });
  return { graph, index, bursts, nodes };
}

describe('node construction over F1', () => {
  test('every issue and PR event becomes a node', async () => {
    const { nodes } = await f1Context();
    // Issue lane: opened + closed + 2 comments. PR lane: opened + merged + closed
    // + 3 comments, which is why the PR lane carries more comment nodes.
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

  test('the node list does not depend on the mode — folding is by push_id alone', async () => {
    // No mode has a folding rule of its own — no runs of unremarkable commits into a
    // count badge. Pinned: the same sub-log yields the same marks in every temporal mode,
    // and no node is a "group" of anything but a push.
    const real = await f1Context({ mode: 'absolute' });
    const discrete = await f1Context({ mode: 'discrete' });
    assert.deepEqual(
      discrete.nodes.map((n) => n.id),
      real.nodes.map((n) => n.id),
      'the mode changed which marks exist',
    );
    assert.ok(real.nodes.every((n) => !n.isGroup && n.groupKey === undefined));
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
        subjectEvent('e1', 'IssueOpened', '2025-01-01T00:00:00Z', 'issue:1'),
        subjectEvent('e2', 'IssueOpened', '2025-01-02T00:00:00Z', 'issue:2'),
        subjectEvent('e3', 'IssueClosed', '2025-01-05T00:00:00Z', 'issue:1'),
        subjectEvent('e4', 'PullRequestOpened', '2025-01-03T00:00:00Z', 'pr:1'),
        subjectEvent('e5', 'PullRequestOpened', '2025-01-03T12:00:00Z', 'pr:2'),
        subjectEvent('e6', 'PullRequestMerged', '2025-01-04T00:00:00Z', 'pr:1'),
      ],
      links: [],
    });

  test('both issues and both PRs contribute nodes', () => {
    const graph = twoOfEach();
    const index = indexSubLog(graph);
    const nodes = buildNodes({ graph, index, bursts: [] });

    const issueObjects = new Set(nodes.filter((n) => n.lane === 'issue').map((n) => n.objectId));
    const prObjects = new Set(nodes.filter((n) => n.lane === 'pull_request').map((n) => n.objectId));

    assert.deepEqual([...issueObjects].sort(), ['issue:1', 'issue:2']);
    assert.deepEqual([...prObjects].sort(), ['pr:1', 'pr:2']);
    assert.equal(nodes.length, 6);
  });

  test('a sub-log with no commits produces no commit nodes and does not throw', () => {
    const graph = twoOfEach();
    const index = indexSubLog(graph);
    const nodes = buildNodes({ graph, index, bursts: [] });
    assert.equal(nodes.filter((n) => n.lane === 'commit').length, 0);
  });

  test('a PR with no linked issue still renders', () => {
    const graph = normalizeGraph({
      meta: {},
      objects: [{ id: 'pr:9', type: 'pull_request', label: 'PR #9', intervals: [{ start: '2025-01-01T00:00:00Z' }] }],
      events: [subjectEvent('e1', 'PullRequestOpened', '2025-01-01T00:00:00Z', 'pr:9')],
      links: [],
    });
    const index = indexSubLog(graph);
    const nodes = buildNodes({ graph, index, bursts: [] });
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].lane, 'pull_request');
  });
});

describe('ranking and filtering', () => {
  test('ranks follow temporal order and are dense over distinct instants', async () => {
    const { nodes } = await f1Context();
    const { rankOrder, rankMax, rankTimes } = assignRanks(nodes);
    assert.equal(rankOrder.length, nodes.length);
    const distinct = new Set(nodes.map((n) => +n.t)).size;
    assert.equal(rankTimes.length, distinct, 'one rank per instant');
    assert.equal(rankMax, Math.max(1, distinct - 1));
    for (let i = 1; i < rankTimes.length; i++) {
      assert.ok(rankTimes[i] > rankTimes[i - 1], 'rank instants are strictly increasing');
    }
    // Dense: each rank is the previous rank or the previous rank plus one, from 0.
    assert.equal(rankOrder[0].rank, 0);
    for (let i = 1; i < rankOrder.length; i++) {
      const step = rankOrder[i].rank - rankOrder[i - 1].rank;
      assert.ok(step === 0 || step === 1, `rank jumped by ${step} at ${i}`);
      assert.equal(step === 0, +rankOrder[i].t === +rankOrder[i - 1].t, 'same rank iff same instant');
    }
  });

  test('two events at the same instant share a column in discrete mode', () => {
    // vscode #188934: a reopen and the comment that reopened it, both 2023-07-27 21:05:51.
    const t = new Date('2023-07-27T21:05:51Z');
    const later = new Date('2023-07-27T21:07:00Z');
    const { rankOrder, rankMax, rankTimes } = assignRanks([
      { id: 'e_comment', lane: 'issue', t },
      { id: 'e_reopen', lane: 'issue', t },
      { id: 'e_after', lane: 'issue', t: later },
    ]);
    const byId = new Map(rankOrder.map((m) => [m.id, m.rank]));
    assert.equal(byId.get('e_comment'), byId.get('e_reopen'), 'same second, same rank');
    assert.equal(byId.get('e_after'), 1);
    assert.equal(rankMax, 1);
    assert.deepEqual(rankTimes, [+t, +later]);
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
    const index = indexSubLog(graph);
    const groups = deriveRelGroups(graph.links, index.byId);

    const summary = groups.map((g) => [g.key, g.pairs.map((p) => p.label).sort()]);
    // Still four: the Issue ↔ PR pair moved from validated to extracted with pr_body.
    assert.deepEqual(summary, [
      ['validated', ['Commit ↔ PR']],
      ['extracted', ['Commit ↔ Issue', 'Commit ↔ PR', 'Issue ↔ PR']],
    ]);
  });

  test('every derived pair starts visible', async () => {
    const graph = await loadF1();
    const index = indexSubLog(graph);
    const groups = deriveRelGroups(graph.links, index.byId);
    const state = resetToggles(createState(), { relGroups: groups });
    assert.equal(Object.keys(state.relPairs).length, 4);
    assert.ok(Object.values(state.relPairs).every(Boolean));
  });

  test('every link resolves to a toggle key', async () => {
    const graph = await loadF1();
    const index = indexSubLog(graph);
    const groups = deriveRelGroups(graph.links, index.byId);
    const state = resetToggles(createState(), { relGroups: groups });
    // No exemption: every link in the bundle is object→object, so every one of them
    // must be reachable by a control. A link nobody can switch off is as much a defect
    // as one that switches off something else.
    for (const link of graph.links) {
      const key = linkPairKey(link, index.byId);
      assert.ok(key in state.relPairs, `link ${link.source}→${link.target} has no toggle`);
    }
  });

  test('retired vocabulary does not appear in any toggle key', async () => {
    const graph = await loadF1();
    const index = indexSubLog(graph);
    const groups = deriveRelGroups(graph.links, index.byId);
    assert.doesNotMatch(JSON.stringify(groups), /inferred/);
  });
});

/**
 * A commit observed in several pushes.
 *
 * The SHA reaches another branch and GitHub reports a new PushEvent, so one commit
 * object is carried by several `Push` events. It is common — 39.6% of vscode's
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
  const at = (time, ref, pushId, i) =>
    pushEvent(`push:${i}`, time, [sha], { actorId: 'actor:flarnie', repo: 'facebook/react', attrs: { ref, push_id: pushId } });
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
    const index = indexSubLog(graph);
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
    const index = indexSubLog(graph);
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
    const index = indexSubLog(graph);
    const nodes = buildNodes({ graph, index, bursts: deriveBursts(index.objectsOfType('commit')) });
    const { repeatRow } = packRows(nodes, ['commit'], {});
    assert.equal(repeatRow, null, 'F1 has no repeated commit, so the lane must not grow');
  });

  test('pusherByCommit names the FIRST pusher, not whichever event was written last', () => {
    // Events are supplied out of order on purpose: the last one written is the
    // 15-stable push, the earliest is 15.6-dev. Overwriting would pick the wrong one.
    const graph = repeatedCommitGraph();
    const index = indexSubLog(graph);
    const commit = index.objectsOfType('commit')[0];
    const first = index.eventsOf(commit.id)[0];
    assert.equal(index.pusherByCommit.get(commit.id), actorOf(first));
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

describe('discrete mode gives every drawn mark its own slot', () => {
  test('repeat observations are ranked, in time order, alongside the nodes', () => {
    const graph = repeatedCommitGraph();
    const index = indexSubLog(graph);
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
    // `discreteTime` interpolated them — anything past the last ranked node clamped to
    // the right edge and landed on top of whatever ended the sub-log.
    const commit = nodes.find((n) => n.lane === 'commit');
    const ranks = commit.observations.map((o) => o.rank ?? commit.rank);
    assert.equal(new Set(ranks).size, 3, 'each observation needs its own discrete slot');
  });

  test('a sub-log with no repeats ranks one slot per instant, as everywhere', async () => {
    const { nodes } = await f1Context();
    const { rankOrder, rankMax } = assignRanks(nodes);
    assert.equal(rankOrder.length, nodes.length);
    // Marks at one instant share a slot (`assignRanks`), so the last rank is the number
    // of distinct instants minus one — equal to nodes.length - 1 only when no two tie.
    assert.equal(rankMax, Math.max(1, new Set(nodes.map((n) => +n.t)).size - 1));
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
        subjectEvent('e0', 'IssueOpened', at(0), 'issue:1', { actorId: 'actor:a', repo: 'r', comment: false }),
        // three within an hour of each other, then one a fortnight later
        subjectEvent('c1', 'IssueCommented', at(1), 'issue:1', { actorId: 'actor:a', repo: 'r', comment: true }),
        subjectEvent('c2', 'IssueCommented', at(2), 'issue:1', { actorId: 'actor:a', repo: 'r', comment: true }),
        subjectEvent('c3', 'IssueCommented', at(3), 'issue:1', { actorId: 'actor:a', repo: 'r', comment: true }),
        subjectEvent('c4', 'IssueCommented', at(400), 'issue:1', { actorId: 'actor:a', repo: 'r', comment: true }),
      ],
      links: [],
    });
    const index = indexSubLog(graph);
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

describe('a comment run never crosses a lifecycle boundary', () => {
  // The mark sits at the run's first comment, so a run that straddled a close put a
  // post-close comment inside the open interval. Runs break at every lifecycle-segment
  // change, whatever the window says.
  const at = (h) => new Date(Date.UTC(2025, 0, 1, h)).toISOString();
  const derive = (intervals, commentHours, windowDays = 30) => {
    const graph = normalizeGraph({
      meta: { repo: 'r', seed: [{ id: 'issue:1', type: 'issue' }] },
      objects: [
        { id: 'actor:a', type: 'actor', label: '@a', repo: 'r', vmap: { login: 'a' }, intervals: [] },
        { id: 'issue:1', type: 'issue', label: '#1', repo: 'r', intervals },
      ],
      events: commentHours.map((h, i) =>
        subjectEvent(`c${i + 1}`, 'IssueCommented', at(h), 'issue:1', { actorId: 'actor:a', repo: 'r', comment: true }),
      ),
      links: [],
    });
    return deriveCommentBursts(indexSubLog(graph), ['issue'], { windowDays });
  };

  test('post-close comments fold with each other, never with in-life ones', () => {
    const bursts = derive([{ start: at(0), end: at(10) }], [1, 2, 20, 21]);
    assert.equal(bursts.length, 2, 'one in-life burst, one after the close');
    assert.deepEqual(bursts[0].eventIds, ['c1', 'c2']);
    assert.deepEqual(bursts[1].eventIds, ['c3', 'c4']);
  });

  test('a reopen splits runs, and a comment in the closed gap joins neither side', () => {
    const bursts = derive(
      [{ start: at(0), end: at(5) }, { start: at(8), end: at(20) }],
      [4, 4.5, 6, 9, 9.5],
    );
    assert.equal(bursts.length, 2, 'the gap comment is a run of one, so no third burst');
    assert.deepEqual(bursts[0].eventIds, ['c1', 'c2'], 'first life');
    assert.deepEqual(bursts[1].eventIds, ['c4', 'c5'], 'second life');
  });

  test('a still-open interval has no far edge, so its comments fold freely', () => {
    const bursts = derive([{ start: at(0), end: null }], [1, 300]);
    assert.equal(bursts.length, 1);
    assert.equal(bursts[0].size, 2);
  });

  test('a comment at the closing instant folds with the life it closed', () => {
    const bursts = derive([{ start: at(0), end: at(3) }], [1, 2, 3]);
    assert.equal(bursts.length, 1);
    assert.equal(bursts[0].size, 3, 'the interval end is inclusive');
  });
});

describe('an unfolded comment run can be folded back', () => {
  const at = (h) => new Date(Date.UTC(2025, 0, 1, h)).toISOString();
  const setup = async (expanded) => {
    const graph = normalizeGraph({
      meta: { repo: 'r', seed: [{ id: 'issue:1', type: 'issue' }] },
      objects: [
        { id: 'actor:a', type: 'actor', label: '@a', repo: 'r', vmap: { login: 'a' }, intervals: [] },
        { id: 'issue:1', type: 'issue', label: '#1', repo: 'r', intervals: [{ start: at(0), end: at(9) }] },
      ],
      events: [
        subjectEvent('e0', 'IssueOpened', at(0), 'issue:1', { actorId: 'actor:a', repo: 'r', comment: false }),
        ...[1, 2, 3].map((h) =>
          subjectEvent(`c${h}`, 'IssueCommented', at(h), 'issue:1', { actorId: 'actor:a', repo: 'r', comment: true }),
        ),
      ],
      links: [],
    });
    const index = indexSubLog(graph);
    const commentBursts = deriveCommentBursts(index, ['issue', 'pull_request'], { windowDays: 1 });
    const nodes = buildNodes({ graph, index, bursts: [], commentBursts, expandedCommentBursts: expanded });
    nodes.forEach((n, i) => { n.x = i * 50; n.y = 40; });
    return { commentBursts, nodes };
  };

  test('a folded run offers no handle — there is nothing to fold back', async () => {
    const { commentBursts, nodes } = await setup(new Set());
    assert.deepEqual(expandedCommentRuns(nodes, commentBursts, new Set()), []);
  });

  test('an unfolded run reports the span its handle must cover', async () => {
    const { commentBursts, nodes } = await setup(new Set());
    const expanded = new Set([commentBursts[0].id]);
    const open = await setup(expanded);
    const runs = expandedCommentRuns(open.nodes, open.commentBursts, expanded);

    assert.equal(runs.length, 1, 'the open run must be findable, or it cannot be closed');
    assert.equal(runs[0].size, 3, 'every comment of the run counts toward its extent');
    assert.ok(runs[0].maxX > runs[0].minX, 'the span must cover the run, not a point');
    assert.equal(runs[0].burst.id, commentBursts[0].id);
    void nodes;
  });

  test('a run whose comments are not drawn yields no handle, rather than a broken one', async () => {
    // Hiding comments removes the nodes; a handle floating over nothing would be worse
    // than no handle at all.
    const { commentBursts } = await setup(new Set());
    const runs = expandedCommentRuns([], commentBursts, new Set([commentBursts[0].id]));
    assert.deepEqual(runs, []);
  });
});

describe('the actor trail passes through folded marks', () => {
  // Folds have no single actorId, and the trail used to skip them: an actor's path
  // visibly broke wherever their work was folded, and only unfolding restored it.
  const nodes = [
    { id: 'a', x: 0, y: 0, t: new Date(1), actorId: 'actor:1', isComment: false },
    // A push with one pusher: on the trail, solid.
    { id: 'b', x: 10, y: 0, t: new Date(2), actorId: null, isBurst: true, actorIds: ['actor:1'] },
    // A comment run shared between two actors: on the trail, dashed.
    { id: 'c', x: 20, y: 0, t: new Date(3), actorId: null, isCommentBurst: true, isComment: true, actorIds: ['actor:1', 'actor:2'] },
    // A fold with none of this actor's work: not on the trail at all.
    { id: 'd', x: 30, y: 0, t: new Date(4), actorId: null, isBurst: true, actorIds: ['actor:2'] },
  ];

  test('folds containing the actor join the trail, flagged solid or mixed', () => {
    const points = actorPoints(nodes, 'actor:1');
    assert.equal(points.length, 3);
    assert.equal(points[1].mixed, false, 'a fold that is all this actor rings solid');
    assert.equal(points[2].mixed, true, 'a fold shared with others rings dashed');
    assert.deepEqual(actorPoints(nodes, 'actor:2').map((point) => point.x), [20, 30]);
  });

  test('a folded run of comments knows who wrote it', async () => {
    // Derived, not stored: the run's events carry the actors. Window wide enough that
    // F1's comments certainly fold.
    const { loadSubLog } = await import('../src/data/loadSubLog.js');
    const { indexSubLog } = await import('../src/model/subLog.js');
    const { deriveCommentBursts } = await import('../src/model/commentBursts.js');
    const { readFile } = await import('node:fs/promises');
    const graph = await loadSubLog(
      { fixture: 'F1' },
      { transport: async () => JSON.parse(await readFile(new URL('./fixtures/F1.json', import.meta.url), 'utf8')) },
    );
    const bursts = deriveCommentBursts(indexSubLog(graph), ['issue', 'pull_request'], { windowDays: 365 });
    assert.ok(bursts.length > 0, 'F1 must fold at least one run at a year-wide window');
    for (const burst of bursts) {
      assert.ok(burst.actorIds.length > 0, `${burst.id} names no actors`);
      assert.ok(burst.actorIds.every((id) => id.startsWith('actor:')));
    }
  });
});

describe('an actor-card row finds its mark, through whatever fold carries it', () => {
  const nodes = [
    { id: 'n_e1', event: { id: 'e1' }, objectId: 'issue:1' },
    { id: 'n_cb', isCommentBurst: true, commentBurst: { eventIds: ['e2', 'e3'] }, objectId: 'issue:1' },
    { id: 'n_burst', isBurst: true, burst: { commitIds: new Set(['commit:a', 'commit:b']) } },
    { id: 'n_obj', objectId: 'pr:9' },
  ];

  test('unfolded event → its own node; folded comment → the run; folded commit → the push', () => {
    assert.equal(markForEvent(nodes, subjectEvent('e1', 'IssueOpened', 't', 'issue:1')).id, 'n_e1');
    assert.equal(markForEvent(nodes, subjectEvent('e3', 'IssueCommented', 't', 'issue:1')).id, 'n_cb');
    assert.equal(markForEvent(nodes, pushEvent('e9', 't', ['commit:a', 'commit:b']), 'commit:b').id, 'n_burst');
  });

  test('relationships mode: the object mark stands for every one of its events', () => {
    assert.equal(markForEvent(nodes, subjectEvent('e7', 'PullRequestOpened', 't', 'pr:9')).id, 'n_obj');
  });

  test('an event whose mark is filtered out resolves to nothing, not to a wrong mark', () => {
    assert.equal(markForEvent(nodes, pushEvent('e8', 't', ['commit:zz'])), null);
    assert.equal(markForEvent(nodes, null), null);
  });
});

describe('labels give way before marks do', () => {
  const mark = (id, x, extra = {}) => ({ id, lane: 'pull_request', row: 0, x, isComment: false, ...extra });

  test('of two same-row marks 40 px apart only the right-hand one keeps its word', () => {
    const shown = labelledMarks([mark('open', 100), mark('merge', 140)]);
    assert.ok(!shown.has('open'), 'the left mark would run its word into the right mark');
    assert.ok(shown.has('merge'), 'the last mark on a row always keeps its word');
  });

  test('two marks 120 px apart both keep their words; a comment never has one', () => {
    const shown = labelledMarks([mark('open', 100), mark('c', 130, { isComment: true }), mark('merge', 220)]);
    assert.ok(shown.has('open') && shown.has('merge'));
    assert.ok(!shown.has('c'));
  });

  test('rows and lanes are independent: a close mark on another row does not hide a word', () => {
    const shown = labelledMarks([mark('open', 100), mark('other', 110, { row: 1 }), mark('issue', 105, { lane: 'issue' })]);
    assert.ok(shown.has('open') && shown.has('other') && shown.has('issue'));
  });

  test('commit labels keep their own left-to-right thinning', () => {
    const c = (id, x) => ({ id, lane: 'commit', row: 0, x, isComment: false });
    const shown = labelledMarks([c('a', 0), c('b', 30), c('c', 100)]);
    assert.deepEqual([...shown].sort(), ['a', 'c']);
  });
});
