/**
 * Object-to-object links: the traceability edges.
 *
 * Evidence is encoded in the stroke — solid for validated, dashed with a "?" badge
 * for extracted. That is the visual answer to shortcoming S8 and the reason most of
 * this sub-log now reads as uncertain: reclassifying branch-ref matches moved 29 of
 * 34 links from solid to dashed (decision 7). That is the honest result.
 *
 * Collapsed bursts complicate this. Twenty commits folded into one node would draw
 * twenty near-identical edges to the same PR, so links from folded commits are
 * aggregated onto their burst and drawn once.
 */

import { escapeHtml } from './format.js';
import { qualifierColor, typeColor, evidenceStyle, COLORS } from './theme.js';
import { linkPairKey } from '../state/state.js';

const EXTRACTED_NOTE =
  'Parsed from an unenforced convention — a branch-ref or commit-message match, ' +
  'not something the platform asserts. Weak evidence.';

function evidenceBadge(evidence) {
  const color = evidence === 'validated' ? 'var(--color-accent-300)' : COLORS.extracted;
  return (
    `<span class="badge" style="background:var(--color-neutral-900);color:${color};` +
    `border-color:transparent">${evidence}</span>`
  );
}

/**
 * Resolve an object id to what is actually on screen: a folded commit renders as
 * its burst, everything else as itself.
 */
function makeAnchorResolver(burstsByCommit, expandedBursts) {
  return (objectId) => {
    const burst = burstsByCommit.get(objectId);
    if (burst && !expandedBursts.has(burst.id)) return { id: burst.id, folded: true, burst };
    return { id: objectId, folded: false };
  };
}

export function renderLinks({
  gLink,
  defs,
  links,
  byId,
  anchors,
  state,
  focus,
  burstsByCommit,
  tooltip,
}) {
  const resolve = makeAnchorResolver(burstsByCommit, state.expandedBursts);
  const drawn = new Set();

  const visible = links.filter((link) => {
    if (link.qualifier === 'actor') return false;
    const source = byId.get(link.source);
    const target = byId.get(link.target);
    if (!source || !target) return false;
    if (!state.tracks[source.type] || !state.tracks[target.type]) return false;
    return state.relPairs[linkPairKey(link, byId)] !== false;
  });

  // Gradients are rebuilt every render because both endpoints move. One per drawn
  // link, keyed by the *anchored* endpoints so folded links share a gradient.
  defs.selectAll('*').remove();

  for (const link of visible) {
    const source = byId.get(link.source);
    const target = byId.get(link.target);
    const sourceAnchor = resolve(link.source);
    const targetAnchor = resolve(link.target);
    const folded = sourceAnchor.folded || targetAnchor.folded;

    // When either end is folded, many links collapse onto the same visible pair.
    // Draw the first and let it represent the rest.
    const key = `${sourceAnchor.id}|${targetAnchor.id}|${link.qualifier}|${link.evidence}`;
    if (folded) {
      if (drawn.has(key)) continue;
      drawn.add(key);
    }

    const sx = anchors.x(sourceAnchor.id, source);
    const sy = anchors.y(sourceAnchor.id, source);
    const ty = anchors.y(targetAnchor.id, target);
    // Slide the target end along the target's lifecycle bar so the edge meets it at
    // the nearest point rather than always at its start.
    const tx = anchors.clampToLifecycle(targetAnchor.id, target, sx);

    const gradientId = `grad_${cssId(sourceAnchor.id)}_${cssId(targetAnchor.id)}_${link.qualifier}`;
    const gradient = defs
      .append('linearGradient')
      .attr('id', gradientId)
      .attr('gradientUnits', 'userSpaceOnUse')
      .attr('x1', sx)
      .attr('y1', sy)
      .attr('x2', tx)
      .attr('y2', ty);
    gradient.append('stop').attr('offset', '0%').attr('stop-color', typeColor(source.type));
    gradient.append('stop').attr('offset', '100%').attr('stop-color', qualifierColor(link.qualifier));

    const isExtracted = link.evidence === 'extracted';
    const style = evidenceStyle(link.evidence);
    const inFocus =
      !focus ||
      (focus.has(link.source) && focus.has(link.target)) ||
      (sourceAnchor.folded && focus.has(sourceAnchor.id)) ||
      (targetAnchor.folded && focus.has(targetAnchor.id));

    const midY = (sy + ty) / 2;
    const path = `M${sx},${sy} C ${sx},${midY} ${tx},${midY} ${tx},${ty}`;

    const group = gLink.append('g').attr('opacity', inFocus ? style.opacity : 0.1);
    group
      .append('path')
      .attr('data-legend', isExtracted ? 'link-extracted' : 'link-validated')
      .attr('data-grad', `url(#${gradientId})`)
      .attr('d', path)
      .attr('fill', 'none')
      .attr('stroke', `url(#${gradientId})`)
      .attr('stroke-width', style.width)
      .attr('stroke-dasharray', style.dash);

    if (isExtracted && inFocus) {
      const color = qualifierColor(link.qualifier);
      group
        .append('circle')
        .attr('cx', tx)
        .attr('cy', midY)
        .attr('r', 8)
        .attr('fill', 'var(--color-bg)')
        .attr('stroke', color)
        .attr('stroke-width', 2);
      group
        .append('text')
        .attr('x', tx)
        .attr('y', midY)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .attr('font-size', 10)
        .attr('font-weight', 700)
        .attr('fill', color)
        .attr('class', 'mono')
        .text('?');
    }

    // A wide transparent path on top, so a 1.6px dashed line is still easy to hit.
    const buildSpec = () => ({
      accent: qualifierColor(link.qualifier),
      shape: 'line',
      kicker: `OCEL link · ${link.qualifier}`,
      title: `${escapeHtml(source.label || source.id)} &rarr; ${escapeHtml(target.label || target.id)}`,
      rows: [
        ['Evidence', evidenceBadge(link.evidence)],
        ['Method', escapeHtml(link.method || '—'), 'mono'],
        link.n_methods > 1 ? ['Methods agreeing', String(link.n_methods)] : null,
      ],
      note: folded
        ? 'Standing in for every folded commit’s link to this object. Expand the push to see them individually.'
        : isExtracted
          ? EXTRACTED_NOTE
          : '',
    });

    tooltip.bind(
      gLink
        .append('path')
        .attr('d', path)
        .attr('fill', 'none')
        .attr('stroke', '#000')
        .attr('stroke-opacity', 0)
        .attr('stroke-width', 16)
        .style('cursor', 'pointer'),
      buildSpec,
    );
  }
}

/** Ids contain characters like `:` and `/` that are not safe in a CSS selector. */
function cssId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}
