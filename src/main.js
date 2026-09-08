/**
 * Wiring only — no layout, no drawing, no metrics.
 *
 * This module resolves DOM elements, creates the collaborators, and connects
 * events to state changes. If logic starts accumulating here, it belongs in a
 * module instead.
 */

/* global d3 */

import { summarizeSubLog, seedObjects } from './data/loadSubLog.js';
import { createSource, resolveQuery } from './data/source.js';
import { TRAVERSAL_DEGREE } from './data/api.js';
import { describeSeedRef, parseSeedRef } from './data/seedQuery.js';
import { indexSubLog } from './model/subLog.js';
import { LANE_TYPES, activityShortLabel } from './model/activities.js';
import { MAX_FOCUS_DEGREE } from './model/graph.js';
import { MODES, TEMPORAL_MODES, STRUCTURAL_LAYOUTS, isStructuralMode } from './layout/engine.js';
import {
  createState,
  deriveRelGroups,
  deriveQualifiers,
  deriveMethods,
  resetToggles,
  summarizeHidden,
  selectVisible,
  summaryForMode,
  nudgesFor,
  MIN_ZOOM,
  MAX_ZOOM,
} from './state/state.js';
import { deriveCommitGroups } from './model/commitGroups.js';
import { deriveBursts } from './model/bursts.js';
import { deriveCommentBursts } from './model/commentBursts.js';
import { applyState, decodePreset } from './state/presets.js';
import { renderHiddenBanner, renderPresetPanel } from './render/controls.js';
import { actorColor, TYPE } from './render/theme.js';
import { createTooltip } from './render/tooltip.js';
import { createMinimap } from './render/minimap.js';
import { createActorCard } from './render/actorCard.js';
import { createTimeline, MARGIN, STRUCTURAL_MARGIN } from './render/timeline.js';
import { renderSubLogCard, renderProcessCard } from './render/subLogCard.js';
import { scrollToKeepAnchor } from './render/pan.js';
import { bindHelpStrip } from './render/helpStrip.js';
import { renderLegend, legendKeysPresentIn } from './render/legend.js';
import { createMessageSurface, messageHtml, errorHtml } from './render/message.js';
import { createLoadingOverlay } from './render/loading.js';
import { renderStats } from './render/stats.js';
import { createDfgView } from './render/dfg.js';
import { layoutDfg } from './layout/dfg.js';
import { deriveDfgToggles, filterDfg } from './model/dfg.js';
import { formatInstant } from './render/format.js';
import {
  renderLaneRows,
  renderRelationshipRows,
  renderActorRows,
  renderBurstControls,
  renderDfgControls,
  setupCombo,
  setupSearchCombo,
} from './render/sidebar.js';

const el = (id) => document.getElementById(id);

const elements = {
  chart: el('chart'),
  chartMessage: el('chartMessage'),
  statsMessage: el('statsMessage'),
  dfgMessage: el('dfgMessage'),
  chartLoading: el('chartLoading'),
  statsLoading: el('statsLoading'),
  dfgLoading: el('dfgLoading'),
  scroll: el('scroll'),
  statsContent: el('statsContent'),
  dfgContent: el('dfgContent'),
  dfgToggles: el('dfgToggles'),
  dfgActivities: el('dfgActivities'),
  dfgLegend: el('dfgLegend'),
  subLogQuery: el('subLogQuery'),
  dfgQueryNote: el('dfgQueryNote'),
  dfgFocusInfo: el('dfgFocusInfo'),
  dfgCard: el('dfgCard'),
  sourceToggle: el('sourceToggle'),
  sourceNote: el('sourceNote'),
  app: el('app'),
  tip: el('tip'),
  minimap: el('minimap'),
  actorCard: el('actorCard'),
  degreeStepper: el('degreeStepper'),
  subLogCard: el('subLogCard'),
  focusInfo: el('focusInfo'),
  lanes: el('lanes'),
  relationships: el('relationships'),
  actors: el('actors'),
  actorSearch: el('actorSearch'),
  legend: el('legend'),
  bursts: el('bursts'),
  presets: el('presets'),
  hiddenBanner: el('hiddenBanner'),
  toast: el('toast'),
  statsGrid: el('statsGrid'),
  statsLandmarks: el('statsLandmarks'),
  repoInput: el('repoInput'),
  repoDropdown: el('repoDropdown'),
  objectInput: el('objectInput'),
  objectDropdown: el('objectDropdown'),
  traversalInfo: el('traversalInfo'),
};

// The sub-log card is present from the first paint, titled and empty, so the sidebar has
// its final shape before anything is loaded (`render/subLogCard.js`).
renderSubLogCard({ container: elements.subLogCard, summary: null });
renderProcessCard({ container: elements.dfgCard, shown: null });

// The help strip: one delegated listener on the body, texts from help/tips.js. Removing
// this one call switches the feature off; the data-tip attributes are inert without it.
bindHelpStrip({ root: document.body, stripEl: el('helpStrip') });

/*
 * One message surface per page, each a sibling of the thing it stands in for.
 *
 * Both are needed because both pages can fail, and a failure has to be visible on the
 * page the reader is looking at. Routing to "whichever page is visible" was the other
 * option and is worse: the message would then depend on where the user happened to be
 * when the error fired, and switching pages would lose it.
 */
const chartSurface = createMessageSurface({
  messageEl: elements.chartMessage,
  contentEl: elements.chart,
});
const statsSurface = createMessageSurface({
  messageEl: elements.statsMessage,
  contentEl: elements.statsContent,
});
// The process-map page's surface. NOT in the sub-log fan-outs below: its load, its
// failures and its seed-less-ness are all independent of the sub-log's.
const dfgSurface = createMessageSurface({
  messageEl: elements.dfgMessage,
  contentEl: elements.dfgContent,
});

/*
 * One loading overlay per page, for the reason each page has its own message surface: a
 * load blocks both, and the reader may be on either. `loading` fans out to both so the
 * call sites stay a single `show`/`hide` pair.
 *
 * The chart's overlay blurs `#scroll` rather than `#chart`, so whatever is on that page —
 * the drawing, or the message standing in for it — goes behind the scrim together.
 */
const overlays = [
  createLoadingOverlay({ overlayEl: elements.chartLoading, contentEl: elements.scroll }),
  createLoadingOverlay({ overlayEl: elements.statsLoading, contentEl: elements.statsContent }),
];
const loading = {
  show: (description) => overlays.forEach((overlay) => overlay.show(description)),
  hide: () => overlays.forEach((overlay) => overlay.hide()),
};
// Separate from the fan-out: a sub-log load must not blur the process map, nor a DFG
// load the timeline. Each page's overlay answers its own fetch.
const dfgLoadingOverlay = createLoadingOverlay({
  overlayEl: elements.dfgLoading,
  contentEl: elements.dfgContent,
});

const state = createState();
// wrapEl is the app ROOT: the card positions against the whole window, so it works
// identically on every page rather than only inside the timeline's subtree.
const tooltip = createTooltip({ tipEl: elements.tip, wrapEl: elements.app });
const actorCard = createActorCard({
  element: elements.actorCard,
  // Hovering an activity row rings exactly that event's mark in the chart — through
  // whatever fold currently carries it (`markForEvent`) — in the actor's own colour.
  onHoverItem: (event, options) => timeline.highlightEvent(event, options),
});

let current = null; // { graph, index, actorColors, … }
/** So a `?brush=` in the opening URL survives the first load's reset. */
let firstLoad = true;
let relSync = () => {};

// ---------------------------------------------------------------------------
// collaborators
// ---------------------------------------------------------------------------

