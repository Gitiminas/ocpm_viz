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

const CARD =
  'margin-top:8px;padding:8px 10px;border:1px solid var(--color-neutral-800);' +
  'border-radius:var(--radius-md);background:var(--color-neutral-900);display:flex;' +
  'flex-direction:column;gap:6px';
const GRID = 'display:grid;grid-template-columns:repeat(4, minmax(0,1fr));gap:4px';
const CELL =
  'display:flex;flex-direction:column;align-items:flex-start;gap:1px;min-width:0';
const COUNT = 'font-size:13px;font-weight:600;color:var(--color-text);line-height:1.1';
const LABEL = 'font-size:9.5px;color:var(--color-neutral-500);white-space:nowrap';
const LINE = 'font-size:10px;color:var(--color-neutral-400);line-height:1.4';
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

  // One cell per object type: glyph, count, label. The glyph is the same drawing the
  // lanes and the legend use (`theme.js`), so the card and the picture agree on shapes.
  const grid = document.createElement('div');
  grid.style.cssText = GRID;
  for (const type of COUNTED_TYPES) {
    const n = summary.counts.get(type) ?? 0;
    const cell = document.createElement('div');
    cell.style.cssText = CELL;
    const shape = TYPE[type]?.shape ?? 'circle';
    const color = TYPE[type]?.color ?? 'var(--color-neutral-400)';
    const label = TYPE_LABELS[type] ?? type;
    cell.innerHTML =
      `<span style="display:inline-flex;align-items:center;gap:5px">${glyph(shape, color)}` +
      `<span class="mono" style="${COUNT}">${n}</span></span>` +
      `<span style="${LABEL}">${escapeHtml(plural(label, n))}</span>`;
    cell.title = `${n} ${plural(label, n)} in the sub-log`;
    grid.appendChild(cell);
  }
  container.appendChild(grid);

  const line = document.createElement('div');
  line.className = 'mono';
  line.style.cssText = LINE;
  const parts = [
    `${summary.links} link${summary.links === 1 ? '' : 's'}`,
    `${summary.events} event${summary.events === 1 ? '' : 's'}`,
  ];
  if (summary.span) {
    parts.push(
      summary.span.ms > 0
        ? `spans ${formatDuration(summary.span.ms)} · ${formatDateYear(summary.span.first)} → ${formatDateYear(summary.span.last)} UTC`
        : `one instant · ${formatDateYear(summary.span.first)} UTC`,
    );
  }
  line.textContent = parts.join(' · ');
  container.appendChild(line);

  for (const text of notes) {
    const note = document.createElement('div');
    note.style.cssText = NOTE;
    note.textContent = text;
    container.appendChild(note);
  }
}

function plural(label, n) {
  return n === 1 ? label : `${label}s`;
}
