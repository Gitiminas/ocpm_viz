/**
 * Wiring only — no layout, no drawing, no metrics.
 *
 * This module resolves DOM elements, creates the collaborators, and connects
 * events to state changes. If logic starts accumulating here, it belongs in a
 * module instead.
 */

/* global d3 */

import { loadObjectGraph, describeSubLog } from './data/loadObjectGraph.js';
import { loadCatalogue } from './data/fixtures.js';
import { indexObjectGraph } from './model/objectGraph.js';
import { LANE_TYPES } from './model/activities.js';
import { MAX_FOCUS_DEGREE } from './model/graph.js';
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
import { applyState, decodePreset } from './state/presets.js';
import { renderHiddenBanner, renderPresetPanel } from './render/controls.js';
import { actorColor } from './render/theme.js';
import { createTooltip } from './render/tooltip.js';
import { createMinimap } from './render/minimap.js';
import { createActorCard } from './render/actorCard.js';
import { createTimeline, MARGIN } from './render/timeline.js';
import { renderLegend } from './render/legend.js';
import { renderStats } from './render/stats.js';
import {
  renderTrackRows,
  renderRelationshipRows,
  renderActorRows,
  renderBurstControls,
  setupCombo,
} from './render/sidebar.js';

const el = (id) => document.getElementById(id);

const elements = {
  chart: el('chart'),
  scroll: el('scroll'),
  wrap: el('wrap'),
  tip: el('tip'),
  minimap: el('minimap'),
  actorCard: el('actorCard'),
  degreeStepper: el('degreeStepper'),
  breadcrumb: el('breadcrumb'),
  focusInfo: el('focusInfo'),
  tracks: el('tracks'),
  relationships: el('relationships'),
  actors: el('actors'),
  actorSearch: el('actorSearch'),
  legend: el('legend'),
  bursts: el('bursts'),
  presets: el('presets'),
  hiddenBanner: el('hiddenBanner'),
  toast: el('toast'),
  statsGrid: el('statsGrid'),
  statsMilestones: el('statsMilestones'),
  statsBreadcrumb: el('statsBreadcrumb'),
  repoInput: el('repoInput'),
  repoDropdown: el('repoDropdown'),
  objectInput: el('objectInput'),
  objectDropdown: el('objectDropdown'),
  traversalInfo: el('traversalInfo'),
};

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

    onCollapseBurst(burst) {
      timeline.captureTween();
      state.expandedBursts.delete(burst.id);
      timeline.render();
    },

    onRendered({ nodes, scales, plotWidth, basePlotWidth }) {
      el('zin').disabled = state.k >= MAX_ZOOM - 0.001;
      el('zout').disabled = state.k <= MIN_ZOOM + 0.001;
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
  const graph = await loadObjectGraph(query);
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
  renderLegend(elements.legend);
  wireSelectors(graph.meta.repo, graph.meta.seed?.[0]?.id);

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

  renderTrackRows({
    container: elements.tracks,
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
    bursts: deriveBursts(index.objectsOfType('commit'), { threshold: state.burstThreshold }),
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
  timeline.render();
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
  const { graph, index, groupsByCommit, toggleContext, description } = current;
  renderStats({
    graph: selectVisible(graph, state, groupsByCommit),
    index,
    gridEl: elements.statsGrid,
    milestonesEl: elements.statsMilestones,
    breadcrumbEl: elements.statsBreadcrumb,
    description,
    hiddenSummary: summarizeHidden(state, toggleContext),
    onRerender: refreshStats,
  });
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
el('zrst').onclick = () => setZoom(1);

for (const option of document.querySelectorAll('#modeSeg .seg-opt')) {
  option.addEventListener('click', () => {
    for (const other of document.querySelectorAll('#modeSeg .seg-opt')) other.classList.remove('on');
    option.classList.add('on');
    state.mode = option.dataset.mode;
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
  ['milestonesCard', 'Milestones'],
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
    page: params.get('page') === 'stats' ? 'stats' : 'timeline',
  };
}

const initialQuery = queryFromUrl();

let catalogue = null;

/**
 * Populate the two selectors from the catalogue.
 *
 * Repositories with no loadable sub-log are listed and disabled with their reason
 * rather than omitted: their absence is itself a finding — the RQ2 limitation is
 * precisely about react and kubernetes — and a picker that never mentioned them
 * would hide that.
 */
function wireSelectors(activeRepoName, activeSeedId) {
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

  const seeds = activeRepo?.seeds ?? [];
  const activeSeed = seeds.find((seed) => seed.id === activeSeedId) || seeds[0];

  setupCombo({
    input: elements.objectInput,
    dropdown: elements.objectDropdown,
    options: seeds.map((seed) => ({
      label: `${seed.type.replace('_', ' ')} ${seed.label}`,
      seed: seed.id,
      note: seed.yields,
      active: seed.id === activeSeed?.id,
    })),
    initialLabel: activeSeed ? `${activeSeed.type.replace('_', ' ')} ${activeSeed.label}` : '',
    onSelect: (option) => reload({ repo: activeRepo.name, seed: option.seed }),
  });
}

async function reload(query) {
  try {
    await load(query);
  } catch (error) {
    showFatal(error);
  }
}

/**
 * State the traversal degree, and say plainly what can and cannot be seeded.
 *
 * Read-only by design: the degree is fixed when a sub-log is built, so a stepper
 * here would be a control that silently does nothing.
 */
function updateTraversalInfo(graph) {
  const degree = graph.meta?.traversal_degree;
  const repo = catalogue?.repos.find((entry) => entry.name === graph.meta?.repo);
  const servable = repo?.seeds.length ?? 0;

  elements.traversalInfo.innerHTML =
    (degree == null ? '' : `Traversal degree ${degree} · fixed by the query<br>`) +
    `${servable} seed${servable === 1 ? '' : 's'} servable here — seeding from any ` +
    `object needs the RPC`;
}

// ---------------------------------------------------------------------------
// startup
// ---------------------------------------------------------------------------

function showFatal(error) {
  console.error(error);
  elements.chart.innerHTML =
    '<div style="padding:32px;max-width:760px">' +
    '<div style="font-size:15px;font-weight:600;color:var(--color-text);margin-bottom:8px">' +
    'Could not render this sub-log</div>' +
    '<pre class="mono" style="white-space:pre-wrap;font-size:12px;color:var(--color-neutral-400);' +
    'line-height:1.6;margin:0">' +
    String(error.message || error).replace(/</g, '&lt;') +
    '</pre></div>';
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
loadCatalogue()
  .then((loaded) => {
    catalogue = loaded;
    return reload(initialQuery);
  })
  .then(() => {
    if (initialQuery.page === 'stats') showPage('stats');
  })
  .catch(showFatal);
