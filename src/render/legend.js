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

export function renderLegend(container) {
  container.innerHTML = '';

  const addRow = (html, key, color) => {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;gap:8px;font-size:11px;color:var(--color-neutral-400);' +
      'padding:6px 8px;border-radius:var(--radius-sm);cursor:default;transition:background .15s ease';
    row.innerHTML = html;
    if (key) {
      row.addEventListener('mouseenter', () => {
        row.style.background = 'color-mix(in srgb, var(--color-text) 6%, transparent)';
        highlightLegendGroup(key, true, color);
      });
      row.addEventListener('mouseleave', () => {
        row.style.background = '';
        highlightLegendGroup(key, false, color);
      });
    }
    container.appendChild(row);
  };

  for (const [type, spec] of Object.entries(TYPE)) {
    addRow(
      `${glyph(spec.shape, spec.color)} <span class="mono">${spec.label}</span>`,
      type,
      spec.color,
    );
  }

  addRow(
    '<svg width="24" height="8"><line x1="0" y1="4" x2="24" y2="4" stroke="var(--color-neutral-400)" stroke-width="2.4"/></svg> validated link',
    'link-validated',
    'var(--color-neutral-300)',
  );
  addRow(
    '<svg width="24" height="8"><line x1="0" y1="4" x2="24" y2="4" stroke="var(--color-neutral-400)" stroke-width="1.6" stroke-dasharray="4 4"/></svg> extracted link',
    'link-extracted',
    COLORS.extracted,
  );
  addRow(
    '<svg width="24" height="8"><line x1="0" y1="4" x2="24" y2="4" stroke="var(--color-neutral-400)" stroke-width="2" stroke-dasharray="1 4" stroke-linecap="round"/></svg> comments',
    'comments',
    'var(--color-neutral-300)',
  );
}
