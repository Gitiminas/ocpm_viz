import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

import { LEGEND_SECTIONS, LEGEND_KEYS, legendPresence } from '../src/render/legend.js';
import { legendKeyFor } from '../src/render/nodes.js';
import { TYPE } from '../src/render/theme.js';
import { loadSubLog } from '../src/data/loadSubLog.js';
import { indexSubLog } from '../src/model/subLog.js';
import { deriveBursts } from '../src/model/bursts.js';
import { buildNodes } from '../src/layout/nodes.js';

/**
 * The legend is a **key to the picture**, so the thing worth asserting is not how it
 * looks but that it is complete in both directions: nothing is drawn that the legend
 * does not name, and nothing is named that is never drawn.
 *
 * It went stale exactly this way. Comments, bursts, folded runs, repeat commit
 * observations and the ×N bundle badge were all added to the renderers over time, and
 * nothing forced a legend entry — so the picture grew a vocabulary the reader had no key
 * to, and only the three object types, two link classes and the comment connector were
 * ever explained.
 *
 * Reading the render sources is deliberate. The alternative is a hand-maintained list of
 * "marks that exist", which is the same thing that fell out of date in the first place;
 * the source is the only account of what is actually drawn.
 *
 * ⚠️ A literal scan is not enough on its own, and the first version of this test proved
 * it by reporting five false orphans. Node glyphs are tagged through `legendKeyFor`,
 * which returns `node.lane` — a value no regex can resolve. So the keys come from two
 * places: literals for the marks written inline, and `legendKeyFor` **executed** over
 * real and synthetic nodes for the ones computed at draw time.
 */
const RENDER_DIR = new URL('../src/render/', import.meta.url);

async function legendKeysUsedByRenderers() {
  const files = (await readdir(RENDER_DIR)).filter(
    (name) => name.endsWith('.js') && name !== 'legend.js',
  );
  const used = new Map(); // key -> the file that draws it

  for (const name of files) {
    const source = await readFile(new URL(name, RENDER_DIR), 'utf8');
    // `data-legend` is always written with a literal on the same line, either directly
    // or through a ternary; both forms are string literals we can read off.
    for (const line of source.split('\n')) {
      if (!line.includes('data-legend')) continue;
      for (const [, key] of line.matchAll(/'([a-z-]+)'/g)) {
        if (key === 'data-legend') continue;
        if (!used.has(key)) used.set(key, name);
      }
    }
  }
  return used;
}

/** The keys `legendKeyFor` can actually produce, resolved by running it. */
async function legendKeysFromNodes() {
  const transport = async (query) =>
    JSON.parse(
      await readFile(new URL(`./fixtures/${query.fixture}.json`, import.meta.url), 'utf8'),
    );
  const graph = await loadSubLog({ fixture: 'F1' }, { transport });
  const index = indexSubLog(graph);
  const bursts = deriveBursts(index.objectsOfType('commit'));

  const keys = new Set();
  // Real nodes cover the lanes and, in F1, a collapsed burst and comments.
  for (const node of buildNodes({ graph, index, bursts })) keys.add(legendKeyFor(node));
  keys.add(legendKeyFor({ isBurst: true }));
  keys.add(legendKeyFor({ isCommentBurst: true }));
  keys.add(legendKeyFor({ isComment: true, lane: 'issue' }));
  return keys;
}

describe('the legend is a complete key to what is drawn', () => {
  test('every mark a renderer tags has a legend row', async () => {
    const used = await legendKeysUsedByRenderers();
    for (const key of await legendKeysFromNodes()) if (!used.has(key)) used.set(key, 'legendKeyFor');
    const missing = [...used.keys()].filter((key) => !LEGEND_KEYS.includes(key));
    assert.deepEqual(
      missing,
      [],
      `drawn but unexplained: ${missing.map((k) => `${k} (${used.get(k)})`).join(', ')}`,
    );
  });

  test('every legend row names something a renderer actually draws', async () => {
    const used = await legendKeysUsedByRenderers();
    for (const key of await legendKeysFromNodes()) used.set(key, 'legendKeyFor');
    const orphans = LEGEND_KEYS.filter((key) => !used.has(key));
    assert.deepEqual(orphans, [], `explained but never drawn: ${orphans.join(', ')}`);
  });

  test('the marks that prompted this are all present', () => {
    // Named individually rather than by count, so the failure says which one went.
    for (const key of [
      'comments', // the comment glyph AND its dotted connector
      'repeat-observation', // the hollow square
      'closed-unmerged', // the dashed ring
      'landmark', // the solid ring — merged, issue closed
      'burst', // bulk push
      'comment-burst', // a run of comments folded together
      'link-crowded', // the ×N badge
      'sequence', // an object's own spine
      'actor-trail', // the selected actor's dashed path
    ]) {
      assert.ok(LEGEND_KEYS.includes(key), `legend is missing "${key}"`);
    }
  });

  test('every object type has a row, so no lane is unexplained', () => {
    for (const type of Object.keys(TYPE)) {
      assert.ok(LEGEND_KEYS.includes(type), `legend is missing the ${type} lane`);
    }
  });
});

