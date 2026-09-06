import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadSubLog } from '../src/data/loadSubLog.js';
import { indexSubLog } from '../src/model/subLog.js';
import { deriveCommitGroups } from '../src/model/commitGroups.js';
import {
  createState,
  resetToggles,
  deriveRelGroups,
  deriveQualifiers,
  deriveMethods,
  selectVisible,
} from '../src/state/state.js';
import { deriveBursts } from '../src/model/bursts.js';
import { formatDuration } from '../src/render/format.js';
import {
  perObjectMetrics,
  groupRowsByType,
  aggregateRows,
  prOutcome,
  prOutcomeDistribution,
  largestGaps,
  leadTimes,
  commentCounts,
  landmarks,
} from '../src/stats/metrics.js';

const fileTransport = async (query) =>
  JSON.parse(await readFile(new URL(`./fixtures/${query.fixture}.json`, import.meta.url), 'utf8'));
const load = (fixture) => loadSubLog({ fixture }, { transport: fileTransport });

async function context(fixture) {
  const graph = await load(fixture);
  const index = indexSubLog(graph);
  const { groupsByCommit } = deriveCommitGroups(
    index.objectsOfType('commit'),
    graph.links,
    index.byId,
  );
  const state = resetToggles(createState(), {
    relGroups: deriveRelGroups(graph.links, index.byId),
    qualifiers: deriveQualifiers(graph.links),
    methods: deriveMethods(graph.links),
  });
  return { graph, index, state, groupsByCommit };
}

describe('the per-object table replaces the single-object cards', () => {
  test('every lane-bearing object gets exactly one row', async () => {
    const { graph } = await context('F1');
    const rows = perObjectMetrics(graph);
    // 1 issue + 1 PR + 32 commits. Actors have no row: they are not lane objects.
    assert.equal(rows.length, 34);
    assert.equal(rows.some((row) => row.type === 'actor'), false);
  });

  test('rows carry the numbers the old cards reported, per object', async () => {
    const { graph } = await context('F1');
    const rows = perObjectMetrics(graph);
    const issue = rows.find((row) => row.id === 'issue:242864');
    const pr = rows.find((row) => row.id === 'pr:243221');

    // The baseline cards showed 4d 16h and 4h 45m — now attributed to their objects
    // rather than presented as properties of the sub-log.
    assert.equal(formatDuration(issue.lifetime), '4d 16h');
    assert.equal(formatDuration(pr.lifetime), '4h 45m');
    assert.equal(issue.comments, 2);
    assert.equal(pr.comments, 3);
  });

  test('with two objects of a type, each keeps its own numbers', async () => {
    const { graph } = await context('F3');
    const rows = perObjectMetrics(graph);
    const prs = rows.filter((row) => row.type === 'pull_request');
    assert.equal(prs.length, 2);
    assert.notEqual(prs[0].lifetime, prs[1].lifetime, 'the two PRs must not share a figure');
  });

  test('a reopened issue reports open time and its interval count', async () => {
    const { graph } = await context('F9');
    const [issue] = perObjectMetrics(graph).filter((row) => row.type === 'issue');
    assert.equal(issue.intervals, 2);
    // Three days open plus five, across a wall-clock span of thirteen.
    assert.equal(Math.round(issue.lifetime / 86400000), 8);
  });

  test('handoffs count gaps that span a change of actor', async () => {
    const { graph } = await context('F13');
    const rows = perObjectMetrics(graph);
    const issue = rows.find((row) => row.type === 'issue');
    assert.ok(issue.handoffs >= 0);
    assert.equal(typeof issue.maxGapHours, 'number');
  });
});

describe('aggregation on demand', () => {
  test('groups follow lane order and carry an aggregate', async () => {
    const { graph } = await context('F1');
    const groups = groupRowsByType(perObjectMetrics(graph));
    assert.deepEqual(
      groups.map((group) => group.type),
      ['issue', 'pull_request', 'commit'],
    );
    assert.equal(groups[2].aggregate.n, 32);
  });

  test('the aggregate reports a range, not just a midpoint', () => {
    const rows = [
      { type: 'issue', lifetime: 1000, events: 1, comments: 0, links: 0, handoffs: 0 },
      { type: 'issue', lifetime: 2000, events: 1, comments: 0, links: 0, handoffs: 0 },
      { type: 'issue', lifetime: 90000, events: 1, comments: 0, links: 0, handoffs: 0 },
    ];
    const aggregate = aggregateRows(rows);
    assert.equal(aggregate.median, 2000);
    assert.equal(aggregate.min, 1000);
    assert.equal(aggregate.max, 90000);
    // A mean would be 31000 — between the typical case and the outlier, describing
    // neither. The range is what tells you the median means something.
    assert.notEqual(aggregate.median, 31000);
  });

  test('objects with no finished interval are excluded from the duration, not counted as zero', () => {
    const rows = [
      { type: 'issue', lifetime: 5000, events: 0, comments: 0, links: 0, handoffs: 0 },
      { type: 'issue', lifetime: null, events: 0, comments: 0, links: 0, handoffs: 0 },
    ];
    const aggregate = aggregateRows(rows);
    assert.equal(aggregate.n, 2);
    assert.equal(aggregate.withDuration, 1);
    assert.equal(aggregate.median, 5000);
  });
});

