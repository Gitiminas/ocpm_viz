/**
 * The legend, and the hover-to-highlight it drives.
 *
 * Hovering a legend row makes every matching mark glow. Marks are tagged with
 * `data-legend` as they are drawn, and their original stroke attributes are stashed
 * on the element so they can be restored exactly — a link's stroke is a gradient
 * `url(...)`, which must come back as the gradient and not as the flat highlight
 * colour.
 */

import { glyph, COLORS, TYPE } from './theme.js';

export function highlightLegendGroup(key, on, color) {
  for (const element of document.querySelectorAll(`[data-legend="${key}"]`)) {
    const target = element.matches('rect,circle,path,line')
      ? element
      : element.querySelector('rect,circle,path,line') || element;

    if (on) {
      element.style.filter = `drop-shadow(0 0 3px ${color}) drop-shadow(0 0 9px ${color})`;
      target.dataset.origSw = target.getAttribute('stroke-width') || '';
      target.dataset.origStroke = target.getAttribute('stroke') || '';
      target.dataset.origFillOp = target.getAttribute('fill-opacity') || '';

      const strokeWidth = parseFloat(target.getAttribute('stroke-width')) || 1.5;
      target.setAttribute('stroke-width', Math.max(strokeWidth * 2, 3.5));
      if (target.getAttribute('stroke')?.startsWith('url(')) target.setAttribute('stroke', color);

      const fillOpacity = parseFloat(target.getAttribute('fill-opacity'));
      if (!Number.isNaN(fillOpacity)) {
        target.setAttribute('fill-opacity', Math.max(fillOpacity, 0.6));
      }
    } else {
      element.style.filter = '';
      if (target.dataset.origSw !== undefined) {
        target.setAttribute('stroke-width', target.dataset.origSw);
        delete target.dataset.origSw;
      }
      if (target.dataset.origStroke) {
        // Restore the gradient reference, not the highlight colour.
        target.setAttribute('stroke', target.getAttribute('data-grad') || target.dataset.origStroke);
        delete target.dataset.origStroke;
      }
      if (target.dataset.origFillOp !== undefined) {
        if (target.dataset.origFillOp) target.setAttribute('fill-opacity', target.dataset.origFillOp);
        delete target.dataset.origFillOp;
      }
    }
  }
}

/* ------------------------------------------------------------------------------------
 * The legend, as data.
 *
 * Pure and exported so it can be checked without a DOM. `tests/legend.test.js` asserts
 * both directions: every `data-legend` a renderer writes has a row here, and every row
 * here is written by some renderer. That invariant is the point — the legend went stale
 * because marks were added (comments, bursts, folded runs, repeat observations, the ×N
 * bundle badge) and nothing forced an entry to be written for them, so the picture grew
 * a vocabulary the reader had no key to.
 *
 * `key` must equal the `data-legend` value the mark is drawn with; hovering a row
 * highlights every element carrying it. A row without a key is explanatory only.
 * ---------------------------------------------------------------------------------- */

const ring = (dash) =>
  '<svg width="18" height="18" viewBox="-9 -9 18 18">' +
  `<circle cx="0" cy="0" r="7" fill="none" stroke="var(--color-neutral-500)" ` +
  `stroke-width="1.5"${dash ? ' stroke-dasharray="3 3"' : ''}/></svg>`;

const stroke = (attrs) =>
  `<svg width="24" height="8"><line x1="0" y1="4" x2="24" y2="4" ` +
  `stroke="var(--color-neutral-400)" ${attrs}/></svg>`;

const hollow = (shape) => {
  const common = 'fill="var(--color-bg)" stroke="var(--color-neutral-400)" stroke-width="2"';
  const inner =
    shape === 'diamond'
      ? `<path d="M6 1L11 6L6 11L1 6Z" ${common}/>`
      : `<rect x="1.5" y="1.5" width="9" height="9" rx="2" ${common}/>`;
  return `<svg width="12" height="12">${inner}</svg>`;
};

