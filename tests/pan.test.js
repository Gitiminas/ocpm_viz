import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { enableCanvasPan } from '../src/render/pan.js';

/**
 * Dragging the canvas to pan it (relationships mode). The module touches the DOM only
 * through addEventListener/pointer capture on the svg and scrollLeft/scrollTop on the
 * surface, so an EventTarget and a plain object stand in for both.
 */

function harness({ active = true } = {}) {
  const svgEl = new EventTarget();
  svgEl.style = {};
  const scrollEl = { scrollLeft: 100, scrollTop: 50 };
  const pan = enableCanvasPan({ svgEl, scrollEl, isActive: () => active });
  const fire = (type, props) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { button: 0, pointerId: 1, ...props });
    svgEl.dispatchEvent(event);
    return event;
  };
  return { svgEl, scrollEl, pan, fire };
}

describe('dragging the background pans the surface', () => {
  test('the picture follows the hand: dragging right scrolls left, by the same distance', () => {
    const { scrollEl, fire, pan } = harness();
    fire('pointerdown', { clientX: 200, clientY: 200 });
    fire('pointermove', { clientX: 260, clientY: 170 });
    assert.equal(scrollEl.scrollLeft, 100 - 60);
    assert.equal(scrollEl.scrollTop, 50 + 30);
    fire('pointerup', { clientX: 260, clientY: 170 });
    // The click that ends a real drag must not clear the focus.
    assert.equal(pan.consumedClick(), true);
    assert.equal(pan.consumedClick(), false, 'consumedClick resets itself');
  });

  test('a press that barely moves is a click, not a pan', () => {
    const { scrollEl, fire, pan } = harness();
    fire('pointerdown', { clientX: 200, clientY: 200 });
    fire('pointermove', { clientX: 202, clientY: 201 });
    fire('pointerup', { clientX: 202, clientY: 201 });
    assert.equal(scrollEl.scrollLeft, 100);
    assert.equal(scrollEl.scrollTop, 50);
    assert.equal(pan.consumedClick(), false);
  });

  test('only the primary button pans, and only while the mode says so', () => {
    const right = harness();
    right.fire('pointerdown', { clientX: 0, clientY: 0, button: 2 });
    right.fire('pointermove', { clientX: 80, clientY: 80, button: 2 });
    assert.equal(right.scrollEl.scrollLeft, 100);

    const timeline = harness({ active: false });
    timeline.fire('pointerdown', { clientX: 0, clientY: 0 });
    timeline.fire('pointermove', { clientX: 80, clientY: 80 });
    assert.equal(timeline.scrollEl.scrollLeft, 100, 'the timeline modes keep their behaviour');
    assert.equal(timeline.svgEl.style.cursor ?? '', '');
  });

  test('dispose removes every listener', () => {
    const { scrollEl, fire, pan } = harness();
    pan.dispose();
    fire('pointerdown', { clientX: 0, clientY: 0 });
    fire('pointermove', { clientX: 80, clientY: 80 });
    assert.equal(scrollEl.scrollLeft, 100);
  });
});
