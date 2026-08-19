import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { bindHelpStrip, resolveTip } from '../src/render/helpStrip.js';
import { DEFAULT_TIP, TIPS } from '../src/help/tips.js';

/**
 * The help strip touches the DOM through addEventListener on the root, `closest` and
 * `dataset` on the hovered element, and textContent/classList on the strip — so stubs
 * stand in for all three and the behaviour is checked without a browser.
 */

/** A fake element tree: each node knows its parent, its dataset, and answers `closest`. */
function element(dataset = {}, parent = null) {
  const el = { dataset, parent };
  el.closest = (selector) => {
    const attr = selector.slice(1, -1); // '[data-tip]' → 'data-tip'
    const prop = attr === 'data-tip' ? 'tip' : 'legend';
    for (let node = el; node; node = node.parent) if (node.dataset[prop] != null) return node;
    return null;
  };
  return el;
}

function harness() {
  const root = new EventTarget();
  const classes = new Set(['isDefault']);
  const stripEl = {
    textContent: '',
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) },
  };
  const strip = bindHelpStrip({ root, stripEl });
  const fire = (type, target, relatedTarget = {}) => {
    const event = new Event(type);
    Object.defineProperty(event, 'target', { value: target });
    Object.defineProperty(event, 'relatedTarget', { value: relatedTarget });
    root.dispatchEvent(event);
  };
  return { root, stripEl, strip, fire, classes };
}

describe('resolving what the pointer is on', () => {
  test('walks up to the nearest labelled ancestor', () => {
    const row = element({ tip: 'zoom.out' });
    const icon = element({}, row);
    assert.equal(resolveTip(icon), TIPS['zoom.out']);
  });

  test('a chart mark needs only its legend key', () => {
    const mark = element({ legend: 'pull_request' });
    assert.equal(resolveTip(mark), TIPS['legend.pull_request']);
  });

  test('data-tip wins over data-legend, and a parametrised key takes its argument', () => {
    const both = element({ tip: 'lane', tipArg: 'commit', legend: 'commit' });
    assert.match(resolveTip(both), /every commit/);
  });

  test('nothing labelled means no text, and a non-element is tolerated', () => {
    assert.equal(resolveTip(element({})), null);
    assert.equal(resolveTip(null), null);
    assert.equal(resolveTip({}), null);
  });
});

describe('the strip follows the pointer and the keyboard', () => {
  test('starts on the quiet hint, shows a text on hover, and returns to the hint', () => {
    const { stripEl, fire, classes } = harness();
    assert.equal(stripEl.textContent, DEFAULT_TIP);
    assert.ok(classes.has('isDefault'));

    fire('mouseover', element({ tip: 'source.database' }));
    assert.equal(stripEl.textContent, TIPS['source.database']);
    assert.ok(!classes.has('isDefault'));

    fire('mouseover', element({})); // plain background
    assert.equal(stripEl.textContent, DEFAULT_TIP);
    assert.ok(classes.has('isDefault'));
  });

  test('leaving the window reverts; moving between two elements does not flicker', () => {
    const { stripEl, fire } = harness();
    fire('mouseover', element({ tip: 'zoom.in' }));
    fire('mouseout', element({ tip: 'zoom.in' }), element({})); // to another element: ignore
    assert.equal(stripEl.textContent, TIPS['zoom.in']);
    fire('mouseout', element({ tip: 'zoom.in' }), null); // out of the window
    assert.equal(stripEl.textContent, DEFAULT_TIP);
  });

  test('keyboard focus does the same as hover', () => {
    const { stripEl, fire } = harness();
    fire('focusin', element({ tip: 'query.seed' }));
    assert.equal(stripEl.textContent, TIPS['query.seed']);
    fire('focusout', element({ tip: 'query.seed' }));
    assert.equal(stripEl.textContent, DEFAULT_TIP);
  });

  test('an unknown key leaves the hint up rather than showing "undefined"', () => {
    const { stripEl, fire } = harness();
    fire('mouseover', element({ tip: 'no.such.key' }));
    assert.equal(stripEl.textContent, DEFAULT_TIP);
  });

  test('dispose stops it listening', () => {
    const { stripEl, fire, strip } = harness();
    strip.dispose();
    fire('mouseover', element({ tip: 'zoom.in' }));
    assert.equal(stripEl.textContent, DEFAULT_TIP);
  });
});
