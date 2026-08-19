import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { enableCanvasPan, scrollToKeepAnchor } from '../src/render/pan.js';

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

  test('the pointer is captured only once the press has become a pan', () => {
    // ⚠️ Capturing on pointerdown retargeted the following click to the svg, so the fold
    // pill above an unfolded push never received its click and pushes could not be folded
    // back in relationships mode. A press that stays within the slop must leave the
    // pointer — and its click — to whatever was pressed.
    const { svgEl, fire } = harness();
    const captured = [];
    svgEl.setPointerCapture = (id) => captured.push(id);
    svgEl.releasePointerCapture = () => {};
    fire('pointerdown', { clientX: 10, clientY: 10 });
    fire('pointermove', { clientX: 11, clientY: 11 });
    fire('pointerup', { clientX: 11, clientY: 11 });
    assert.deepEqual(captured, [], 'a click-sized press must not capture');

    fire('pointerdown', { clientX: 10, clientY: 10 });
    fire('pointermove', { clientX: 40, clientY: 10 });
    assert.deepEqual(captured, [1], 'a real pan captures, once it is one');
  });

  test('dispose removes every listener', () => {
    const { scrollEl, fire, pan } = harness();
    pan.dispose();
    fire('pointerdown', { clientX: 0, clientY: 0 });
    fire('pointermove', { clientX: 80, clientY: 80 });
    assert.equal(scrollEl.scrollLeft, 100);
  });
});

describe('zooming about an anchor keeps the point under it still', () => {
  const origin = { x: 16, y: 16 };

  test('the content point under the pointer is the same point after the zoom', () => {
    // Surface scrolled to (100, 50); the pointer is 300,200 into the visible surface, so it
    // points at content (400, 250). After a 2× zoom that content point sits at
    // origin + (c − origin)×2 = (784, 484); scrolling so it is again 300,200 from the
    // surface's top-left means scrollLeft 484, scrollTop 284.
    const next = scrollToKeepAnchor({ scrollLeft: 100, scrollTop: 50, offsetX: 300, offsetY: 200, factor: 2, origin });
    assert.deepEqual(next, { scrollLeft: 484, scrollTop: 284 });
    // And zooming back out returns exactly to where it was.
    const back = scrollToKeepAnchor({ ...next, offsetX: 300, offsetY: 200, factor: 0.5, origin });
    assert.deepEqual(back, { scrollLeft: 100, scrollTop: 50 });
  });

  test('a factor of 1 changes nothing, and the result never scrolls negative', () => {
    assert.deepEqual(
      scrollToKeepAnchor({ scrollLeft: 30, scrollTop: 40, offsetX: 10, offsetY: 10, factor: 1, origin }),
      { scrollLeft: 30, scrollTop: 40 },
    );
    // Zooming out near the top-left would ask for a negative scroll; clamp at 0.
    const out = scrollToKeepAnchor({ scrollLeft: 0, scrollTop: 0, offsetX: 500, offsetY: 300, factor: 0.5, origin });
    assert.deepEqual(out, { scrollLeft: 0, scrollTop: 0 });
  });
});
