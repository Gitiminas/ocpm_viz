/**
 * Drawing the **relationships** (structural) mode.
 *
 * The timeline's renderers assume a time axis and lanes — `render/links.js` slides an
 * endpoint along a lifecycle bar, `render/axis.js` draws ticks, `render/nodes.js` packs
 * marks into rows. None of that exists here, so this is a second, small renderer rather
 * than a pile of `if (mode === 'relationships')` inside the first. It draws exactly two things:
 * edges, then nodes.
 *
 * **What is held constant, deliberately** — the point of the mode is that only *position*
 * changes:
 *
 *   type      shape (circle / diamond / square) and size, exactly as `TYPE` defines them
 *   evidence  solid vs dashed, from `evidenceStyle` — untouched from every other mode
 *   identity  the object's own shade (`objectShade`), as fill, exactly as elsewhere
 *   time      the arrowheads, the time brush, and the hovercard's first row
 *
 * **Only position changes.** An earlier version put a light-to-dark ramp on the fill so
 * colour could carry time, as the design brief proposed. It was wrong in practice and was
 * removed: a lone issue came out pale lilac instead of the accent blurple it is in every
 * other mode, pull requests lost their orange, and a reader carrying the colour mapping
 * across from the timeline or the statistics page was simply misled — two views must not
 * disagree over what a colour means. Time is better served by dimming what falls outside
 * a brushed range, which subtracts rather than recolours, and by the arrowheads that were
 * always going to carry precedence.
 */

import { TYPE, drawSymbol, typeColor, evidenceStyle, COLORS } from './theme.js';
import { objectOpacity } from '../model/graph.js';
import { formatInstant, escapeHtml } from './format.js';
import { activityLabel } from '../model/activities.js';
import { describeMethods } from '../model/evidence.js';
import { legendKeyFor, actorPoints, trailCurve } from './nodes.js';
import { bundleEdges, overlapsBrush } from '../layout/structural.js';
import { pushApart } from './motion.js';
import { createDragSimulation } from '../layout/cluster.js';

/** How faint a mark outside the brushed range becomes. Dimmed, never removed. */
const BRUSHED_OUT = 0.13;

/** Gap between a node's edge and where an arrowhead stops. */
const ARROW_GAP = 4;
const ARROW_SIZE = 7;

/**
 * Draw the edges.
 *
 * ⚠️ **Edges are neutral here, where the timeline colours them by what they reach.**
 * That rule exists because a link crossing a full-width chart converges with a dozen
 * others in the destination lane, and colour was the only thing left that could say
 * *which* pull request it arrived at. In this mode an edge is short and lands on a
 * visibly distinct node whose own colour already answers that, so the problem does not
 * arise here and a coloured edge would only add a third hue to a picture that already
 * has one per object. The evidence cue is untouched, because that is a statement about
 * how much the link is worth and it holds in every mode.
 */