describe('PR outcomes are a distribution, not a count', () => {
  test('a merged PR reads as merged', async () => {
    const { graph } = await context('F1');
    const pr = graph.objects.find((object) => object.type === 'pull_request');
    assert.equal(prOutcome(pr, graph.events), 'merged');
  });

  test('a PR closed without merging is distinguished from a merged one', async () => {
    const { graph } = await context('F8');
    const pr = graph.objects.find((object) => object.type === 'pull_request');
    assert.equal(prOutcome(pr, graph.events), 'closed unmerged');
  });

  test('the distribution covers every PR', async () => {
    const { graph } = await context('F13');
    const distribution = prOutcomeDistribution(graph);
    const total = distribution.reduce((sum, entry) => sum + entry.count, 0);
    assert.equal(total, graph.objects.filter((o) => o.type === 'pull_request').length);
  });

  test('a non-PR has no outcome at all', async () => {
    const { graph } = await context('F1');
    const issue = graph.objects.find((object) => object.type === 'issue');
    assert.equal(prOutcome(issue, graph.events), null);
  });
});

describe('metrics respond to the toggles — the reason they are not precomputed', () => {
  test('hiding comments removes comment events from the visible sub-log', async () => {
    const { graph, state, groupsByCommit } = await context('F1');
    assert.equal(commentCounts(selectVisible(graph, state, groupsByCommit)).total, 5);

    state.showComments.issue = false;
    state.showComments.pull_request = false;
    assert.equal(commentCounts(selectVisible(graph, state, groupsByCommit)).total, 0);
  });

  test('hiding comments genuinely recomputes the gaps', async () => {
    const { graph, state, groupsByCommit } = await context('F1');
    const before = largestGaps(selectVisible(graph, state, groupsByCommit), 1)[0];

    state.showComments.issue = false;
    state.showComments.pull_request = false;
    const after = largestGaps(selectVisible(graph, state, groupsByCommit), 1)[0];

    // The answer changes, and not in the direction one might guess. Removing events
    // between two others merges their gaps, but removing an event at the *end*
    // deletes the tail entirely — and F1's longest gap runs to a comment posted
    // eight days after the merge. Hiding comments therefore shrinks the largest gap
    // from 184h to 112h. Precomputing this in SQL would have answered "unchanged"
    // to a question whose real answer depends on what is on screen.
    assert.equal(Math.round(before.hours), 184);
    assert.equal(Math.round(after.hours), 113);
    assert.ok(after.hours < before.hours);
  });

  test('hiding a lane removes its objects from the table', async () => {
    const { graph, state, groupsByCommit } = await context('F1');
    state.lanes.commit = false;
    const rows = perObjectMetrics(selectVisible(graph, state, groupsByCommit));
    assert.equal(rows.some((row) => row.type === 'commit'), false);
    assert.ok(rows.some((row) => row.type === 'issue'));
  });

  test('hiding one of two PRs leaves the other’s figures untouched', async () => {
    const { graph, state, groupsByCommit } = await context('F3');
    const before = perObjectMetrics(graph).find((row) => row.id === 'pr:21');

    state.hiddenObjects = new Set(['pr:20']);
    const visible = selectVisible(graph, state, groupsByCommit);
    const rows = perObjectMetrics(visible);

    assert.equal(rows.filter((row) => row.type === 'pull_request').length, 1);
    assert.equal(rows.find((row) => row.id === 'pr:21').lifetime, before.lifetime);
  });

  test('hiding a commit group changes the commit count', async () => {
    const { graph, state, groupsByCommit } = await context('F13');
    const all = perObjectMetrics(graph).filter((row) => row.type === 'commit').length;
    state.hiddenCommitGroups = new Set(['pr:80']);
    const visible = perObjectMetrics(selectVisible(graph, state, groupsByCommit)).filter(
      (row) => row.type === 'commit',
    );
    assert.equal(all, 9);
    assert.equal(visible.length, 5, 'the shared commit survives via PR #81');
  });

  test('collapsing a burst is NOT filtering — the commits still count', async () => {
    const { graph, index, state, groupsByCommit } = await context('F1');
    const bursts = deriveBursts(index.objectsOfType('commit'));
    state.expandedBursts = new Set(); // everything folded, the default

    const folded = perObjectMetrics(selectVisible(graph, state, groupsByCommit)).filter(
      (row) => row.type === 'commit',
    ).length;

    state.expandedBursts = new Set(bursts.map((burst) => burst.id));
    const expanded = perObjectMetrics(selectVisible(graph, state, groupsByCommit)).filter(
      (row) => row.type === 'commit',
    ).length;

    // Folding is a display choice about density, not a claim that 20 commits left
    // the sub-log. The count must not jump when a push is folded.
    assert.equal(folded, 32);
    assert.equal(expanded, 32);
  });
});