const minimap = createMinimap({
  svgEl: elements.minimap,
  scrollEl: elements.scroll,
  chartEl: elements.chart,
  onZoom(zoom) {
    state.k = zoom;
    return timeline.plotWidth();
  },
  onAfterZoom() {
    timeline.render();
  },
});

const timeline = createTimeline({
  elements,
  state,
  laneTypes: LANE_TYPES,
  tooltip,
  minimap,
  handlers: {
    onBackgroundClick() {
      if (!state.focus) return;
      state.focus = null;
      hideDegreeStepper();
      updateFocusLabel();
      timeline.render();
    },

    onNodeClick(event, node) {
      // Expanding a burst is a layout change; tween from the current positions so
      // nodes visibly fly apart rather than jumping.
      if (node.isBurst) {
        timeline.captureTween();
        state.expandedBursts.add(node.burst.id);
        redraw();
        return;
      }
      if (node.isCommentBurst) {
        timeline.captureTween();
        state.expandedCommentBursts.add(node.commentBurst.id);
        redraw();
        return;
      }
      state.focus = state.focus === node.objectId ? null : node.objectId;
      state.focusDegree = 1;
      if (state.focus) showDegreeStepper(event.clientX, event.clientY);
      else hideDegreeStepper();
      updateFocusLabel();
      timeline.render();
    },

    /*
     * A mark the reader has dragged.
     *
     * Recorded as an offset from where the layout put it, so it survives a re-render, a
     * zoom and an expanded push — and so the arrangement remains the computed one plus a
     * set of stated displacements rather than a pile of absolute coordinates nobody can
     * account for. This changes the picture, so it is declared and it is undoable.
     */
    onNodeDragged(nudges) {
      // Into the arrangement that is on: an offset means nothing in the other one.
      for (const { id, dx, dy } of nudges) nudgesFor(state).set(id, { dx, dy });
    },

    onCollapseCommentBurst(burst) {
      timeline.captureTween();
      state.expandedCommentBursts.delete(burst.id);
      redraw();
    },

    onCollapseBurst(burst) {
      timeline.captureTween();
      state.expandedBursts.delete(burst.id);
      redraw();
    },

    onRendered({ nodes, scales, plotWidth, basePlotWidth, kind, extent }) {
      el('zin').disabled = state.k >= MAX_ZOOM - 0.001;
      el('zout').disabled = state.k <= MIN_ZOOM + 0.001;

      /*
       * ⚠️ **The minimap is hidden in relationships mode, not left showing the last picture.**
       *
       * It is a *time* overview — a strip of every event's instant, with a viewport you
       * drag along it — and relationships mode has no time axis for it to describe. Leaving it up
       * would be a control that silently does nothing and a picture that quietly belongs
       * to a different mode: the stale-picture failure, in the other direction. Its space
       * is given back rather than blanked, so nothing suggests a strip that failed to draw.
       */
      const structural = kind === 'structural';
      el('minimapWrap').style.display = structural ? 'none' : 'block';
      // The brush takes the minimap's slot: one place to look for "when", whichever mode
      // is on. Hidden with no span to brush — a sub-log of one instant has no range.
      el('timeBrushWrap').style.display = structural && extent ? 'block' : 'none';
      if (structural) {
        updateTimeBrushLabel(extent);
        return;
      }

      minimap.render({
        nodes,
        plotWidth,
        marginLeft: MARGIN.left,
        marginRight: MARGIN.right,
        basePlotWidth,
        scales,
        zoomBounds: { min: MIN_ZOOM, max: MAX_ZOOM },
      });
    },
  },
});

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

async function load(query) {
  const graph = await source.loadSubLog(query);
  const index = indexSubLog(graph);

  const actors = index.objectsOfType('actor');
  const actorColors = new Map(actors.map((actor, i) => [actor.id, actorColor(i)]));
  for (const actor of actors) actor.eventCount = index.eventCountByActor.get(actor.id) || 0;


  // The toggle vocabulary is derived from what this sub-log actually contains,
  // never enumerated — a different sub-log gets different controls.
  const relGroups = deriveRelGroups(graph.links, index.byId);
  const qualifiers = deriveQualifiers(graph.links);
  const methods = deriveMethods(graph.links);
  const { groups: commitGroups, groupsByCommit } = deriveCommitGroups(
    index.objectsOfType('commit'),
    graph.links,
    index.byId,
  );

  resetToggles(state, { relGroups, qualifiers, methods });
  // A preset in the URL is applied after the vocabulary is derived, so it can only
  // set toggles this sub-log actually has.
  if (query?.preset) {
    const snapshot = decodePreset(query.preset);
    if (snapshot) applyState(state, snapshot);
    else showToast('The link carried an unreadable view — showing defaults');
  }
  state.focus = firstLoad ? state.focus : null;
  state.expandedBursts = new Set();
  // A displacement is relative to a position in *this* sub-log; carrying it into another
  // would move a mark by an amount that meant something somewhere else. The brush resets
  // for the same reason in reverse: "the last third" of one span is not the last third of
  // another, and a range silently carried over would hide marks nobody chose to hide.
  state.nodeNudges.clear();
  // ⚠️ Not on the first load, or a `?brush=` link would reset itself before drawing
  // anything — the range would be in the URL, in the sliders, and applied to nothing.
  if (!firstLoad) {
    state.timeBrush = [0, 1];
    el('timeBrushFrom').value = 0;
    el('timeBrushTo').value = 1000;
    syncTimeBrush();
  }
  firstLoad = false;

  const objectColors = timeline.setGraph(graph, index, actorColors);
  const toggleContext = { relGroups, qualifiers, methods, commitGroups, objectsById: index.byId };
  current = {
    graph,
    index,
    actorColors,
    query,
    toggleContext,
    objectColors,
    commitGroups,
    groupsByCommit,
  };

  updateFocusLabel();
  updateTraversalInfo(graph);

  renderSidebar();
  wireSelectors(graph.meta.repo, graph.meta.seed?.[0]?.id, seedObjects(graph)[0]);

  // There is a sub-log now, so take the surface back from whatever message was up.
  // Before `measure()`, which reads the layout the chart is about to be drawn into.
  chartSurface.hide();
  statsSurface.hide();
  timeline.measure();
  redraw();
  refreshStats();
}

/**
 * Rebuild every sidebar control from the current sub-log.
 *
 * Called on load and after a preset is applied, because a preset can change any
 * toggle and the controls must show the truth rather than what they were left at.
 */
