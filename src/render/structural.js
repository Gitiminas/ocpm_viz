/**
 * Drawing the **off** (structural) mode.
 *
 * The timeline's renderers assume a time axis and lanes — `render/links.js` slides an
 * endpoint along a lifecycle bar, `render/axis.js` draws ticks, `render/nodes.js` packs
 * marks into rows. None of that exists here, so this is a second, small renderer rather
 * than a pile of `if (mode === 'off')` inside the first. It draws exactly two things:
 * edges, then nodes.
 *
 * **What is held constant, deliberately** — the point of the mode is that only *position*
 * changes:
 *
 *   type      shape (circle / diamond / square) and size, exactly as `TYPE` defines them
 *   evidence  solid vs dashed, from `evidenceStyle` — untouched from every other mode
 *   identity  the object's own shade (`objectShade`) as the node's stroke
 *   time      the fill ramp, the arrowheads, and the hovercard's first row
 *
 * **What changes**: fill stops meaning "which object" and starts meaning "when". The
 * object's shade moves to the stroke rather than being dropped, so nothing a reader
 * learned from the timeline or the statistics page becomes false here.
 */

import { TYPE, drawSymbol, typeColor, timeRampFill, evidenceStyle, COLORS } from './theme.js';
import { objectOpacity } from '../model/graph.js';
import { timeFraction } from '../layout/structural.js';
import { formatInstant, escapeHtml } from './format.js';
import { activityLabel } from '../model/activities.js';
import { legendKeyFor } from './nodes.js';

/** Gap between a node's edge and where an arrowhead stops. */
const ARROW_GAP = 4;
const ARROW_SIZE = 7;

/**
 * Draw the edges.
 *
 * ⚠️ **Edges are neutral here, where the timeline colours them by what they reach
 * (decision 24).** That decision exists because a link crossing a full-width chart
 * converges with a dozen others in the destination lane, and colour was the only thing
 * left that could say *which* pull request it arrived at. In this mode an edge is short
 * and lands on a visibly distinct node, so the problem it solves does not arise — and
 * colour is now carrying time, so a coloured edge would compete with the one channel the
 * mode depends on. The evidence cue is untouched, because that is a statement about how
 * much the link is worth and it holds in every mode.
 */
export function renderStructuralEdges({
  gLink,
  edges,
  nodesById,
  focus,
  tooltip,
  direction,
  dimmed = () => false,
}) {
  for (const edge of edges) {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source || !target) continue;

    const style = evidenceStyle(edge.evidence);
    // Focus dims by object, and an edge is only as bright as its dimmer end: an edge
    // half in the focus set and half out is not "in" it.
    const opacity =
      Math.min(
        objectOpacity(source.objectId, focus),
        objectOpacity(target.objectId, focus),
      ) * style.opacity;

    const [from, to] = trim(source, target);
    const heading = direction(edge);
    // ⚠️ Hoisted rather than written inline in the `.attr()` call. `tests/legend.test.js`
    // reads every string literal on a line mentioning `data-legend`, so an inline
    // `edge.evidence === 'validated' ? …` makes it report a mark called `validated` that
    // nothing draws. Both keys are registered from `render/links.js`, which is the point:
    // the evidence cue is identical in every mode and shares one legend row.
    const legendKey = edge.evidence === 'validated' ? 'link-validated' : 'link-extracted';

    const line = gLink
      .append('line')
      .attr('data-legend', legendKey)
      .attr('x1', from.x)
      .attr('y1', from.y)
      .attr('x2', to.x)
      .attr('y2', to.y)
      .attr('stroke', edge.evidence === 'validated' ? 'var(--color-neutral-500)' : COLORS.extracted)
      .attr('stroke-width', style.width)
      .attr('stroke-dasharray', style.dash)
      .attr('opacity', dimmed(edge) ? opacity * 0.15 : opacity);

    if (heading !== 0) {
      drawArrowhead(gLink, heading === 1 ? from : to, heading === 1 ? to : from, {
        color: edge.evidence === 'validated' ? 'var(--color-neutral-500)' : COLORS.extracted,
        opacity: dimmed(edge) ? opacity * 0.15 : opacity,
      });
    }

    if (tooltip) {
      line.style('cursor', 'help');
      line
        .on('mouseenter', (event) => tooltip.show(event, edgeCard(edge, source, target, heading)))
        .on('mousemove', (event) => tooltip.move(event))
        .on('mouseleave', () => tooltip.hide());
    }
  }
}

