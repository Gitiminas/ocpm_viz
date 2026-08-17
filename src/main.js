/**
 * Wiring only — no layout, no drawing, no metrics.
 *
 * This module resolves DOM elements, creates the collaborators, and connects
 * events to state changes. If logic starts accumulating here, it belongs in a
 * module instead.
 */

/* global d3 */

import { describeSubLog, seedObjects } from './data/loadObjectGraph.js';
import { createSource, resolveQuery } from './data/source.js';
import { describeSeedRef, parseSeedRef } from './data/seedQuery.js';
import { indexObjectGraph } from './model/objectGraph.js';
import { LANE_TYPES } from './model/activities.js';
import { MAX_FOCUS_DEGREE } from './model/graph.js';
import { MODES, STRUCTURAL_LAYOUTS, isStructuralMode } from './layout/engine.js';
import {
  createState,
  deriveRelGroups,
  deriveQualifiers,
  deriveMethods,
  resetToggles,
  summarizeHidden,
  selectVisible,
  MIN_ZOOM,
  MAX_ZOOM,
} from './state/state.js';
import { deriveCommitGroups } from './model/commitGroups.js';
import { deriveBursts } from './model/bursts.js';
import { deriveCommentBursts } from './model/commentBursts.js';
import { applyState, decodePreset } from './state/presets.js';
import { renderHiddenBanner, renderPresetPanel } from './render/controls.js';
import { actorColor } from './render/theme.js';
import { createTooltip } from './render/tooltip.js';
import { createMinimap } from './render/minimap.js';
import { createActorCard } from './render/actorCard.js';
import { createTimeline, MARGIN } from './render/timeline.js';
import { renderLegend, legendKeysPresentIn } from './render/legend.js';
import { createMessageSurface, messageHtml, errorHtml } from './render/message.js';
import { renderStats } from './render/stats.js';
import {
  renderLaneRows,
  renderRelationshipRows,
  renderActorRows,
  renderBurstControls,
  setupCombo,
  setupSearchCombo,
} from './render/sidebar.js';

const el = (id) => document.getElementById(id);

const elements = {
  chart: el('chart'),
  chartMessage: el('chartMessage'),
  statsMessage: el('statsMessage'),
  statsContent: el('statsContent'),
  sourceToggle: el('sourceToggle'),
  sourceNote: el('sourceNote'),
  scroll: el('scroll'),
  wrap: el('wrap'),
  tip: el('tip'),
  minimap: el('minimap'),
  actorCard: el('actorCard'),
  degreeStepper: el('degreeStepper'),
  breadcrumb: el('breadcrumb'),
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
  statsBreadcrumb: el('statsBreadcrumb'),
  repoInput: el('repoInput'),
  repoDropdown: el('repoDropdown'),
  objectInput: el('objectInput'),
  objectDropdown: el('objectDropdown'),
  traversalInfo: el('traversalInfo'),
};

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

const state = createState();
const tooltip = createTooltip({ tipEl: elements.tip, wrapEl: elements.wrap });
const actorCard = createActorCard({ element: elements.actorCard });