function renderSidebar() {
  if (!current) return;
  const { graph, index, actorColors, objectColors, commitGroups, toggleContext, query } = current;

  renderLaneRows({
    container: elements.lanes,
    state,
    laneTypes: LANE_TYPES,
    index,
    objectColors,
    commitGroups,
    onChange: redraw,
    relSync: () => relSync(),
  });
  relSync = renderRelationshipRows({
    container: elements.relationships,
    state,
    relGroups: toggleContext.relGroups,
    qualifiers: toggleContext.qualifiers,
    methods: toggleContext.methods,
    onChange: redraw,
  });
  renderBurstControls({
    container: elements.bursts,
    state,
    bursts: deriveBursts(index.objectsOfType('commit')),
    commentBursts: deriveCommentBursts(index, LANE_TYPES, { windowDays: state.commentWindowDays }),
    // The threshold changes which pushes are bursts at all, so the graph context
    // has to be rebuilt, not merely redrawn.
    onChange: () => {
      timeline.setGraph(graph, index, actorColors);
      renderSidebar();
      redraw();
    },
  });
  renderActorRows({
    container: elements.actors,
    searchInput: elements.actorSearch,
    actors: index.objectsOfType('actor'),
    actorColors,
    state,
    onChange: redraw,
    // Hover draws a throwaway trail straight onto the last render; it never touches
    // `state.actors`, so nothing a hover does can outlive the pointer. The card counts
    // the previewed trail the same way, and drops it on leave (`actorId` null).
    onPreview: (actorId) => {
      timeline.previewActor(actorId);
      updateSubLogCard({ previewActor: actorId });
    },
    onProfile: (actor, anchor) =>
      actorCard.open(actor, anchor, { graph, index, color: actorColors.get(actor.id) }),
  });
  renderPresetPanel({
    container: elements.presets,
    state,
    context: toggleContext,
    query: {
      repo: graph.meta.repo,
      seed: graph.meta.seed?.[0]?.id,
      fixture: query?.fixture,
      source: source.name,
      traversalDegree: graph.meta.traversal_degree,
    },
    // Read at click time, not at render time: see `renderPresetPanel`.
    view: () => ({
      page: activePage,
      brush: state.timeBrush,
      focus: state.focus,
      focusDegree: state.focusDegree,
      layout: state.structuralLayout,
    }),
    onApply: (snapshot) => {
      applyState(state, snapshot);
      // A saved view may carry a different mode and arrangement; the controls and the
      // mode's chrome have to follow, and the chrome before the draw (see `markMode`).
      markMode(state.mode);
      markLayout(state.structuralLayout);
      renderSidebar();
      redraw();
    },
    onToast: showToast,
  });
}

/**
 * Draw the timeline and refresh the hidden-state banner together.
 *
 * Deliberately one function: every path that can subtract from the picture must
 * also update what the app says it is hiding. Splitting them would make it possible
 * to filter something without declaring it, which is the exact failure the banner
 * exists to prevent.
 */
function redraw() {
  // ⚠️ Anything that changes WHAT is drawn — a toggle, the mode, the arrangement, a
  // push folding or unfolding — must come through here and not call `timeline.render()`
  // directly, because the legend's presence, the hidden-state banner and the sub-log card
  // are refreshed below and nowhere else. The mode switch used to call render directly,
  // so the legend kept the timeline's rows lit in relationships mode — "comments" among
  // them, which that mode never draws. Handlers that only move or dim marks (zoom, brush,
  // focus, resize) may still render directly: they change no mark's presence.
  //
  // Guarded for the same reason as refreshStats: every toggle, zoom and mode switch
  // reaches this from an event handler, where a throw would only reach the console and
  // leave whatever was last drawn on screen — a stale picture, which is worse than none.
  try {
    timeline.render();
    chartSurface.hide();
  } catch (error) {
    console.error(error);
    chartSurface.show(errorHtml(error, 'Could not draw this sub-log'));
    return;
  }
  // After the draw, never before: the legend dims the marks that are not on screen, and
  // "what is on screen" is read off the chart that was just rebuilt. Re-rendering fifteen
  // rows costs nothing, and replacing the nodes each time means the hover listeners go
  // with them rather than stacking.
  // Each page's legend explains its own vocabulary: the Trace legend everything but
  // the Process page's section, which lives in that page's own sidebar.
  renderLegend(elements.legend, legendKeysPresentIn(elements.chart), { except: ['Process map'] });
  if (!current) return;
  updateSubLogCard();
  renderHiddenBanner({
    container: elements.hiddenBanner,
    summary: summarizeHidden(state, current.toggleContext),
    state,
    onRestore: () => {
      renderSidebar();
      redraw();
    },
  });
}

let toastTimer = null;
function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    elements.toast.style.display = 'none';
  }, 1800);
}

/**
 * Recompute the statistics over the **visible** sub-log.
 *
 * Not over the whole bundle: metrics must respond to the toggles, so
 * hiding comments genuinely recomputes the gaps. The stats page has no sidebar
 * controls and no banner of its own, so it is also handed the hidden summary and
 * says up front that its figures describe a filtered view.
 */
function refreshStats() {
  if (!current) return;
  const { graph, index, groupsByCommit, toggleContext, objectColors } = current;
  // ⚠️ Guarded, because this is reached from a click handler as well as from `load()`.
  // Unguarded, a throw here left an empty dashboard and a console line — and from the
  // startup path the explanation went to the *timeline's* surface, invisible from here.
  try {
    renderStats({
      graph: selectVisible(graph, state, groupsByCommit),
      index,
      // The same shades the timeline draws with, so a colour means one thing across both
      // pages rather than "an issue" here and "*which* issue" there.
      objectColors,
      gridEl: elements.statsGrid,
      landmarksEl: elements.statsLandmarks,
      hiddenSummary: summarizeHidden(state, toggleContext),
      onRerender: refreshStats,
    });
    statsSurface.hide();
  } catch (error) {
    console.error(error);
    statsSurface.show(errorHtml(error, 'Could not compute these statistics'));
  }
}

// ---------------------------------------------------------------------------
// focus stepper
// ---------------------------------------------------------------------------

function updateFocusLabel() {
  const label = state.focus ? current?.index.byId.get(state.focus)?.label || state.focus : null;
  elements.focusInfo.textContent = label ? `Focus: ${label}` : 'No focus';
}

function showDegreeStepper(x, y) {
  elements.degreeStepper.style.left = `${Math.min(x + 14, window.innerWidth - 140)}px`;
  elements.degreeStepper.style.top = `${Math.max(10, y - 16)}px`;
  elements.degreeStepper.style.display = 'flex';
  updateDegreeStepper();
}

function hideDegreeStepper() {
  elements.degreeStepper.style.display = 'none';
}

function updateDegreeStepper() {
  el('degVal').textContent = state.focusDegree;
  el('degMinus').style.opacity = state.focusDegree <= 1 ? 0.4 : 1;
  el('degPlus').style.opacity = state.focusDegree >= MAX_FOCUS_DEGREE ? 0.4 : 1;
}

el('degMinus').addEventListener('click', (event) => {
  event.stopPropagation();
  if (state.focusDegree > 1) {
    state.focusDegree -= 1;
    updateDegreeStepper();
    timeline.render();
  }
});
el('degPlus').addEventListener('click', (event) => {
  event.stopPropagation();
  if (state.focusDegree < MAX_FOCUS_DEGREE) {
    state.focusDegree += 1;
    updateDegreeStepper();
    timeline.render();
  }
});
elements.degreeStepper.addEventListener('click', (event) => event.stopPropagation());

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

function setZoom(value) {
  state.k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
  timeline.render();
}

/**
 * Zoom the relationships picture about a point on the surface.
 *
 * `setZoom` alone re-renders with the surface still scrolled to where it was, so the
 * drawing — which grows about the frame's origin — ran off to the right and down and the
 * reader had to chase it. This keeps one content point fixed under one surface point:
 * the pointer for the wheel, the surface's centre for the buttons.
 * The arithmetic is `scrollToKeepAnchor` (`render/pan.js`), pure and tested; this
 * function only reads and writes the DOM around it.
 *
 * @param {number} value   the zoom to set (clamped by `setZoom`)
 * @param {{clientX:number, clientY:number}|null} anchor  a pointer position, or null for
 *   the centre of the visible surface
 */
function zoomAround(value, anchor = null) {
  const scroll = elements.scroll;
  const rect = scroll.getBoundingClientRect();
  const offsetX = anchor ? anchor.clientX - rect.left : scroll.clientWidth / 2;
  const offsetY = anchor ? anchor.clientY - rect.top : scroll.clientHeight / 2;
  const before = { scrollLeft: scroll.scrollLeft, scrollTop: scroll.scrollTop, k: state.k };
  setZoom(value);
  const next = scrollToKeepAnchor({
    ...before,
    offsetX,
    offsetY,
    factor: state.k / before.k,
    origin: { x: STRUCTURAL_MARGIN.left, y: STRUCTURAL_MARGIN.top },
  });
  scroll.scrollLeft = next.scrollLeft;
  scroll.scrollTop = next.scrollTop;
}