/** Pull both ends back to the node's rim, so a line never runs under a glyph. */
function trim(source, target) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const sourceGap = (source.radius ?? 8) + 2;
  const targetGap = (target.radius ?? 8) + 2 + ARROW_GAP;
  return [
    { x: source.x + ux * sourceGap, y: source.y + uy * sourceGap },
    { x: target.x - ux * targetGap, y: target.y - uy * targetGap },
  ];
}

/**
 * A small filled triangle at the later end.
 *
 * Drawn as a path rather than an SVG `marker`, because a marker inherits the line's dash
 * pattern handling inconsistently across renderers and — more to the point — this one has
 * to sit at the *temporally* later end, which is not always the line's `x2`.
 */
function drawArrowhead(group, from, to, { color, opacity }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  // Perpendicular, for the two base corners.
  const px = -uy;
  const py = ux;

  const tipX = to.x;
  const tipY = to.y;
  const baseX = to.x - ux * ARROW_SIZE;
  const baseY = to.y - uy * ARROW_SIZE;
  const half = ARROW_SIZE * 0.42;

  group
    .append('path')
    .attr('data-legend', 'precedence-arrow')
    .attr(
      'd',
      `M${tipX},${tipY} L${baseX + px * half},${baseY + py * half} ` +
        `L${baseX - px * half},${baseY - py * half} Z`,
    )
    .attr('fill', color)
    .attr('opacity', opacity);
}

function edgeCard(edge, source, target, heading) {
  const rows = [
    ['Qualifier', escapeHtml(edge.qualifier || '—'), 'mono'],
    ['Evidence', edge.evidence],
    ['Method', escapeHtml(edge.link?.method || '—'), 'mono'],
  ];
  if (edge.link?.n_methods > 1) {
    rows.push(['Agreed by', `${edge.link.n_methods} methods`]);
  }
  if (heading !== 0) {
    const [earlier, later] = heading === 1 ? [source, target] : [target, source];
    rows.push(['Order', `${escapeHtml(earlier.title)} → ${escapeHtml(later.title)}`]);
  }
  return {
    accent: edge.evidence === 'validated' ? 'var(--color-neutral-500)' : COLORS.extracted,
    kicker: 'Link',
    title: `${escapeHtml(source.title)} ↔ ${escapeHtml(target.title)}`,
    rows,
    note:
      edge.evidence === 'validated'
        ? "The platform's own data asserts this link."
        : 'Parsed from a convention nobody enforces — the arrow shows which came first, ' +
          'not which caused which.',
  };
}

/**
 * Draw the nodes.
 *
 * One mark per object. Fill is the time ramp, stroke is the object's own shade, shape and
 * size are the type — the three channels doing three separate jobs.
 */
