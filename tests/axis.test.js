import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { withStartAnchor, buildLabels, gapTipArg } from '../src/render/axis.js';
import { createScales } from '../src/layout/scales.js';
import { tipFor } from '../src/help/tips.js';

/*
 * `computeTicks` reaches the global d3 that only the browser has, so what is asserted here is
 * the two pure halves it composes: which ticks exist (`withStartAnchor`) and what they say
 * (`buildLabels`). The one fact about d3's own selection that matters is documented rather
 * than mocked — `d3.scaleUtc().ticks(n)` returns round times *inside* the domain, so its
 * first tick is the first interval boundary at or after the earliest instant, and the plot's
 * left edge is not among them except by coincidence.
 */

const MARGIN_LEFT = 180;
const at = (iso) => ({ t: new Date(iso), x: 0 });

/** kubernetes PR #118316: a 26 h span that d3 ticks 6-hourly, so its first tick is 18:00. */
const K118316_START = '2023-05-29T13:38:34Z';
const K118316_ROUNDS = [
  at('2023-05-29T18:00:00Z'),
  at('2023-05-30T00:00:00Z'),
  at('2023-05-30T06:00:00Z'),
  at('2023-05-30T12:00:00Z'),
];

describe('the absolute axis anchors its left edge', () => {
  test('the sub-log’s start is the leftmost tick', () => {
    const ticks = withStartAnchor(K118316_ROUNDS, +new Date(K118316_START), MARGIN_LEFT);
    assert.equal(+ticks[0].t, +new Date(K118316_START));
    assert.equal(ticks[0].x, MARGIN_LEFT);
    assert.equal(ticks[0].anchor, true);
    assert.ok(ticks.slice(1).every((tick) => !tick.anchor));
  });

  test('no mark can sit left of the leftmost tick', () => {
    // This is the property the anchor exists for. Without it the PR's opening mark drew at
    // the left edge while the first tick said "May 29" some way to its right, so a mark
    // genuinely timed 13:38 on the 29th read as the 28th.
    const instants = [
      +new Date(K118316_START),
      +new Date('2023-05-29T19:03:37Z'),
      +new Date('2023-05-30T16:29:37Z'),
    ];
    const scales = createScales({ instants, marginLeft: MARGIN_LEFT, plotWidth: 1000 });
    const [anchor] = withStartAnchor(K118316_ROUNDS, scales.first, MARGIN_LEFT);
    assert.equal(anchor.x, scales.x(new Date(K118316_START)));
    assert.ok(instants.every((t) => scales.x(new Date(t)) >= anchor.x));
  });

  test('a round tick on the same instant is not drawn twice', () => {
    // A sub-log that happens to begin at midnight: d3 ticks there too, and the anchor wins
    // because it is the more precise label for that position.
    const start = +new Date('2023-05-30T00:00:00Z');
    const ticks = withStartAnchor(
      [at('2023-05-30T00:00:00Z'), at('2023-05-30T06:00:00Z')],
      start,
      MARGIN_LEFT,
    );
    assert.equal(ticks.length, 2);
    assert.equal(ticks[0].anchor, true);
    assert.equal(+ticks[1].t, +new Date('2023-05-30T06:00:00Z'));
  });

  test('the round ticks keep their order and nothing else is added', () => {
    const ticks = withStartAnchor(K118316_ROUNDS, +new Date(K118316_START), MARGIN_LEFT);
    assert.deepEqual(
      ticks.slice(1).map((tick) => tick.t.toISOString()),
      K118316_ROUNDS.map((tick) => tick.t.toISOString()),
    );
  });

  test('a sub-log spanning no time still gets its one tick', () => {
    // d3 has nothing round to offer inside a zero-width domain; the edge is still a real
    // instant and is still where every mark sits.
    const ticks = withStartAnchor([], +new Date(K118316_START), MARGIN_LEFT);
    assert.equal(ticks.length, 1);
    assert.equal(ticks[0].anchor, true);
  });
});