/**
 * The zoom buttons. In relationships mode they zoom about the CENTRE of the visible
 * surface: the reader is looking at the middle of what is on screen, and a zoom that
 * grew the drawing about the frame's origin sent it off to the right and down.
 * In the timeline modes they keep their behaviour — the minimap owns horizontal position
 * there, and the picture is a strip rather than a plane.
 */
const stepZoom = (factor) =>
  isStructuralMode(state.mode) ? zoomAround(state.k * factor, null) : setZoom(state.k * factor);
el('zin').onclick = () => stepZoom(1.3);
el('zout').onclick = () => stepZoom(1 / 1.3);
/*
 * One "put it back" control, not several.
 *
 * It resets everything the reader can do to the *view* without changing what was loaded:
 * the zoom, any marks dragged out of place, and the brushed time range. A separate button
 * per thing was the alternative and is worse — two or three reset controls side by side
 * make the reader work out which one they want before any of them does anything.
 *
 * ⚠️ The brush was left out of this when the drag reset was folded in, so the pill undid
 * two of the three things it appears to promise and quietly kept dimming half the graph.
 * A control that resets *some* of the view is worse than one that resets none, because
 * the reader stops looking for the rest.
 */
el('zrst').onclick = () => {
  state.nodeNudges.clear();
  state.timeBrush = [0, 1];
  el('timeBrushFrom').value = 0;
  el('timeBrushTo').value = 1000;
  syncTimeBrush();
  setZoom(1);
};

/**
 * The temporal mode to return to when "Time" is chosen after "Relationships" — the one
 * that was on before, so the first level toggles between two pictures the reader has
 * already seen rather than resetting the second level under them.
 */
let lastTemporalMode = TEMPORAL_MODES[0];

/**
 * Put every piece of mode-dependent chrome in the state the mode calls for.
 *
 * ⚠️ **This must run BEFORE the render that follows a mode change, not after it.** The
 * relationships mode fits its layout into the surface it can see, and the surface's height depends
 * on what sits above it — the minimap in the timeline modes, the time brush in relationships mode.
 * When the minimap was hidden from `onRendered`, the first relationships-mode render measured a
 * surface still shortened by the minimap, fitted the drawing into that, and the surface
 * then grew underneath a picture that had already been sized: on a 1500×900 window the
 * layout got 443px of a 640px-tall surface, and the drawing came out at half the height
 * it had room for. Reported as the graph being cramped.
 *
 * `onRendered` still applies the same two toggles, so a render reached by any other path
 * ends in a consistent state; this is the one that runs early enough to matter.
 */
function markMode(mode) {
  const structural = isStructuralMode(mode);
  // The two-level control: the first level says what position means, the second
  // refines it — which time axis, or which arrangement. Only the second-level
  // control that applies is shown; the other would be a control that silently does
  // nothing, which this project forbids.
  for (const option of document.querySelectorAll('#facetSeg .seg-opt')) {
    option.classList.toggle('on', (option.dataset.facet === 'relationships') === structural);
  }
  for (const option of document.querySelectorAll('#timeSeg .seg-opt')) {
    option.classList.toggle('on', option.dataset.mode === mode);
  }
  el('timeSeg').style.display = structural ? 'none' : '';
  el('layoutSeg').style.display = structural ? '' : 'none';
  if (!structural) lastTemporalMode = mode;
  // The minimap is a time overview and relationships mode has no time axis; the brush takes its
  // slot. `onRendered` hides the brush again for a sub-log with no span to brush.
  el('minimapWrap').style.display = structural ? 'none' : 'block';
  el('timeBrushWrap').style.display = structural ? 'block' : 'none';
}

/**
 * Say what the brush is currently letting through.
 *
 * Named in UTC instants rather than as percentages, because "1 Mar – 14 Mar" is a fact
 * about the sub-log and "20%–60%" is a fact about a slider. The times are UTC and
 * labelled as such, here as everywhere.
 */
function updateTimeBrushLabel(extent) {
  const [from, to] = state.timeBrush;
  const label = el('timeBrushLabel');
  if (!extent) {
    label.textContent = '';
    return;
  }
  if (from <= 0 && to >= 1) {
    label.textContent = 'the whole sub-log';
    return;
  }
  const span = extent.max - extent.min;
  const at = (fraction) => formatInstant(new Date(extent.min + span * fraction));
  label.textContent = `${at(Math.min(from, to))} → ${at(Math.max(from, to))}`;
}

/**
 * Keep the two handles in order and paint the filled span between them.
 *
 * ⚠️ The handles are stopped from crossing rather than being allowed to swap. Swapping
 * works arithmetically — the range is read as min-to-max either way — but on screen the
 * handle under the pointer would jump to the other side of the one it passed, and the
 * reader would be dragging a different handle from the one they grabbed.
 */
function syncTimeBrush(changed) {
  const from = el('timeBrushFrom');
  const to = el('timeBrushTo');
  if (changed === 'from' && Number(from.value) > Number(to.value)) from.value = to.value;
  if (changed === 'to' && Number(to.value) < Number(from.value)) to.value = from.value;

  const low = Number(from.value) / 1000;
  const high = Number(to.value) / 1000;
  state.timeBrush = [low, high];

  const fill = el('timeBrushFill');
  fill.style.left = `${low * 100}%`;
  fill.style.width = `${(high - low) * 100}%`;
}

for (const [id, which] of [
  ['timeBrushFrom', 'from'],
  ['timeBrushTo', 'to'],
]) {
  el(id).addEventListener('input', () => {
    syncTimeBrush(which);
    // A redraw, not a reload: the brush dims, it does not change what was loaded.
    timeline.render();
  });
}

// Paint the filled span once at startup. Without this the rail shows empty on a first
// load — the range covers everything and the control says it covers nothing.
syncTimeBrush();

/** Reflect the active structural arrangement. */
function markLayout(layout) {
  for (const option of document.querySelectorAll('#layoutSeg .seg-opt')) {
    option.classList.toggle('on', option.dataset.layout === layout);
  }
}



function switchMode(mode) {
  markMode(mode);
  state.mode = mode;
  timeline.captureTween();
  redraw();
}

for (const option of document.querySelectorAll('#facetSeg .seg-opt')) {
  option.addEventListener('click', () => {
    switchMode(option.dataset.facet === 'relationships' ? 'relationships' : lastTemporalMode);
  });
}

for (const option of document.querySelectorAll('#timeSeg .seg-opt')) {
  option.addEventListener('click', () => switchMode(option.dataset.mode));
}

for (const option of document.querySelectorAll('#layoutSeg .seg-opt')) {
  option.addEventListener('click', () => {
    markLayout(option.dataset.layout);
    state.structuralLayout = option.dataset.layout;
    timeline.captureTween();
    redraw();
  });
}

/**
 * The wheel over the drawing surface.
 *
 * In the timeline modes it scrolls, as a page does, and Ctrl+wheel zooms. In the
 * relationships mode it does NOT scroll: the picture is a graph, not a page, and the
 * surface is navigated by dragging it — a wheel that scrolled it vertically moved the
 * picture out from under a reader who meant to zoom, and there is no sideways
 * counterpart, so scrolling was half a control. The wheel's job there is zooming.
 */
