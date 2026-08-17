/**
 * The timeline render pass.
 *
 * Order matters and is not arbitrary:
 *
 *   build nodes → filter by toggles → rank → position (x) → pack rows → lane
 *   geometry → position (y) → draw
 *
 * Ranking happens *after* filtering so that hiding comments cannot shift ordinal
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
import { createLayout } from '../layout/engine.js';
import { edgeDirection } from '../layout/structural.js';
import { renderStructuralEdges, renderStructuralNodes } from './structural.js';
import { renderAxis, highlightTickInstants } from './axis.js';
import { renderLinks } from './links.js';
import {
  renderNodes,
  renderLifecycleBars,
  renderSequenceLines,
  renderActorTrails,
  renderBurstHandles,
  renderCommentBurstHandles,
  renderGroupBoxes,
} from './nodes.js';
import { TYPE, drawSymbol, typeColor, objectShade } from './theme.js';
import { isNodeVisible, isObjectVisible, isLinkVisible, actorPreview } from '../state/state.js';

export const MARGIN = { top: 32, right: 120, bottom: 150, left: 180 };
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

  svg.on('click', () => handlers.onBackgroundClick());

  let basePlotWidth = 1100;
  let context = null; // set by setGraph
  let lastNodes = [];
  let pendingTween = null;

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
    const available = elements.scroll.clientHeight - MARGIN.top - MARGIN.bottom;
    return Math.max(420, available) * state.k;
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
      expandedGroups: state.expandedGroups,
      isVisible: (node) => isNodeVisible(node, state, groupsByCommit),
      isLinkVisible: (link) => isLinkVisible(link, index.byId, state, groupsByCommit),
      structuralLayout: state.structuralLayout,
      margin: MARGIN,
      plotWidth: plotWidth(),
      plotHeight: structuralPlotHeight(),
    });

    const { nodes, geometry, anchors, objectRow, scales, rankOrder, rankMax, rankTimes,
      width, height } = layout;
    lastNodes = nodes;

    svg.attr('width', width).attr('height', height);
    for (const layer of Object.values(layers)) layer.selectAll('*').remove();

    const focus = focusSet(adjacency, state.focus, state.focusDegree);

    // ---- the one branch -------------------------------------------------------
    //
    // Off mode has no lanes, no axis, no lifecycle bars and no sequence spines, because
    // every one of those is a statement about a time axis. It draws edges and nodes.
    if (layout.kind === 'structural') {
      const nodesById = new Map(nodes.map((node) => [node.id, node]));
      renderStructuralEdges({
        gLink: layers.link,
        edges: layout.edges,
        nodesById,
        focus,
        tooltip,
        direction: (edge) => edgeDirection(edge, nodesById),
        // Where a row-skipping edge should bend, so it goes around the middle row
        // rather than through it.
        waypoints: layout.waypoints,
      });
      renderStructuralNodes({
        gNode: layers.node,
        nodes,
        focus,
        tooltip,
        handlers,
        objectColors,
        actorLogin: (id) => index.byId.get(id)?.vmap?.login ?? id,
      });
      handlers.onRendered({
        nodes,
        scales: null,
        plotWidth: plotWidth(),
        basePlotWidth,
        kind: 'structural',
      });
      return;
    }

    // ---- draw -----------------------------------------------------------------
    // Which objects actually survived the filters, so the lane caption can say so.
    const visibleObjectIds = new Set();
    for (const node of nodes) {
      if (node.isGroup) node.members.forEach((m) => visibleObjectIds.add(m.objectId));
      else if (node.objectId) visibleObjectIds.add(node.objectId);
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
    renderGroupBoxes({ gBG: layers.bg, nodes });

    renderAxis({
      gAxis: layers.axis,
      mode: state.mode,
      scales,
      zoom: state.k,
      highlightInstants:
        state.mode === 'highlights'
          ? highlightTickInstants({
              index,
              lanes: state.lanes,
              bursts,
              expandedBursts: state.expandedBursts,
              laneTypes,
            })
          : [],
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
    setGraph,
    captureTween,
    syncStickyLabels,
    plotWidth,
    basePlotWidth: () => basePlotWidth,
    lastNodes: () => lastNodes,
  };
}

