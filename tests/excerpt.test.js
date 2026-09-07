import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { excerptHtml } from '../src/render/tooltip.js';
import { nodeTooltipSpec } from '../src/render/nodes.js';

/**
 * The comment excerpt in the hovercard. What matters most here is the escaping: comment
 * bodies are arbitrary user-written GitHub content, and excerptHtml is the ONE place they
 * become markup.
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
    assert.ok(cut.includes('shortened (full text on GitHub)'));
  });

  test('the block is a headed section, so prose is not fighting the k/v layout', () => {
    const html = excerptHtml({ excerptText: 'Some words.' });
    assert.ok(html.includes('tip-group'), 'the group box is the section treatment');
    assert.ok(html.includes('Comment text'), 'headed by the field, like the observation list');
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

describe('the issue and pull-request cards carry the title and the description', () => {
  const lifecycleNode = (vmap, extra = {}) => ({
    lane: 'pull_request',
    isComment: false,
    title: 'Opened',
    t: new Date('2025-01-05T10:00:00Z'),
    actorId: 'actor:1',
    object: { label: 'PR #14', vmap },
    event: { attrs: {} },
    ...extra,
  });

  test('a Title row and a Description block appear when the payload carries them', () => {
    const spec = nodeTooltipSpec(
      lifecycleNode({ title: 'Fix <b>the</b> thing', body_excerpt: 'Why: it was broken.', body_truncated: true }),
      () => 'alice',
    );
    const title = spec.rows.find((r) => Array.isArray(r) && r[0] === 'Title');
    assert.ok(title, 'a Title row');
    assert.ok(!title[1].includes('<b>'), 'the title is escaped');
    const body = spec.rows.find((r) => !Array.isArray(r) && r.excerptText != null);
    assert.equal(body.excerptText, 'Why: it was broken.');
    assert.equal(body.truncated, true);
    assert.equal(body.heading, 'Description');
  });

  test('a comment mark keeps the comment text, not the description', () => {
    const spec = nodeTooltipSpec(
      lifecycleNode(
        { title: 'T', body_excerpt: 'the description' },
        { isComment: true, event: { attrs: { comment_excerpt: 'the comment' } } },
      ),
      () => 'alice',
    );
    const blocks = spec.rows.filter((r) => !Array.isArray(r) && r.excerptText != null);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].excerptText, 'the comment');
  });

  test('without a title or body in vmap the card has neither row, not empty ones', () => {
    const spec = nodeTooltipSpec(lifecycleNode({ pr_number: 14 }), () => 'alice');
    assert.ok(!spec.rows.some((r) => Array.isArray(r) && r[0] === 'Title'));
    assert.ok(spec.rows.every((r) => Array.isArray(r) || r.excerptText == null));
  });

  test('the excerpt block takes its heading from the row', () => {
    assert.ok(excerptHtml({ excerptText: 'x', heading: 'Description' }).includes('Description'));
    assert.ok(excerptHtml({ excerptText: 'x' }).includes('Comment text'));
  });
});
