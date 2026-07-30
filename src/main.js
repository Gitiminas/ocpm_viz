/**
 * Wiring only — no layout, no drawing, no metrics.
 *
 * This module resolves DOM elements, creates the collaborators, and connects
 * events to state changes. If logic starts accumulating here, it belongs in a
 * module instead.
 */

/* global d3 */

import { loadObjectGraph, describeSubLog } from './data/loadObjectGraph.js';
import { FIXTURES } from './data/fixtures.js';
import { indexObjectGraph } from './model/objectGraph.js';
import { LANE_TYPES } from './model/activities.js';
import { MAX_FOCUS_DEGREE } from './model/graph.js';
import { createState, deriveRelGroups, resetRelPairs, MIN_ZOOM, MAX_ZOOM } from './state/state.js';
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
  statsGrid: el('statsGrid'),
  statsMilestones: el('statsMilestones'),
  statsBreadcrumb: el('statsBreadcrumb'),
  repoInput: el('repoInput'),
  repoDropdown: el('repoDropdown'),
  objectInput: el('objectInput'),
  objectDropdown: el('objectDropdown'),
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
  current = { graph, index, actorColors, description, query };

  const relGroups = deriveRelGroups(graph.links, index.byId);
  resetRelPairs(state, relGroups);
  state.focus = null;
  state.expandedBursts = new Set();
  state.expandedGroups = new Set();

  elements.breadcrumb.textContent = description;
  elements.breadcrumb.title = description;
  updateFocusLabel();

  renderTrackRows({
    container: elements.tracks,
    state,
    laneTypes: LANE_TYPES,
    onChange: () => timeline.render(),
    relSync: () => relSync(),
  });
  relSync = renderRelationshipRows({
    container: elements.relationships,
    state,
    relGroups,
    onChange: () => timeline.render(),
  });
  renderActorRows({
    container: elements.actors,
    searchInput: elements.actorSearch,
    actors,
    actorColors,
    state,
    onChange: () => timeline.render(),
    onProfile: (actor, anchor) =>
      actorCard.open(actor, anchor, { graph, index, color: actorColors.get(actor.id) }),
  });
  renderLegend(elements.legend);

  wireObjectCombo(graph);

  timeline.setGraph(graph, index, actorColors);
  timeline.measure();
  timeline.render();
  refreshStats();
}

function refreshStats() {
  if (!current) return;
  renderStats({
    graph: current.graph,
    index: current.index,
    gridEl: elements.statsGrid,
    milestonesEl: elements.statsMilestones,
    breadcrumbEl: elements.statsBreadcrumb,
    description: current.description,
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

for (const tab of document.querySelectorAll('.pageTab')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.pageTab')) {
      other.classList.remove('on');
      other.style.color = 'var(--color-neutral-400)';
      other.style.background = 'none';
      other.style.border = '1px solid transparent';
    }
    tab.classList.add('on');
    tab.style.color = 'var(--color-text)';
    tab.style.background = 'color-mix(in srgb, var(--color-accent) 16%, transparent)';
    tab.style.border = '1px solid var(--color-accent)';

    const isTimeline = tab.dataset.page === 'timeline';
    el('timelinePage').style.display = isTimeline ? 'flex' : 'none';
    el('statsPage').style.display = isTimeline ? 'none' : 'flex';
    el('timelineSidebarSections').style.display = isTimeline ? 'flex' : 'none';
    el('statsSidebarSections').style.display = isTimeline ? 'none' : 'flex';

    if (isTimeline) {
      timeline.measure();
      timeline.render();
    } else {
      refreshStats();
    }
  });
}

for (const dashboard of [
  ['statsCard', 'Sub-log statistics'],
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

setupCombo({
  input: elements.repoInput,
  dropdown: elements.repoDropdown,
  options: Object.values(FIXTURES).map((fixture) => ({
    label: fixture.label,
    fixture: fixture.id,
    active: true,
  })),
  initialLabel: Object.values(FIXTURES)[0].label,
  onSelect: (option) => reload({ fixture: option.fixture }),
});

/**
 * The object combo focuses an object rather than reloading.
 *
 * Selecting an object *within* the loaded sub-log is a focus change. Selecting one
 * outside it would need a new traversal from the RPC, which does not exist yet — so
 * the list is scoped to what is loaded, rather than offering choices that cannot be
 * honoured.
 */
function wireObjectCombo(graph) {
  const options = graph.objects
    .filter((object) => object.type !== 'actor')
    .map((object) => ({ label: `${object.type}: ${object.label}`, id: object.id }));

  setupCombo({
    input: elements.objectInput,
    dropdown: elements.objectDropdown,
    options,
    initialLabel: options[0]?.label ?? '',
    onSelect: (option) => {
      state.focus = option.id;
      state.focusDegree = 1;
      updateFocusLabel();
      timeline.render();
    },
  });
}

async function reload(query) {
  try {
    await load(query);
  } catch (error) {
    showFatal(error);
  }
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

reload({ fixture: 'F1' });