elements.scroll.addEventListener(
  'wheel',
  (event) => {
    if (isStructuralMode(state.mode)) {
      // The wheel zooms, about the pointer, with no modifier — and only over the surface,
      // since this listener is the surface's own. Fine steps: a notch is ~10%.
      event.preventDefault();
      zoomAround(state.k * (event.deltaY < 0 ? 1.1 : 1 / 1.1), {
        clientX: event.clientX,
        clientY: event.clientY,
      });
      return;
    }
    if (!event.ctrlKey) return;
    event.preventDefault();
    setZoom(state.k * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
  },
  { passive: false },
);

elements.scroll.addEventListener('scroll', () => {
  if (minimap.isResizing()) return;
  timeline.syncStickyLabels();
  minimap.syncViewport();
});

/**
 * The sidebar's collapsible sections — Views, Lanes, Relationships, Folding, Actors, Legend.
 *
 * ⚠️ **All of them start CLOSED, and nothing about loading a sub-log opens them.** They
 * used to start open, so every load presented the whole control surface at once and the
 * sub-log itself — the thing just asked for — sat below a wall of toggles; reported as the
 * menus "auto-expanding". A section stays however the reader left it for the rest of the
 * session: loading another sub-log re-renders a section's *contents* (`renderSidebar`)
 * but never touches whether it is open. The Sub-log section has no header and is always
 * shown, because it is where the next query is typed.
 */
function setSectionOpen(header, open) {
  el(header.dataset.target).style.display = open ? 'flex' : 'none';
  header.querySelector('.chev').style.transform = open ? 'rotate(0deg)' : 'rotate(-90deg)';
}
for (const header of document.querySelectorAll('.collapseHeader')) {
  setSectionOpen(header, false);
  header.addEventListener('click', () => {
    setSectionOpen(header, el(header.dataset.target).style.display === 'none');
  });
}

/** Which page is showing — what a copied link has to carry (`presetUrl`). */
let activePage = 'timeline';

/**
 * The three pages, as data: their container, their sidebar block, and what to run
 * once the page is VISIBLE — visibility first, because a hidden page measures 0 wide
 * and lays out into nothing (ARCHITECTURE trap #8).
 */
const PAGES = {
  timeline: {
    pageEl: 'timelinePage',
    sidebarEl: 'timelineSidebarSections',
    onShow: () => {
      timeline.measure();
      redraw();
    },
  },
  stats: { pageEl: 'statsPage', sidebarEl: 'statsSidebarSections', onShow: () => refreshStats() },
  dfg: { pageEl: 'dfgPage', sidebarEl: 'dfgSidebarSections', onShow: () => refreshDfg() },
};

/**
 * The sub-log group's sliding indicator: over the active Trace or Stats tab, out on the
 * Process page. Measured from the DOM because the tabs' widths are their labels'. The
 * geometry is trivial on purpose — a `left`/`width` pair — so the motion is CSS's.
 */
function placePageThumb(page) {
  const thumb = document.getElementById('pageThumb');
  const group = document.getElementById('pageGroup');
  if (!thumb || !group) return;
  const tab = group.querySelector(`.pageTab[data-page="${page}"]`);
  if (!tab) {
    thumb.classList.add('off');
    return;
  }
  thumb.classList.remove('off');
  thumb.style.left = `${tab.offsetLeft}px`;
  thumb.style.width = `${tab.offsetWidth}px`;
}

/** Switch pages. Extracted so `?page=` can drive it as a click would. */
function showPage(page) {
  activePage = page;
  for (const other of document.querySelectorAll('.pageTab')) {
    other.classList.toggle('on', other.dataset.page === page);
  }
  placePageThumb(page);

  for (const [name, entry] of Object.entries(PAGES)) {
    el(entry.pageEl).style.display = name === page ? 'flex' : 'none';
    el(entry.sidebarEl).style.display = name === page ? 'flex' : 'none';
  }
  // The seed half of the shared query block makes no sense on the process map — the
  // whole log counts — so it is swapped for a sentence, never greyed.
  const isDfg = page === 'dfg';
  elements.subLogQuery.style.display = isDfg ? 'none' : '';
  elements.dfgQueryNote.style.display = isDfg ? '' : 'none';

  renderSourceToggle();
  PAGES[page].onShow();
}

for (const tab of document.querySelectorAll('.pageTab')) {
  tab.addEventListener('click', () => showPage(tab.dataset.page));
}
// The indicator's first position, and again once fonts have settled the tab widths.
placePageThumb(activePage);
window.addEventListener('load', () => placePageThumb(activePage));

// ---------------------------------------------------------------------------
// the process-map page
// ---------------------------------------------------------------------------

const dfgChart = createDfgView({
  container: elements.dfgContent,
  tooltip,
  handlers: {
    // Click a mark to see only what touches it, click the background to clear —
    // the Trace page's focus gesture. Highlight only; the geometry never moves.
    onNodeClick(key) {
      dfgView.focus = dfgView.focus === key ? null : key;
      renderDfg();
    },
    onBackgroundClick() {
      if (!dfgView.focus) return;
      dfgView.focus = null;
      renderDfg();
    },
  },
});
/*
 * The page's own view state, deliberately outside `st` and outside presets: presets
 * describe sub-log views, and none of this describes anything a sub-log has. Across a
 * repository switch the toggles KEEP (the vocabulary is closed and shared, and "hide
 * commits" is an intent that transfers); `focus` clears (it names a node in a picture
 * that no longer exists); `range` re-derives to the new artifact's default, because an
 * absolute count is a statement about one log while the decile default transfers.
 */
const dfgView = {
  lanes: {},
  pairs: {},
  hiddenActivities: new Set(),
  linkEvidence: {},
  linkQualifiers: {},
  linkMethods: {},
  range: null,
  focus: null,
};
let currentDfgToggles = null;
/** Loaded DFGs, one per repository. */
const dfgCache = new Map();
let currentDfg = null;

/** Which repository the process map should describe right now. */
function dfgRepoName() {
  // The loaded sub-log's repo first; the combo's text covers the prompt state, where a
  // repository is chosen but no seed is, and no sub-log exists to read it from.
  return current?.graph?.meta?.repo ?? ((elements.repoInput.value || '').trim() || null);
}

/**
 * Load (or reuse) the DFG for the current repository, then draw it. Runs only while
 * the page is visible; errors land on this page's own surface and nowhere else.
 */
async function refreshDfg() {
  // The capability flag, not the source name — the traversalEditable pattern. Fixtures
  // hold pre-built sub-logs; a whole-repository map has nothing to be built from there.
  if (!source.dfgAvailable) {
    dfgSurface.show(
      messageHtml(
        'The process map needs the database',
        'Fixtures hold pre-built sub-logs, and a process map covers a whole ' +
          'repository’s log.<br>Switch the data source: ' +
          '<a href="?source=database&page=dfg" style="color:var(--color-accent-300)">' +
          '?source=database</a>.',
      ),
    );
    return;
  }
  const repo = dfgRepoName();
  if (!repo) {
    dfgSurface.show(
      messageHtml('Choose a repository', 'The process map covers one repository’s whole log.'),
    );
    return;
  }
  const key = `${source.name}:${repo}`;
  try {
    if (!dfgCache.has(key)) {
      dfgLoadingOverlay.show(`process map of ${repo}`);
      try {
        dfgCache.set(key, await source.loadDfg(repo));
      } finally {
        dfgLoadingOverlay.hide();
      }
    }
    const isNewArtifact = currentDfg !== dfgCache.get(key);
    currentDfg = dfgCache.get(key);
    if (isNewArtifact) {
      currentDfgToggles = deriveDfgToggles(currentDfg);
      // The repo-switch policy from the state object's comment: toggles keep, focus
      // clears, range re-derives to this artifact's default.
      dfgView.focus = null;
      dfgView.range = [...currentDfgToggles.defaultRange];
      renderDfgControls({
        container: elements.dfgToggles,
        activitiesContainer: elements.dfgActivities,
        vocabulary: currentDfgToggles,
        view: dfgView,
        onChange: renderDfg,
      });
    }
    dfgSurface.hide();
    renderDfg();
  } catch (error) {
    console.error(error);
    dfgCache.delete(key);
    dfgSurface.show(errorHtml(error));
  }
}

/** The Trace pill's twin: which activity is focused, or that none is. */
function updateDfgFocusLabel() {
  if (!dfgView.focus) {
    elements.dfgFocusInfo.textContent = 'No focus';
    return;
  }
  const [type, activity] = dfgView.focus.split('/');
  elements.dfgFocusInfo.textContent = `Focus: ${TYPE[type].label} ${activityShortLabel(activity)}`;
}

/** Draw the loaded DFG: the page view filters BEFORE layout, so rows re-spread. */
function renderDfg() {
  if (!currentDfg) return;
  const filtered = filterDfg(currentDfg, dfgView);
  // A focused activity that has since been hidden names nothing; clear it.
  if (
    dfgView.focus &&
    !filtered.dfg.nodes.some((n) => `${n.object_type}/${n.activity}` === dfgView.focus)
  ) {
    dfgView.focus = null;
  }
  const width = dfgChart.measure();
  // Widths pinned to the UNFILTERED maximum, so a stroke means the same count at
  // every filter setting.
  const layout = layoutDfg(filtered.dfg, {
    width,
    maxSuccessions: currentDfgToggles.maxSuccessions,
  });
  dfgChart.render(currentDfg, layout, { counts: filtered, focus: dfgView.focus });
  updateDfgFocusLabel();
  renderProcessCard({
    container: elements.dfgCard,
    shown: {
      activities: filtered.dfg.nodes.length,
      perType: filtered.dfg.edges.length,
      cross: filtered.dfg.cross_edges.length,
    },
    total: {
      activities: currentDfg.nodes.length,
      perType: currentDfg.edges.length,
      // Arrow units: the raw cross rows are per link class since contract v2.
      cross: currentDfgToggles.crossArrows,
    },
  });
  renderLegend(elements.dfgLegend, legendKeysPresentIn(elements.dfgContent), { only: ['Process map'] });
}

for (const dashboard of [
  ['statsCard', 'Per-artifact statistics'],
  ['landmarksCard', 'Landmarks'],
]) {
  const row = document.createElement('label');
  row.className = 'sideRow on';
  row.dataset.tip = 'stats.dashboard';
  row.dataset.tipArg = dashboard[1].toLowerCase();
  row.style.cssText =
    'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--radius-sm);cursor:pointer';
  row.innerHTML =
    '<input type="checkbox" checked style="accent-color:var(--color-accent);width:14px;height:14px;' +
    `flex:0 0 auto;cursor:pointer"><span class="mono" style="font-size:12px;flex:1">${dashboard[1]}</span>`;
  const checkbox = row.querySelector('input');
  checkbox.addEventListener('change', () => {
    el(dashboard[0]).style.display = checkbox.checked ? 'flex' : 'none';
    row.classList.toggle('on', checkbox.checked);
  });
  el('dashboards').appendChild(row);
}

// ---------------------------------------------------------------------------
// search combos — wired, unlike the mockup where selecting did nothing
// ---------------------------------------------------------------------------

/**
 * The selection is a **query**: a repository, and a seed object to traverse out
 * from. That is the `get_sublog` contract, and the UI now names it rather
 * than picking a file.
 *
 * `?repo=` and `?seed=` make a selection reproducible by link. `?fixture=` is kept
 * as a direct address for tests
 * and for the links already written down.
 */
function queryFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return {
    repo: params.get('repo') || null,
    seed: params.get('seed') || null,
    fixture: params.get('fixture') || null,
    preset: params.get('preset') || null,
    // Server-side expansion. Absent means "whatever the source defaults to", which for
    // the RPC is `TRAVERSAL_DEGREE.default` (1) and for a fixture is whatever it was
    // built at.
    traversalDegree: params.get('degree') ? Number(params.get('degree')) : undefined,
    // Whitelisted against the page map, the way ?mode= and ?layout= are — an unknown
    // value falls back to the timeline rather than being half-honoured.
    page: ['stats', 'dfg'].includes(params.get('page')) ? params.get('page') : 'timeline',
    /*
     * The time mode, for the same reason `?page=` exists: a link has to reproduce what
     * someone was looking at. It matters more than it did when every mode was a timeline,
     * because the relationships mode changes what *position* means — "look at this sub-log" and "look at this
     * sub-log with time released" are two different requests, and a link has to be able to
     * make the second one.
     *
     * A preset also carries the mode (`serializeState`), but a preset is a whole
     * configuration; this is the one knob on its own. An unknown value is ignored rather
     * than defaulted loudly — it is a URL someone typed, not a payload.
     */
    mode: MODES.includes(params.get('mode')) ? params.get('mode') : null,
    // Which arrangement the relationships mode uses. Same reasoning as `mode`: a link has to be
    // able to reproduce the picture, and rows and rings are two different pictures.
    layout: STRUCTURAL_LAYOUTS.includes(params.get('layout')) ? params.get('layout') : null,
    // The brushed range, as two fractions — `?brush=0.6,1` is "the last two fifths". Same
    // reproducibility argument as ?mode= and ?layout=: a brushed picture is a different
    // picture, and a link has to be able to carry it. Fractions rather than dates because
    // that is what the state holds, and because a date outside the span would silently
    // mean nothing.
    brush: parseBrush(params.get('brush')),
    // A focused object, and how far the highlight reaches. Same reproducibility argument
    // as the rest: a focused picture is a different picture. ⚠️ `focusDegree`, not
    // `degree` — that one is the *traversal* degree, which decides what is in the sub-log
    // at all. Two notions of degree, named apart, as CLAUDE.md requires.
    focus: params.get('focus') || null,
    focusDegree: params.get('focusDegree') ? Number(params.get('focusDegree')) : null,
  };
}