export function renderStructuralEdges({
  gLink,
  edges,
  nodesById,
  focus,
  tooltip,
  direction,
  waypoints = new Map(),
  brush = null,
}) {
  // What movement needs in order to keep an edge attached to its ends: which two marks it
  // joins, and how to redraw it once they have moved.
  const live = [];

  for (const bundle of bundleEdges(edges)) {
    const first = bundle.edges[0];
    const source = nodesById.get(first.source);
    const target = nodesById.get(first.target);
    if (!source || !target) continue;

    /*
     * ⚠️ **One line per EVIDENCE CLASS, not one per link.**
     *
     * Both ends of every link in a bundle sit at the same two points, so N links draw N
     * exactly superimposed lines and the reader sees one. Measured on kubernetes #47532:
     * 77 links over 43 pairs, one pair carrying six — and two bundles mixing the classes,
     * which means a dashed *extracted* link was sitting invisibly underneath a solid
     * *validated* one. That is the buried link again, in a mode with no fan to separate
     * them, and it hides exactly the uncertainty cue (S8) this tool exists to show.
     * Splitting by class and offsetting the two apart is the smallest thing that cannot
     * hide one under the other; links that agree on their class are genuinely one mark
     * and carry a count instead.
     */
    const byEvidence = new Map();
    for (const edge of bundle.edges) {
      if (!byEvidence.has(edge.evidence)) byEvidence.set(edge.evidence, []);
      byEvidence.get(edge.evidence).push(edge);
    }
    // Validated first, so the offset is stable rather than depending on link order.
    const classes = [...byEvidence.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));

    classes.forEach(([evidence, group], index) => {
      const style = evidenceStyle(evidence);
      // An edge is only as bright as its dimmer end, under focus and under the brush
      // alike: an edge half inside a brushed range is not inside it.
      const brushed =
        overlapsBrush(source, brush) && overlapsBrush(target, brush) ? 1 : BRUSHED_OUT;
      const opacity =
        Math.min(
          objectOpacity(source.objectId, focus, { graded: true }),
          objectOpacity(target.objectId, focus, { graded: true }),
        ) *
        style.opacity *
        brushed;
      const color = evidence === 'validated' ? 'var(--color-neutral-500)' : COLORS.extracted;
      const legendKey = evidence === 'validated' ? 'link-validated' : 'link-extracted';

      // Only offset when there is something to separate from.
      const shift = classes.length > 1 ? (index - (classes.length - 1) / 2) * 5 : 0;
      const route = points(source, target, waypoints.get(bundle.key), shift);
      const heading = direction(group[0]);

      const drawn = gLink
        .append('path')
        .attr('data-legend', legendKey)
        .attr('d', pathThrough(route))
        .attr('fill', 'none')
        .attr('stroke', color)
        .attr('stroke-width', style.width)
        .attr('stroke-dasharray', style.dash)
        .attr('opacity', opacity);

      // Recomputed from the two live centres rather than transformed: an edge *is* its
      // endpoints, and nudging it any other way would let it come adrift from the marks
      // it joins — visibly, and only while something was moving.
      const head =
        heading === 0
          ? null
          : drawArrowhead(
              gLink,
              heading === 1 ? route[route.length - 2] : route[1],
              heading === 1 ? route[route.length - 1] : route[0],
              { color, opacity },
            );

      const via = waypoints.get(bundle.key);
      live.push({
        source: bundle.edges[0].source,
        target: bundle.edges[0].target,
        apply(from, to) {
          const moved = points({ ...source, ...from }, { ...target, ...to }, via, shift);
          drawn.attr('d', pathThrough(moved));
          /*
           * ⚠️ **The head moves with the line.** It is a separate path — it has to be, to
           * sit at the *temporally* later end rather than at whichever end the line was
           * drawn towards — so nothing moves it unless this does. Left out, dragging a
           * mark peeled every arrowhead off its edge and left them floating where the
           * marks used to be.
           */
          if (head) {
            head.attr(
              'd',
              heading === 1
                ? arrowPath(moved[moved.length - 2], moved[moved.length - 1])
                : arrowPath(moved[1], moved[0]),
            );
          }
        },
      });

      /*
       * ⚠️ **The hover target is a separate, invisible, fat path — not the drawn one.**
       *
       * Binding to the visible stroke means a *dashed* edge only answers the pointer on
       * its painted segments, so extracted links were effectively unhoverable while
       * validated ones worked. That is the worst way round: the uncertain links are
       * precisely the ones a reader needs to interrogate, and the failure looks like the
       * feature simply not existing rather than like a bug. `render/links.js` already
       * solved this the same way for the timeline, and `tooltip.bind` brings right-click
       * pinning with it.
       */
      if (tooltip) {
        // The fat path is also what the pointer actually rests on, so the help strip's
        // attributes go here: on the drawn stroke or the arrowhead they would never fire,
        // this path masking both. `data-tip` rather than `data-legend`, because the legend
        // hover-highlight mutates every `data-legend` element and this one is not a mark.
        tooltip.bind(
          gLink
            .append('path')
            .attr('d', pathThrough(route))
            .attr('fill', 'none')
            .attr('stroke', '#000')
            .attr('stroke-opacity', 0)
            .attr('stroke-width', 16)
            .attr(
              'data-tip',
              evidence === 'validated' ? 'rel.arrow.validated' : 'rel.arrow.extracted',
            )
            .style('cursor', 'pointer'),
          () => edgeCard(group, source, target, heading),
        );
      }
    });
  }
  return live;
}

