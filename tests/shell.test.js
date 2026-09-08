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
    // Inside `#scroll` it would scroll away with the chart, and it must be impossible
    // to miss while anything is hidden.
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

  test('the stats page has a message surface of its own', async () => {
    // Without one, an exception in renderStats rendered an empty dashboard while the
    // explanation went to #chartMessage — an element on a page that was not on screen.
    const html = await shell();
    const [message, content] = orderOf(html, 'statsMessage', 'statsContent');
    assert.ok(message > 0, 'the stats page needs somewhere to say why it is empty');
    assert.ok(content > 0, 'and something to say it instead of');
    assert.ok(message < content, 'the message must precede the content as a sibling');
  });

  test('the process-map page has its tab, and a message surface of its own', async () => {
    // The same contract the stats page carries: a page that can fail needs somewhere
    // on ITSELF to say why, before the content root it stands in for.
    const html = await shell();
    assert.ok(html.includes('data-page="dfg"'), 'the page needs a tab to reach it');
    const [message, content] = orderOf(html, 'dfgMessage', 'dfgContent');
    assert.ok(message > 0, 'the process-map page needs somewhere to say why it is empty');
    assert.ok(content > 0, 'and something to say it instead of');
    assert.ok(message < content, 'the message must precede the content as a sibling');
  });

  test('the sidebar follows the order of the task', async () => {
    // Choose what you are looking at, choose how you want to see it, then refine.
    // A saved view sets every toggle below it at once, so it belongs above them:
    // met afterwards, it invites arranging the sidebar by hand and only then
    // discovering that one click already did it — and then overwrites that work.
    const html = await shell();
    const at = (label) => html.indexOf(`>${label}</span>`);
    const order = ['Views', 'Lanes', 'Relationships', 'Folding', 'Actors', 'Legend'];
    const positions = order.map(at);
    assert.ok(positions.every((p) => p > 0), `a sidebar section is missing: ${order}`);
    assert.deepEqual(
      positions.slice().sort((a, b) => a - b),
      positions,
      `sidebar sections must appear in the order ${order.join(' → ')}`,
    );
  });

  test('the placeholder is a sibling of the chart, never its content', async () => {
    // Writing into #chart detaches the one <svg> the renderer holds, and every later
    // draw then lands outside the document.
    const html = await shell();
    const [message, chart] = orderOf(html, 'chartMessage', 'chart');
    assert.ok(message > 0 && chart > 0);
    assert.ok(message < chart, 'the message element must precede #chart as a sibling');
    // `#chart` must be empty in the markup — the renderer owns everything inside it.
    assert.match(html, /<div id="chart"><\/div>/, '#chart must ship empty');
  });
});

describe('the page navigation says which pages share a sub-log', () => {
  test('Trace and Stats sit in one group with one indicator; Process stands apart', async () => {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const group = html.slice(html.indexOf('id="pageGroup"'), html.indexOf('</div>', html.indexOf('id="pageGroup"')));
    assert.ok(group.includes('id="pageThumb"'), 'the group carries the sliding indicator');
    assert.ok(group.includes('data-page="timeline"') && group.includes('data-page="stats"'));
    assert.ok(!group.includes('data-page="dfg"'), 'the process map is not a sub-log page');
    assert.ok(html.includes('class="pageTab solo" data-page="dfg"'), 'Process is styled on its own');
    assert.ok(html.indexOf('Sub-log</span>') < html.indexOf('id="pageGroup"'), 'the group is captioned');
    assert.ok(html.includes('Whole log</span>'), 'and so is the process map');
  });
});

describe('the Process page carries the Trace page’s header chrome', () => {
  test('help strip, focus label and the three zoom buttons, in that order', async () => {
    const html = await shell();
    const page = html.slice(html.indexOf('id="dfgPage"'), html.indexOf('id="dfgContent"'));
    const order = ['id="dfgHelpStrip"', 'id="dfgFocusInfo"', 'id="dfgZout"', 'id="dfgZrst"', 'id="dfgZin"']
      .map((needle) => page.indexOf(needle));
    assert.ok(order.every((i) => i >= 0), `missing: ${order}`);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'same order as the Trace header');
    assert.ok(!page.includes('<h1'), 'no page title: the sidebar names the page');
    assert.ok(html.includes('id="dfgHiddenBanner"'), 'the hidden-state banner has a home');
  });
});
