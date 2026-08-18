import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadObjectGraph } from '../src/data/loadObjectGraph.js';
import { indexObjectGraph } from '../src/model/objectGraph.js';
import { deriveCommitGroups, isCommitInVisibleGroup, UNLINKED_GROUP } from '../src/model/commitGroups.js';
import {
  createState,
  deriveRelGroups,
  deriveQualifiers,
  deriveMethods,
  resetToggles,
  isObjectVisible,
  isNodeVisible,
  isLinkVisible,
  summarizeHidden,
  restoreAll,
} from '../src/state/state.js';
import {
  serializeState,
  applyState,
  encodePreset,
  decodePreset,
  presetUrl,
  BUILT_IN_PRESETS,
} from '../src/state/presets.js';

const fileTransport = async (query) =>
  JSON.parse(await readFile(new URL(`./fixtures/${query.fixture}.json`, import.meta.url), 'utf8'));
const load = (fixture) => loadObjectGraph({ fixture }, { transport: fileTransport });

/** Load a fixture and wire up the full toggle vocabulary, as main.js does. */
async function context(fixture) {
  const graph = await load(fixture);
  const index = indexObjectGraph(graph);
  const relGroups = deriveRelGroups(graph.links, index.byId);
  const qualifiers = deriveQualifiers(graph.links);
  const methods = deriveMethods(graph.links);
  const { groups: commitGroups, groupsByCommit } = deriveCommitGroups(
    index.objectsOfType('commit'),
    graph.links,
    index.byId,
  );
  const state = resetToggles(createState(), { relGroups, qualifiers, methods });
  return {
    graph,
    index,
    state,
    relGroups,
    qualifiers,
    methods,
    commitGroups,
    groupsByCommit,
    ctx: { relGroups, qualifiers, methods, commitGroups, objectsById: index.byId },
  };
}

const visibleLinks = (c) =>
  c.graph.links.filter((l) => isLinkVisible(l, c.index.byId, c.state, c.groupsByCommit));

describe('commit groups', () => {
  test('F13 groups commits by the PR they reach, plus the shared one in both', async () => {
    const c = await context('F13');
    const byKey = new Map(c.commitGroups.map((g) => [g.key, g]));
    assert.ok(byKey.has('pr:80') && byKey.has('pr:81'));
    // Four own commits each, plus the shared one.
    assert.equal(byKey.get('pr:80').commitIds.size, 5);
    assert.equal(byKey.get('pr:81').commitIds.size, 5);

    const shared = [...c.groupsByCommit.entries()].filter(([, groups]) => groups.size > 1);
    assert.equal(shared.length, 1, 'exactly one commit belongs to both PRs');
  });

  test('commits reaching no PR fall into an explicit group, not a silent gap', async () => {
    const c = await context('F7');
    const unlinked = c.commitGroups.find((g) => g.key === UNLINKED_GROUP);
    assert.ok(unlinked, 'F7 has no commit→PR links, so every commit is unlinked');
    assert.equal(unlinked.commitIds.size, 18);
  });

  test('a commit is visible while ANY of its groups is — convergence is not flattened', async () => {
    const c = await context('F13');
    const shared = [...c.groupsByCommit.entries()].find(([, groups]) => groups.size > 1)[0];

    const hideOne = new Set(['pr:80']);
    assert.equal(
      isCommitInVisibleGroup(shared, c.groupsByCommit, hideOne),
      true,
      'still PR #81’s commit, so it stays',
    );

    const hideBoth = new Set(['pr:80', 'pr:81']);
    assert.equal(isCommitInVisibleGroup(shared, c.groupsByCommit, hideBoth), false);
  });

  test('hiding one group removes only that group’s exclusive commits', async () => {
    const c = await context('F13');
    c.state.hiddenCommitGroups = new Set(['pr:80']);
    const commits = c.index.objectsOfType('commit');
    const visible = commits.filter((commit) =>
      isCommitInVisibleGroup(commit.id, c.groupsByCommit, c.state.hiddenCommitGroups),
    );
    // 9 commits: 4 exclusive to PR#80 go, 4 exclusive to PR#81 and the shared one stay.
    assert.equal(commits.length, 9);
    assert.equal(visible.length, 5);
  });
});

