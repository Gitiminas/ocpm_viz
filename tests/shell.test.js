import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Assertions about `index.html`'s structure.
 *
 * The shell has no logic to unit-test, but two of its arrangements are load-bearing and
 * both were learned by breaking them, so they are pinned here rather than left to be
 * re-derived by whoever next edits the markup. Reading the file is the only DOM-free way
 * to state them.
 */
const shell = async () => readFile(new URL('../index.html', import.meta.url), 'utf8');

const orderOf = (html, ...ids) => ids.map((id) => html.indexOf(`id="${id}"`));

describe('the app shell keeps its load-bearing order', () => {
  test('the hidden-state banner sits BELOW the chart, so appearing cannot shove it down', async () => {
    const html = await shell();
    const [chart, banner] = orderOf(html, 'chart', 'hiddenBanner');
    assert.ok(chart > 0 && banner > 0, 'both elements must exist');
    assert.ok(
      banner > chart,
      'the banner must come after the chart: above it, the first thing you hide pushes ' +
        'the whole graph down, and comparing before with after is exactly why you toggled',
    );
  });

  test('the banner is out of the flex flow of the scroll area, not inside it', async () => {
    // Inside `#scroll` it would scroll away with the chart, and decision 27 requires it
    // to be impossible to miss while anything is hidden.
    const html = await shell();
    const scroll = html.indexOf('id="scroll"');
    const wrapEnd = html.indexOf('</main>', scroll);
    const banner = html.indexOf('id="hiddenBanner"');
    assert.ok(banner > scroll, 'sanity: the banner comes after the scroll container');
    assert.ok(banner < wrapEnd, 'the banner must stay inside the timeline page');
    assert.match(
      html.slice(banner, banner + 120),
      /flex:0 0 auto/,
      'the banner must not flex, or it would steal height from the chart as it grows',
    );
  });

  test('the placeholder is a sibling of the chart, never its content', async () => {
    // Decision 74: writing into #chart detaches the one <svg> the renderer holds, and
    // every later draw then lands outside the document.
    const html = await shell();
    const [message, chart] = orderOf(html, 'chartMessage', 'chart');
    assert.ok(message > 0 && chart > 0);
    assert.ok(message < chart, 'the message element must precede #chart as a sibling');
    // `#chart` must be empty in the markup — the renderer owns everything inside it.
    assert.match(html, /<div id="chart"><\/div>/, '#chart must ship empty');
  });
});
