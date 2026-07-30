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
    assert.equal(c.state.tracks.pull_request, true, 'the lane itself stays on');
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
    c.state.tracks.pull_request = false;
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
    c.state.qualifiers.referenced_pull_request = false;
    const remaining = visibleLinks(c);
    assert.equal(remaining.some((l) => l.qualifier === 'referenced_pull_request'), false);
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
    c.state.qualifiers.referenced_pull_request = false;
    c.state.methods.commit_message = false;
    const remaining = visibleLinks(c);
    assert.equal(remaining.some((l) => l.qualifier === 'referenced_pull_request'), false);
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
    c.state.tracks.commit = false;
    c.state.showComments.issue = false;
    c.state.hiddenObjects = new Set(['pr:80']);
    c.state.hiddenCommitGroups = new Set(['pr:81']);
    c.state.qualifiers.related_issue = false;
    c.state.methods.head_sha = false;

    const summary = summarizeHidden(c.state, c.ctx);
    assert.equal(summary.anyHidden, true);
    const keys = summary.items.map((i) => i.key).sort();
    assert.deepEqual(keys, [
      'comments',
      'commitGroups',
      'methods',
      'objects',
      'qualifiers',
      'tracks',
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
    c.state.tracks.commit = false;
    c.state.showComments.issue = false;
    c.state.hiddenObjects = new Set(['pr:80']);
    c.state.hiddenCommitGroups = new Set(['pr:81']);
    c.state.qualifiers.related_issue = false;
    c.state.methods.head_sha = false;

    restoreAll(c.state, c.ctx);
    assert.equal(summarizeHidden(c.state, c.ctx).anyHidden, false);
  });

  test('one item can be restored without restoring the rest', async () => {
    const c = await context('F1');
    c.state.tracks.commit = false;
    c.state.showComments.issue = false;
    const summary = summarizeHidden(c.state, c.ctx);
    summary.items.find((i) => i.key === 'tracks').restore(c.state);

    assert.equal(c.state.tracks.commit, true);
    assert.equal(c.state.showComments.issue, false, 'the other subtraction is untouched');
  });
});

describe('presets', () => {
  test('a snapshot round-trips through serialize and apply', async () => {
    const c = await context('F13');
    c.state.tracks.commit = false;
    c.state.hiddenObjects = new Set(['pr:80']);
    c.state.hiddenCommitGroups = new Set(['pr:81']);
    c.state.qualifiers.related_issue = false;

    const snapshot = serializeState(c.state);
    const restored = applyState(createState(), snapshot);

    assert.equal(restored.tracks.commit, false);
    assert.deepEqual([...restored.hiddenObjects], ['pr:80']);
    assert.deepEqual([...restored.hiddenCommitGroups], ['pr:81']);
    assert.equal(restored.qualifiers.related_issue, false);
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
    c.state.tracks.issue = false;
    const encoded = encodePreset(serializeState(c.state));
    assert.equal(/^[A-Za-z0-9_-]+$/.test(encoded), true, 'must be URL-safe');
    assert.equal(decodePreset(encoded).tracks.issue, false);
  });

  test('a malformed preset decodes to null rather than throwing', () => {
    assert.equal(decodePreset('not-valid-base64!!!'), null);
    assert.equal(decodePreset(''), null);
  });

  test('a shareable URL carries both the sub-log and the configuration', async () => {
    const c = await context('F1');
    c.state.tracks.commit = false;
    const url = presetUrl('http://localhost:8000/', 'F3', serializeState(c.state));
    const params = new URL(url).searchParams;
    assert.equal(params.get('fixture'), 'F3');
    assert.equal(decodePreset(params.get('preset')).tracks.commit, false);
  });

  test('an old preset applies what it can to a different sub-log', async () => {
    const fromF13 = await context('F13');
    fromF13.state.tracks.commit = false;
    fromF13.state.hiddenObjects = new Set(['pr:80']); // does not exist in F1
    const snapshot = serializeState(fromF13.state);

    const toF1 = await context('F1');
    applyState(toF1.state, snapshot);
    assert.equal(toF1.state.tracks.commit, false, 'the part that applies, applies');
    // The stale id is harmless: it hides nothing, because nothing has that id.
    assert.equal(toF1.graph.objects.some((o) => toF1.state.hiddenObjects.has(o.id)), false);
  });

  test('every built-in preset produces a usable snapshot', async () => {
    const c = await context('F1');
    for (const preset of BUILT_IN_PRESETS) {
      const snapshot = preset.build(c.ctx);
      const state = applyState(createState(), snapshot);
      assert.ok(preset.description.length > 10, `${preset.name} needs a description`);
      assert.ok(state.tracks, `${preset.name} must set tracks`);
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
    assert.equal(c.state.tracks.commit, false);
    // The hidden-dependency mitigation must fire for a built-in too.
    assert.equal(summarizeHidden(c.state, c.ctx).anyHidden, true);
  });

  test('"Everything" hides nothing', async () => {
    const c = await context('F1');
    c.state.tracks.commit = false;
    const preset = BUILT_IN_PRESETS.find((p) => p.name === 'Everything');
    applyState(c.state, preset.build(c.ctx));
    assert.equal(summarizeHidden(c.state, c.ctx).anyHidden, false);
  });
});
