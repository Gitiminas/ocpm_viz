/**
 * The timeline render pass.
 *
 * Order matters and is not arbitrary:
 *
 *   build nodes → filter by toggles → rank → position (x) → pack rows → lane
 *   geometry → position (y) → draw
 *
 * Ranking happens *after* filtering so that hiding comments cannot shift discrete
 * positions of the nodes that remain, and row packing happens after x is known
 * because collisions are horizontal.
 *
 * Like the mockup, this tears down and rebuilds the whole SVG on every interaction.
 * That is not efficient, but sub-logs are small and correctness comes first; if a
 * real sub-log ever makes it feel slow, report it rather than pre-optimising.
 */

/* global d3 */

import { collectInstants } from '../model/objectGraph.js';
import { deriveBursts, indexBurstsByCommit } from '../model/bursts.js';
import { deriveCommentBursts } from '../model/commentBursts.js';
import { buildAdjacency, focusSet } from '../model/graph.js';
import { deriveCommitGroups } from '../model/commitGroups.js';
import { createLayout, isStructuralMode } from '../layout/engine.js';
import { edgeDirection, brushRange } from '../layout/structural.js';
import {
  renderStructuralEdges,
  renderStructuralNodes,
  renderFoldHandles,
  renderStructuralTrails,
} from './structural.js';
import { enableCanvasPan } from './pan.js';
import { createMotion } from './motion.js';
import { renderAxis } from './axis.js';
import { renderLinks } from './links.js';
import {
  renderNodes,
  renderLifecycleBars,
  renderSequenceLines,
  renderActorTrails,
  markForEvent,
  renderBurstHandles,
  renderCommentBurstHandles,
} from './nodes.js';
import { TYPE, drawSymbol, typeColor, objectShade } from './theme.js';
import { isNodeVisible, isObjectVisible, isLinkVisible, actorPreview, nudgesFor } from '../state/state.js';

/**
 * The timeline's frame: room on the left for lane labels, at the bottom for the time axis
 * and its ticks, on the right for the last label to overhang.
 */
export const MARGIN = { top: 32, right: 120, bottom: 150, left: 180 };
/**
 * The relationships mode's frame. Nothing is drawn in its margins — no lane labels, no axis — so
 * they are a hairline, and the structural layout gets the drawing surface.
 *
 * ⚠️ It used to get the timeline's frame, and that was most of the "cramped" complaint:
 * on a 1500×900 window the timeline margins reserve 300px of width and 182px of height
 * for things relationships mode does not draw, so the layout was fitted into 850×498 of a
 * 1150×680 surface and came out at a third of the width. The layout's own `padding`
 * (see `engine.js`) still keeps labels off the edge; this is only the frame around it.
 */
export const STRUCTURAL_MARGIN = { top: 16, right: 16, bottom: 16, left: 16 };
const MIN_PLOT_WIDTH = 820;