/** `"0.2,0.8"` → `[0.2, 0.8]`, or null if it is not two numbers in range. */
function parseBrush(value) {
  if (!value) return null;
  const parts = value.split(',').map(Number);
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) return null;
  return [Math.min(...parts), Math.max(...parts)];
}

const initialQuery = queryFromUrl();

// Before the first load, so the opening render is already in the asked-for mode rather
// than drawing the timeline and then replacing it.
if (initialQuery.mode) {
  state.mode = initialQuery.mode;
  markMode(initialQuery.mode);
}
if (initialQuery.layout) {
  state.structuralLayout = initialQuery.layout;
  markLayout(initialQuery.layout);
}
if (initialQuery.focus) {
  state.focus = initialQuery.focus;
  state.focusDegree = Math.min(
    MAX_FOCUS_DEGREE,
    Math.max(1, initialQuery.focusDegree || 1),
  );
}
if (initialQuery.brush) {
  state.timeBrush = initialQuery.brush;
  el('timeBrushFrom').value = Math.round(initialQuery.brush[0] * 1000);
  el('timeBrushTo').value = Math.round(initialQuery.brush[1] * 1000);
  syncTimeBrush();
}

/**
 * Fixtures or the database, chosen by `?source=` and defaulting to fixtures.
 *
 * Defaulting to fixtures is deliberate: the database source needs PostgREST running,
 * and an app that refuses to start because a server is down would be worse than one
 * that starts on the corpus it ships with.
 */
const source = createSource();