/**
 * The points a bundle's line passes through, trimmed to the node rims.
 *
 * `via` is the waypoint list for an edge that skips a row — an issue linked straight to a
 * commit bends around the pull requests rather than cutting through them. `shift` moves
 * the whole line sideways, perpendicular to its direction, so two evidence classes on one
 * pair stay apart.
 */
function points(source, target, via, shift) {
  const middle = (via || []).map((point) => ({ x: point.x, y: point.y }));
  const [from, to] = trim(source, target, middle[0], middle[middle.length - 1]);
  const all = [from, ...middle, to];

  if (!shift) return all;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  return all.map((point) => ({ x: point.x + (-dy / length) * shift, y: point.y + (dx / length) * shift }));
}

/** A straight line, or a gently rounded polyline when the edge is routed. */
function pathThrough(route) {
  if (route.length === 2) return `M${route[0].x},${route[0].y} L${route[1].x},${route[1].y}`;
  // Quadratic through each waypoint, so a routed edge reads as one bending line rather
  // than as a chain of separate segments meeting at a corner.
  let d = `M${route[0].x},${route[0].y}`;
  for (let i = 1; i < route.length - 1; i++) {
    const next = route[i + 1];
    d += ` Q${route[i].x},${route[i].y} ${(route[i].x + next.x) / 2},${(route[i].y + next.y) / 2}`;
  }
  const last = route[route.length - 1];
  d += ` L${last.x},${last.y}`;
  return d;
}

/** Pull both ends back to the node's rim, so a line never runs under a glyph. */
function trim(source, target, firstVia, lastVia) {
  const dx = (firstVia?.x ?? target.x) - source.x;
  const dy = (firstVia?.y ?? target.y) - source.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const sourceGap = (source.radius ?? 8) + 2;

  // The far end is trimmed along its OWN incoming direction, which is only the same line
  // when the edge is straight. A routed edge arrives from its last waypoint.
  const backX = (lastVia?.x ?? source.x) - target.x;
  const backY = (lastVia?.y ?? source.y) - target.y;
  const backLength = Math.hypot(backX, backY) || 1;
  const targetGap = (target.radius ?? 8) + 2 + ARROW_GAP;

  return [
    { x: source.x + ux * sourceGap, y: source.y + uy * sourceGap },
    {
      x: target.x + (backX / backLength) * targetGap,
      y: target.y + (backY / backLength) * targetGap,
    },
  ];
}

/**
 * A small filled triangle at the later end.
 *
 * Drawn as a path rather than an SVG `marker`, because a marker inherits the line's dash
 * pattern handling inconsistently across renderers and — more to the point — this one has
 * to sit at the *temporally* later end, which is not always the line's `x2`.
 */
