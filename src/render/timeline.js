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
import { deriveCommitGroups } from '../model/commitGroups.js';
import { buildNodes, assignRanks, filterNodes } from '../layout/nodes.js';
import { createScales } from '../layout/scales.js';
import { packRows } from '../layout/packing.js';
import { computeLaneGeometry, rowY } from '../layout/lanes.js';
import { createAnchors } from '../layout/anchors.js';
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
import { TYPE, drawSymbol, typeColor, objectShade } from './theme.js';
import { isNodeVisible, isObjectVisible } from '../state/state.js';

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
    const { graph, index, bursts, burstsByCommit, adjacency, instants, actorColors, objectColors,
      groupsByCommit } = context;

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
    const nodes = filterNodes(allNodes, (node) => isNodeVisible(node, state, groupsByCommit));
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
    for (const node of nodes) node.y = rowY(geometry, node.lane, node.row);

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
    // `objectRow` is what tells an edge which band its issue or PR was packed into;
    // without it every link into a lane lands on band 0.
    const anchors = createAnchors({ nodes, nodeByObject, geometry, scales, objectRow });

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
    setGraph,
    captureTween,
    syncStickyLabels,
    plotWidth,
    basePlotWidth: () => basePlotWidth,
    lastNodes: () => lastNodes,
  };
}

