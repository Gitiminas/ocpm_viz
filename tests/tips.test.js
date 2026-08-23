import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { TIPS, tipFor, DEFAULT_TIP } from '../src/help/tips.js';
import { LEGEND_KEYS } from '../src/render/legend.js';
import { TYPE_LABELS } from '../src/state/labels.js';

/**
 * The help texts are data, and data gets checked in both directions: a label on screen with
 * no text behind it, or a text nobody shows, is a silent drift. Plus the house rules for the
 * words themselves.
 */

const ROOT = new URL('..', import.meta.url);

async function sourceFiles() {
  const files = [join(ROOT.pathname, 'index.html')];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.js')) files.push(path);
    }
  }
  await walk(join(ROOT.pathname, 'src'));
  return files;
}

/** Every tip key a file refers to — `data-tip="x"` in markup, `'data-tip', 'x'` in d3. */
async function referencedKeys() {
  const keys = new Set();
  for (const file of await sourceFiles()) {
    const text = await readFile(file, 'utf8');
    for (const m of text.matchAll(/data-tip="([a-zA-Z0-9_.-]+)"/g)) keys.add(m[1]);
    for (const m of text.matchAll(/'data-tip',\s*'([a-zA-Z0-9_.-]+)'/g)) keys.add(m[1]);
    for (const m of text.matchAll(/dataset\.tip\s*=\s*'([a-zA-Z0-9_.-]+)'/g)) keys.add(m[1]);
  }
  return keys;
}

/** Every value, resolved with a representative argument. */
function everyText() {
  return Object.entries(TIPS).map(([key, entry]) => {
    const arg =
      key === 'card.type' || key === 'lane' || key === 'lane.comments'
        ? 'pull_request'
        : key === 'views.preset' || key === 'seed.result'
          ? '' // these fall back to their own text when no argument arrives
          : 'something';
    return [key, typeof entry === 'function' ? entry(arg) : entry];
  });
}

describe('every help text reads as one or two plain sentences', () => {
  test('non-empty, ends with a full stop, short enough for two lines', () => {
    for (const [key, text] of everyText()) {
      assert.ok(typeof text === 'string' && text.length > 0, `${key} is empty`);
      assert.ok(/[.!?]$/.test(text), `${key} does not end a sentence: "${text}"`);
      assert.ok(text.length <= 170, `${key} is ${text.length} characters; keep it under 170`);
    }
    assert.ok(DEFAULT_TIP.endsWith('.'));
  });

  test('the retired words do not appear, and neither do the house style’s pet hates', () => {
    for (const [key, text] of everyText()) {
      assert.doesNotMatch(text, /\bcase\b/i, `${key} says "case" (CLAUDE.md: there is no case)`);
      assert.doesNotMatch(text, /\bmilestone/i, `${key} says "milestone" (it is "landmark")`);
      assert.doesNotMatch(text, /\binferred\b/i, `${key} says "inferred" (it is "extracted")`);
      assert.doesNotMatch(text, /—|;/, `${key} uses a dash or semicolon: "${text}"`);
    }
  });

  test('a parametrised entry takes its argument, and an unknown key says so', () => {
    assert.match(tipFor('lane', 'pull_request'), /every pull request/);
    assert.match(tipFor('card.type', 'issue'), /issues/);
    assert.equal(tipFor('views.preset', 'A custom description.'), 'A custom description.');
    assert.equal(tipFor('no.such.key'), null);
    assert.equal(tipFor('zoom.out'), TIPS['zoom.out']);
  });
});

describe('labels and texts agree', () => {
  test('every key the markup or a renderer refers to has a text', async () => {
    const missing = [...(await referencedKeys())].filter((key) => !(key in TIPS));
    assert.deepEqual(missing, [], `data-tip keys with no text: ${missing.join(', ')}`);
  });

  test('every text is shown by something — a quoted key in the markup or a renderer', async () => {
    // The reverse direction (S3). A `legend.<key>` text is reached through a mark's
    // `data-legend` or a legend row's `data-tip`, so those count as referenced when the
    // key is a legend key; everything else must appear as a quoted literal somewhere
    // outside tips.js — as a data-tip attribute, a dataset.tip assignment, or a tip key.
    const corpus = [];
    for (const file of await sourceFiles()) {
      if (file.endsWith('help/tips.js')) continue;
      corpus.push(await readFile(file, 'utf8'));
    }
    const text = corpus.join('\n');
    const unreferenced = Object.keys(TIPS).filter((key) => {
      if (key.startsWith('legend.')) return !LEGEND_KEYS.includes(key.slice('legend.'.length));
      return !text.includes(`'${key}'`) && !text.includes(`"${key}"`) && !text.includes(`\`${key}\``);
    });
    assert.deepEqual(unreferenced, [], `texts nothing shows: ${unreferenced.join(', ')}`);
  });

  test('every legend key has a legend.<key> text — marks and legend rows share it', () => {
    const missing = LEGEND_KEYS.filter((key) => !(`legend.${key}` in TIPS));
    assert.deepEqual(missing, []);
  });

  test('every object type the sidebar names has a lane text', () => {
    for (const type of Object.keys(TYPE_LABELS)) {
      if (type === 'actor') continue; // actors have no lane
      assert.ok(tipFor('lane', type).length > 0);
    }
  });
});