function arrowPath(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  // Perpendicular, for the two base corners.
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

function drawArrowhead(group, from, to, { color, opacity }) {
  return group
    .append('path')
    .attr('data-legend', 'precedence-arrow')
    .attr('d', arrowPath(from, to))
    .attr('fill', color)
    .attr('opacity', opacity);
}

function edgeCard(group, source, target, heading) {
  const edge = group[0];
  const rows = [];

  // Every link this mark stands for, so a bundle can never quietly speak for links it
  // does not name. One line each: qualifier and method are what distinguish them.
  if (group.length > 1) {
    rows.push(['Links', `${group.length} of the same evidence class`]);
    for (const member of group) {
      rows.push([
        escapeHtml(member.qualifier || '—'),
        escapeHtml(describeMethods(member.link).join(', ') || '—'),
        'mono',
      ]);
    }
  } else {
    const methods = describeMethods(edge.link);
    rows.push(['Qualifier', escapeHtml(edge.qualifier || '—'), 'mono']);
    rows.push([methods.length > 1 ? 'Methods' : 'Method', escapeHtml(methods.join(', ') || '—'), 'mono']);
  }
  rows.push(['Evidence', edge.evidence]);
  if (heading !== 0) {
    const [earlier, later] = heading === 1 ? [source, target] : [target, source];
    rows.push(['Order', `${escapeHtml(earlier.title)} → ${escapeHtml(later.title)}`]);
  }
  return {
    accent: edge.evidence === 'validated' ? 'var(--color-neutral-500)' : COLORS.extracted,
    kicker: 'Link',
    title: `${escapeHtml(source.title)} ↔ ${escapeHtml(target.title)}`,
    rows,
    note: '',
  };
}

/**
 * Pinned actor trails that FOLLOW the marks.
 *
 * The timeline's `renderActorTrails` draws from positions frozen at render time, which
 * is right there — nothing moves a timeline mark. Here marks settle, drift and get
 * dragged, and a static trail stayed behind, visibly detached from the marks it claimed
 * to join. So the trail is drawn once and then DRIVEN like the edges are: every segment
 * and ring is returned in the motion contract's edge shape — `{source, target,
 * apply(from, to)}`, keyed by mark id, a ring being a segment from a mark to itself —
 * and `motion.paint` re-applies them from the same per-frame positions as everything
 * else. One system moving everything is what keeps a trail glued to a dragged fold.
 *
 * (The hover PREVIEW trail stays static: it lives a pointer-length at a time, and
 * dragging while hovering the actor list takes a second mouse.)
 *
 * @returns {Array} motion edge handles to concatenate with the link edges
 */
export function renderStructuralTrails({ gHalo, nodes, state, actorColors }) {
  const handles = [];
  for (const actorId of state.actors) {
    const color = actorColors.get(actorId);
    const points = actorPoints(nodes, actorId);

    for (let i = 1; i < points.length; i++) {
      const path = gHalo
        .append('path')
        .attr('data-legend', 'actor-trail')
        .attr('d', trailCurve(points[i - 1], points[i]))
        .attr('fill', 'none')
        .attr('stroke', color)
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', '4 6')
        .attr('opacity', 0.8);
      handles.push({
        source: points[i - 1].id,
        target: points[i].id,
        apply: (from, to) => path.attr('d', trailCurve(from, to)),
      });
    }
    for (const point of points) {
      const ring = gHalo
        .append('circle')
        .attr('data-legend', 'actor-trail')
        .attr('cx', point.x)
        .attr('cy', point.y)
        .attr('r', point.ring)
        .attr('fill', 'none')
        .attr('stroke', color)
        .attr('stroke-width', 2.5);
      if (point.mixed) ring.attr('stroke-dasharray', '5 4');
      handles.push({
        source: point.id,
        target: point.id,
        apply: (from) => ring.attr('cx', from.x).attr('cy', from.y),
      });
    }
  }
  return handles;
}

/**
 * The fold handle for every expanded push: a "−" pill above the push's commits.
 *
 * The timeline's handle (`render/nodes.js` `renderBurstHandles`) sits on the time axis at
 * the push's instant, which this mode does not have — its anchors refuse `xOfTime` on
 * purpose. So an expanded push could be unfolded here and never folded back: the only
 * way was to leave the mode. The handle here hangs above the centroid of the push's
 * commit marks instead, with the same tooltip and the same `onCollapseBurst` behind it,
 * so folding works the same way in every mode.
 *
 * ⚠️ Drawn at the LAYOUT positions. The marks themselves settle and drift a few pixels
 * (`render/motion.js`) and can be dragged; the handle stays where the layout put the
 * centroid, which is the right place within a few pixels and is redrawn — like every
 * mark — by the render that follows a drag's end.
 *
 * @param {object} options
 * @param {d3.Selection} options.gNode
 * @param {Array}  options.bursts           every push (`deriveBursts`)
 * @param {Set}    options.expandedBursts   the ones currently unfolded
 * @param {Map}    options.nodeByObject     from the layout — where each commit mark is
 * @param {object} options.tooltip
 * @param {Function} options.onCollapse     `(burst) => void`
 */
export function renderFoldHandles({ gNode, bursts, expandedBursts, nodeByObject, tooltip, onCollapse }) {
  const color = COLORS.commit;
  for (const burst of bursts) {
    if (!expandedBursts.has(burst.id)) continue;
    // `commitIds` is a Set (`model/bursts.js`).
    const members = [...burst.commitIds].map((id) => nodeByObject.get(id)).filter(Boolean);
    if (!members.length) continue;

    const cx = members.reduce((sum, m) => sum + m.x, 0) / members.length;
    const top = Math.min(...members.map((m) => m.y - (m.radius ?? 6)));

    // No `data-legend`: this is a control, not a mark, like the timeline's own handle —
    // it must not light the "bulk push" legend row when no bulk-push node is drawn.
    const handle = gNode
      .append('g')
      .attr('data-tip', 'fold.handle')
      .attr('transform', `translate(${cx},${top - 16})`)
      .style('cursor', 'pointer')
      .on('click', (event) => {
        event.stopPropagation();
        onCollapse(burst);
      });
    if (tooltip) {
      tooltip.bind(handle, () => ({
        accent: 'var(--color-accent)',
        shape: 'square',
        kicker: 'Commit · bulk push',
        title: `Collapse ${burst.size} commits`,
        rows: [['Push', escapeHtml(burst.pushId), 'mono']],
        note: 'Click to fold these commits back into one bulk-push node.',
      }));
    }
    handle
      .append('rect')
      .attr('x', -13)
      .attr('y', -10)
      .attr('width', 26)
      .attr('height', 20)
      .attr('rx', 6)
      .attr('fill', 'var(--color-neutral-900)')
      .attr('stroke', color)
      .attr('stroke-width', 1.8);
    handle
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('font-size', 15)
      .attr('font-weight', 700)
      .attr('fill', color)
      .text('−');
  }
}

/**
 * Draw the nodes.
 *
 * One mark per object, in the object's own colour — the same shade the timeline and the
 * statistics page give it. Shape and size carry the type, as they do everywhere else.
 */
export function renderStructuralNodes({
  gNode,
  nodes,
  focus,
  tooltip,
  handlers,
  objectColors = new Map(),
  actorLogin = (id) => id,
  previous = new Map(),
  onDragged = null,
  repaint = () => {},
  brush = null,
  edges = [],
  settling = false,
  anchorId = null,
  hold = () => {},
  release = () => {},
}) {
  // What movement needs: where each mark belongs, where it was a moment ago, and how to
  // put it somewhere. The label rides along, so a name never parts company with its mark.
  const live = [];
  // Every gesture handler this pass created, so a re-render can shut down a simulation
  // that would otherwise go on driving marks which no longer exist.
  const gestures = [];

  for (const node of nodes) {
    // The object's own shade, exactly as every other mode draws it, and the same map the
    // statistics page uses. Fill means "which object" here as it does there; time is
    // carried by the arrowheads, the brush and the hovercard instead. See the note on
    // `renderStructuralNodes` for what this replaced.
    const shade = objectColors.get(node.objectId) || typeColor(node.lane);
    /*
     * ⚠️ **Dimmed, never removed.** A mark outside the brushed range is still part of the
     * sub-log, and taking it away would leave the reader unable to tell "nothing happened
     * then" from "you narrowed the range" — the same distinction the legend's dimming and
     * the banner protect. Dimming says both at once: the shape of the whole graph stays
     * visible behind what was asked for.
     */
    const opacity =
      objectOpacity(node.objectId, focus, { graded: true }) *
      (overlapsBrush(node, brush) ? 1 : BRUSHED_OUT);

    const group = gNode
      .append('g')
      // The same key the timeline tags its glyphs with, so hovering "Issue" in the
      // legend lights the issues here exactly as it does there.
      .attr('data-legend', legendKeyFor(node))
      .attr('transform', `translate(${node.x},${node.y})`)
      .attr('opacity', opacity)
      .style('cursor', 'pointer');

    if (node.landmark && node.heuristicLandmark) {
      // The off-platform merge's own ring — see `render/nodes.js`.
      group
        .append('circle')
        .attr('data-legend', 'landmark-heuristic')
        .attr('r', node.radius + 6)
        .attr('fill', 'none')
        .attr('stroke', COLORS.extracted)
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '1.5 3')
        .attr('stroke-opacity', 0.9);
    } else if (node.landmark) {
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
    // The stroke keeps the shade's promise: it still says *which* object.
    drawSymbol(
      group.append('g'),
      TYPE[node.lane].shape,
      node.radius,
      shade,
      shade,
      node.isBurst ? 2.5 : 2,
    );

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

    const mark = {
      id: node.id,
      x: node.x,
      y: node.y,
      // The shove needs a size to work with, and an offset is measured from where the
      // layout put the mark rather than from wherever it currently sits.
      radius: node.radius,
      lane: node.lane,
      // The cluster's radius, where the arrangement knows one — see `layoutStructural`.
      footprint: node.footprint,
      layoutX: node.layoutX ?? node.x,
      layoutY: node.layoutY ?? node.y,
      // Where this mark was drawn last time, so it slides rather than jumps. A mark that
      // is new to the picture has no `from` and simply appears where it belongs.
      from: previous.get(node.id),
      apply(point) {
        group.attr('transform', `translate(${point.x},${point.y})`);
      },
    };

    const drag = onDragged
      ? enableDrag(group, mark, node, {
          onDragged,
          repaint,
          marks: live,
          edges,
          settling,
          anchorId,
          hold,
          release,
        })
      : null;
    if (drag) gestures.push(drag);

    group.on('click', (event) => {
      event.stopPropagation();
      // ⚠️ A drag ends in a click, and without this every drag would also toggle focus or
      // expand a push — so moving a mark to see it better would change what is on screen.
      // A few pixels of slop, because a deliberate click is never perfectly still.
      if (drag?.consumedClick()) return;
      handlers?.onNodeClick?.(event, node);
    });

    if (tooltip) tooltip.bind(group, () => nodeCard(node, actorLogin));

    live.push(mark);
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
  const labelled = new Map();
  for (const node of nodes) {
    if (node.lane === 'commit') continue;
    const label = gNode
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
    labelled.set(node.id, { label, offset: node.radius + 15 });
  }

  // A label is not inside its mark's group — it is drawn in a later pass so it cannot be
  // covered — so it has to be moved alongside it, or names would slide off their marks.
  for (const mark of live) {
    const entry = labelled.get(mark.id);
    if (!entry) continue;
    const move = mark.apply;
    mark.apply = (point) => {
      move(point);
      entry.label.attr('x', point.x).attr('y', point.y + entry.offset);
    };
  }

  live.dispose = () => {
    for (const gesture of gestures) gesture.dispose?.();
  };
  return live;
}

/** How far the pointer may travel before a press counts as a drag rather than a click. */
const DRAG_SLOP_PX = 3;
/**
 * Let a mark be dragged.
 *
 * ⚠️ **The drag moves the mark, not the layout.** What it records is an *offset* from
 * where the layout put the node (`node.layoutX`), which `state.nodeNudges` keeps and the
 * engine re-applies on the next render. So both structural layouts stay pure functions of
 * the sub-log — a dragged picture is still the computed picture plus a set of stated
 * displacements, and clearing them returns exactly to the arrangement the algorithm chose.
 *
 * Pointer capture rather than window listeners: the pointer keeps talking to this element
 * even when it leaves it, so a fast drag cannot slip off the mark and strand it mid-move.
 */
function enableDrag(
  group,
  mark,
  node,
  {
    onDragged,
    repaint,
    marks,
    edges,
    settling,
    anchorId = null,
    hold = () => {},
    release = () => {},
  },
) {
  let from = null;
  let travelled = 0;
  let simulation = null;

  group.style('cursor', 'grab');

  /**
   * Start a live simulation over the whole drawing.
   *
   * ⚠️ **Nothing is pinned but the mark under the pointer and the layout's anchor root,
   * and every free mark remembers where it started.** Two earlier versions got this wrong
   * in opposite directions, and both are worth knowing about:
   *
   *   - The first pinned everything more than two hops away, after a measurement showed a
   *     drag flinging an unrelated pull request 210px. That measurement was taken with a
   *     hand-written solver whose charge signs were inverted, so repulsion ran four orders
   *     of magnitude too strong; the pinning outlived the bug and quietly cost the thing
   *     dragging is for. Reported as the re-order being minimal.
   *   - The second freed everything and pinned only the mark in hand. With no centring
   *     force, no range on the repulsion and no anchor, a held gesture let unlinked marks
   *     push each other without limit: on kubernetes #47532 the anchor issue itself
   *     travelled 256px, all 23 unrelated marks moved more than 30px and one 500px, and
   *     on F10 three marks left the box. Reported as the picture losing its orientation
   *     so that nothing could be understood any more.
   *
   * What runs now is in `createDragSimulation`: home springs, a ranged charge, the
   * footprint force, and the anchor held. Re-measured on the same sub-logs: the anchor
   * moves 0px, F10's unrelated marks move at most 56px and none leave the box, and no
   * commit→pull-request link stretches. What still moves a long way is a *whole fan* that
   * the dragged fan is pushed into — it steps aside intact, commits and all, which is the
   * behaviour a graph tool owes a drag.
   */
  function begin() {
    const simNodes = marks.map((other) => {
      const seed = {
        id: other.id,
        lane: other.lane,
        radius: other.radius,
        footprint: other.footprint,
        x: other.x,
        y: other.y,
      };
      // The mark under the pointer is held here; the layout's anchor root is held by the
      // simulation itself (`createDragSimulation`), unless it is the mark in hand.
      // Everything else is free — and remembers where it started, which is what keeps
      // a drag from re-orienting the whole picture.
      if (other.id === mark.id) {
        seed.fx = other.x;
        seed.fy = other.y;
      }
      return seed;
    });
    const byId = new Map(simNodes.map((entry) => [entry.id, entry]));
    const simLinks = edges
      .filter((edge) => byId.has(edge.source) && byId.has(edge.target))
      .map((edge) => ({ source: edge.source, target: edge.target }));

    simulation = createDragSimulation(simNodes, simLinks, { anchorId });
    simulation.on('tick', () => {
      for (const other of marks) {
        const at = byId.get(other.id);
        if (!at || other.id === mark.id) continue;
        other.x = at.x;
        other.y = at.y;
      }
      repaint();
    });
    simulation.on('end', () => {
      // Recorded when the motion stops rather than on release, so what is remembered is
      // where things came to rest — not where they happened to be mid-flight.
      if (travelled > DRAG_SLOP_PX) recordNudges();
    });

    return byId.get(mark.id);
  }

  function recordNudges() {
    onDragged(
      marks
        .filter((other) => other.x !== other.layoutX || other.y !== other.layoutY)
        .map((other) => ({
          id: other.id,
          dx: other.x - other.layoutX,
          dy: other.y - other.layoutY,
        })),
    );
  }

  group.on('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    from = { x: event.clientX, y: event.clientY, markX: mark.x, markY: mark.y };
    travelled = 0;
    hold();
    group.style('cursor', 'grabbing');
    group.node().setPointerCapture?.(event.pointerId);

    if (settling) {
      from.handle = begin();
      // Reheated, so the gesture has momentum from the first pixel rather than starting
      // cold and catching up.
      simulation.alphaTarget(0.3).restart();
    }
  });

  group.on('pointermove', (event) => {
    if (!from) return;
    const dx = event.clientX - from.x;
    const dy = event.clientY - from.y;
    travelled = Math.max(travelled, Math.hypot(dx, dy));
    mark.x = from.markX + dx;
    mark.y = from.markY + dy;

    if (from.handle) {
      // The dragged mark is where the pointer says, exactly. Its neighbours are the
      // simulation's business, and it will move them on its own schedule.
      from.handle.fx = mark.x;
      from.handle.fy = mark.y;
    } else {
      // No simulation here — the layered arrangement's rows ARE the object's type, and
      // springs would pull marks off them, which would say something false. Dragging
      // there only shoves what it collides with.
      pushApart(marks, { fixedId: mark.id });
    }
    repaint();
  });

  const finish = (event) => {
    if (!from) return;
    release();
    group.style('cursor', 'grab');
    group.node().releasePointerCapture?.(event.pointerId);

    if (simulation) {
      // Let it coast to a stop instead of freezing mid-motion. `end` records where things
      // actually settled.
      simulation.alphaTarget(0);
    } else if (travelled > DRAG_SLOP_PX) {
      recordNudges();
    }
    from = null;
  };
  group.on('pointerup', finish);
  group.on('pointercancel', finish);

  return {
    /** Whether the click that follows this gesture belongs to a drag and must be ignored. */
    consumedClick() {
      const wasDrag = travelled > DRAG_SLOP_PX;
      travelled = 0;
      return wasDrag;
    },
    /** Stop any live simulation, so a re-render cannot leave one driving vanished marks. */
    dispose() {
      simulation?.stop();
      simulation = null;
    },
  };
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
 * The first row is a real timestamp, exactly as in every other mode: time is demoted,
 * and the one place it is never approximate is here. It is the first LIFECYCLE row —
 * "Open · Mar 07, 2025 …", "Commit observed · …" — not a separate "Time" row above it:
 * the two always carried the same instant (a node's `t` IS its first lifecycle event),
 * and a reader saw the same timestamp twice with two labels. Reported as redundant. Only
 * a mark with no lifecycle to list (a folded push) keeps a plain "Time" row.
 */
export function nodeCard(node, actorLogin = (id) => id) {
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
  // The lifecycle the mark collapsed, listed in order — the first of them is the real
  // timestamp every mode's hovercard leads with. This is the half of "one node per
  // object" that keeps the mode honest: the events are not gone, they are here.
  const rows = node.lifecycle.map((entry) => [
    activityLabel(entry.activity),
    formatInstant(entry.time),
    'time',
  ]);
  if (!rows.length) rows.push(['Time', formatInstant(node.t), 'time']);
  const vmap = node.object?.vmap || {};
  if (vmap.title) rows.push(['Title', escapeHtml(String(vmap.title))]);
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
  if (vmap.body_excerpt) {
    rows.push({
      excerptText: vmap.body_excerpt,
      truncated: Boolean(vmap.body_truncated),
      heading: 'Description',
    });
  }

  return {
    accent: type.color,
    shape: type.shape,
    kicker: `${type.label} · entire lifecycle`,
    title: escapeHtml(node.title),
    rows,
    note: '',
  };
}
