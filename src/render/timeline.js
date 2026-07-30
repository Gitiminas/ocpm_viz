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
import { buildAdjacency, focusSet } from '../model/graph.js';
import { buildNodes, assignRanks, filterNodes } from '../layout/nodes.js';
import { createScales } from '../layout/scales.js';
import { packRows, ROW_HEIGHT } from '../layout/packing.js';
import { computeLaneGeometry } from '../layout/lanes.js';
import { renderAxis, highlightTickInstants } from './axis.js';
import { renderLinks } from './links.js';
import {
  renderNodes,
  renderLifecycleBars,
  renderSequenceLines,
  renderActorTrails,
  renderBurstHandles,
  renderGroupBoxes,
} from './nodes.js';
import { TYPE, drawSymbol, typeColor } from './theme.js';

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

  /** Swap in a new sub-log. Everything derived from the graph is rebuilt here. */
  function setGraph(graph, index, actorColors) {
    const commits = index.objectsOfType('commit');
    const bursts = deriveBursts(commits, { threshold: state.burstThreshold });
    context = {
      graph,
      index,
      actorColors,
      bursts,
      burstsByCommit: indexBurstsByCommit(bursts),
      adjacency: buildAdjacency(graph.links, bursts),
      instants: collectInstants(graph),
    };
    lastNodes = [];
    pendingTween = null;
  }

  /** Capture current positions so the next render animates from them. */
  function captureTween() {
    pendingTween = new Map(lastNodes.map((node) => [node.id, { x: node.x, y: node.y }]));
  }

  function render() {
    if (!context) return;
    const { graph, index, bursts, burstsByCommit, adjacency, instants, actorColors } = context;

    const tweenFrom = pendingTween;
    pendingTween = null;

    const visibleLanes = laneTypes.filter((lane) => state.tracks[lane]);

    // ---- node model -----------------------------------------------------------
    const allNodes = buildNodes({
      graph,
      index,
      bursts,
      expandedBursts: state.expandedBursts,
      expandedGroups: state.expandedGroups,
      mode: state.mode,
      laneTypes,
    });
    const nodes = filterNodes(allNodes, state);
    const { rankOrder, rankMax, rankTimes } = assignRanks(nodes);

    // ---- horizontal position --------------------------------------------------
    const scales = createScales({
      instants,
      marginLeft: MARGIN.left,
      plotWidth: plotWidth(),
      mode: state.mode,
      rankTimes,
      rankMax,
    });
    for (const node of nodes) node.x = scales.x(node.t, node);
    lastNodes = nodes;

    // ---- vertical position ----------------------------------------------------
    // Objects are passed in so a lane can allocate sub-lanes when two of its
    // objects overlap in time; without them the packer can only see nodes, and an
    // object's *span* is what decides whether it needs its own band.
    const laneObjects = new Map(visibleLanes.map((lane) => [lane, index.objectsOfType(lane)]));
    const { maxRowByLane, objectRow } = packRows(nodes, visibleLanes, { laneObjects });
    const { lanes: geometry, height } = computeLaneGeometry(visibleLanes, maxRowByLane, MARGIN);
    for (const node of nodes) {
      const lane = geometry.get(node.lane);
      node.y = lane ? lane.contentTop + node.row * ROW_HEIGHT : 0;
    }

    // Which drawn node stands for which object — commits carry their packed row, so
    // a link into the commit lane must meet the node, not the lane's top.
    const nodeByObject = new Map();
    for (const node of nodes) {
      if (node.isGroup) {
        for (const member of node.members) nodeByObject.set(member.objectId, node);
      } else if (node.objectId) {
        nodeByObject.set(node.objectId, node);
      }
    }

    const width = MARGIN.left + plotWidth() + MARGIN.right;
    svg.attr('width', width).attr('height', height);
    for (const layer of Object.values(layers)) layer.selectAll('*').remove();

    const focus = focusSet(adjacency, state.focus, state.focusDegree);
    const anchors = createAnchors({ nodes, nodeByObject, geometry, scales });

    // ---- draw -----------------------------------------------------------------
    drawLaneChrome({ layers, geometry, visibleLanes, index, width });
    renderLifecycleBars({
      gBG: layers.bg,
      index,
      geometry,
      state,
      anchors,
      focus,
      laneTypes,
      objectRow,
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
              tracks: state.tracks,
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

    renderSequenceLines({ gSeq: layers.seq, nodes, laneTypes: visibleLanes, focus });
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
      actorLogin: (id) => index.byId.get(id)?.vmap?.login ?? id,
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

  /** Lane backgrounds, separators and the sticky lane labels. */
  function drawLaneChrome({ layers, geometry, visibleLanes, index, width }) {
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
        .text(laneSubtitle(laneType, index));
    });
  }

  /**
   * The lane's subtitle.
   *
   * The mockup printed the single issue's and single PR's labels here. With N
   * objects a label no longer identifies the lane, so it names the one object when
   * there is exactly one and counts them otherwise.
   */
  function laneSubtitle(laneType, index) {
    const objects = index.objectsOfType(laneType);
    if (objects.length === 1 && laneType !== 'commit') return objects[0].label;
    return `${objects.length} object${objects.length === 1 ? '' : 's'}`;
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
    setGraph,
    captureTween,
    syncStickyLabels,
    plotWidth,
    basePlotWidth: () => basePlotWidth,
    lastNodes: () => lastNodes,
  };
}

