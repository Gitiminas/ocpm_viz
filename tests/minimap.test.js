import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { minimapX } from '../src/render/minimap.js';

describe('the minimap keeps its first and last dots on the strip', () => {
  const WIDTH = 400;
  const at = (x) => minimapX(x, 180, 1000, WIDTH);

  test('the first and last dots are fully inside, not half off the edge', () => {
    // r=4 is the largest dot, so anything under 4px from an edge is clipped.
    assert.ok(at(180) >= 4, 'the first dot must not hang off the left edge');
    assert.ok(at(1180) <= WIDTH - 4, 'the last dot must not hang off the right edge');
  });

  test('the extremes clear the viewport grips, which start flush left', () => {
    // A grip is centred on the viewport edge (x - GRIP_WIDTH/2), so at the initial
    // position it reaches 2.5px into the strip. The dot's own edge must clear that.
    assert.ok(at(180) - 4 > 2.5, 'the first dot must not touch the left grip');
    assert.ok(at(1180) + 4 < WIDTH - 2.5, 'the last dot must not touch the right grip');
  });

  test('order is preserved and the span still fills the strip', () => {
    assert.ok(at(180) < at(680) && at(680) < at(1180));
    // Not squashed into the middle: the two ends stay near the two ends.
    assert.ok(at(1180) - at(180) > WIDTH * 0.9);
  });

  test('a node outside the plot is clamped rather than drawn off-strip', () => {
    assert.equal(at(-5000), at(180));
    assert.equal(at(99999), at(1180));
  });

  test('a zero span does not produce NaN', () => {
    assert.ok(Number.isFinite(minimapX(180, 180, 0, WIDTH)));
  });
});