describe('absolute tick labels state the instant they mark', () => {
  const labels = () =>
    buildLabels(withStartAnchor(K118316_ROUNDS, +new Date(K118316_START), MARGIN_LEFT), 'absolute');

  test('the anchor names the day and the time it actually sits on', () => {
    assert.match(labels()[0], /May 29\s+13:38/);
  });

  test('the round ticks stay bare dates at midnight and bare times within the day', () => {
    assert.deepEqual(labels().slice(1), ['18:00', 'May 30', '06:00', '12:00']);
  });

  test('no round label claims a day boundary its tick does not sit on', () => {
    // A bare "Mon DD" asserts the start of that day, so it is only honest at 00:00 UTC.
    // The anchor is exempt because it never uses that form.
    const ticks = withStartAnchor(
      [
        at('2023-05-29T18:00:00Z'),
        at('2023-05-30T00:00:00Z'),
        at('2023-05-30T06:00:00Z'),
        at('2023-06-01T00:00:00Z'),
      ],
      +new Date(K118316_START),
      MARGIN_LEFT,
    );
    buildLabels(ticks, 'absolute').forEach((label, i) => {
      if (!/^\w{3} \d{2}$/.test(label)) return;
      const tick = ticks[i].t;
      assert.ok(
        tick.getUTCHours() === 0 && tick.getUTCMinutes() === 0,
        `"${label}" is a date alone but its tick is not at 00:00 UTC`,
      );
    });
  });

  test('labels are UTC, whatever the machine timezone', () => {
    // 23:30Z is the previous day west of Greenwich and the next one far enough east; the
    // label must not move with the viewer.
    const [anchor] = buildLabels(
      withStartAnchor([], +new Date('2023-05-29T23:30:00Z'), MARGIN_LEFT),
      'absolute',
    );
    assert.match(anchor, /May 29\s+23:30/);
  });
});

describe('a hovered gap marking tells the help strip the span it hides', () => {
  const gap = (fromIso, toIso) => ({
    t0: +new Date(fromIso),
    t1: +new Date(toIso),
    duration: +new Date(toIso) - +new Date(fromIso),
  });

  test('one band: from → to in UTC, with the length in parentheses', () => {
    assert.equal(
      gapTipArg([gap('2020-07-21T23:21:00Z', '2020-08-12T23:42:00Z')]),
      'Spans Jul 21, 2020 · 23:21:00 UTC → Aug 12, 2020 · 23:42:00 UTC (22d).',
    );
  });

  test('the parenthesised length reads days and hours', () => {
    assert.match(gapTipArg([gap('2023-05-29T13:00:00Z', '2023-06-02T17:00:00Z')]), /\(4d 4h\)\.$/);
  });

  test('a merged label: the count, the stretch the group sits in, and the combined length', () => {
    assert.equal(
      gapTipArg([
        gap('2023-01-01T00:00:00Z', '2023-01-08T00:00:00Z'),
        gap('2023-02-01T00:00:00Z', '2023-02-04T00:00:00Z'),
      ]),
      '2 gaps between Jan 01, 2023 · 00:00:00 UTC and Feb 04, 2023 · 00:00:00 UTC (10d combined).',
    );
  });

  test('the strip text composes: what the marking does, then the span', () => {
    const text = tipFor('axis.gap', gapTipArg([gap('2020-07-21T23:21:00Z', '2020-08-12T23:42:00Z')]));
    assert.equal(
      text,
      'A quiet stretch drawn compressed: its width stands for the duration written above it. ' +
        'Spans Jul 21, 2020 · 23:21:00 UTC → Aug 12, 2020 · 23:42:00 UTC (22d).',
    );
  });
});

describe('discrete-mode tick labels are unchanged', () => {
  test('minutes normally, seconds only where two ticks share a minute', () => {
    const ticks = [
      at('2023-05-29T13:38:34Z'),
      at('2023-05-29T13:38:42Z'),
      at('2023-05-29T19:03:37Z'),
    ];
    const labels = buildLabels(ticks, 'discrete');
    assert.match(labels[0], /May 29\s+13:38:34/);
    assert.match(labels[1], /May 29\s+13:38:42/);
    assert.match(labels[2], /^May 29\s+19:03$/);
  });
});
