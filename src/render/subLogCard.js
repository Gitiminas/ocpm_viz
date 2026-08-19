/**
 * The sub-log info card in the sidebar: what the loaded sub-log contains, at a glance.
 *
 * This replaced the one-line breadcrumb that sat above the chart ("kubernetes/kubernetes
 * · from issue #47532 · degree 1 · 27 actors, 6 commits, …"). Repository and seed are not
 * repeated here — they are the two search boxes directly above — and the traversal degree
 * has its own line with the stepper, so the card states what the query *returned*: how
 * many of each object type, how many links and events, and the span of time they cover.
 *
 * ⚠️ Counts are of the PAYLOAD, not of what is currently visible. Hiding a lane does not
 * change them — the hidden-state banner below the chart is what declares subtraction
 * (decision 27), and a card that shrank with the toggles would say the sub-log got
 * smaller when only the picture did.
 *
 * Renders into the container it is given and nothing else; the numbers come from
 * `summarizeSubLog`, which is DOM-free and tested on its own.
 */

import { TYPE, glyph } from './theme.js';
import { TYPE_LABELS } from '../state/labels.js';
import { formatDateYear, formatDuration, escapeHtml } from './format.js';

/** The object types the card counts, in lane order, then actors. */
const COUNTED_TYPES = ['issue', 'pull_request', 'commit', 'actor'];

/*
 * One tile contract for every cell, so the card reads as one instrument: a value in the
 * app's numeral face, a sentence-case label beneath it, no colons and no separators.
 * The first row carries the four object types (with the lanes' own glyphs); the second,
 * under a hairline, what joins them — links, events, and the span of time.
 */
const CARD =
  'margin-top:8px;padding:8px 10px 9px;border:1px solid var(--color-neutral-800);' +
  'border-radius:var(--radius-md);background:var(--color-neutral-900);display:flex;' +
  'flex-direction:column;gap:7px';
const ROW = 'display:grid;grid-template-columns:repeat(4, minmax(0,1fr));gap:6px';
const RULE = 'border-top:1px solid var(--color-neutral-800);margin:0 -2px';
const TILE = 'display:flex;flex-direction:column;gap:2px;min-width:0';
const VALUE_ROW = 'display:inline-flex;align-items:center;gap:5px;min-width:0';
const VALUE = 'font-size:13px;font-weight:600;color:var(--color-text);line-height:1.1;white-space:nowrap';
const LABEL =
  'font-size:9.5px;color:var(--color-neutral-500);line-height:1.25;white-space:nowrap;' +
  'overflow:hidden;text-overflow:ellipsis';
const NOTE = 'font-size:10px;color:var(--color-neutral-300);line-height:1.4';

/**
 * @param {object} options
 * @param {HTMLElement} options.container  emptied and refilled
 * @param {object} options.summary         from `summarizeSubLog`
 * @param {string[]} [options.notes]       plain sentences worth stating with the numbers —
 *   "no links from this seed", and the like
 */
export function renderSubLogCard({ container, summary, notes = [] }) {
  container.innerHTML = '';
  container.style.cssText = CARD;

  // Row 1 — what the sub-log is made of. The glyph is the same drawing the lanes and the
  // legend use (`theme.js`), so the card and the picture agree on shapes.
  const objects = document.createElement('div');
  objects.style.cssText = ROW;
  for (const type of COUNTED_TYPES) {
    const n = summary.counts.get(type) ?? 0;
    const label = plural(TYPE_LABELS[type] ?? type, n);
    objects.appendChild(
      tile({
        value: String(n),
        label,
        glyph: glyph(TYPE[type]?.shape ?? 'circle', TYPE[type]?.color ?? 'var(--color-neutral-400)'),
        title: `${n} ${label} in the sub-log`,
      }),
    );
  }
  container.appendChild(objects);

  const rule = document.createElement('div');
  rule.style.cssText = RULE;
  container.appendChild(rule);

  // Row 2 — what joins them. The span tile takes two columns so its dates have room.
  const joins = document.createElement('div');
  joins.style.cssText = ROW;
  joins.appendChild(
    tile({ value: String(summary.links), label: plural('Link', summary.links), title: 'Links between objects, every evidence class' }),
  );
  joins.appendChild(
    tile({ value: String(summary.events), label: plural('Event', summary.events), title: 'Events across every object' }),
  );
  const span = summary.span
    ? summary.span.ms > 0
      ? {
          value: formatDuration(summary.span.ms),
          label: `${formatDateYear(summary.span.first)} → ${formatDateYear(summary.span.last)} UTC`,
        }
      : { value: 'one instant', label: `${formatDateYear(summary.span.first)} UTC` }
    : { value: '—', label: 'no events' };
  const spanTile = tile({ ...span, title: `First event to last, UTC: ${span.label}` });
  spanTile.style.gridColumn = 'span 2';
  // Two dates and the zone are the one label allowed to wrap: truncating would drop the
  // zone, and every time in this tool is labelled UTC (CLAUDE.md).
  spanTile.lastElementChild.style.whiteSpace = 'normal';
  joins.appendChild(spanTile);
  container.appendChild(joins);

  for (const text of notes) {
    const note = document.createElement('div');
    note.style.cssText = NOTE;
    note.textContent = text;
    container.appendChild(note);
  }
}

/** One stat tile: optional glyph + value on the first line, label on the second. */
function tile({ value, label, glyph: glyphMarkup = '', title = '' }) {
  const el = document.createElement('div');
  el.style.cssText = TILE;
  if (title) el.title = title;
  el.innerHTML =
    `<span style="${VALUE_ROW}">${glyphMarkup}<span class="mono" style="${VALUE}">${escapeHtml(value)}</span></span>` +
    `<span style="${LABEL}">${escapeHtml(label)}</span>`;
  return el;
}

function plural(label, n) {
  return n === 1 ? label : `${label}s`;
}
