import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createLoadingOverlay,
  loadingHtml,
  SHOW_DELAY_MS,
  PATIENCE_MS,
} from '../src/render/loading.js';

/**
 * The loading overlay, checked against stubs and a fake clock.
 *
 * It touches `innerHTML` and `style` on two elements and takes its timers by injection,
 * so every property below is decidable without a browser — including the one that
 * matters most, that a load fast enough never draws anything at all.
 */

/** A clock that fires nothing until a test says so. */
function clock() {
  let next = 1;
  const timers = new Map();
  return {
    schedule: (fn, ms) => {
      const handle = next++;
      timers.set(handle, { fn, ms });
      return handle;
    },
    cancel: (handle) => timers.delete(handle),
    /** Fire every timer due at or before `ms`, soonest first. */
    advance(ms) {
      for (const [handle, timer] of [...timers].sort((a, b) => a[1].ms - b[1].ms)) {
        if (timer.ms > ms) continue;
        timers.delete(handle);
        timer.fn();
      }
    },
    pending: () => timers.size,
  };
}

function harness() {
  const overlayEl = { innerHTML: '', style: {} };
  const contentEl = { style: {} };
  const time = clock();
  const overlay = createLoadingOverlay({
    overlayEl,
    contentEl,
    schedule: time.schedule,
    cancel: time.cancel,
  });
  return { overlay, overlayEl, contentEl, time };
}

describe('a load fast enough is never announced', () => {
  test('nothing is drawn before the delay elapses', () => {
    // The fixture source answers in milliseconds. A spinner that appears for one frame on
    // every fixture load reads as a glitch, so `show` only arms a timer.
    const { overlay, overlayEl, contentEl } = harness();
    overlay.show('synthetic/fixture');
    assert.equal(overlay.isShowing(), false);
    assert.equal(overlayEl.innerHTML, '');
    assert.equal(contentEl.style.filter, undefined, 'nothing is blurred yet');
  });

  test('a load that finishes first leaves no trace', () => {
    const { overlay, overlayEl, contentEl, time } = harness();
    overlay.show('synthetic/fixture');
    overlay.hide();
    time.advance(10_000); // the delay would have fired here
    assert.equal(overlay.isShowing(), false);
    assert.equal(overlayEl.innerHTML, '');
    assert.equal(overlayEl.style.display, 'none');
    assert.equal(contentEl.style.filter, '');
    assert.equal(time.pending(), 0, 'no timer is left running');
  });

  test('`show` reports a load in flight even before the card appears', () => {
    const { overlay } = harness();
    assert.equal(overlay.isPending(), false);
    overlay.show('kubernetes/kubernetes');
    assert.equal(overlay.isPending(), true);
    assert.equal(overlay.isShowing(), false);
  });
});

describe('a slow load is announced, and blocks the stale picture', () => {
  test('the card appears once the delay elapses', () => {
    const { overlay, overlayEl, time } = harness();
    overlay.show('kubernetes/kubernetes · traversal degree 2');
    time.advance(SHOW_DELAY_MS);
    assert.equal(overlay.isShowing(), true);
    assert.equal(overlayEl.style.display, 'flex');
    assert.match(overlayEl.innerHTML, /Loading sub-log/);
    assert.match(overlayEl.innerHTML, /kubernetes\/kubernetes · traversal degree 2/);
  });

  test('the previous sub-log blurs and stops taking pointer events', () => {
    // Not cosmetic: a click landing on the stale picture acts on a sub-log that is being
    // replaced, which is how a drag or a toggle gets applied to the wrong thing.
    const { overlay, contentEl, time } = harness();
    overlay.show('kubernetes/kubernetes');
    time.advance(SHOW_DELAY_MS);
    assert.match(contentEl.style.filter, /blur/);
    assert.equal(contentEl.style.pointerEvents, 'none');
  });

  test('hiding restores the picture exactly', () => {
    const { overlay, contentEl, time } = harness();
    overlay.show('kubernetes/kubernetes');
    time.advance(SHOW_DELAY_MS);
    overlay.hide();
    assert.equal(contentEl.style.filter, '');
    assert.equal(contentEl.style.pointerEvents, '');
  });

  test('a failed load still puts the picture back', () => {
    // `reload` hides in a `finally`; this is the property that makes that safe.
    const { overlay, overlayEl, contentEl, time } = harness();
    overlay.show('kubernetes/kubernetes');
    time.advance(SHOW_DELAY_MS);
    overlay.hide(); // as the `finally` does, with the error already on screen
    assert.equal(overlayEl.style.display, 'none');
    assert.equal(contentEl.style.filter, '');
  });

  test('hiding when nothing is showing is harmless', () => {
    const { overlay } = harness();
    overlay.hide();
    assert.equal(overlay.isShowing(), false);
  });
});

describe('a long wait says more than a spinner', () => {
  test('the card admits the query is slow once patience runs out', () => {
    const { overlay, overlayEl, time } = harness();
    overlay.show('kubernetes/kubernetes · traversal degree 2');
    time.advance(SHOW_DELAY_MS);
    assert.doesNotMatch(overlayEl.innerHTML, /Still working/);
    time.advance(PATIENCE_MS);
    assert.match(overlayEl.innerHTML, /Still working/);
    assert.match(overlayEl.innerHTML, /kubernetes\/kubernetes/, 'and still says what it is');
  });

  test('the patience line never fires after the load ended', () => {
    const { overlay, overlayEl, time } = harness();
    overlay.show('kubernetes/kubernetes');
    time.advance(SHOW_DELAY_MS);
    overlay.hide();
    time.advance(PATIENCE_MS);
    assert.equal(overlayEl.innerHTML, '');
  });

  test('a second load while the first is up retitles rather than restarting', () => {
    const { overlay, overlayEl, time } = harness();
    overlay.show('microsoft/vscode');
    time.advance(SHOW_DELAY_MS);
    overlay.show('kubernetes/kubernetes · traversal degree 2');
    assert.equal(overlay.isShowing(), true);
    assert.match(overlayEl.innerHTML, /kubernetes\/kubernetes/);
    assert.doesNotMatch(overlayEl.innerHTML, /vscode/);
  });
});

describe('what the card says', () => {
  test('a description is shown when there is one', () => {
    assert.match(loadingHtml('kubernetes/kubernetes'), /kubernetes\/kubernetes/);
  });

  test('no description leaves no empty line behind', () => {
    assert.doesNotMatch(loadingHtml(''), /loadingQuery/);
  });

  test('a repository name cannot inject markup', () => {
    // The name comes from a URL parameter, so it is the one string here that must not be
    // reinterpreted as HTML.
    const html = loadingHtml('<img src=x onerror=alert(1)>');
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
  });

  test('an overlay without an element to draw into is a programming error', () => {
    assert.throws(() => createLoadingOverlay({}), /overlayEl is required/);
  });
});