export function renderStructuralNodes({
  gNode,
  nodes,
  extent,
  focus,
  tooltip,
  handlers,
  objectColors = new Map(),
  actorLogin = (id) => id,
}) {
  for (const node of nodes) {
    const shade = objectColors.get(node.objectId) || typeColor(node.lane);
    const fill = timeRampFill(node.lane, timeFraction(node.t, extent));
    const opacity = objectOpacity(node.objectId, focus);

    const group = gNode
      .append('g')
      // The same key the timeline tags its glyphs with, so hovering "Issue" in the
      // legend lights the issues here exactly as it does there.
      .attr('data-legend', legendKeyFor(node))
      .attr('transform', `translate(${node.x},${node.y})`)
      .attr('opacity', opacity)
      .style('cursor', 'pointer');

    if (node.landmark) {
      group
        .append('circle')
        .attr('data-legend', 'landmark')
        .attr('r', node.radius + 6)
        .attr('fill', 'none')
        .attr('stroke', shade)
        .attr('stroke-width', 1.5)
        .attr('stroke-opacity', 0.7);
    }
    if (node.unmergedClose) {
      group
        .append('circle')
        .attr('data-legend', 'closed-unmerged')
        .attr('r', node.radius + 6)
        .attr('fill', 'none')
        .attr('stroke', 'var(--color-neutral-500)')
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '3 3')
        .attr('stroke-opacity', 0.9);
    }

    // Shape from the type, size from the type, fill from time, stroke from the object.
    // The stroke is what keeps decision 24's promise: the shade still says *which*.
    drawSymbol(
      group.append('g'),
      TYPE[node.lane].shape,
      node.radius,
      fill,
      shade,
      node.isBurst ? 2.5 : 2,
    ).attr('data-legend', 'time-ramp');

    // A collapsed push says how many it stands for, inside the mark, exactly as the
    // timeline's burst does. The count is the member count, never metadata.
    if (node.isBurst) {
      group
        .append('text')
        .attr('data-legend', 'burst')
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .attr('font-size', Math.min(11, node.radius))
        .attr('font-family', 'JetBrains Mono, monospace')
        .attr('fill', 'var(--color-bg)')
        .attr('pointer-events', 'none')
        .text(node.burst.size);
    }

    group.on('click', (event) => {
      event.stopPropagation();
      handlers?.onNodeClick?.(event, node);
    });

    if (tooltip) {
      group
        .on('mouseenter', (event) => tooltip.show(event, nodeCard(node, extent, actorLogin)))
        .on('mousemove', (event) => tooltip.move(event))
        .on('mouseleave', () => tooltip.hide());
    }
  }

  /*
   * Labels last, in a pass of their own.
   *
   * ⚠️ Drawn inside each node's group they were covered by whatever was drawn after them —
   * on F10 a pull request's name disappeared under the 40-commit push beside it, which is
   * the one label in that cluster a reader actually needs. SVG has no z-index; paint order
   * is the only ordering there is, so "on top" means "in a later pass".
   *
   * Issues and pull requests are labelled; commits are not, because a dense sub-log has
   * dozens and the labels would BE the picture. A commit names itself on hover.
   */
  for (const node of nodes) {
    if (node.lane === 'commit') continue;
    gNode
      .append('text')
      .attr('x', node.x)
      .attr('y', node.y + node.radius + 15)
      .attr('text-anchor', 'middle')
      .attr('font-size', 11)
      .attr('font-family', 'JetBrains Mono, monospace')
      .attr('fill', 'var(--color-neutral-300)')
      .attr('opacity', objectOpacity(node.objectId, focus))
      .attr('pointer-events', 'none')
      // A dark halo, so a label crossing an edge or a node stays readable without a box.
      .attr('paint-order', 'stroke')
      .attr('stroke', 'var(--color-bg)')
      .attr('stroke-width', 3.5)
      .attr('stroke-linejoin', 'round')
      .text(node.title);
  }
}

/**
 * The hovercard for a structural node.
 *
 * ⚠️ **The kicker says `entire lifecycle`, not `event`**, and that wording is load-bearing.
 * One mark here stands for an object's whole history, where the same object in the
 * timeline is one mark per event — so a reader who assumed the marks correspond would be
 * wrong about what they are counting. The pull request has not become an object; it
 * always was one. What changed is how much of it a single mark stands for.
 *
 * The first row is the real timestamp, exactly as in every other mode: time is demoted,
 * and the one place it is never approximate is here.
 */
export function nodeCard(node, extent, actorLogin = (id) => id) {
  if (node.isBurst) {
    return {
      accent: typeColor('commit'),
      shape: 'square',
      kicker: 'Commit · bulk push',
      title: `${node.burst.size} commits in one push`,
      rows: [
        ['Time', formatInstant(node.t), 'time'],
        ['Push', escapeHtml(String(node.burst.pushId ?? '—')), 'mono'],
      ],
      note: 'Click to expand this push into its commits. Folding is by push id and nothing else.',
    };
  }

  const type = TYPE[node.lane];
  const rows = [['Time', formatInstant(node.t), 'time']];

  // The lifecycle the mark collapsed, listed in order. This is the half of "one node per
  // object" that keeps the mode honest: the events are not gone, they are here.
  for (const entry of node.lifecycle) {
    rows.push([activityLabel(entry.activity), formatInstant(entry.time), 'time']);
  }
  if (node.commentCount) {
    rows.push(['Comments', String(node.commentCount)]);
  }
  if (node.actorIds.length) {
    rows.push([
      node.actorIds.length === 1 ? 'Actor' : 'Actors',
      node.actorIds
        .slice(0, 3)
        .map((id) => `@${escapeHtml(actorLogin(id))}`)
        .join(', ') + (node.actorIds.length > 3 ? ` +${node.actorIds.length - 3}` : ''),
    ]);
  }

  return {
    accent: type.color,
    shape: type.shape,
    kicker: `${type.label} · entire lifecycle`,
    title: escapeHtml(node.title),
    rows,
    note:
      'One mark, the whole object. In the time-based modes this object is drawn once per ' +
      'event; here its lifecycle is collapsed and listed above.',
  };
}
