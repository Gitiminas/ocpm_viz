/**
 * The sub-log info card in the sidebar: what is CURRENTLY DISPLAYED, at a glance.
 *
 * This replaced the one-line breadcrumb that sat above the chart ("kubernetes/kubernetes
 * · from issue #47532 · degree 1 · 27 actors, 6 commits, …"). Repository and seed are not
 * repeated here — they are the two search boxes directly above — and the traversal degree
 * has its own line with the stepper, so the card states what is on screen: how many of
 * each object type, how many links and events, and the span of time they cover.
 *
 * ⚠️ **Counts follow the toggles, and say so when they differ from the payload.** The
 * card is summarised over `selectVisible(...)` — the same selection the statistics page
 * computes from (decision 12) — so hiding the pull-request lane or the extracted links
 * makes the numbers drop. A count that dropped is shown against the payload's total
 * ("6 / 8") so the card can never be read as "this sub-log has six pull requests" when
 * the truth is "you are looking at six of eight" — decision 27's rule, in numbers. The
 * kicker reads "Currently displayed" for the same reason.
 *
 * Renders into the container it is given and nothing else; both summaries come from
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
const KICKER =
  'font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-500);' +
  'display:flex;justify-content:space-between;gap:8px';
const OF_TOTAL = 'font-size:10px;font-weight:400;color:var(--color-neutral-500);margin-left:3px';

/**
 * @param {object} options
 * @param {HTMLElement} options.container  emptied and refilled
 * @param {object} options.summary         `summarizeSubLog` over what is VISIBLE
 * @param {object} [options.total]         `summarizeSubLog` over the whole payload; where
 *   a count differs from the visible one, the tile shows both ("6 / 8")
 * @param {string[]} [options.notes]       plain sentences worth stating with the numbers —
 *   "no links from this seed", and the like
 */
export function renderSubLogCard({ container, summary, total = summary, notes = [] }) {
  container.innerHTML = '';
  container.style.cssText = CARD;

  const anyHidden =
    COUNTED_TYPES.some((type) => (total.counts.get(type) ?? 0) !== (summary.counts.get(type) ?? 0)) ||
    total.links !== summary.links ||
    total.events !== summary.events;
  const kicker = document.createElement('div');
  kicker.style.cssText = KICKER;
  kicker.innerHTML =
    '<span>Currently displayed</span>' +
    (anyHidden ? '<span title="Some of the sub-log is hidden by the current view; the hidden-state banner below the chart says what">of the sub-log</span>' : '');
  container.appendChild(kicker);

  // Row 1 — what the sub-log is made of. The glyph is the same drawing the lanes and the
  // legend use (`theme.js`), so the card and the picture agree on shapes.
  const objects = document.createElement('div');
  objects.style.cssText = ROW;
  for (const type of COUNTED_TYPES) {
    const n = summary.counts.get(type) ?? 0;
    const all = total.counts.get(type) ?? 0;
    const label = plural(TYPE_LABELS[type] ?? type, all);
    objects.appendChild(
      tile({
        value: String(n),
        of: all,
        label,
        glyph: glyph(TYPE[type]?.shape ?? 'circle', TYPE[type]?.color ?? 'var(--color-neutral-400)'),
        title: all === n ? `${n} ${label} in the sub-log` : `${n} of ${all} ${label} shown; ${all - n} hidden by the current view`,
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
    tile({
      value: String(summary.links),
      of: total.links,
      label: plural('Link', total.links),
      title:
        total.links === summary.links
          ? 'Links between objects, every evidence class'
          : `${summary.links} of ${total.links} links shown; the rest are switched off or join hidden objects`,
    }),
  );
  joins.appendChild(
    tile({
      value: String(summary.events),
      of: total.events,
      label: plural('Event', total.events),
      title:
        total.events === summary.events
          ? 'Events across every object'
          : `${summary.events} of ${total.events} events shown; the rest belong to hidden objects or are hidden comments`,
    }),
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

/**
 * One stat tile: optional glyph + value on the first line, label on the second. When a
 * total is given and differs from the value, the value reads "n / total" with the total
 * muted — the visible number stays the loud one, the payload's the reference.
 */
function tile({ value, of = null, label, glyph: glyphMarkup = '', title = '' }) {
  const el = document.createElement('div');
  el.style.cssText = TILE;
  if (title) el.title = title;
  const ofTotal =
    of != null && String(of) !== value ? `<span style="${OF_TOTAL}">/ ${escapeHtml(String(of))}</span>` : '';
  el.innerHTML =
    `<span style="${VALUE_ROW}">${glyphMarkup}<span class="mono" style="${VALUE}">${escapeHtml(value)}${ofTotal}</span></span>` +
    `<span style="${LABEL}">${escapeHtml(label)}</span>`;
  return el;
}

function plural(label, n) {
  return n === 1 ? label : `${label}s`;
}
