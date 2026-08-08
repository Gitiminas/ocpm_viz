import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMessageSurface, messageHtml, errorHtml } from '../src/render/message.js';

/**
 * A message surface touches only `innerHTML` and `style.display`, which is the whole
 * reason it was extracted: the rule it enforces — a page says why it cannot draw, in an
 * element that is a *sibling* of the drawing surface — is checkable against a stub.
 */
const stub = () => ({ innerHTML: 'stale', style: { display: 'block' } });

describe('a page message surface', () => {
  test('showing a message hides the content rather than emptying it', () => {
    const messageEl = stub();
    const contentEl = stub();
    createMessageSurface({ messageEl, contentEl }).show('<p>why</p>');

    assert.equal(messageEl.innerHTML, '<p>why</p>');
    assert.equal(messageEl.style.display, 'block');
    assert.equal(contentEl.style.display, 'none');
    // Emptying it would destroy what the renderer holds a reference to (decision 74),
    // and showing the last sub-log under "could not draw" would contradict the message.
    assert.equal(contentEl.innerHTML, 'stale', 'the content must not be cleared');
  });

  test('hiding hands the surface back and leaves no stale message behind', () => {
    const messageEl = stub();
    const contentEl = stub();
    const surface = createMessageSurface({ messageEl, contentEl });
    surface.show('<p>why</p>');
    surface.hide();

    assert.equal(messageEl.style.display, 'none');
    assert.equal(messageEl.innerHTML, '', 'a hidden message must not linger in the DOM');
    assert.equal(contentEl.style.display, '', 'the content gets its own display back');
  });

  test('isShowing reports the state, so a caller need not read the DOM', () => {
    const surface = createMessageSurface({ messageEl: stub(), contentEl: stub() });
    surface.hide();
    assert.equal(surface.isShowing(), false);
    surface.show('x');
    assert.equal(surface.isShowing(), true);
  });

  test('a surface with no content element still works', () => {
    // Not every page has one drawing surface to swap with.
    const messageEl = stub();
    const surface = createMessageSurface({ messageEl });
    surface.show('x');
    assert.equal(messageEl.innerHTML, 'x');
    surface.hide();
    assert.equal(messageEl.innerHTML, '');
  });

  test('constructing without a message element fails loudly', () => {
    // Silently doing nothing is how a page ends up unable to report anything at all.
    assert.throws(() => createMessageSurface({}), /messageEl is required/);
  });
});

describe('message formatting', () => {
  test('an error message is escaped, never interpreted as markup', () => {
    const html = errorHtml(new Error('unexpected <script> in payload & more'));
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&amp; more/);
    assert.doesNotMatch(html, /<script>/, 'an exception message must not become markup');
  });

  test('an error renders its message, not the object', () => {
    assert.match(errorHtml(new Error('boom')), /boom/);
    assert.match(errorHtml('a bare string'), /a bare string/);
  });

  test('the title is caller-supplied, so each page names its own failure', () => {
    assert.match(errorHtml(new Error('x'), 'Could not compute these statistics'),
      /Could not compute these statistics/);
    assert.match(errorHtml(new Error('x')), /Could not render this sub-log/);
  });

  test('messageHtml keeps body markup, which the prompts rely on', () => {
    const html = messageHtml('Pick one', 'try <strong>Start from</strong>');
    assert.match(html, /<strong>Start from<\/strong>/);
    assert.match(html, /Pick one/);
  });
});