describe('individual object toggles', () => {
  test('one of two concurrent PRs can be hidden without hiding the lane', async () => {
    const c = await context('F3');
    c.state.hiddenObjects = new Set(['pr:20']);

    assert.equal(isObjectVisible(c.index.byId.get('pr:20'), c.state), false);
    assert.equal(isObjectVisible(c.index.byId.get('pr:21'), c.state), true);
    assert.equal(c.state.lanes.pull_request, true, 'the lane itself stays on');
  });

  test('hiding an object hides its nodes and its links', async () => {
    const c = await context('F3');
    const before = visibleLinks(c).length;
    c.state.hiddenObjects = new Set(['pr:20']);
    const after = visibleLinks(c).length;
    assert.ok(after < before, 'links into a hidden object must go too');

    const node = { lane: 'pull_request', objectId: 'pr:20' };
    assert.equal(isNodeVisible(node, c.state, c.groupsByCommit), false);
  });

  test('hiding the lane hides its objects regardless of their own toggles', async () => {
    const c = await context('F3');
    c.state.lanes.pull_request = false;
    assert.equal(isObjectVisible(c.index.byId.get('pr:21'), c.state), false);
  });
});

describe('link filters are independent and all must pass', () => {
  test('F1 starts with every object link visible', async () => {
    const c = await context('F1');
    assert.equal(visibleLinks(c).length, 34);
  });

  test('a qualifier toggle removes exactly that qualifier', async () => {
    const c = await context('F1');
    c.state.qualifiers.contains_commit = false;
    const remaining = visibleLinks(c);
    assert.equal(remaining.some((l) => l.qualifier === 'contains_commit'), false);
    assert.ok(remaining.length > 0, 'other qualifiers survive');
  });

  test('a detection-method toggle removes exactly that method', async () => {
    const c = await context('F1');
    c.state.methods.ref_match = false;
    const remaining = visibleLinks(c);
    assert.equal(remaining.some((l) => l.method === 'ref_match'), false);
    // F1 has 29 ref_match links out of 34.
    assert.equal(remaining.length, 5);
  });

  test('all four issue↔PR methods are toggleable even when the sub-log lacks them', async () => {
    const c = await context('F1');
    for (const method of ['pr_body', 'branch_name', 'pr_title', 'issue_comment']) {
      assert.ok(method in c.state.methods, `${method} must have a toggle`);
    }
    // F1 exercises only pr_body; the other three exist with a count of zero.
    const counts = Object.fromEntries(c.methods.map((m) => [m.key, m.count]));
    assert.equal(counts.pr_body, 1);
    assert.equal(counts.branch_name, 0);
  });

  test('filters compose — no toggle overrides another', async () => {
    const c = await context('F1');
    c.state.qualifiers.contains_commit = false;
    c.state.methods.commit_message = false;
    const remaining = visibleLinks(c);
    assert.equal(remaining.some((l) => l.qualifier === 'contains_commit'), false);
    assert.equal(remaining.some((l) => l.method === 'commit_message'), false);
  });

  test('a link whose evidence pair is off disappears even if its method is on', async () => {
    const c = await context('F1');
    const pairKey = Object.keys(c.state.relPairs).find((k) => k.startsWith('extracted'));
    c.state.relPairs[pairKey] = false;
    assert.ok(visibleLinks(c).length < 34);
  });
});

