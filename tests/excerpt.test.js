import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { excerptHtml } from '../src/render/tooltip.js';
import { nodeTooltipSpec } from '../src/render/nodes.js';

/**
 * The comment excerpt in the hovercard (decision 124). What matters most here is the
 * escaping: comment bodies are arbitrary user-written GitHub content, and excerptHtml is
 * the ONE place they become markup.
 */

describe('the excerpt block', () => {
  test('user-written markup is escaped, never rendered', () => {
    const html = excerptHtml({ excerptText: 'nice <script>alert(1)</script> & <img src=x onerror=y>' });
    assert.ok(!html.includes('<script>'), 'a script tag survived escaping');
    assert.ok(!html.includes('<img'), 'an img tag survived escaping');
    assert.ok(html.includes('&lt;script&gt;'));
  });

  test('a short comment shows whole: no clamp, no fade, no hint', () => {
    const html = excerptHtml({ excerptText: 'Looks good to me. Can tweak later. Thanks!' });
    assert.ok(!html.includes('clamp'));
    assert.ok(!html.includes('tip-excerpt-cut'));
  });

  test('a long comment clamps, and a server-truncated one says it was shortened', () => {
    const long = 'word '.repeat(60); // 300 chars — clamps, but nothing was cut server-side
    assert.ok(excerptHtml({ excerptText: long }).includes('clamp'));
    assert.ok(!excerptHtml({ excerptText: long }).includes('tip-excerpt-cut'));
    const cut = excerptHtml({ excerptText: 'x'.repeat(500), truncated: true });
    assert.ok(cut.includes('clamp'));
    assert.ok(cut.includes('shortened'));
  });
});

describe('the comment hovercard carries the excerpt', () => {
  const commentNode = (attrs) => ({
    lane: 'issue',
    isComment: true,
    title: 'Comment',
    t: new Date('2025-01-05T10:00:00Z'),
    actorId: 'actor:1',
    object: { label: '#14' },
    event: { attrs },
  });

  test('an excerpt row appears when the payload shipped one, with its flag', () => {
    const spec = nodeTooltipSpec(
      commentNode({ comment_excerpt: 'The fix works for me.', comment_truncated: false }),
      () => 'alice',
    );
    const row = spec.rows.find((r) => !Array.isArray(r) && r.excerptText != null);
    assert.equal(row.excerptText, 'The fix works for me.');
    assert.equal(row.truncated, false);
  });

  test('fixtures without comment text get a card with no excerpt row, not an empty one', () => {
    // F1's frozen blob carries no comment bodies, and nothing is fabricated for it.
    const spec = nodeTooltipSpec(commentNode({}), () => 'alice');
    assert.ok(spec.rows.every((r) => Array.isArray(r) || r.excerptText == null));
  });
});