describe('cross-object lead times are labelled, not silently arbitrary', () => {
  test('F1 reproduces the baseline lead time to first commit', async () => {
    const { graph } = await context('F1');
    const entries = leadTimes(graph);
    const toCommit = entries.find((entry) => entry.label.includes('first commit'));
    // The baseline card read "Issue → first commit: 1d 13h".
    assert.equal(formatDuration(toCommit.value), '1d 13h');
  });

  test('every entry says which two instants were subtracted', async () => {
    const { graph } = await context('F13');
    for (const entry of leadTimes(graph)) {
      assert.match(entry.label, /^First /, `"${entry.label}" must name its endpoints`);
      assert.equal(typeof entry.value, 'number');
    }
  });

  test('an entry is omitted rather than reported as zero when an endpoint is missing', async () => {
    // F8 is an orphan PR: no issue at all, so no issue-based lead time exists.
    const { graph } = await context('F8');
    const labels = leadTimes(graph).map((entry) => entry.label);
    assert.equal(labels.some((label) => label.includes('issue')), false);
  });
});

describe('the stats page can shade by object, not only by type', () => {
  /**
   * The timeline spends a colour channel answering "which pull request is this"
   * (`assignObjectColors`). The stats page painted every issue one purple and every
   * pull request one orange, so a table of three pull requests said "pull request"
   * three times and nothing about which was which — two views of one sub-log
   * disagreeing about what a colour means.
   *
   * The renderer needs a DOM, so what is asserted here is the part that does not: that
   * the data it shades by is present and keyed the way the colour map is.
   */
  test('every per-object row carries the id the colour map is keyed on (F10)', async () => {
    const graph = await load('F10');
    const rows = perObjectMetrics(graph);
    assert.ok(rows.length > 1, 'F10 must have several objects, or this proves nothing');
    for (const row of rows) {
      assert.ok(row.id, `a row for "${row.label}" has no id to look a shade up by`);
      assert.ok(graph.objects.some((o) => o.id === row.id), `${row.id} is not an object`);
    }
  });

  test('rows of one type have distinct ids, so distinct shades are possible (F10)', async () => {
    const graph = await load('F10');
    const prs = perObjectMetrics(graph).filter((r) => r.type === 'pull_request');
    assert.ok(prs.length > 1, 'F10 must have several pull requests');
    assert.equal(new Set(prs.map((r) => r.id)).size, prs.length, 'ids must be unique');
  });

  test('landmark entries name the object they belong to (F10)', async () => {
    const graph = await load('F10');
    const entries = landmarks(graph);
    // Commit landmarks are aggregate ("First commit"), so they carry no object; every
    // issue or PR landmark must, or its dot falls back to the flat type colour.
    const perObject = entries.filter((e) => e.type !== 'commit');
    assert.ok(perObject.length > 0);
    for (const entry of perObject) {
      assert.ok(entry.objectId, `landmark "${entry.label}" has no objectId`);
    }
  });

  test('a landmark objectId resolves to a real object (F10)', async () => {
    const graph = await load('F10');
    const ids = new Set(graph.objects.map((o) => o.id));
    for (const entry of landmarks(graph).filter((e) => e.objectId)) {
      assert.ok(ids.has(entry.objectId), `${entry.objectId} is not in the sub-log`);
    }
  });
});