export const LEGEND_SECTIONS = [
  {
    title: 'Objects',
    rows: Object.entries(TYPE).map(([type, spec]) => ({
      key: type,
      label: spec.label,
      color: spec.color,
      swatch: glyph(spec.shape, spec.color),
    })),
  },
  {
    title: 'Marks',
    rows: [
      {
        key: 'comments',
        label: 'comment',
        swatch: hollow('diamond'),
        // Hollow is the comment's own cue, which is why an abandoned pull request and a
        // repeat commit observation had to find other devices (decisions 78, 81).
      },
      {
        key: 'comment-burst',
        label: 'comments folded together',
        swatch:
          '<svg width="16" height="16" viewBox="-8 -8 16 16"><circle cx="0" cy="0" r="6.5" ' +
          'fill="var(--color-bg)" stroke="var(--color-neutral-400)" stroke-width="2"/>' +
          '<text x="0" y="0.5" text-anchor="middle" dominant-baseline="central" font-size="7" ' +
          'font-family="monospace" fill="var(--color-neutral-400)">N</text></svg>',
      },
      { key: 'landmark', label: 'merged · issue closed', swatch: ring(false) },
      { key: 'closed-unmerged', label: 'closed, not merged', swatch: ring(true) },
      {
        key: 'repeat-observation',
        label: 'same commit, pushed again',
        swatch: hollow('square'),
      },
      {
        key: 'burst',
        label: 'bulk push — click to expand',
        swatch:
          '<svg width="16" height="16" viewBox="-8 -8 16 16"><rect x="-7" y="-7" width="14" ' +
          'height="14" rx="3" fill="none" stroke="var(--color-neutral-400)" stroke-width="2"/></svg>',
      },
      {
        key: 'fold-group',
        label: 'folded commits (Highlights)',
        swatch:
          '<svg width="18" height="14" viewBox="-9 -7 18 14"><rect x="-8" y="-6" width="16" ' +
          'height="12" rx="3" fill="none" stroke="var(--color-neutral-400)" stroke-width="1.5" ' +
          'stroke-dasharray="3 3"/></svg>',
      },
    ],
  },
  {
    title: 'Links',
    rows: [
      { key: 'link-validated', label: 'validated link', swatch: stroke('stroke-width="2.4"') },
      {
        key: 'link-extracted',
        label: 'extracted link — weak evidence',
        color: COLORS.extracted,
        swatch: stroke('stroke-width="1.6" stroke-dasharray="4 4"'),
      },
      {
        key: 'link-crowded',
        label: 'more links than can be fanned',
        swatch:
          '<svg width="24" height="14" viewBox="-12 -7 24 14"><rect x="-11" y="-6" width="22" ' +
          'height="12" rx="6" fill="none" stroke="var(--color-neutral-400)" stroke-width="1.5"/>' +
          '<text x="0" y="1" text-anchor="middle" dominant-baseline="central" font-size="8" ' +
          'font-family="monospace" fill="var(--color-neutral-400)">&#215;N</text></svg>',
      },
    ],
  },
  {
    title: 'Lines',
    rows: [
      { key: 'sequence', label: "one object's own history", swatch: stroke('stroke-width="2"') },
      {
        key: 'comments',
        label: 'comment traffic',
        swatch: stroke('stroke-width="2" stroke-dasharray="1 4" stroke-linecap="round"'),
      },
      {
        key: 'actor-trail',
        label: 'selected actor',
        swatch: stroke('stroke-width="2" stroke-dasharray="4 6"'),
      },
    ],
  },
];

/** Every legend key, deduplicated — `comments` explains both a glyph and a connector. */
export const LEGEND_KEYS = [
  ...new Set(LEGEND_SECTIONS.flatMap((s) => s.rows.map((r) => r.key).filter(Boolean))),
];

/**
 * Which legend keys are present in what is currently drawn.
 *
 * Read off the picture rather than re-derived from the model, deliberately: deriving it
 * would mean a second copy of "which marks get drawn", and a second copy is what
 * decision 82 exists to prevent. The elements are the only account of what was drawn.
 */
export function legendKeysPresentIn(element) {
  const present = new Set();
  if (!element) return present;
  for (const mark of element.querySelectorAll('[data-legend]')) {
    present.add(mark.getAttribute('data-legend'));
  }
  return present;
}

/**
 * The legend, annotated with what is on screen.
 *
 * ⚠️ **Absent rows are dimmed, never removed.** A row that vanishes cannot say whether
 * the mark is missing because the data has none or because you switched something off,
 * and the reader cannot tell those apart from the panel alone — the hidden-dependency
 * failure decision 27 exists to prevent, in the one place whose whole job is explaining
 * the picture. Dimming also keeps the vocabulary in a stable position instead of
 * reshuffling on every toggle.
 *
 * `present = null` means "not known yet" — before the first draw — and everything reads
 * as active, which is the honest default for "we have not looked".
 */
export function legendPresence(present = null) {
  return LEGEND_SECTIONS.map((section) => {
    const rows = section.rows.map((row) => ({
      ...row,
      present: !present || !row.key || present.has(row.key),
    }));
    return { ...section, rows, present: rows.some((row) => row.present) };
  });
}

export function renderLegend(container, present = null) {
  container.innerHTML = '';

  for (const section of legendPresence(present)) {
    const heading = document.createElement('div');
    heading.className = 'mono';
    heading.style.cssText =
      'font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;' +
      'color:var(--color-neutral-600);padding:8px 8px 2px;' +
      `opacity:${section.present ? 1 : 0.35}`;
    heading.textContent = section.title;
    container.appendChild(heading);

    for (const row of section.rows) {
      const element = document.createElement('div');
      element.style.cssText =
        'display:flex;align-items:center;gap:8px;font-size:11px;color:var(--color-neutral-400);' +
        'padding:5px 8px;border-radius:var(--radius-sm);cursor:default;' +
        `transition:background .15s ease,opacity .15s ease;opacity:${row.present ? 1 : 0.32}`;
      element.innerHTML =
        `<span style="flex:0 0 26px;display:flex;justify-content:center">${row.swatch}</span>` +
        `<span class="mono" style="min-width:0">${row.label}</span>`;
      // Say why it is dim. "Not drawn" and "switched off" look identical otherwise, and
      // the panel is the one place a reader goes to resolve that.
      if (!row.present) element.title = 'not in the current view';

      // Hover-highlight only where there is something to highlight; a row that lit
      // nothing would read as the highlight being broken.
      if (row.key && row.present) {
        const color = row.color || 'var(--color-neutral-300)';
        element.addEventListener('mouseenter', () => {
          element.style.background = 'color-mix(in srgb, var(--color-text) 6%, transparent)';
          highlightLegendGroup(row.key, true, color);
        });
        element.addEventListener('mouseleave', () => {
          element.style.background = '';
          highlightLegendGroup(row.key, false, color);
        });
      }
      container.appendChild(element);
    }
  }
}