/**
 * Where a link should meet an object.
 *
 * A commit meets its drawn node, including the row it was packed into. Anything else
 * meets its lane, at the x of the exact node for that instant when one exists — so an
 * edge lands on the "merged" diamond rather than near it.
 */
function createAnchors({ nodes, nodeByObject, geometry, scales }) {
  /**
   * The single drawn node standing for an object — but only in the commit lane.
   *
   * A commit (or a burst, or a fold group) is exactly one node, so an edge into the
   * commit lane must meet that node at the row it was packed into. An issue or PR is
   * *many* nodes, so `nodeByObject` holds whichever happened to be written last —
   * for the vscode PR, the comment eight days after the merge. Consulting it for a
   * non-commit object is what dragged every link to the right-hand edge.
   */
  function commitNode(anchorId) {
    const node = nodeByObject.get(anchorId);
    return node && node.lane === 'commit' ? node : null;
  }

  /** The node for this object at exactly this instant, if one is drawn. */
  function exactNodeX(objectId, time) {
    for (const node of nodes) {
      if (node.objectId === objectId && +node.t === +time) return node.x;
    }
    return null;
  }

  function xAt(object, time) {
    if (!object) return scales.x(time);
    if (object.type === 'commit') {
      const node = commitNode(object.id);
      return node ? node.x : scales.x(time);
    }
    // Land on the actual glyph for this instant — the "merged" diamond rather than
    // merely near it — falling back to the scale when no node marks that moment.
    const exact = exactNodeX(object.id, time);
    return exact != null ? exact : scales.x(time);
  }

  function y(anchorId, object) {
    const node = commitNode(anchorId);
    if (node) return node.y;
    const lane = geometry.get(object?.type);
    return lane ? lane.contentTop : 0;
  }

  function x(anchorId, object) {
    const node = commitNode(anchorId);
    if (node) return node.x;
    return xAt(object, object?.intervals?.[0]?.start ?? scales.first);
  }

  /** Slide an endpoint along the object's lifecycle so the edge meets it side-on. */
  function clampToLifecycle(anchorId, object, sourceX) {
    const node = commitNode(anchorId);
    if (node) return node.x;
    const interval = object?.intervals?.[0];
    if (!interval?.start || !interval?.end) return x(anchorId, object);
    const low = xAt(object, interval.start);
    const high = xAt(object, interval.end);
    return Math.max(low, Math.min(high, sourceX));
  }

  return { x, y, xAt, clampToLifecycle, xOfTime: (t) => scales.x(t) };
}
