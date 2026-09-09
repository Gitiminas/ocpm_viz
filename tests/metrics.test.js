import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadSubLog } from '../src/data/loadSubLog.js';
import { normalizeGraph } from '../src/model/subLog.js';
import {
  objectLifetime,
  aggregateDuration,
  commitStats,
  commentCounts,
  linkCounts,
  leadTimeToFirstCommit,
  landmarks,
  perObjectGaps,
  perObjectDurations,
} from '../src/stats/metrics.js';
import { formatDuration, formatApproxDuration } from '../src/render/format.js';

const fileTransport = async (query) =>
  JSON.parse(await readFile(new URL(`./fixtures/${query.fixture || 'F1'}.json`, import.meta.url), 'utf8'));
const loadF1 = () => loadSubLog({ fixture: 'F1' }, { transport: fileTransport });

const HOUR = 3600000;
const DAY = 24 * HOUR;

describe('duration formatting', () => {
  test('renders days and hours, dropping minutes above a day', () => {
    assert.equal(formatDuration(4 * DAY + 16 * HOUR + 30 * 60000), '4d 16h');
  });

  test('renders hours and minutes below a day', () => {
    assert.equal(formatDuration(4 * HOUR + 45 * 60000), '4h 45m');
  });

  test('sub-minute durations read as <1m rather than 0', () => {
    assert.equal(formatDuration(2000), '<1m');
  });

  test('approximate durations pluralise correctly', () => {
    assert.equal(formatApproxDuration(DAY), '≈ 1 day');
    assert.equal(formatApproxDuration(7 * DAY), '≈ 7 days');
    assert.equal(formatApproxDuration(2 * HOUR), '≈ 2 hours');
  });
});

describe('F1 reproduces the numbers on the baseline stats page', () => {
  test('issue and PR lifetimes match the baseline cards', async () => {
    const graph = await loadF1();
    // The baseline screenshot reports 4d 16h and 4h 45m.
    assert.equal(formatDuration(aggregateDuration(graph, 'issue').median), '4d 16h');
    assert.equal(formatDuration(aggregateDuration(graph, 'pull_request').median), '4h 45m');
  });

  test('issue to first commit matches the baseline lead time', async () => {
    const graph = await loadF1();
    assert.equal(formatDuration(leadTimeToFirstCommit(graph)), '1d 13h');
  });

  test('commit and comment counts match the baseline', async () => {
    const graph = await loadF1();
    const commits = commitStats(graph);
    assert.equal(commits.count, 32);
    assert.equal(commits.authors, 1);

    const comments = commentCounts(graph);
    assert.equal(comments.total, 5);
    assert.equal(comments.byType.get('issue'), 2);
    assert.equal(comments.byType.get('pull_request'), 3);
  });

  test('link counts report the reclassified split, not the old one', async () => {
    const graph = await loadF1();
    assert.deepEqual(linkCounts(graph), { total: 34, validated: 2, extracted: 32 });
  });
});

describe('lifetimes sum across intervals, so reopens are counted', () => {
  const reopened = () =>
    normalizeGraph({
      meta: {},
      objects: [
        {
          id: 'issue:1',
          type: 'issue',
          label: '#1',
          intervals: [
            { start: '2025-01-01T00:00:00Z', end: '2025-01-03T00:00:00Z' },
            { start: '2025-01-10T00:00:00Z', end: '2025-01-11T00:00:00Z' },
          ],
        },
      ],
      events: [],
      links: [],
    });

  test('a reopened issue reports open time, not wall-clock span', () => {
    const [issue] = reopened().objects;
    const lifetime = objectLifetime(issue);
    // Two days plus one day open, across a ten-day wall-clock span.
    assert.equal(lifetime.total, 3 * DAY);
    assert.equal(lifetime.intervals, 2);
    assert.equal(lifetime.complete, true);
  });

  test('an unfinished interval is reported as incomplete rather than guessed', () => {
    const graph = normalizeGraph({
      meta: {},
      objects: [
        { id: 'issue:1', type: 'issue', label: '#1', intervals: [{ start: '2025-01-01T00:00:00Z', end: null }] },
      ],
      events: [],
      links: [],
    });
    const lifetime = objectLifetime(graph.objects[0]);
    assert.equal(lifetime.total, null);
    assert.equal(lifetime.complete, false);
  });

  test('per-object durations skip objects with no lifecycle', async () => {
    const graph = await loadF1();
    const durations = perObjectDurations(graph);
    // 1 issue + 1 PR + 32 commits have intervals; the 4 actors do not.
    assert.equal(durations.length, 34);
    assert.equal(durations.some((d) => d.type === 'actor'), false);
  });
});

