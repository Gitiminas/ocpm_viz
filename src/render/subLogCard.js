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
 * computes from — so hiding the pull-request lane or the extracted links makes the
 * numbers drop. A count that dropped is shown against the payload's total ("6 / 8") so
 * the card can never be read as "this sub-log has six pull requests" when the truth is
 * "you are looking at six of eight" — anything hidden is declared, in numbers. The
 * kicker reads "Currently displayed" for the same reason. An actor is drawn only when
 * pinned, and the relationships mode draws one mark per object, so the summary is first
 * passed through `summaryForMode` (`state/state.js`): actors are the pinned ones, and in
 * that mode artifacts are marks, both still against the payload's totals.
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
/*
 * The card's name is its own line, ruled off from the tiles, so it reads as a title and
 * not as a caption of the first row. "Currently displayed" is what every number below
 * means; the right-hand hint appears only when that differs from the payload.
 */
const KICKER =
  'font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-500);' +
  'display:flex;justify-content:space-between;gap:8px;padding-bottom:6px;' +
  'border-bottom:1px solid var(--color-neutral-800);margin:0 -2px';
const EMPTY = 'font-size:10.5px;color:var(--color-neutral-500);line-height:1.4;font-style:italic';
const EXPORT_BUTTON =
  'margin-top:6px;padding:5px 8px;font:inherit;font-size:10.5px;color:var(--color-accent-300);' +
  'background:transparent;border:1px solid var(--color-neutral-800);border-radius:4px;cursor:pointer;' +
  'text-align:left';
const OF_TOTAL = 'font-size:10px;font-weight:400;color:var(--color-neutral-500);margin-left:3px';

/**
 * @param {object} options
 * @param {HTMLElement} options.container  emptied and refilled
 * @param {object|null} options.summary    `summarizeSubLog` over what is VISIBLE, or null
 *   when no sub-log is loaded — the card stays, titled, and says so
 * @param {object} [options.total]         `summarizeSubLog` over the whole payload; where
 *   a count differs from the visible one, the tile shows both ("6 / 8")
 * @param {() => void} [options.onExport]  when given, a button below the numbers that hands
 *                                         the reader the whole sub-log as an OCEL 2.0 JSON file
 * @param {string[]} [options.notes]       plain sentences worth stating with the numbers —
 *   "no links from this seed", and the like
 */
export function renderSubLogCard({ container, summary, total = summary, notes = [], onExport = null }) {
  container.innerHTML = '';
  container.style.cssText = CARD;

  // The empty state keeps the card in place with its title, so the sidebar does not
  // rearrange itself when a sub-log arrives and a reader learns where the numbers will be.
  if (!summary) {
    const kicker = document.createElement('div');
    kicker.style.cssText = KICKER;
    kicker.textContent = 'Currently displayed';
    container.appendChild(kicker);
    const empty = document.createElement('div');
    empty.style.cssText = EMPTY;
    empty.textContent = 'No sub-log loaded yet.';
    container.appendChild(empty);
    return;
  }

  const anyHidden =
    COUNTED_TYPES.some((type) => (total.counts.get(type) ?? 0) !== (summary.counts.get(type) ?? 0)) ||
    total.links !== summary.links ||
    total.events !== summary.events;
  const kicker = document.createElement('div');
  kicker.style.cssText = KICKER;
  kicker.innerHTML =
    '<span>Currently displayed</span>' +
    (anyHidden ? '<span>of the sub-log</span>' : '');
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
        tip: { key: 'card.type', arg: type },
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
      tip: { key: 'card.links' },
    }),
  );
  joins.appendChild(
    tile({
      value: String(summary.events),
      of: total.events,
      label: plural('Event', total.events),
      tip: { key: 'card.events' },
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
  const spanTile = tile({ ...span, tip: { key: 'card.span' } });
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

  // The whole sub-log, not the shown part: an export is the record, the toggles are a view
  // of it. The click is the caller's (`main.js`), which is where a Blob and a download
  // link belong; this renderer only states that the export exists and names its format.
  if (onExport) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.tip = 'card.export';
    button.textContent = 'Download as OCEL 2.0 JSON';
    button.style.cssText = EXPORT_BUTTON;
    button.addEventListener('click', onExport);
    container.appendChild(button);
  }
}

/**
 * The process map's twin of the card above: what the page currently draws, counted.
 *
 * Same tile contract, same "n / total when the filter hides something" honesty, same
 * kicker — the two cards must read as one instrument, because they answer the same
 * question on different pages. The counted items are the map's own: activities, and
 * the two succession classes.
 *
 * @param {object} options
 * @param {HTMLElement} options.container  emptied and refilled
 * @param {{activities, perType, cross}|null} options.shown  what survived the filter,
 *   or null before a DFG is loaded — the card stays, titled, and says so
 * @param {{activities, perType, cross}} [options.total]  the whole artifact's counts
 */
export function renderProcessCard({ container, shown, total = shown }) {
  container.innerHTML = '';
  container.style.cssText = CARD;

  const kicker = document.createElement('div');
  kicker.style.cssText = KICKER;
  if (!shown) {
    kicker.textContent = 'Currently displayed';
    container.appendChild(kicker);
    const empty = document.createElement('div');
    empty.style.cssText = EMPTY;
    empty.textContent = 'No process map loaded yet.';
    container.appendChild(empty);
    return;
  }

  const anyHidden =
    shown.activities !== total.activities ||
    shown.perType !== total.perType ||
    shown.cross !== total.cross;
  kicker.innerHTML =
    '<span>Currently displayed</span>' + (anyHidden ? '<span>of the whole log</span>' : '');
  container.appendChild(kicker);

  const row = document.createElement('div');
  row.style.cssText = 'display:grid;grid-template-columns:repeat(3, minmax(0,1fr));gap:6px';
  row.appendChild(
    tile({
      value: String(shown.activities),
      of: total.activities,
      label: total.activities === 1 ? 'Activity' : 'Activities',
      tip: { key: 'dfg.card.activities' },
    }),
  );
  row.appendChild(
    tile({
      value: String(shown.perType),
      of: total.perType,
      label: 'Within a type',
      tip: { key: 'dfg.card.perType' },
    }),
  );
  row.appendChild(
    tile({
      value: String(shown.cross),
      of: total.cross,
      label: 'Across links',
      tip: { key: 'dfg.card.cross' },
    }),
  );
  container.appendChild(row);
}

/**
 * One stat tile: optional glyph + value on the first line, label on the second. When a
 * total is given and differs from the value, the value reads "n / total" with the total
 * muted — the visible number stays the loud one, the payload's the reference. The tile
 * carries its help-strip label (`tip`) instead of a browser tooltip.
 */
function tile({ value, of = null, label, glyph: glyphMarkup = '', tip = null }) {
  const el = document.createElement('div');
  el.style.cssText = TILE;
  if (tip) {
    el.dataset.tip = tip.key;
    if (tip.arg != null) el.dataset.tipArg = String(tip.arg);
  }
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
