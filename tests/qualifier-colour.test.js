import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

import { QUALIFIER, qualifierColor } from '../src/render/theme.js';

/**
 * The colour table listed three qualifiers the database has never emitted, so every real
 * qualifier missed the lookup and fell through to neutral grey — a feature quietly doing
 * nothing, with nothing to notice. What was missing was any assertion tying the table to
 * the qualifiers that actually occur, so that is what this is.
 */
const FIXTURES = new URL('./fixtures/', import.meta.url);
const NEUTRAL = 'var(--color-neutral-400)';

async function qualifiersIn(prefix) {
  const files = (await readdir(FIXTURES)).filter(
    (n) => n.startsWith(prefix) && n.endsWith('.json'),
  );
  const found = new Map(); // qualifier -> the file it came from
  for (const name of files) {
    const bundle = JSON.parse(await readFile(new URL(name, FIXTURES), 'utf8'));
    for (const link of bundle.links || []) {
      if (!found.has(link.qualifier)) found.set(link.qualifier, name);
    }
  }
  return found;
}

describe('every qualifier that occurs has a colour', () => {
  test('all four qualifiers are covered', () => {
    // These are what fe.link_mat emits, and the only vocabulary the RPC may produce.
    for (const q of ['resolves', 'references_issue', 'contains_commit', 'merge_commit']) {
      assert.ok(q in QUALIFIER, `${q} is missing from the colour table`);
      assert.notEqual(qualifierColor(q), NEUTRAL, `${q} falls through to the default`);
    }
  });

  test('the table holds those four and nothing invented', () => {
    assert.deepEqual(
      Object.keys(QUALIFIER).sort(),
      ['contains_commit', 'merge_commit', 'references_issue', 'resolves'],
    );
  });

  test('every qualifier in a real RPC snapshot resolves to a colour', async () => {
    const found = await qualifiersIn('LIVE');
    assert.ok(found.size > 0, 'there must be a LIVE sample to check against');
    for (const [q, file] of found) {
      assert.notEqual(qualifierColor(q), NEUTRAL, `${q} (${file}) has no colour`);
    }
  });

  test('the fixture corpus speaks the same vocabulary as the database', async () => {
    // `related_issue`, `referenced_pull_request` and `referenced_issue` are names the RPC
    // can never produce. Pinned so they cannot creep back into the fixtures.
    const found = await qualifiersIn('F');
    for (const q of found.keys()) {
      assert.ok(q in QUALIFIER, `fixture qualifier "${q}" is outside the four`);
    }
    assert.ok(found.size > 0);
    for (const [q, file] of found) {
      assert.notEqual(qualifierColor(q), NEUTRAL, `${q} (${file}) has no colour`);
    }
  });

  test('a qualifier reaching an issue and one reaching a commit differ', () => {
    // The colour is "what the link reaches", so the two must be distinguishable.
    assert.notEqual(qualifierColor('resolves'), qualifierColor('contains_commit'));
    // ...and two that reach the same kind of thing agree.
    assert.equal(qualifierColor('resolves'), qualifierColor('references_issue'));
    assert.equal(qualifierColor('contains_commit'), qualifierColor('merge_commit'));
  });

  test('an unknown qualifier still falls back rather than throwing', () => {
    assert.equal(qualifierColor('not_a_qualifier'), NEUTRAL);
    assert.equal(qualifierColor(undefined), NEUTRAL);
  });
});