describe('aggregation across N objects', () => {
  const many = (spans) =>
    normalizeGraph({
      meta: {},
      objects: spans.map((days, i) => ({
        id: `issue:${i}`,
        type: 'issue',
        label: `#${i}`,
        intervals: [
          { start: '2025-01-01T00:00:00Z', end: new Date(Date.UTC(2025, 0, 1 + days)).toISOString() },
        ],
      })),
      events: [],
      links: [],
    });

  test('the median resists a single extreme outlier', () => {
    const graph = many([1, 2, 3, 400]);
    const { n, median } = aggregateDuration(graph, 'issue');
    assert.equal(n, 4);
    // Mean would be over 100 days; the median stays near the typical issue.
    assert.equal(median, 2.5 * DAY);
  });

  test('with one object the aggregate is just that object', () => {
    const { n, median } = aggregateDuration(many([5]), 'issue');
    assert.equal(n, 1);
    assert.equal(median, 5 * DAY);
  });

  test('a type with no objects aggregates to nothing, not zero', () => {
    assert.deepEqual(aggregateDuration(many([1]), 'pull_request'), { n: 0, median: null });
  });
});

describe('landmarks identify which object they belong to', () => {
  test('F1 landmarks are labelled and time-ordered', async () => {
    const graph = await loadF1();
    const entries = landmarks(graph);
    for (let i = 1; i < entries.length; i++) {
      assert.ok(+entries[i].time >= +entries[i - 1].time, 'landmarks must be sorted');
    }
    const labels = entries.map((e) => e.label);
    assert.ok(labels.some((l) => l.includes('First commit')));
    assert.ok(labels.some((l) => l.includes('#242864') && l.includes('Close')));
    assert.ok(labels.some((l) => l.includes('PR #243221') && l.includes('Merge')));
  });

  test('with two issues each landmark names its own object', () => {
    const graph = normalizeGraph({
      meta: {},
      objects: [
        { id: 'issue:1', type: 'issue', label: '#1', intervals: [{ start: '2025-01-01T00:00:00Z', end: '2025-01-02T00:00:00Z' }] },
        { id: 'issue:2', type: 'issue', label: '#2', intervals: [{ start: '2025-01-01T00:00:00Z', end: '2025-01-03T00:00:00Z' }] },
      ],
      events: [
        { id: 'e1', activity: 'IssueClosed', time: '2025-01-02T00:00:00Z', object_id: 'issue:1' },
        { id: 'e2', activity: 'IssueClosed', time: '2025-01-03T00:00:00Z', object_id: 'issue:2' },
      ],
      links: [],
    });
    const labels = landmarks(graph).map((e) => e.label);
    assert.ok(labels.includes('#1 · Close'));
    assert.ok(labels.includes('#2 · Close'));
  });
});

describe('gaps follow the events they are given', () => {
  test('hiding events changes the gaps, which is why this is not precomputed', async () => {
    const graph = await loadF1();
    const all = perObjectGaps(graph.events, 'issue:242864');
    const withoutComments = perObjectGaps(
      graph.events.filter((event) => !event.comment),
      'issue:242864',
    );
    assert.ok(all.length > withoutComments.length);
    // With comments hidden the issue keeps only opened → closed, one long gap.
    assert.equal(withoutComments.length, 1);
    assert.ok(withoutComments[0].hours > all[0].hours);
  });

  test('an actor change across a gap is flagged', () => {
    const events = [
      { id: 'a', object_id: 'i:1', time: new Date('2025-01-01T00:00:00Z'), actor_id: 'actor:1' },
      { id: 'b', object_id: 'i:1', time: new Date('2025-01-02T00:00:00Z'), actor_id: 'actor:2' },
    ];
    const [gap] = perObjectGaps(events, 'i:1');
    assert.equal(gap.hours, 24);
    assert.equal(gap.actorChanged, true);
  });

  // An opening derived from a later event's payload can carry no actor (an issue known
  // only from comments). "Unknown → someone" is a gap in the record, not a handoff.
  test('a gap from or to an event without an actor is not a handoff', () => {
    const events = [
      { id: 'a', object_id: 'i:1', time: new Date('2025-01-01T00:00:00Z'), actor_id: null },
      { id: 'b', object_id: 'i:1', time: new Date('2025-01-02T00:00:00Z'), actor_id: 'actor:2' },
      { id: 'c', object_id: 'i:1', time: new Date('2025-01-03T00:00:00Z'), actor_id: 'actor:2' },
      { id: 'd', object_id: 'i:1', time: new Date('2025-01-04T00:00:00Z'), actor_id: 'actor:3' },
    ];
    const gaps = perObjectGaps(events, 'i:1');
    assert.deepEqual(
      gaps.map((gap) => gap.actorChanged),
      [false, false, true],
    );
  });
});