/**
 * Say which data source is live, and let it be changed without editing the URL.
 *
 * The source is chosen by `?source=` and defaults to fixtures. Before this existed the
 * only way to know whether you were looking at the real database or at hand-built
 * test bundles was to remember what you had typed — and a reading taken on fixtures by
 * accident would say the wrong thing while looking identical to one taken on real data. Switching reloads the page rather than swapping the source in place,
 * because a seed from one source is meaningless in the other (fixtures key on
 * `issue:242864`, the database on `issue:2902032454`), so carrying the query across
 * would guarantee a failed load.
 */
function renderSourceToggle() {
  const OPTIONS = [
    { id: 'fixtures', label: 'Fixtures', tip: 'source.fixtures', note: 'Pre-built test sub-logs. No database.' },
    { id: 'database', label: 'Database', tip: 'source.database', note: 'Live via PostgREST. Seed from any artifact.' },
  ];

  // The process map is whole-log and the fixtures hold sub-logs, so on that page the
  // Fixtures option is REMOVED, not greyed — a source that cannot serve the page is not
  // a choice. The Trace and Stats pages get both back.
  const options = activePage === 'dfg' ? OPTIONS.filter((o) => o.id === 'database') : OPTIONS;

  elements.sourceToggle.innerHTML = '';
  for (const option of options) {
    const active = option.id === source.name;
    const button = document.createElement('button');
    button.className = 'mono';
    button.textContent = option.label;
    button.dataset.tip = option.tip;
    button.style.cssText =
      'flex:1;cursor:pointer;border:none;padding:6px 8px;font-size:11.5px;font-weight:600;' +
      (active
        ? 'background:var(--color-accent-600,#5b5bd6);color:#fff'
        : 'background:var(--color-neutral-900);color:var(--color-neutral-400)');
    button.setAttribute('aria-pressed', String(active));
    if (!active) {
      button.addEventListener('click', () => {
        // Only the source survives the switch. See above.
        window.location.search = `?source=${option.id}`;
      });
    }
    elements.sourceToggle.appendChild(button);
  }
  elements.sourceNote.textContent =
    (options.find((o) => o.id === source.name) ?? options[0]).note;
}
renderSourceToggle();

let catalogue = null;

/**
 * Populate the two selectors from the catalogue.
 *
 * Repositories with no loadable sub-log are listed and disabled with their reason
 * rather than omitted: their absence is itself a finding, and a picker that never
 * mentioned them would hide that.
 */
function wireSelectors(activeRepoName, activeSeedId, loadedSeed) {
  const repos = catalogue.repos;
  const activeRepo =
    repos.find((repo) => repo.name === activeRepoName) || repos.find((repo) => repo.available);

  setupCombo({
    input: elements.repoInput,
    dropdown: elements.repoDropdown,
    options: repos.map((repo) => ({
      label: repo.name,
      repo: repo.name,
      disabled: !repo.available,
      note: repo.available ? (repo.synthetic ? 'synthetic' : null) : 'no data',
      title: repo.reason,
      active: repo.name === activeRepo?.name,
    })),
    initialLabel: activeRepo?.name ?? '',
    // Changing repository loads that repository's first servable seed; there is no
    // meaningful "same seed" across repositories. The process map, if it is what is on
    // screen, follows the new repository too.
    onSelect: (option) => {
      reload({ repo: option.repo });
      if (activePage === 'dfg') refreshDfg();
    },
  });

  /*
   * The label for the seed currently loaded.
   *
   * It used to be looked up in the catalogue's seed list, which only the fixture source
   * has — the database source searches rather than enumerating, so there
   * is no list to look in. Reading it off the loaded sub-log instead works for both, and
   * is more truthful anyway: it names what is actually on screen rather than what the
   * catalogue said would be.
   */
  const activeSeed =
    loadedSeed || (activeRepo?.seeds ?? []).find((seed) => seed.id === activeSeedId);

  // The seed box is a **search**, not a list. A real repository holds hundreds of
  // thousands of objects, so there is nothing to enumerate: you name what you want.
  setupSearchCombo({
    input: elements.objectInput,
    dropdown: elements.objectDropdown,
    initialLabel: activeSeed ? seedLabel(activeSeed) : '',
    // Async in both sources; `setupSearchCombo` debounces and guards against a stale
    // response overwriting a fresher one.
    // The full ranked superset in ONE query (limit 200 is the RPC's own cap, and costs
    // the same as 20 — measured 585 vs 661 ms); the dropdown reveals it 15 at a time.
    // Ranking is client-side, so server-side paging would page an
    // UNRANKED superset and shuffle the order between batches.
    search: async (text) =>
      (await source.searchSeeds(activeRepo?.name, text, { limit: 200 })).map((seed) => ({
        label: seedLabel(seed),
        note: seed.title || null,
        // What the help strip shows in full while the row is hovered: the type, and the
        // whole title (or commit message) the row itself has to truncate.
        tipText: seed.title ? `${seedLabel(seed)} — ${seed.title}` : null,
        seed: seed.id,
        active: seed.id === activeSeedId,
      })),
    // The message differs by source because the *reason* differs: fixtures cannot
    // traverse from an arbitrary object, the database simply has no such object.
    // Saying "needs the RPC" once the RPC is what you are talking to would be a lie.
    emptyMessage: (text) =>
      text.trim()
        ? source.emptySeedMessage(describeSeedRef(parseSeedRef(text)), activeRepo?.name)
        : 'Type an issue or PR number, or a commit SHA.',
    onSelect: (option) => reload({ repo: activeRepo.name, seed: option.seed }),
  });
}

// "pull request #116416", not "pull request PR #116416": a PR's own label starts with
// "PR", which the spelled-out type already says. Display only — matching parses the
// TYPED text ("pr 116416") against seed.type and the digits, never against this string.
const seedLabel = (seed) =>
  `${seed.type.replace('_', ' ')} ${seed.type === 'pull_request' ? String(seed.label).replace(/^PR\s+/, '') : seed.label}`;

async function reload(query) {
  /*
   * Everything that changes the sub-log comes through here — the repository picker, the
   * seed box, the traversal stepper and startup — so this is the one place the wait has
   * to be reported. `finally`, because a failed load must not leave the overlay up over
   * the error it is hiding.
   */
  loading.show(describeQuery(query));
  try {
    /*
     * A repository without a seed is an incomplete query, and how to
     * complete it depends on the source: fixtures can offer their first servable seed,
     * the database cannot enumerate one to offer. Previously neither case was handled —
     * `reload({repo})` went straight to the transport, which the fixture path absorbed
     * silently by taking `repo.seeds[0]` and the RPC rightly refused. The result was
     * that opening `?source=database` with no seed, or switching repository at all,
     * produced a dead app with no selectors.
     */
    const resolved = await resolveQuery(query, source);
    if (resolved.action === 'prompt') {
      showSeedPrompt(resolved.repo);
      return;
    }
    await load(resolved.query);
  } catch (error) {
    showFatal(error, query);
  } finally {
    loading.hide();
  }
}

/**
 * What the overlay says it is loading.
 *
 * The repository and the traversal degree, never the seed id: those two are what a reader
 * can act on — the degree above all, since reaching further is what makes a wait long —
 * while `issue:829212149` is a database key that means nothing on screen. The seed box
 * already shows which object was asked for.
 */
