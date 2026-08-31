import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildLabels } from '../src/render/axis.js';

/*
 * `computeTicks` needs the global d3 that only the browser has, so what is asserted here is
 * tick *labelling*, which is pure. Tick *selection* is d3's, and the one fact about it that
 * matters below is documented rather than mocked: `d3.scaleUtc().ticks(n)` returns round
 * times *inside* the domain, so tick 0 is the first interval boundary at or after the
 * earliest instant in the sub-log — midnight only by coincidence.
 */

const at = (iso) => ({ t: new Date(iso), x: 0 });

/** Ticks d3 chooses for kubernetes PR #118316: a 26 h span, 6-hourly, starting at 18:00. */
const K118316_TICKS = [
  at('2023-05-29T18:00:00Z'),
  at('2023-05-30T00:00:00Z'),
  at('2023-05-30T06:00:00Z'),
  at('2023-05-30T12:00:00Z'),
];

describe('absolute-mode tick labels state the instant they mark', () => {
  test('a first tick that is not midnight carries its time, not just its date', () => {
    // The defect: this tick is 18:00 on the 29th and was labelled "May 29", which reads as
    // midnight. The PR opens at 13:38 on the 29th and draws to the LEFT of it, so the
    // opening mark read as May 28 — a whole day earlier than the data says.
    const [first] = buildLabels(K118316_TICKS, 'absolute');
    assert.match(first, /May 29/, 'the first tick must still name its day');
    assert.match(first, /18:00/, 'and must say which instant on that day it marks');
    assert.notEqual(first, 'May 29');
  });

  test('no absolute label claims a day boundary the tick does not sit on', () => {
    // The invariant behind the fix: a label may leave information out, never assert
    // something false. A bare "Mon DD" asserts the start of that day, so it is only
    // honest on a tick that is actually at 00:00 UTC.
    const ticks = [
      at('2023-05-29T13:38:34Z'),
      at('2023-05-29T18:00:00Z'),
      at('2023-05-30T00:00:00Z'),
      at('2023-05-30T06:00:00Z'),
      at('2023-06-01T00:00:00Z'),
    ];
    buildLabels(ticks, 'absolute').forEach((label, i) => {
      const tick = ticks[i].t;
      const isMidnight = tick.getUTCHours() === 0 && tick.getUTCMinutes() === 0;
      const isDateOnly = /^\w{3} \d{2}$/.test(label);
      if (isDateOnly) {
        assert.ok(isMidnight, `"${label}" is a date alone but its tick is not at 00:00 UTC`);
      }
    });
  });

  test('a first tick that is midnight keeps the plain date', () => {
    const labels = buildLabels([at('2023-05-30T00:00:00Z'), at('2023-05-30T06:00:00Z')], 'absolute');
    assert.equal(labels[0], 'May 30');
  });

  test('later non-midnight ticks stay bare times, so the axis does not repeat the date', () => {
    const labels = buildLabels(K118316_TICKS, 'absolute');
    assert.deepEqual(labels.slice(1), ['May 30', '06:00', '12:00']);
  });

  test('labels are UTC, whatever the machine timezone', () => {
    // 23:30Z is the previous day west of Greenwich and the next one far enough east; the
    // label must not move with the viewer.
    const [label] = buildLabels([at('2023-05-29T23:30:00Z')], 'absolute');
    assert.match(label, /May 29\s+23:30/);
  });
});

describe('discrete-mode tick labels are unchanged', () => {
  test('minutes normally, seconds only where two ticks share a minute', () => {
    const labels = buildLabels(
      [at('2023-05-29T13:38:34Z'), at('2023-05-29T13:38:42Z'), at('2023-05-29T19:03:37Z')],
      'discrete',
    );
    assert.match(labels[0], /May 29\s+13:38:34/);
    assert.match(labels[1], /May 29\s+13:38:42/);
    assert.match(labels[2], /^May 29\s+19:03$/);
  });
});
