/**
 * The process-map page's renderer: one whole-log directly-follows graph.
 *
 * The same ownership pattern as `render/timeline.js` — one `<svg>` appended once,
 * `measure()` before `render()`, and never while the page is hidden (a hidden page
 * measures 0 wide; ARCHITECTURE trap #8). Everything positional comes from
 * `layout/dfg.js`; this file only draws.
 *
 * The page cannot follow the sidebar toggles — the DFG is computed server-side over
 * data the client never loads, which is the one stated exception to the
 * metrics-follow-the-toggles rule — so a standing notice says so, in the Stats page's
 * filtered-notice style. Cross-type successions ride on the admitted links and are
 * floors; their hovercard and the notice both say that too.
 */

/* global d3 */

import { TYPE, typeColor, drawSymbol, COLORS } from './theme.js';
import { activityLabel, activityShortLabel } from '../model/activities.js';
import { escapeHtml } from './format.js';
import { DFG_LOOP_RADIUS } from '../layout/dfg.js';

const ARROW_SIZE = 7;

/** A small filled triangle at the target end — the structural renderer's arrowhead. */
function arrowPath(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;
  const baseX = to.x - ux * ARROW_SIZE;
  const baseY = to.y - uy * ARROW_SIZE;
  const half = ARROW_SIZE * 0.42;
  return (
    `M${to.x},${to.y} L${baseX + px * half},${baseY + py * half} ` +
    `L${baseX - px * half},${baseY - py * half} Z`
  );
}

/** Trim a curve's ends back to the node rims so lines never run under glyphs. */
function trimmed(points, radius) {
  const [from, mid, to] = points;
  const cut = (a, b, r) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: a.x + (dx / length) * r, y: a.y + (dy / length) * r };
  };
  return [cut(from, mid, radius + 2), mid, cut(to, mid, radius + 2 + ARROW_SIZE)];
}