describe('the hidden summary reports every subtraction', () => {
  test('nothing hidden reports nothing', async () => {
    const c = await context('F1');
    assert.deepEqual(summarizeHidden(c.state, c.ctx), { anyHidden: false, items: [] });
  });

  test('each control that subtracts shows up by name', async () => {
    const c = await context('F13');
    c.state.lanes.commit = false;
    c.state.showComments.issue = false;
    c.state.hiddenObjects = new Set(['pr:80']);
    c.state.hiddenCommitGroups = new Set(['pr:81']);
    c.state.qualifiers.resolves = false;
    c.state.methods.head_sha = false;

    const summary = summarizeHidden(c.state, c.ctx);
    assert.equal(summary.anyHidden, true);
    const keys = summary.items.map((i) => i.key).sort();
    assert.deepEqual(keys, [
      'comments',
      'commitGroups',
      'lanes',
      'methods',
      'objects',
      'qualifiers',
    ]);
  });

  test('hidden objects are named, not merely counted', async () => {
    const c = await context('F3');
    c.state.hiddenObjects = new Set(['pr:20']);
    const item = summarizeHidden(c.state, c.ctx).items.find((i) => i.key === 'objects');
    assert.match(item.label, /PR #20/);
  });

  test('restore all really restores everything', async () => {
    const c = await context('F13');
    c.state.lanes.commit = false;
    c.state.showComments.issue = false;
    c.state.hiddenObjects = new Set(['pr:80']);
    c.state.hiddenCommitGroups = new Set(['pr:81']);
    c.state.qualifiers.resolves = false;
    c.state.methods.head_sha = false;

    restoreAll(c.state, c.ctx);
    assert.equal(summarizeHidden(c.state, c.ctx).anyHidden, false);
  });

  test('one item can be restored without restoring the rest', async () => {
    const c = await context('F1');
    c.state.lanes.commit = false;
    c.state.showComments.issue = false;
    const summary = summarizeHidden(c.state, c.ctx);
    summary.items.find((i) => i.key === 'lanes').restore(c.state);

    assert.equal(c.state.lanes.commit, true);
    assert.equal(c.state.showComments.issue, false, 'the other subtraction is untouched');
  });
});

describe('presets', () => {
  test('a snapshot round-trips through serialize and apply', async () => {
    const c = await context('F13');
    c.state.lanes.commit = false;
    c.state.hiddenObjects = new Set(['pr:80']);
    c.state.hiddenCommitGroups = new Set(['pr:81']);
    c.state.qualifiers.resolves = false;

    const snapshot = serializeState(c.state);
    const restored = applyState(createState(), snapshot);

    assert.equal(restored.lanes.commit, false);
    assert.deepEqual([...restored.hiddenObjects], ['pr:80']);
    assert.deepEqual([...restored.hiddenCommitGroups], ['pr:81']);
    assert.equal(restored.qualifiers.resolves, false);
  });

  test('a snapshot excludes zoom, focus and burst expansion', async () => {
    const c = await context('F1');
    c.state.k = 4;
    c.state.focus = 'issue:242864';
    c.state.expandedBursts = new Set(['burst:1']);
    const snapshot = serializeState(c.state);

    assert.equal('k' in snapshot, false);
    assert.equal('focus' in snapshot, false);
    assert.equal('expandedBursts' in snapshot, false);
  });

  test('a preset survives a URL round-trip', async () => {
    const c = await context('F1');
    c.state.lanes.issue = false;
    const encoded = encodePreset(serializeState(c.state));
    assert.equal(/^[A-Za-z0-9_-]+$/.test(encoded), true, 'must be URL-safe');
    assert.equal(decodePreset(encoded).lanes.issue, false);
  });

  test('a v1 snapshot written as `tracks` still applies its lanes', () => {
    // Presets live in local storage and in shared ?preset= URLs — the reproducibility
    // mechanism the task-based evaluation depends on. A v1 snapshot that quietly lost
    // its lane settings would restore a *different picture* under the same link, with
    // nothing saying so.
    const state = createState();
    applyState(state, { v: 1, tracks: { commit: false, issue: true, pull_request: true } });
    assert.equal(state.lanes.commit, false, 'a v1 `tracks` key must still be honoured');
    assert.equal(state.lanes.issue, true);
  });

  test('a v2 snapshot wins over a stray legacy key', () => {
    const state = createState();
    applyState(state, { v: 2, lanes: { commit: false }, tracks: { commit: true } });
    assert.equal(state.lanes.commit, false, 'the current key is authoritative');
  });

  test('what is written now is `lanes`, so the rename actually happened', () => {
    const snapshot = serializeState(createState());
    assert.ok('lanes' in snapshot, 'a snapshot must carry lanes');
    assert.ok(!('tracks' in snapshot), 'and must not still write the old name');
  });

  test('a malformed preset decodes to null rather than throwing', () => {
    assert.equal(decodePreset('not-valid-base64!!!'), null);
    assert.equal(decodePreset(''), null);
  });

  test('a shareable URL carries the query and the configuration', async () => {
    const c = await context('F1');
    c.state.lanes.commit = false;
    const url = presetUrl(
      'http://localhost:8000/',
      { repo: 'microsoft/vscode', seed: 'issue:242864' },
      serializeState(c.state),
    );
    const params = new URL(url).searchParams;
    // Both halves of what someone else needs: what was selected, and how it was
    // filtered.
    assert.equal(params.get('repo'), 'microsoft/vscode');
    assert.equal(params.get('seed'), 'issue:242864');
    assert.equal(decodePreset(params.get('preset')).lanes.commit, false);
  });

  test('a share URL carries everything the opening URL is parsed for — source above all', async () => {
    // ⚠️ The regression this pins: the link used to carry repo, seed and preset only.
    // Against the database it therefore had no `?source=`, opened on the fixtures
    // source, and could not find the seed — "copy link doesn't work anymore".
    const c = await context('F1');
    c.state.mode = 'relationships';
    c.state.structuralLayout = 'cluster';
    const url = presetUrl(
      'http://localhost:8000/?source=database&repo=old',
      {
        repo: 'kubernetes/kubernetes',
        seed: 'issue:235959617',
        source: 'database',
        traversalDegree: 2,
      },
      serializeState(c.state),
      { page: 'stats', brush: [0.2, 0.8], focus: 'pr:1', focusDegree: 2 },
    );
    const params = new URL(url).searchParams;
    assert.equal(params.get('source'), 'database');
    assert.equal(params.get('repo'), 'kubernetes/kubernetes');
    assert.equal(params.get('seed'), 'issue:235959617');
    assert.equal(params.get('degree'), '2');
    assert.equal(params.get('mode'), 'relationships');
    assert.equal(params.get('layout'), 'cluster');
    assert.equal(params.get('page'), 'stats');
    assert.equal(params.get('brush'), '0.2,0.8');
    assert.equal(params.get('focus'), 'pr:1');
    assert.equal(params.get('focusDegree'), '2');
    // And the arrangement travels inside the snapshot too, like the mode.
    assert.equal(decodePreset(params.get('preset')).structuralLayout, 'cluster');
  });

  test('defaults are left implicit, so a plain link stays short', async () => {
    const c = await context('F1');
    const url = presetUrl(
      'http://localhost:8000/',
      { repo: 'microsoft/vscode', seed: 'issue:242864', source: 'fixtures' },
      serializeState(c.state),
      { page: 'timeline', brush: [0, 1], focus: null },
    );
    const params = new URL(url).searchParams;
    for (const absent of ['source', 'page', 'brush', 'focus', 'focusDegree', 'degree']) {
      assert.equal(params.get(absent), null, `${absent} should not be written when default`);
    }
  });

  test('a snapshot restores the arrangement along with the mode', async () => {
    const from = await context('F1');
    from.state.mode = 'relationships';
    from.state.structuralLayout = 'cluster';
    const to = await context('F1');
    applyState(to.state, decodePreset(encodePreset(serializeState(from.state))));
    assert.equal(to.state.mode, 'relationships');
    assert.equal(to.state.structuralLayout, 'cluster');
  });

  test('a share URL replaces the previous query rather than appending to it', async () => {
    const c = await context('F1');
    const url = presetUrl(
      'http://localhost:8000/?repo=old&seed=stale&preset=xxx',
      { repo: 'microsoft/vscode', seed: 'issue:242864' },
      serializeState(c.state),
    );
    const params = new URL(url).searchParams;
    assert.equal(params.getAll('repo').length, 1);
    assert.equal(params.get('repo'), 'microsoft/vscode');
  });

  test('an old preset applies what it can to a different sub-log', async () => {
    const fromF13 = await context('F13');
    fromF13.state.lanes.commit = false;
    fromF13.state.hiddenObjects = new Set(['pr:80']); // does not exist in F1
    const snapshot = serializeState(fromF13.state);

    const toF1 = await context('F1');
    applyState(toF1.state, snapshot);
    assert.equal(toF1.state.lanes.commit, false, 'the part that applies, applies');
    // The stale id is harmless: it hides nothing, because nothing has that id.
    assert.equal(toF1.graph.objects.some((o) => toF1.state.hiddenObjects.has(o.id)), false);
  });

  test('every built-in preset produces a usable snapshot', async () => {
    const c = await context('F1');
    for (const preset of BUILT_IN_PRESETS) {
      const snapshot = preset.build(c.ctx);
      const state = applyState(createState(), snapshot);
      assert.ok(preset.description.length > 10, `${preset.name} needs a description`);
      assert.ok(state.lanes, `${preset.name} must set lanes`);
    }
  });

  test('"Validated links only" leaves exactly the validated links', async () => {
    const c = await context('F1');
    const preset = BUILT_IN_PRESETS.find((p) => p.name === 'Validated links only');
    applyState(c.state, preset.build(c.ctx));
    const remaining = visibleLinks(c);
    assert.equal(remaining.length, 3, 'F1 has 3 validated object links');
    assert.equal(remaining.every((l) => l.evidence === 'validated'), true);
  });

  test('"Lifecycle without commits" hides the commit lane and says so', async () => {
    const c = await context('F1');
    const preset = BUILT_IN_PRESETS.find((p) => p.name === 'Lifecycle without commits');
    applyState(c.state, preset.build(c.ctx));
    assert.equal(c.state.lanes.commit, false);
    // The hidden-dependency mitigation must fire for a built-in too.
    assert.equal(summarizeHidden(c.state, c.ctx).anyHidden, true);
  });

  test('"Everything" hides nothing', async () => {
    const c = await context('F1');
    c.state.lanes.commit = false;
    const preset = BUILT_IN_PRESETS.find((p) => p.name === 'Everything');
    applyState(c.state, preset.build(c.ctx));
    assert.equal(summarizeHidden(c.state, c.ctx).anyHidden, false);
  });
});
