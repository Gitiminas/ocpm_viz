import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { setupSearchCombo } from '../src/render/sidebar.js';
import { searchSeeds } from '../src/data/api.js';

/**
 * The seed box, checked without a browser.
 *
 * It touches the DOM through `addEventListener`, `value`/`setAttribute` on the input and
 * `innerHTML`/`style` on the dropdown, so stubs stand in for both. Every assertion here is
 * about which text reaches `search` and when — the row rendering needs a real `document`
 * and is left to the eye.
 */

/** A fake input that records its listeners and lets a test fire them. */
function inputStub(value = '') {
  const listeners = new Map();
  return {
    value,
    selected: false,
    addEventListener: (type, handler) => listeners.set(type, handler),
    setAttribute: (_name, _next) => {
      /* the DOM attribute, so a re-render keeps the typed text */
    },
    select() {
      this.selected = true;
    },
    fire: (type) => listeners.get(type)?.(),
    has: (type) => listeners.has(type),
  };
}

const dropdownStub = () => ({ innerHTML: '', style: {}, onscroll: null });

/** Wire a combo up and record every text `search` is asked for. */
function harness({ initialLabel = '', results = [] } = {}) {
  const asked = [];
  const input = inputStub(initialLabel);
  const dropdown = dropdownStub();
  setupSearchCombo({
    input,
    dropdown,
    initialLabel,
    search: async (text) => {
      asked.push(text);
      return results;
    },
    emptyMessage: (text) => (text.trim() ? `no match for ${text}` : 'Type an issue or PR number.'),
    onSelect: () => {},
  });
  return { input, dropdown, asked };
}

/** `renderResults` awaits `search`, so let the microtask queue drain before asserting. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('the seed box searches what it is showing', () => {
  test('focusing with a seed loaded searches that seed, not the empty string', async () => {
    // The defect: focus searched `''`, so clicking the box while "issue #100138" was
    // displayed opened a dropdown of whatever an unfiltered search returns — on the
    // database source, commits by SHA — naming nothing the box said and nothing on screen.
    const { input, asked } = harness({ initialLabel: 'issue #100138' });
    input.fire('focus');
    await settle();
    assert.deepEqual(asked, ['issue #100138']);
  });

  test('focusing an empty box searches the empty string', async () => {
    const { input, asked } = harness({ initialLabel: '' });
    input.fire('focus');
    await settle();
    assert.deepEqual(asked, ['']);
  });

  test('focus opens the dropdown', () => {
    const { input, dropdown } = harness({ initialLabel: 'issue #100138' });
    input.fire('focus');
    assert.equal(dropdown.style.display, 'block');
  });

  test('an empty result set says why rather than claiming a match', async () => {
    const { input, dropdown } = harness({ initialLabel: 'issue #100138', results: [] });
    input.fire('focus');
    await settle();
    assert.match(dropdown.innerHTML, /no match for issue #100138/);
  });

  test('the box starts showing the loaded seed', () => {
    const { input } = harness({ initialLabel: 'issue #100138' });
    assert.equal(input.value, 'issue #100138');
  });

  test('focus selects the text, so a new search does not start by deleting the old one', () => {
    // The box is never empty once a seed is loaded, and searching for something else is
    // the usual reason to click it.
    const { input } = harness({ initialLabel: 'issue #100138' });
    assert.equal(input.selected, false);
    input.fire('focus');
    assert.equal(input.selected, true);
    assert.equal(input.value, 'issue #100138', 'selecting must not clear what is loaded');
  });
});

describe('an empty query against the database names nothing', () => {
  /** A transport that fails the test if it is ever called. */
  const forbidden = () => {
    throw new Error('the database was queried for an empty seed reference');
  };

  test('an empty box does not become a request', async () => {
    // With every filter NULL the RPC answers with whatever its stable key orders first —
    // commits by SHA — so this used to cost a 200-row round trip to produce a list that
    // is not a starting point for anything.
    assert.deepEqual(await searchSeeds('kubernetes/kubernetes', '', { transport: forbidden }), []);
  });

  test('whitespace and undefined name nothing either', async () => {
    assert.deepEqual(await searchSeeds('r', '   ', { transport: forbidden }), []);
    assert.deepEqual(await searchSeeds('r', undefined, { transport: forbidden }), []);
  });

  test('a type word alone is a filter, not nothing, and still queries', async () => {
    // "pr" narrows to pull requests; it must not be swallowed by the empty-query guard.
    let sent = null;
    const transport = async (params) => {
      sent = params;
      return [];
    };
    await searchSeeds('r', 'pr', { transport });
    assert.equal(sent?.seed_type, 'pull_request');
  });
});