function describeQuery(query) {
  // `traversalDegree`, the key the query actually uses — `degree` is only the URL
  // parameter's spelling, and reading it here would silently drop the one fact that
  // explains a long wait.
  const degree = query?.traversalDegree;
  return [query?.repo, degree != null ? `traversal degree ${degree}` : null]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The state between choosing a repository and naming a seed.
 *
 * Not an error and not a blank page: the selectors are wired so the search box works,
 * and the message says what to do. The selection is a query — the tool cannot show a
 * sub-log until it has been told which one.
 */
function showSeedPrompt(repoName) {
  wireSelectors(repoName, null, null);
  renderSubLogCard({ container: elements.subLogCard, summary: null });
renderProcessCard({ container: elements.dfgCard, shown: null });
  const html = messageHtml(
    `Choose something to start from${repoName ? ` in ${escapeForHtml(repoName)}` : ''}`,
    'A sub-log is a repository <em>and</em> an artifact to traverse out from, so there is ' +
      'nothing to draw yet.<br>Use <strong>Start from</strong> — an issue or PR number ' +
      '(<span class="mono">102358</span>), a commit SHA (<span class="mono">48fd5cb</span>), ' +
      'or free text (<span class="mono">mcp server</span>).',
  );
  chartSurface.show(html);
  statsSurface.show(html);
}

const escapeForHtml = (value) => String(value).replace(/[&<>]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/**
 * The traversal degree line, and the sub-log info card beneath it.
 *
 * The degree is a stepper against the database and text on fixtures: the control is
 * real where it can be honoured and text where it cannot. The card
 * (`render/subLogCard.js`) states what the query returned — counts by type, links,
 * events, span — and replaced the breadcrumb that used to run above the chart. Repository
 * and seed are not repeated: they are the two boxes directly above.
 *
 * ⚠️ What used to be said here about the SOURCE — "N seeds servable here", "live from the
 * database, N searchable" — is gone on purpose. The source toggle's own note already says
 * which source is on and what it can seed, and a second sentence saying it again under
 * the degree was the kind of caption that goes stale without anyone noticing.
 */
function updateTraversalInfo(graph) {
  const degree = graph.meta?.traversal_degree;

  /*
   * Editable at last, and only where it can be honoured.
   *
   * On a fixture the degree was fixed when the fixture was built, so a stepper would be
   * a control that silently did nothing — the thing this project forbids.
   * `get_sublog` takes the degree as a parameter, so against the database the
   * control is real. On fixtures it stays text.
   *
   * ⚠️ The range is 0–2 and the default 1 (`TRAVERSAL_DEGREE` in `data/api.js`).
   * A step is steep and non-obvious: on vscode PR #116416 the
   * sub-log goes 1 → 39 → 42 objects from degree 0 to 2, and 291 at the third hop that
   * is no longer offered — a stepper that reached it would invite someone to click it on
   * a busy seed and conclude the tool had hung.
   */
  const degreeNote = source.traversalEditable
    ? `Traversal degree ${renderDegreeControl(degree)}`
    : degree == null
      ? ''
      : `<span data-tip="query.degree.fixed">Traversal degree ${degree} · fixed by the query</span>`;

  /*
   * ⚠️ **Say when a seed reaches nothing.** A sub-log of one object is a legitimate
   * answer — the object exists and no detection method connects it to anything — but on
   * screen it is indistinguishable from a failure, and users reported exactly that
   * ("issue 245207 loads only itself"). Verified for that issue: zero links here AND
   * zero upstream, so the picture is right and only the silence is wrong.
   *
   * The rule that anything hidden is declared, one step further. That rule declares what
   * the tool *subtracted*; this declares what the data never had, which is the other way
   * a sparse picture misleads.
   */
  elements.traversalInfo.innerHTML = degreeNote;
  bindDegreeControl(graph);
  // The card itself is drawn by `updateSubLogCard`, from `redraw()`, because its numbers
  // follow the toggles; `load()` ends in a `redraw()`, so it is drawn on load too.
}

/**
 * The sub-log card: what is CURRENTLY DISPLAYED, against the payload.
 *
 * Summarised over `selectVisible(...)` — the same selection the statistics page computes
 * from — so hiding a lane, a relationship class or the comments changes
 * the numbers, and each tile shows "n / total" where they differ. Called from `redraw()`
 * beside the hidden-state banner, which is the other place that says what is hidden.
 */
function updateSubLogCard({ previewActor = null } = {}) {
  if (!current) return;
  const { graph, groupsByCommit } = current;
  const notes = [];
  if (graph.links.length === 0) {
    notes.push(
      'No links from this seed — nothing upstream connects it, so there is nothing to ' +
        'traverse to. The artifact itself is shown.',
    );
  }
  const visible = selectVisible(graph, state, groupsByCommit);
  renderSubLogCard({
    container: elements.subLogCard,
    // An actor is drawn only when pinned, and the relationships mode folds events into
    // one mark per object; `summaryForMode` counts what is actually on screen.
    summary: summaryForMode(summarizeSubLog(visible), visible, state, { previewActor }),
    total: summarizeSubLog(graph),
    notes,
  });
}

/** Reload at a new degree, keeping the rest of the query. */
function bindDegreeControl(graph) {
  const container = document.getElementById('degreeControl');
  if (!container) return;
  for (const button of container.querySelectorAll('button[data-degree]')) {
    button.addEventListener('click', () => {
      const degree = Number(button.dataset.degree);
      if (degree === (graph.meta?.traversal_degree ?? TRAVERSAL_DEGREE.default)) return;
      reload({
        repo: graph.meta?.repo,
        seed: graph.meta?.seed?.[0]?.id,
        traversalDegree: degree,
      });
    });
  }
}

/**
 * The degree stepper, as markup. Wired after the note is written, because it is rebuilt
 * on every render and a listener bound to a replaced node would be lost.
 */
function renderDegreeControl(degree) {
  const current = degree ?? TRAVERSAL_DEGREE.default;
  const options = Array.from(
    { length: TRAVERSAL_DEGREE.max - TRAVERSAL_DEGREE.min + 1 },
    (_, i) => TRAVERSAL_DEGREE.min + i,
  )
    .map(
      (d) =>
        `<button data-degree="${d}" data-tip="query.degree" class="mono" style="cursor:pointer;border:1px solid ` +
        `var(--color-neutral-700);background:${d === current ? 'var(--color-accent-600,#5b5bd6)' : 'transparent'};` +
        `color:${d === current ? '#fff' : 'var(--color-neutral-400)'};font-size:10px;` +
        `padding:1px 5px;border-radius:3px;margin-right:2px">${d}</button>`,
    )
    .join('');
  return `<span id="degreeControl">${options}</span>`;
}


// ---------------------------------------------------------------------------
// startup
// ---------------------------------------------------------------------------

function showFatal(error, query) {
  console.error(error);
  // Keep the selectors alive on failure. Stranding the user with a dead sidebar means
  // the only way out of a bad seed is editing the URL.
  try {
    if (catalogue) wireSelectors(query?.repo, null, null);
  } catch {
    /* the selectors are a courtesy here; never let them mask the real error */
  }
  // Both pages: a sub-log that would not load is missing from both, and the reader may
  // be on either. This is the defect that made a failed renderStats look like a stats
  // page with nothing in it.
  const html = errorHtml(error);
  chartSurface.show(html);
  statsSurface.show(html);
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    // Only the visible page re-measures: a hidden one reads 0 wide and would lay out
    // into nothing. Whichever was hidden re-measures in its onShow instead.
    if (activePage === 'dfg') {
      renderDfg();
    } else {
      timeline.measure();
      timeline.render();
    }
  }, 150);
});

/**
 * Startup: fetch the catalogue first, because the selectors describe what can be
 * asked for and the sub-log is the answer to one such question.
 */
source
  .listRepos()
  .then((repos) => {
    catalogue = { repos };
    return reload(initialQuery);
  })
  .then(() => {
    if (initialQuery.page !== 'timeline') showPage(initialQuery.page);
  })
  .catch(showFatal);