export function createTimeline({ elements, state, laneTypes, tooltip, minimap, handlers }) {
  const svg = d3.select(elements.chart).append('svg');
  const defs = svg.append('defs');
  const layers = {
    bg: svg.append('g'),
    seq: svg.append('g'),
    link: svg.append('g'),
    halo: svg.append('g'),
    // Hover previews draw here, under the glyphs like the pinned trails beside them but
    // in their own layer, so clearing a preview cannot touch what the user has pinned.
    preview: svg.append('g'),
    node: svg.append('g'),
    label: svg.append('g'),
    axis: svg.append('g'),
  };

  // Drag the background to pan, in relationships mode (`render/pan.js`). A pan swallows
  // the click that ends it, so letting go after a drag does not also clear the focus.
  const pan = enableCanvasPan({
    svgEl: svg.node(),
    scrollEl: elements.scroll,
    isActive: () => isStructuralMode(state.mode),
  });
  svg.on('click', () => {
    if (pan.consumedClick()) return;
    handlers.onBackgroundClick();
  });

  let basePlotWidth = 1100;
  let context = null; // set by setGraph
  let lastNodes = [];
  let pendingTween = null;
  /*
   * Movement for the relationships mode. One instance for the session, replayed on every draw —
   * `play` stops whatever was running first, so two loops can never fight over one mark.
   * Nothing here feeds back into the layout: see `render/motion.js`.
   */
  const motion = createMotion();
  /** Where each structural mark was drawn last time, so a re-render slides into place. */
  let lastStructuralAt = new Map();
  /*
   * The previous pass's gesture handlers. A drag runs a live simulation, and a re-render
   * replaces every mark it was driving — so the old one has to be shut down or it goes on
   * writing coordinates into elements that are no longer in the document.
   */
  let lastGestures = null;

  function measure() {
    basePlotWidth = Math.max(
      elements.scroll.clientWidth - MARGIN.left - MARGIN.right,
      MIN_PLOT_WIDTH,
    );
  }

  function plotWidth() {
    return basePlotWidth * state.k;
  }

  /**
   * The box the structural layout is fitted into.
   *
   * The timeline's height falls out of how many rows its lanes needed; a force layout has
   * no such number, so it takes the space that is actually on screen and fills it. Zoom
   * multiplies it exactly as it multiplies the width, so zooming spreads the graph rather
   * than stretching it in one direction only — which is what would happen if the height
   * stayed fixed while `plotWidth` grew.
   */
  function structuralPlotHeight() {
    const available =
      elements.scroll.clientHeight - STRUCTURAL_MARGIN.top - STRUCTURAL_MARGIN.bottom;
    return Math.max(420, available) * state.k;
  }

  /** The structural layout's width — the surface less its own frame, times the zoom. */
  function structuralPlotWidth() {
    const available =
      elements.scroll.clientWidth - STRUCTURAL_MARGIN.left - STRUCTURAL_MARGIN.right;
    return Math.max(MIN_PLOT_WIDTH, available) * state.k;
  }

  /**
   * The box the active engine draws into: its margin and the plot size inside it.
   *
   * This is the renderer's one look at the mode before the layout runs, and it is here
   * because the frame is a property of the drawing surface, not of the arrangement — the
   * engine is told what room it has, it does not measure the page. Everything after
   * `createLayout` reads `layout.kind`, never `state.mode`.
   */
  function frame() {
    if (isStructuralMode(state.mode)) {
      return {
        margin: STRUCTURAL_MARGIN,
        plotWidth: structuralPlotWidth(),
        plotHeight: structuralPlotHeight(),
        zoom: state.k,
      };
    }
    return { margin: MARGIN, plotWidth: plotWidth() };
  }

  /** Swap in a new sub-log. Everything derived from the graph is rebuilt here. */
  function setGraph(graph, index, actorColors) {
    const commits = index.objectsOfType('commit');
    const bursts = deriveBursts(commits);
    const commentBursts = deriveCommentBursts(index, laneTypes, {
      windowDays: state.commentWindowDays,
    });
    context = {
      graph,
      index,
      actorColors,
      bursts,
      burstsByCommit: indexBurstsByCommit(bursts),
      commentBursts,
      adjacency: buildAdjacency(graph.links, bursts),
      instants: collectInstants(graph),
      objectColors: assignObjectColors(index, laneTypes),
      ...deriveCommitGroups(index.objectsOfType('commit'), graph.links, index.byId),
    };
    lastNodes = [];
    pendingTween = null;
    motion.stop();
    lastGestures?.dispose?.();
    lastGestures = null;
    // Positions from one sub-log say nothing about another, so a new graph appears rather
    // than sliding in from wherever the last one happened to leave its marks.
    lastStructuralAt = new Map();
    return context.objectColors;
  }

  /**
   * One colour per object, so a link's colour says which object it reaches.
   *
   * Computed once per sub-log rather than per render: it is keyed on lifecycle
   * order alone, so toggling comments or hiding a lane cannot make an object change
   * colour underneath the reader.
   */
  function assignObjectColors(index, lanes) {
    const colors = new Map();
    for (const laneType of lanes) {
      const ordered = index
        .objectsOfType(laneType)
        .slice()
        .sort((a, b) => {
          const aStart = a.intervals?.[0]?.start ? +a.intervals[0].start : Infinity;
          const bStart = b.intervals?.[0]?.start ? +b.intervals[0].start : Infinity;
          return aStart - bStart || (a.id < b.id ? -1 : 1);
        });
      ordered.forEach((object, i) => colors.set(object.id, objectShade(laneType, i)));
    }
    return colors;
  }

  /**
   * Ring one event's mark, or clear the ring. Drawn into the preview layer, like the
   * actor hover trail, so it cannot outlive a redraw; resolving the event to a mark —
   * through whatever fold carries it — is `markForEvent`.
   */
  function highlightEvent(event, { color } = {}) {
    layers.preview.selectAll('*').remove();
    if (!event) return;
    const node = markForEvent(lastNodes, event);
    if (!node) return;
    layers.preview
      .append('circle')
      .attr('cx', node.x)
      .attr('cy', node.y)
      .attr('r', (node.radius ?? (node.isComment ? 6 : 8)) + 7)
      .attr('fill', 'none')
      // The ACTOR'S colour, when the ring answers "where did this actor act" — the same
      // colour their sidebar dot and trail wear, so ring and trail read as one voice.
      .attr('stroke', color || 'var(--color-accent)')
      .attr('stroke-width', 2.5)
      .attr('opacity', 0.95);
  }

  /** Capture current positions so the next render animates from them. */
  function captureTween() {
    pendingTween = new Map(lastNodes.map((node) => [node.id, { x: node.x, y: node.y }]));
  }

  function render() {
    if (!context) return;
    const { graph, index, bursts, burstsByCommit, commentBursts, adjacency, instants,
      actorColors, objectColors, groupsByCommit } = context;

    const tweenFrom = pendingTween;
    pendingTween = null;

    const visibleLanes = laneTypes.filter((lane) => state.lanes[lane]);

    // ---- layout ---------------------------------------------------------------
    //
    // One call, one engine chosen inside it. Everything below reads the result rather
    // than the mode, which is what keeps "is time on?" out of the render pass.
    const layout = createLayout({
      mode: state.mode,
      graph,
      index,
      laneTypes,
      visibleLanes,
      bursts,
      commentBursts,
      instants,
      expandedBursts: state.expandedBursts,
      expandedCommentBursts: state.expandedCommentBursts,
      isVisible: (node) => isNodeVisible(node, state, groupsByCommit),
      isLinkVisible: (link) => isLinkVisible(link, index.byId, state, groupsByCommit),
      structuralLayout: state.structuralLayout,
      nodeNudges: nudgesFor(state),
      ...frame(),
    });

    const { nodes, geometry, anchors, objectRow, scales, rankOrder, rankMax, rankTimes,
      width, height } = layout;
    lastNodes = nodes;

    svg.attr('width', width).attr('height', height);
    for (const layer of Object.values(layers)) layer.selectAll('*').remove();
    pan.syncCursor();

    const focus = focusSet(adjacency, state.focus, state.focusDegree);

    // ---- the one branch -------------------------------------------------------
    //
    // Relationships mode has no lanes, no axis, no lifecycle bars and no sequence spines, because
    // every one of those is a statement about a time axis. It draws edges and nodes.
    if (layout.kind === 'structural') {
      const nodesById = new Map(nodes.map((node) => [node.id, node]));
      const brush = brushRange(layout.extent, state.timeBrush[0], state.timeBrush[1]);
      const liveEdges = renderStructuralEdges({
        gLink: layers.link,
        edges: layout.edges,
        nodesById,
        focus,
        tooltip,
        direction: (edge) => edgeDirection(edge, nodesById),
        // Where a row-skipping edge should bend, so it goes around the middle row
        // rather than through it.
        waypoints: layout.waypoints,
        brush,
      });
      lastGestures?.dispose?.();
      const liveMarks = renderStructuralNodes({
        gNode: layers.node,
        nodes,
        focus,
        tooltip,
        handlers,
        objectColors,
        actorLogin: (id) => index.byId.get(id)?.vmap?.login ?? id,
        previous: lastStructuralAt,
        onDragged: (nudges) => handlers.onNodeDragged?.(nudges),
        repaint: () => motion.repaint(),
        brush,
        // Dragging settles the neighbourhood only where settling means something: the
        // layered arrangement's rows ARE the object's type, and springs would pull marks
        // off them.
        edges: layout.edges,
        settling: layout.structuralLayout === 'cluster',
        anchorId: layout.anchorId,
        // Stop the idle drift for the duration of a gesture: a deliberate act should not
        // have the picture breathing under it.
        hold: () => motion.hold(),
        release: () => motion.release(),
      });

      // Slide into place, then drift. Remembered *before* the animation runs, so the next
      // render starts from where the layout put things rather than from wherever the
      // drift had wandered to at that instant — otherwise a re-render would inherit a
      // fraction of the wobble and the picture would creep.
      // Pinned actor trails, into the halo layer — ABOVE the links, where a trail under
      // the thick validated lines was nearly invisible — and returned as motion handles
      // so they follow settling, drift and dragging like the edges do.
      const trailHandles = renderStructuralTrails({
        gHalo: layers.halo,
        nodes,
        state,
        actorColors: context.actorColors,
      });

      // Fold handles for the pushes that are open — after the marks, so a handle is
      // never drawn under one; redrawn with everything else on the next render.
      renderFoldHandles({
        gNode: layers.node,
        bursts,
        expandedBursts: state.expandedBursts,
        nodeByObject: layout.nodeByObject,
        tooltip,
        onCollapse: (burst) => handlers.onCollapseBurst(burst),
      });

      lastStructuralAt = new Map(nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
      lastGestures = liveMarks;
      motion.play({ marks: liveMarks, edges: [...liveEdges, ...trailHandles] });
      handlers.onRendered({
        nodes,
        scales: null,
        plotWidth: structuralPlotWidth(),
        basePlotWidth,
        kind: 'structural',
        extent: layout.extent,
      });
      return;
    }

    // ---- draw -----------------------------------------------------------------
    // Which objects actually survived the filters, so the lane caption can say so.
    const visibleObjectIds = new Set();
    for (const node of nodes) {
      if (node.objectId) visibleObjectIds.add(node.objectId);
    }
    for (const burst of bursts) {
      if (!visibleObjectIds.has(burst.id)) continue;
      for (const id of burst.commitIds) visibleObjectIds.add(id);
    }
    // An issue or PR with no events of its own still draws a lifecycle bar, so it
    // counts as visible even though it contributed no node. Commits are excluded:
    // they have no bar, and their group filter is only reflected in their nodes.
    for (const laneType of visibleLanes) {
      if (laneType === 'commit') continue;
      for (const object of index.objectsOfType(laneType)) {
        if (isObjectVisible(object, state)) visibleObjectIds.add(object.id);
      }
    }

    drawLaneChrome({ layers, geometry, visibleLanes, index, width, visibleObjectIds });
    renderLifecycleBars({
      gBG: layers.bg,
      index,
      geometry,
      state,
      anchors,
      focus,
      laneTypes,
      objectRow,
      objectColors,
    });
    renderAxis({
      gAxis: layers.axis,
      mode: state.mode,
      scales,
      zoom: state.k,
      rankOrder,
      rankMax,
      rankTimes,
      plotWidth: plotWidth(),
      marginLeft: MARGIN.left,
      marginTop: MARGIN.top,
      axisY: height - MARGIN.bottom + 24,
    });

    renderSequenceLines({
      gSeq: layers.seq,
      nodes,
      laneTypes: visibleLanes,
      focus,
      objectColors,
    });
    renderLinks({
      gLink: layers.link,
      defs,
      links: graph.links,
      byId: index.byId,
      anchors,
      state,
      focus,
      burstsByCommit,
      tooltip,
      objectColors,
      groupsByCommit,
    });
    renderActorTrails({ gHalo: layers.halo, nodes, state, actorColors });
    renderNodes({
      gNode: layers.node,
      nodes,
      state,
      focus,
      tooltip,
      tweenFrom,
      handlers,
      objectColors,
      actorLogin: (id) => index.byId.get(id)?.vmap?.login ?? id,
    });
    renderCommentBurstHandles({
      gNode: layers.node,
      nodes,
      commentBursts,
      state,
      tooltip,
      handlers,
    });
    renderBurstHandles({
      gNode: layers.node,
      bursts,
      state,
      geometry,
      anchors,
      tooltip,
      handlers,
    });

    handlers.onRendered({ nodes, scales, plotWidth: plotWidth(), basePlotWidth });
    syncStickyLabels();
  }

  /**
   * Draw — or clear — the trail for an actor being hovered.
   *
   * ⚠️ **Deliberately not a re-render.** `render()` tears down and rebuilds the whole
   * SVG, which is fine for a click and wrong for a pointer moving down a list: on a
   * sub-log the size of F10 that is hundreds of nodes rebuilt per row hovered. This
   * reuses the nodes already positioned by the last draw and touches one layer.
   *
   * Which means it is only valid while those positions are: a `render()` clears every
   * layer, this one included, so a preview never survives a redraw into a picture it no
   * longer describes.
   */
  function previewActor(actorId) {
    layers.preview.selectAll('*').remove();
    const preview = context && actorPreview(actorId, state);
    if (!preview) return;
    renderActorTrails({
      gHalo: layers.preview,
      nodes: lastNodes,
      state: preview,
      actorColors: context.actorColors,
    });
  }

  /** Lane backgrounds, separators and the sticky lane labels. */
  function drawLaneChrome({ layers, geometry, visibleLanes, index, width, visibleObjectIds }) {
    visibleLanes.forEach((laneType, i) => {
      const lane = geometry.get(laneType);
      layers.bg
        .append('rect')
        .attr('x', 0)
        .attr('y', lane.top)
        .attr('width', width)
        .attr('height', lane.height)
        .attr('fill', i % 2 ? 'var(--color-neutral-900)' : 'none');
      layers.bg
        .append('line')
        .attr('x1', 0)
        .attr('x2', width)
        .attr('y1', lane.top)
        .attr('y2', lane.top)
        .attr('stroke', 'var(--color-neutral-800)')
        .attr('stroke-width', 1);

      const sticky = layers.label.append('g').attr('class', 'laneSticky');
      sticky
        .append('rect')
        .attr('x', 0)
        .attr('y', lane.top)
        .attr('width', 3)
        .attr('height', lane.height)
        .attr('fill', typeColor(laneType));

      const label = layers.label.append('g').attr('transform', `translate(24,${lane.top + 30})`);
      drawSymbol(
        label.append('g').attr('transform', 'translate(8,0)'),
        TYPE[laneType].shape,
        8,
        typeColor(laneType),
        'none',
        0,
      );
      label
        .append('text')
        .attr('x', 28)
        .attr('dominant-baseline', 'central')
        .attr('font-size', 14)
        .attr('font-weight', 500)
        .attr('fill', 'var(--color-text)')
        .attr('letter-spacing', '0.01em')
        .text(TYPE[laneType].label);

      label
        .append('text')
        .attr('x', 28)
        .attr('y', 20)
        .attr('font-size', 11)
        .attr('fill', 'var(--color-neutral-500)')
        .attr('class', 'mono')
        .text(laneSubtitle(laneType, index, visibleObjectIds));
    });
  }

  /**
   * The lane's subtitle.
   *
   * The mockup printed the single issue's and single PR's labels here. With N
   * objects a label no longer identifies the lane, so it names the one object when
   * there is exactly one and counts them otherwise.
   *
   * When some are filtered out it reads "1 of 2 objects" rather than "2 objects".
   * A count that ignores the filters would contradict what is on screen, and a
   * reader resolving that contradiction by trusting the caption would draw exactly
   * the wrong conclusion about how much the sub-log contains.
   */
  function laneSubtitle(laneType, index, visibleObjectIds) {
    const objects = index.objectsOfType(laneType);
    const visible = objects.filter((object) => visibleObjectIds.has(object.id));

    if (objects.length === 1 && laneType !== 'commit') {
      return visible.length === 1 ? objects[0].label : `${objects[0].label} · hidden`;
    }
    const noun = `object${objects.length === 1 ? '' : 's'}`;
    return visible.length === objects.length
      ? `${objects.length} ${noun}`
      : `${visible.length} of ${objects.length} ${noun}`;
  }

  /** Lane labels live inside the SVG, so they are translated rather than CSS-sticky. */
  function syncStickyLabels() {
    const scrollLeft = elements.scroll.scrollLeft;
    const scrolled = scrollLeft > 2;
    for (const element of elements.chart.querySelectorAll('.laneSticky')) {
      element.setAttribute('transform', `translate(${scrollLeft},0)`);
      const bar = element.querySelector('rect');
      if (bar) {
        bar.setAttribute('width', scrolled ? 1.5 : 3);
        bar.setAttribute('opacity', scrolled ? 0.75 : 1);
      }
    }
  }

  return {
    measure,
    render,
    previewActor,
    highlightEvent,
    setGraph,
    captureTween,
    syncStickyLabels,
    plotWidth,
    basePlotWidth: () => basePlotWidth,
    lastNodes: () => lastNodes,
  };
}

