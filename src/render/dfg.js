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
 * metrics-follow-the-toggles rule — which the Process page's help texts and card say.
 * Cross-type successions ride on the admitted links and are floors; their hovercard
 * says so. What the page's own filter hid is the hidden-state banner's business, as on
 * the Trace page (main.js).
 */

/* global d3 */

import { TYPE, typeColor, drawSymbol } from './theme.js';
import { activityLabel, activityShortLabel } from '../model/activities.js';
import { DIM_OPACITY } from '../model/graph.js';
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

export function createDfgView({ container, tooltip, handlers = {} }) {

  const svg = d3
    .select(container)
    .append('svg')
    .attr('id', 'dfgChart')
    .style('display', 'block');

  // A click on empty canvas clears the focus, the timeline's own gesture.
  svg.on('click', (event) => {
    if (event.target === svg.node()) handlers.onBackgroundClick?.();
  });

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
  }

  /**
   * Draw one laid-out DFG. The layout already carries exactly what the page's filter
   * kept (`filterDfg` runs before `layoutDfg`); `counts` is that filter's arithmetic,
   * which the page's hidden-state banner reports so nothing disappears quietly.
   *
   * `focus` is an activity key (`type/activity`) or null: everything not touching it
   * dims to the standard focus opacity. Highlight only — the geometry this function
   * receives is identical with and without a focus, by construction.
   *
   * @param {object} dfg      the loaded payload (for meta: repo, sample note, dates)
   * @param {object} layout   from `layoutDfg`, post-filter
   * @param {{counts?: object, focus?: string|null}} options
   */
  function render(dfg, layout, { focus = null } = {}) {
    svg.selectAll('*').remove();
    svg.attr('width', layout.width).attr('height', layout.height);

    // What the filter hid is the hidden-state banner's business (main.js), as on the
    // Trace page; nothing is printed above the picture.
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
      ...layout.edges.map((edge) => ({ edge, cross: false })),
      ...layout.crossEdges.map((edge) => ({ edge, cross: true })),
    ];
    const hoverTargets = [];

    // The focus reading: an edge is bright only when it TOUCHES the focused activity,
    // and a node only when it is the focus or shares such an edge.
    const endpoints = (edge, cross) =>
      cross
        ? [`${edge.from_type}/${edge.from_activity}`, `${edge.to_type}/${edge.to_activity}`]
        : [`${edge.object_type}/${edge.from_activity}`, `${edge.object_type}/${edge.to_activity}`];
    const neighbours = new Set(focus ? [focus] : []);
    if (focus) {
      for (const { edge, cross } of edgeSets) {
        const [a, b] = endpoints(edge, cross);
        if (a === focus) neighbours.add(b);
        if (b === focus) neighbours.add(a);
      }
    }
    const edgeDim = (edge, cross) =>
      focus && !endpoints(edge, cross).includes(focus) ? DIM_OPACITY : 1;
    const nodeDim = (key) => (focus && !neighbours.has(key) ? DIM_OPACITY : 1);

    for (const { edge, cross } of edgeSets) {
      const dim = edgeDim(edge, cross);
      // A cross edge wears the colour of the lane it LEAVES — the timeline's
      // coloured-by-endpoint language — while the dash stays its derived-through-links
      // cue. A per-type edge and a cross edge can share a colour; they never share a
      // dash.
      const color = typeColor(cross ? edge.from_type : edge.object_type);
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
        .attr('opacity', (cross ? 0.7 : 0.8) * dim);
      if (head) head.attr('opacity', (cross ? 0.7 : 0.9) * dim);

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
        .attr('opacity', dim)
        // The strip label the edge's hover target carries, so a number and its arrow
        // say the same thing wherever the pointer lands.
        .attr('data-tip', cross ? 'legend.dfg-cross-succession' : 'legend.dfg-succession')
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
        // The hover target is what the pointer actually rests on, so the help strip's
        // label goes here — the relationships-mode lesson. The legend key doubles as
        // the tip key; `data-tip` rather than `data-legend`, because the legend
        // hover-highlight mutates every data-legend element and this is not a mark.
        .attr('data-tip', cross ? 'legend.dfg-cross-succession' : 'legend.dfg-succession')
        .style('cursor', 'pointer');
      tooltip.bind(hover, () => successionCard(edge, cross));
    }

    for (const node of layout.nodes) {
      const key = `${node.object_type}/${node.activity}`;
      const dim = nodeDim(key);
      const group = gNode
        .append('g')
        .attr('transform', `translate(${node.x},${node.y})`)
        .attr('data-legend', 'dfg-activity')
        .attr('opacity', dim)
        .style('cursor', 'pointer')
        .on('click', () => handlers.onNodeClick?.(key));
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
        .attr('opacity', dim)
        .text(activityShortLabel(node.activity));
      gLabel
        .append('text')
        .attr('x', node.x)
        .attr('y', node.y + node.radius + 25)
        .attr('text-anchor', 'middle')
        .attr('font-size', 9)
        .attr('class', 'mono')
        .attr('fill', 'var(--color-neutral-400)')
        .attr('opacity', dim)
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
        // A push touches every commit it carried: one event, several occurrences. The
        // row appears only where the two differ, so the other lanes stay as they were.
        ...(node.occurrences !== node.events
          ? [['Event–object occurrences', node.occurrences.toLocaleString('en-US')]]
          : []),
        ['Objects', node.objects.toLocaleString('en-US')],
        ['Sequence starts', node.starts.toLocaleString('en-US')],
        ['Sequence ends', node.ends.toLocaleString('en-US')],
      ],
      note: '',
    };
  }

  function successionCard(edge, cross) {
    const from = cross ? `${TYPE[edge.from_type].label} ${activityShortLabel(edge.from_activity)}` : activityShortLabel(edge.from_activity);
    const to = cross ? `${TYPE[edge.to_type].label} ${activityShortLabel(edge.to_activity)}` : activityShortLabel(edge.to_activity);
    return {
      accent: typeColor(cross ? edge.from_type : edge.object_type),
      shape: cross ? 'line' : TYPE[edge.object_type].shape,
      kicker: cross ? 'Succession · across a link' : `${TYPE[edge.object_type].label} · succession`,
      title: `${escapeHtml(from)} → ${escapeHtml(to)}`,
      rows: [
        ['Successions', edge.successions.toLocaleString('en-US')],
        cross
          ? ['Linked pairs', edge.pairs.toLocaleString('en-US')]
          : ['Objects', edge.objects.toLocaleString('en-US')],
        /*
         * The link-class breakdown behind the aggregate. Members arrive filter-first,
         * so a class toggled off in the sidebar is simply absent here — the card and
         * the sidebar can never disagree about what is counted. One class renders as
         * plain rows; several as a boxed group, the commit-observations treatment.
         */
        ...(cross && edge.members?.length === 1
          ? [
              ['Qualifier', escapeHtml(edge.members[0].link_qualifier)],
              ['Link evidence', escapeHtml(edge.members[0].link_evidence)],
              ['Method', escapeHtml(edge.members[0].link_method), 'mono'],
            ]
          : []),
        ...(cross && edge.members?.length > 1
          ? [
              {
                label: 'By link class',
                value: `${edge.members.length} classes`,
                items: edge.members.map((member) => ({
                  primary:
                    `${escapeHtml(member.link_qualifier)} · ` +
                    member.successions.toLocaleString('en-US'),
                  secondary: `${escapeHtml(member.link_evidence)} · via ${escapeHtml(member.link_method)}`,
                })),
              },
            ]
          : []),
      ],
      note: '',
    };
  }

  return { render, measure, clear };
}