export function createDfgView({ container, tooltip }) {
  const notice = document.createElement('div');
  notice.className = 'mono';
  notice.style.cssText =
    'font-size:11px;color:var(--color-accent-300);border:1px solid var(--color-accent-700);' +
    'background:color-mix(in srgb, var(--color-accent) 10%, transparent);' +
    'border-radius:var(--radius-sm);padding:7px 10px;line-height:1.5';
  container.appendChild(notice);

  const svg = d3
    .select(container)
    .append('svg')
    .attr('id', 'dfgChart')
    .style('display', 'block');

  let width = 960;

  function measure() {
    // Only meaningful while the page is visible; a hidden page reads 0 and the caller
    // (showPage) is what guarantees visibility before this runs.
    const measured = container.clientWidth;
    if (measured > 0) width = measured;
    return width;
  }

  function clear() {
    svg.selectAll('*').remove();
    notice.textContent = '';
  }

  /**
   * Draw one laid-out DFG.
   *
   * @param {object} dfg      the loaded payload (for meta: repo, sample note, dates)
   * @param {object} layout   from `layoutDfg`
   * @param {{showPerType?: boolean, showCross?: boolean}} toggles
   */
  function render(dfg, layout, { showPerType = true, showCross = true } = {}) {
    svg.selectAll('*').remove();
    svg.attr('width', layout.width).attr('height', layout.height);

    const sample = dfg.meta.source?.sample
      ? ` Drawn from sample ${dfg.meta.source.sample}, a snapshot of ${dfg.meta.repo}.`
      : '';
    notice.textContent =
      `The whole log of ${dfg.meta.repo}, computed server-side — the sidebar toggles do ` +
      `not apply here. Cross-type successions are floors: they ride on the admitted ` +
      `links.${sample}`;

    const gBand = svg.append('g');
    const gLink = svg.append('g');
    // The invisible hover targets, in their own layer above every stroke. Inside the
    // per-edge groups they stacked in draw order, and with dozens of edges through the
    // same corridors the topmost fat band answered for all of them.
    const gHover = svg.append('g');
    const gNode = svg.append('g');
    const gLabel = svg.append('g');

    // Lane bands and labels, the timeline's own chrome: alternating fills, a colour
    // bar, the type's shape beside its name.
    layout.lanes.forEach((lane, i) => {
      gBand
        .append('rect')
        .attr('x', 0)
        .attr('y', lane.y - lane.height / 2)
        .attr('width', layout.width)
        .attr('height', lane.height)
        .attr('fill', i % 2 ? 'var(--color-neutral-900)' : 'none');
      gBand
        .append('rect')
        .attr('x', 0)
        .attr('y', lane.y - lane.height / 2)
        .attr('width', 3)
        .attr('height', lane.height)
        .attr('fill', typeColor(lane.type));
      const label = gBand.append('g').attr('transform', `translate(24,${lane.y - lane.height / 2 + 30})`);
      drawSymbol(label.append('g').attr('transform', 'translate(8,0)'), TYPE[lane.type].shape, 8, typeColor(lane.type), 'none', 0);
      label
        .append('text')
        .attr('x', 22)
        .attr('dominant-baseline', 'central')
        .attr('font-size', 13)
        .attr('font-weight', 600)
        .attr('fill', 'var(--color-text)')
        .text(TYPE[lane.type].label);
    });

    const edgeSets = [
      ...(showPerType ? layout.edges.map((edge) => ({ edge, cross: false })) : []),
      ...(showCross ? layout.crossEdges.map((edge) => ({ edge, cross: true })) : []),
    ];
    const hoverTargets = [];

    for (const { edge, cross } of edgeSets) {
      const color = cross ? COLORS.extracted : typeColor(edge.object_type);
      const group = gLink.append('g');
      group.attr('data-legend', cross ? 'dfg-cross-succession' : 'dfg-succession');

      let path;
      let head;
      if (edge.loop) {
        const [at] = edge.points;
        const r = DFG_LOOP_RADIUS;
        // A circle tangent above the node, drawn as two arcs so it has a free end for
        // the arrowhead to sit on.
        path = group
          .append('path')
          .attr('d', `M${at.x - 6},${at.y - 12} a${r},${r} 0 1 1 12,0`)
          .attr('fill', 'none');
        head = group
          .append('path')
          .attr('d', arrowPath({ x: at.x + 6, y: at.y - 12 - r }, { x: at.x + 6, y: at.y - 12 }))
          .attr('fill', color);
      } else {
        const [from, mid, to] = trimmed(edge.points, 14);
        path = group
          .append('path')
          .attr('d', `M${from.x},${from.y} Q${mid.x},${mid.y} ${to.x},${to.y}`)
          .attr('fill', 'none');
        head = group.append('path').attr('d', arrowPath(mid, to)).attr('fill', color);
      }
      path
        .attr('stroke', color)
        .attr('stroke-width', edge.width)
        .attr('stroke-linecap', 'round')
        .attr('stroke-dasharray', cross ? '6 6' : null)
        .attr('opacity', cross ? 0.7 : 0.8);
      if (head) head.attr('opacity', cross ? 0.7 : 0.9);

      // The count label answers the pointer with the SAME card as its edge, so a number
      // in a crowd can be interrogated without finding its arrow first.
      const label = gLabel
        .append('text')
        .attr('x', edge.labelAt.x)
        .attr('y', edge.labelAt.y)
        .attr('text-anchor', 'middle')
        .attr('font-size', 9)
        .attr('class', 'mono')
        .attr('fill', 'var(--color-neutral-400)')
        .attr('paint-order', 'stroke')
        .attr('stroke', 'var(--color-bg)')
        .attr('stroke-width', 3)
        .style('cursor', 'pointer')
        .text(edge.successions.toLocaleString('en-US'));
      tooltip.bind(label, () => successionCard(edge, cross));

      hoverTargets.push({ d: path.attr('d'), edge, cross });
    }

    /*
     * The fat invisible hover targets, drawn LAST and in successions-descending order,
     * so the thinnest edges' targets sit topmost — a rare edge crossing a busy corridor
     * still answers for itself rather than for whichever heavyweight was drawn after it.
     * Width follows the stroke, so a hairline does not claim a 14px band over its
     * neighbours.
     */
    hoverTargets.sort((a, b) => b.edge.successions - a.edge.successions);
    for (const { d, edge, cross } of hoverTargets) {
      const hover = gHover
        .append('path')
        .attr('d', d)
        .attr('fill', 'none')
        .attr('stroke', '#000')
        .attr('stroke-opacity', 0)
        .attr('stroke-width', Math.max(8, edge.width + 4))
        .style('cursor', 'pointer');
      tooltip.bind(hover, () => successionCard(edge, cross));
    }

    for (const node of layout.nodes) {
      const group = gNode
        .append('g')
        .attr('transform', `translate(${node.x},${node.y})`)
        .attr('data-legend', 'dfg-activity')
        .style('cursor', 'pointer');
      drawSymbol(group, TYPE[node.object_type].shape, node.radius, typeColor(node.object_type), 'var(--color-bg)', 1.5);
      gLabel
        .append('text')
        .attr('x', node.x)
        .attr('y', node.y + node.radius + 12)
        .attr('text-anchor', 'middle')
        .attr('font-size', 11)
        .attr('font-weight', 600)
        .attr('fill', 'var(--color-text)')
        .attr('paint-order', 'stroke')
        .attr('stroke', 'var(--color-bg)')
        .attr('stroke-width', 3)
        .text(activityShortLabel(node.activity));
      gLabel
        .append('text')
        .attr('x', node.x)
        .attr('y', node.y + node.radius + 25)
        .attr('text-anchor', 'middle')
        .attr('font-size', 9)
        .attr('class', 'mono')
        .attr('fill', 'var(--color-neutral-400)')
        .text(`${node.events.toLocaleString('en-US')} ev`);
      tooltip.bind(group, () => activityCard(node));
    }
  }

  function activityCard(node) {
    return {
      accent: typeColor(node.object_type),
      shape: TYPE[node.object_type].shape,
      kicker: `${TYPE[node.object_type].label} · activity`,
      title: escapeHtml(activityLabel(node.activity)),
      rows: [
        ['Events', node.events.toLocaleString('en-US')],
        ['Objects', node.objects.toLocaleString('en-US')],
        ['Sequence starts', node.starts.toLocaleString('en-US')],
        ['Sequence ends', node.ends.toLocaleString('en-US')],
      ],
      note: 'Whole-log figures for this repository, not the loaded sub-log.',
    };
  }

  function successionCard(edge, cross) {
    const from = cross ? `${TYPE[edge.from_type].label} ${activityShortLabel(edge.from_activity)}` : activityShortLabel(edge.from_activity);
    const to = cross ? `${TYPE[edge.to_type].label} ${activityShortLabel(edge.to_activity)}` : activityShortLabel(edge.to_activity);
    return {
      accent: cross ? COLORS.extracted : typeColor(edge.object_type),
      shape: cross ? 'line' : TYPE[edge.object_type].shape,
      kicker: cross ? 'Succession · across a link' : `${TYPE[edge.object_type].label} · succession`,
      title: `${escapeHtml(from)} → ${escapeHtml(to)}`,
      rows: [
        ['Successions', edge.successions.toLocaleString('en-US')],
        cross
          ? ['Linked pairs', edge.pairs.toLocaleString('en-US')]
          : ['Objects', edge.objects.toLocaleString('en-US')],
      ],
      note: cross
        ? 'Counted in the interleaved sequences of linked pairs. A floor, never a point ' +
          'estimate: the admission rules narrow the links this rides on.'
        : 'How often the first activity was directly followed by the second within one ' +
          'object’s own events, across the whole log.',
    };
  }

  return { render, measure, clear };
}