let current = null; // { graph, index, actorColors, description }
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
      // Expanding a burst or a group is a layout change; tween from the current
      // positions so nodes visibly fly apart rather than jumping.
      if (node.isBurst) {
        timeline.captureTween();
        state.expandedBursts.add(node.burst.id);
        timeline.render();
        return;
      }
      if (node.isCommentBurst) {
        timeline.captureTween();
        state.expandedCommentBursts.add(node.commentBurst.id);
        redraw();
        return;
      }
      if (node.isGroup) {
        timeline.captureTween();
        state.expandedGroups.add(node.groupKey);
        timeline.render();
        return;
      }
      if (node.groupKey) {
        timeline.captureTween();
        state.expandedGroups.delete(node.groupKey);
        timeline.render();
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
     * account for. Decision 27's rule applies: this changes the picture, so it is
     * declared and it is undoable.
     */
    onNodeDragged(nudges) {
      for (const { id, dx, dy } of nudges) state.nodeNudges.set(id, { dx, dy });
    },

    onCollapseCommentBurst(burst) {
      timeline.captureTween();
      state.expandedCommentBursts.delete(burst.id);
      redraw();
    },

    onCollapseBurst(burst) {
      timeline.captureTween();
      state.expandedBursts.delete(burst.id);
      timeline.render();
    },

    onRendered({ nodes, scales, plotWidth, basePlotWidth, kind }) {
      el('zin').disabled = state.k >= MAX_ZOOM - 0.001;
      el('zout').disabled = state.k <= MIN_ZOOM + 0.001;

      /*
       * ⚠️ **The minimap is hidden in off mode, not left showing the last picture.**
       *
       * It is a *time* overview — a strip of every event's instant, with a viewport you
       * drag along it — and off mode has no time axis for it to describe. Leaving it up
       * would be a control that silently does nothing and a picture that quietly belongs
       * to a different mode, which is the stale-picture failure decision 87 guards
       * against in the other direction. Its space is given back rather than blanked, so
       * nothing suggests a strip that failed to draw.
       */
      const structural = kind === 'structural';
      el('minimapWrap').style.display = structural ? 'none' : 'block';
      if (structural) return;

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
  const index = indexObjectGraph(graph);

  const actors = index.objectsOfType('actor');
  const actorColors = new Map(actors.map((actor, i) => [actor.id, actorColor(i)]));
  for (const actor of actors) actor.eventCount = index.eventCountByActor.get(actor.id) || 0;

  const description = describeSubLog(graph);

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
  state.focus = null;
  state.expandedBursts = new Set();
  state.expandedGroups = new Set();
  // A displacement is relative to a position in *this* sub-log; carrying it into another
  // would move a mark by an amount that meant something somewhere else.
  state.nodeNudges.clear();

  const objectColors = timeline.setGraph(graph, index, actorColors);
  const toggleContext = { relGroups, qualifiers, methods, commitGroups, objectsById: index.byId };
  current = {
    graph,
    index,
    actorColors,
    description,
    query,
    toggleContext,
    objectColors,
    commitGroups,
    groupsByCommit,
  };

  elements.breadcrumb.textContent = description;
  elements.breadcrumb.title = description;
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
    // `state.actors`, so nothing a hover does can outlive the pointer.
    onPreview: (actorId) => timeline.previewActor(actorId),
    onProfile: (actor, anchor) =>
      actorCard.open(actor, anchor, { graph, index, color: actorColors.get(actor.id) }),
  });
  renderPresetPanel({
    container: elements.presets,
    state,
    context: toggleContext,
    query: { repo: graph.meta.repo, seed: graph.meta.seed?.[0]?.id, fixture: query?.fixture },
    onApply: (snapshot) => {
      applyState(state, snapshot);
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
  // with them rather than stacking (the failure decision 75 records).
  renderLegend(elements.legend, legendKeysPresentIn(elements.chart));
  if (!current) return;
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
 * Not over the whole bundle: metrics must respond to the toggles (decision 12), so
 * hiding comments genuinely recomputes the gaps. The stats page has no sidebar
 * controls and no banner of its own, so it is also handed the hidden summary and
 * says up front that its figures describe a filtered view.
 */
function refreshStats() {
  if (!current) return;
  const { graph, index, groupsByCommit, toggleContext, description, objectColors } = current;
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
      breadcrumbEl: elements.statsBreadcrumb,
      description,
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

el('zin').onclick = () => setZoom(state.k * 1.3);
el('zout').onclick = () => setZoom(state.k / 1.3);
/*
 * One "put it back" control, not two.
 *
 * This resets the zoom and any marks dragged out of place together. A separate button for
 * the second was redundant beside a reset pill that was already there and already meant
 * "return the view to how it was computed" — and two reset controls sitting side by side
 * invite the reader to work out which one they want before either does anything.
 */
el('zrst').onclick = () => {
  state.nodeNudges.clear();
  setZoom(1);
};

/** Reflect the active mode in the segmented control. */
function markMode(mode) {
  for (const option of document.querySelectorAll('#modeSeg .seg-opt')) {
    option.classList.toggle('on', option.dataset.mode === mode);
  }
  // The arrangement control belongs to the off mode alone. Shown in the other three it
  // would be a control that silently does nothing, which this project forbids.
  el('layoutSeg').style.display = isStructuralMode(mode) ? '' : 'none';
}

/** Reflect the active structural arrangement. */
function markLayout(layout) {
  for (const option of document.querySelectorAll('#layoutSeg .seg-opt')) {
    option.classList.toggle('on', option.dataset.layout === layout);
  }
}



for (const option of document.querySelectorAll('#modeSeg .seg-opt')) {
  option.addEventListener('click', () => {
    markMode(option.dataset.mode);
    state.mode = option.dataset.mode;
    timeline.captureTween();
    timeline.render();
  });
}

for (const option of document.querySelectorAll('#layoutSeg .seg-opt')) {
  option.addEventListener('click', () => {
    markLayout(option.dataset.layout);
    state.structuralLayout = option.dataset.layout;
    timeline.captureTween();
    timeline.render();
  });
}

elements.scroll.addEventListener(
  'wheel',
  (event) => {
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

for (const header of document.querySelectorAll('.collapseHeader')) {
  header.addEventListener('click', () => {
    const target = el(header.dataset.target);
    const collapsed = target.style.display === 'none';
    target.style.display = collapsed ? 'flex' : 'none';
    header.querySelector('.chev').style.transform = collapsed ? 'rotate(0deg)' : 'rotate(-90deg)';
  });
}

/** Switch pages. Extracted so `?page=stats` can drive it as a click would. */
function showPage(page) {
  for (const other of document.querySelectorAll('.pageTab')) {
    const isThis = other.dataset.page === page;
    other.classList.toggle('on', isThis);
    other.style.color = isThis ? 'var(--color-text)' : 'var(--color-neutral-400)';
    other.style.background = isThis
      ? 'color-mix(in srgb, var(--color-accent) 16%, transparent)'
      : 'none';
    other.style.border = isThis ? '1px solid var(--color-accent)' : '1px solid transparent';
  }

  const isTimeline = page === 'timeline';
  el('timelinePage').style.display = isTimeline ? 'flex' : 'none';
  el('statsPage').style.display = isTimeline ? 'none' : 'flex';
  el('timelineSidebarSections').style.display = isTimeline ? 'flex' : 'none';
  el('statsSidebarSections').style.display = isTimeline ? 'none' : 'flex';

  if (isTimeline) {
    timeline.measure();
    redraw();
  } else {
    refreshStats();
  }
}

for (const tab of document.querySelectorAll('.pageTab')) {
  tab.addEventListener('click', () => showPage(tab.dataset.page));
}

for (const dashboard of [
  ['statsCard', 'Per-object statistics'],
  ['landmarksCard', 'Landmarks'],
]) {
  const row = document.createElement('label');
  row.className = 'sideRow on';
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
 * from. That is the `get_object_graph` contract, and the UI now names it rather
 * than picking a file.
 *
 * `?repo=` and `?seed=` make a selection reproducible by link, which the
 * task-based evaluation needs. `?fixture=` is kept as a direct address for tests
 * and for the links already written down.
 */
function queryFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return {
    repo: params.get('repo') || null,
    seed: params.get('seed') || null,
    fixture: params.get('fixture') || null,
    preset: params.get('preset') || null,
    // Server-side expansion (decision 35). Absent means "whatever the source defaults
    // to", which for the RPC is 2 and for a fixture is whatever it was built at.
    traversalDegree: params.get('degree') ? Number(params.get('degree')) : undefined,
    page: params.get('page') === 'stats' ? 'stats' : 'timeline',
    /*
     * The time mode, for the same reason `?page=` exists: a link has to reproduce what
     * someone was looking at. It matters more now than it did with three modes, because
     * the fourth changes what *position* means — "look at this sub-log" and "look at this
     * sub-log with time off" are two different requests, and the task-based evaluation
     * needs to be able to make the second one.
     *
     * A preset also carries the mode (`serializeState`), but a preset is a whole
     * configuration; this is the one knob on its own. An unknown value is ignored rather
     * than defaulted loudly — it is a URL someone typed, not a payload.
     */
    mode: MODES.includes(params.get('mode')) ? params.get('mode') : null,
    // Which arrangement the off mode uses. Same reasoning as `mode`: a link has to be
    // able to reproduce the picture, and rows and rings are two different pictures.
    layout: STRUCTURAL_LAYOUTS.includes(params.get('layout')) ? params.get('layout') : null,
  };
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
 * only way to know whether you were looking at the real database or at 13 hand-built
 * test bundles was to remember what you had typed — and an evaluation session run on
 * fixtures by accident would measure the wrong thing while looking identical to one run
 * on real data. Switching reloads the page rather than swapping the source in place,
 * because a seed from one source is meaningless in the other (fixtures key on
 * `issue:242864`, the database on `issue:2902032454`), so carrying the query across
 * would guarantee a failed load.
 */
function renderSourceToggle() {
  const OPTIONS = [
    { id: 'fixtures', label: 'Fixtures', note: 'Pre-built test sub-logs. No database.' },
    { id: 'database', label: 'Database', note: 'Live via PostgREST. Seed from any object.' },
  ];

  elements.sourceToggle.innerHTML = '';
  for (const option of OPTIONS) {
    const active = option.id === source.name;
    const button = document.createElement('button');
    button.className = 'mono';
    button.textContent = option.label;
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
  elements.sourceNote.textContent = OPTIONS.find((o) => o.id === source.name).note;
}
renderSourceToggle();

let catalogue = null;

/**
 * Populate the two selectors from the catalogue.
 *
 * Repositories with no loadable sub-log are listed and disabled with their reason
 * rather than omitted: their absence is itself a finding — the RQ2 limitation is
 * precisely about react and kubernetes — and a picker that never mentioned them
 * would hide that.
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
    // meaningful "same seed" across repositories.
    onSelect: (option) => reload({ repo: option.repo }),
  });

  /*
   * The label for the seed currently loaded.
   *
   * It used to be looked up in the catalogue's seed list, which only the fixture source
   * has — the database source searches rather than enumerating (decision 34), so there
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
    search: async (text) =>
      (await source.searchSeeds(activeRepo?.name, text)).map((seed) => ({
        label: seedLabel(seed),
        note: seed.title || null,
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

const seedLabel = (seed) => `${seed.type.replace('_', ' ')} ${seed.label}`;

async function reload(query) {
  try {
    /*
     * A repository without a seed is an incomplete query (decision 33), and how to
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
  }
}

/**
 * The state between choosing a repository and naming a seed.
 *
 * Not an error and not a blank page: the selectors are wired so the search box works,
 * and the message says what to do. This is the honest shape of decision 33 — the tool
 * cannot show a sub-log until it has been told which one.
 */
function showSeedPrompt(repoName) {
  wireSelectors(repoName, null, null);
  const html = messageHtml(
    `Choose something to start from${repoName ? ` in ${escapeForHtml(repoName)}` : ''}`,
    'A sub-log is a repository <em>and</em> an object to traverse out from, so there is ' +
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
 * State the traversal degree, and say plainly what can and cannot be seeded.
 *
 * Read-only by design (decision 35): the degree is fixed when a sub-log is built, so a
 * stepper here would be a control that silently does nothing.
 *
 * ⚠️ **What it says depends on the source, because what is true depends on the source.**
 * On fixtures, only pre-built seeds can be served and the count is a real limit worth
 * stating. Against the database the traversal runs for real, so "N seeds servable here —
 * seeding from any object needs the RPC" is false twice over: the count is meaningless
 * (there is no list, by decision 34) and the RPC is what you are already talking to.
 * Leaving that text up would be exactly the kind of stale, confidently-wrong caption
 * this project keeps finding in its own documents.
 */
function updateTraversalInfo(graph) {
  const degree = graph.meta?.traversal_degree;

  /*
   * Editable at last, and only where it can be honoured.
   *
   * Decision 35 made this read-only because the degree was fixed when a fixture was
   * built, so a stepper would have been a control that silently did nothing — the thing
   * this project forbids. `get_object_graph` takes the degree as a parameter, so against
   * the database the condition that decision named is met and the control is real. On
   * fixtures it stays text, for exactly the original reason.
   *
   * ⚠️ The steps are labelled with what they cost, because the cost is steep and
   * non-obvious: on vscode PR #116416 the sub-log goes 1 → 39 → 42 → 291 objects from
   * degree 0 to 3. A stepper that hid that would invite someone to drag it to 3 on a
   * busy seed and conclude the tool had hung.
   */
  const degreeNote = source.traversalEditable
    ? `Traversal degree ${renderDegreeControl(degree)} · server-side expansion<br>`
    : degree == null
      ? ''
      : `Traversal degree ${degree} · fixed by the query<br>`;

  /*
   * ⚠️ **Say when a seed reaches nothing.** A sub-log of one object is a legitimate
   * answer — the object exists and no detection method connects it to anything — but on
   * screen it is indistinguishable from a failure, and users reported exactly that
   * ("issue 245207 loads only itself"). Verified for that issue: zero links here AND
   * zero upstream, so the picture is right and only the silence is wrong.
   *
   * This is decision 27's principle one step further. That rule declares what the tool
   * *subtracted*; this declares what the data never had, which is the other way a sparse
   * picture misleads.
   */
  const isolated = graph.links.length === 0;
  const isolatedNote = isolated
    ? `<br>No links from this seed — nothing upstream connects it, so there is nothing ` +
      `to traverse to. The object itself is shown.`
    : '';

  if (source.name === 'database') {
    const repo = catalogue?.repos.find((entry) => entry.name === graph.meta?.repo);
    elements.traversalInfo.innerHTML =
      degreeNote +
      `Live from the database — seed from any issue, pull request or commit` +
      (repo?.seeds_total ? ` (${repo.seeds_total.toLocaleString()} searchable)` : '') +
      isolatedNote;
    bindDegreeControl(graph);
    return;
  }

  const servable = repo_seed_count(graph);
  elements.traversalInfo.innerHTML =
    degreeNote +
    `${servable} seed${servable === 1 ? '' : 's'} servable here — seeding from any ` +
    `object needs the database source (?source=database)` +
    isolatedNote;
  bindDegreeControl(graph);
}

/** Reload at a new degree, keeping the rest of the query. */
function bindDegreeControl(graph) {
  const container = document.getElementById('degreeControl');
  if (!container) return;
  for (const button of container.querySelectorAll('button[data-degree]')) {
    button.addEventListener('click', () => {
      const degree = Number(button.dataset.degree);
      if (degree === (graph.meta?.traversal_degree ?? 2)) return;
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
  const current = degree ?? 2;
  const options = [0, 1, 2, 3]
    .map(
      (d) =>
        `<button data-degree="${d}" class="mono" style="cursor:pointer;border:1px solid ` +
        `var(--color-neutral-700);background:${d === current ? 'var(--color-accent-600,#5b5bd6)' : 'transparent'};` +
        `color:${d === current ? '#fff' : 'var(--color-neutral-400)'};font-size:10px;` +
        `padding:1px 5px;border-radius:3px;margin-right:2px">${d}</button>`,
    )
    .join('');
  return `<span id="degreeControl">${options}</span>`;
}

/** How many seeds the fixture catalogue can actually serve for this sub-log's repo. */
function repo_seed_count(graph) {
  const repo = catalogue?.repos.find((entry) => entry.name === graph.meta?.repo);
  return repo?.seeds?.length ?? 0;
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
    timeline.measure();
    timeline.render();
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
    if (initialQuery.page === 'stats') showPage('stats');
  })
  .catch(showFatal);