describe('the legend data is well formed', () => {
  test('every row has a swatch and a label', () => {
    for (const section of LEGEND_SECTIONS) {
      assert.ok(section.title, 'a section must be titled');
      assert.ok(section.rows.length > 0, `section ${section.title} is empty`);
      for (const row of section.rows) {
        assert.ok(row.label, `a row in ${section.title} has no label`);
        assert.match(row.swatch, /^<svg/, `row "${row.label}" has no svg swatch`);
      }
    }
  });

  test('swatches are self-contained markup, not references to app colours by name', () => {
    // The legend renders outside the chart, so a swatch that leaned on an object shade
    // (`assignObjectColors`) would show a colour that means "which object" in a context
    // where there is no object. Neutral tokens and type colours only.
    for (const section of LEGEND_SECTIONS) {
      for (const row of section.rows) {
        assert.doesNotMatch(row.swatch, /url\(#/, `row "${row.label}" references a gradient`);
      }
    }
  });

  test('keys are unique per meaning — `comments` covers a glyph and a line on purpose', () => {
    const all = LEGEND_SECTIONS.flatMap((s) => s.rows.map((r) => r.key).filter(Boolean));
    const duplicated = all.filter((k, i) => all.indexOf(k) !== i);
    assert.deepEqual(duplicated, ['comments'], 'only `comments` may appear in two sections');
    assert.equal(new Set(all).size, LEGEND_KEYS.length);
  });
});

describe('the legend dims what is not in the picture', () => {
  test('before the first draw everything reads as active', () => {
    // `null` means "we have not looked yet", which must not be shown as "nothing is here".
    for (const section of legendPresence(null)) {
      assert.equal(section.present, true);
      for (const row of section.rows) assert.equal(row.present, true);
    }
  });

  test('an empty picture dims every row and every heading', () => {
    for (const section of legendPresence(new Set())) {
      assert.equal(section.present, false, `${section.title} should be dim`);
      for (const row of section.rows) assert.equal(row.present, false);
    }
  });

  test('only the keys actually drawn stay active', () => {
    const drawn = new Set(['issue', 'comments', 'link-validated']);
    const rows = legendPresence(drawn).flatMap((s) => s.rows);
    const active = rows.filter((r) => r.present).map((r) => r.key);
    // `comments` is deliberately two rows — the glyph and the connector — so it counts twice.
    assert.deepEqual([...new Set(active)].sort(), ['comments', 'issue', 'link-validated']);
    assert.ok(rows.some((r) => !r.present), 'something must be dim, or the test proves nothing');
  });

  test('a heading is active when any of its rows is', () => {
    const sections = legendPresence(new Set(['link-extracted']));
    const links = sections.find((s) => s.title === 'Links');
    assert.equal(links.present, true);
    assert.equal(links.rows.filter((r) => r.present).length, 1);
    assert.equal(sections.find((s) => s.title === 'Artifacts').present, false);
  });

  test('presence never changes the rows themselves — dimming is not filtering', () => {
    const shown = legendPresence(new Set(['issue']));
    assert.deepEqual(
      shown.map((s) => s.rows.length),
      LEGEND_SECTIONS.map((s) => s.rows.length),
      'a dimmed legend must still list every mark the tool can draw',
    );
    assert.equal(shown.length, LEGEND_SECTIONS.length);
  });

  test('every key the presence set can contain is a key the legend knows', () => {
    // Guards the wiring: `legendKeysPresentIn` reads raw `data-legend` values off the
    // DOM, so a stray value would silently dim a row forever.
    for (const key of LEGEND_KEYS) {
      const rows = legendPresence(new Set([key])).flatMap((s) => s.rows);
      assert.ok(rows.some((r) => r.present), `"${key}" never activates any row`);
    }
  });
});
