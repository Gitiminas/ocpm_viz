/**
 * View state, and the pure predicates that decide what is visible.
 *
 * One mutable object, as in the mockup — but the fields that hardcoded a single
 * issue, a single PR and a single burst are now collections, and every dimension of
 * the picture is independently toggleable.
 *
 * The filters are deliberately **independent and ANDed**. A link is drawn only if
 * its lanes, its object-pair, its qualifier, its detection method and both its
 * endpoints all survive. That is what "independently toggleable" has to mean: no
 * toggle may quietly override another, because a user who switches something off
 * and still sees it has been lied to.
 *
 * The predicates live here rather than in the renderers so that "what is visible"
 * is testable without drawing anything.
 */

import { DEFAULT_COMMENT_WINDOW_DAYS } from '../model/commentBursts.js';
import { EVIDENCE, ISSUE_PR_METHODS } from '../model/evidence.js';
import { isCommitInVisibleGroup } from '../model/commitGroups.js';
import { activityShortLabel, isActorRole } from '../model/activities.js';
import { subjectOf } from '../model/subLog.js';
import { LANE_TYPES, TYPE_LABELS, DFG_TYPE_LABELS } from './labels.js';

export const MIN_ZOOM = 0.55;
export const MAX_ZOOM = 14;

/*
 * There is no `TOGGLEABLE_METHODS` constant. Actor attribution is single-sourced on
 * `event.actor_id` rather than being a link method, so there is no exception to carve
 * out of the filter, and an alias for "all of them" is not worth a name. The toggles
 * are derived from the loaded sub-log by `deriveMethods` regardless.
 */

export function createState() {
  return {
    /** Horizontal zoom multiplier. */
    k: 1,
    /** Active time mode: absolute | discrete | relationships. */
    mode: 'absolute',
    /**
     * The brushed time range in the relationships mode, as two fractions of the sub-log's span.
     *
     * Fractions rather than instants, so the range keeps its meaning when the sub-log
     * changes underneath it — "the last third" survives an expanded push or a hidden
     * lane, where two absolute timestamps would quietly start describing a different
     * portion of a different span. `[0, 1]` is no brush at all.
     */
    timeBrush: [0, 1],

    /**
     * Marks the reader has dragged, as an OFFSET from where the layout put them.
     *
     * ⚠️ An offset rather than a position, deliberately. Both structural layouts are pure
     * functions of the sub-log, and storing absolute coordinates would mean a dragged
     * mark stayed put while everything around it moved on a zoom, a resize or an expanded
     * push — pinned to the canvas rather than to its neighbours. An offset survives all
     * three: the mark keeps the displacement the reader gave it, relative to wherever its
     * cluster now is.
     *
     * Deliberately NOT in a preset: a preset captures what is shown, not
     * where you were looking, and a hand-nudged node is the latter.
     *
     * ⚠️ Keyed by ARRANGEMENT first: `Map<structuralLayout, Map<nodeId, {dx, dy}>>`,
     * read through `nudgesFor()`. An offset is relative to where *one* arrangement put
     * the node; re-applied to the other it moved marks by amounts that meant something
     * somewhere else — a drag in Rows sent clusters off screen. Each arrangement keeps
     * its own nudges and shows its own computed layout when switched to.
     */
    nodeNudges: new Map(),

    /**
     * How the relationships mode arranges a sub-log: `layered` (rows) or `cluster` (clusters).
     *
     * Only read when `mode === 'relationships'`. Two geometries for one question — rows read as a
     * process direction and match the timeline's lane order, rings read as containment
     * and suit a hub-shaped sub-log. Neither is right in general, so it is the reader's.
     */
    structuralLayout: 'layered',
    /** Focused object id, or null. Client-side highlighting only. */
    focus: null,
    /** BFS depth from the focused object. Capped at 2 by the graph model. */
    focusDegree: 1,
    /** Actor ids whose trails are drawn. */
    actors: new Set(),

    /** Lane visibility, by object type. */
    lanes: { issue: true, pull_request: true, commit: true },
    /** Comment visibility, per lane. */
    showComments: { issue: true, pull_request: true },
    /** Sidebar sub-row expansion, per lane. */
    laneOpen: { issue: false, pull_request: false, commit: false },

    /**
     * Individual objects hidden by id — one of two concurrent PRs, say, without
     * hiding the lane. Stored as the *hidden* set rather than the visible one so a
     * newly loaded sub-log defaults to showing everything, whatever it contains.
     */
    hiddenObjects: new Set(),
    /** Commit groups hidden by key (a PR id, or UNLINKED_GROUP). */
    hiddenCommitGroups: new Set(),

    /** Link visibility by evidence × object-type pair. Filled on load. */
    relPairs: {},
    /** Link visibility by qualifier. Filled on load. */
    qualifiers: {},
    /** Link visibility by detection method. Filled on load. */
    methods: {},
    /** Sidebar group expansion. */
    relOpen: { validated: false, extracted: false, qualifiers: false, methods: false },

    /** Burst ids the user has unfolded. Empty means every burst is collapsed. */
    expandedBursts: new Set(),
    /** Comment-burst ids the user has unfolded. */
    expandedCommentBursts: new Set(),
    /*
     * How close in time comments must be to fold together, in days.
     *
     * A control rather than a constant, because unlike a push there is no key in the
     * data that says which comments belong together — so the reader sets what "close"
     * means and watches the answer change.
     */
    commentWindowDays: DEFAULT_COMMENT_WINDOW_DAYS,
    /** Highlight-mode group keys the user has unfolded. */
  };
}

/** Stable key for a link's toggle: evidence class plus its sorted type pair. */
/**
 * The drag offsets for one arrangement — by default the one currently on — created on
 * first use. Clearing `state.nodeNudges` itself drops every arrangement's offsets at
 * once, which is what the reset pill and a new sub-log want.
 */
export function nudgesFor(state, layout = state.structuralLayout) {
  let map = state.nodeNudges.get(layout);
  if (!map) {
    map = new Map();
    state.nodeNudges.set(layout, map);
  }
  return map;
}

export function linkPairKey(link, byId) {
  const source = byId.get(link.source);
  const target = byId.get(link.target);
  if (!source || !target) return null;
  const types = [source.type, target.type].sort().join('_');
  return `${link.evidence}_${types}`;
}

/**
 * Derive the relationship toggle groups from the links actually present.
 *
 * The mockup enumerated exactly four evidence × type-pair combinations, which is
 * correct only for this one sub-log.
 */
export function deriveRelGroups(links, byId) {
  const seen = new Map();

  for (const link of links) {
    const key = linkPairKey(link, byId);
    if (!key || seen.has(key)) continue;

    const source = byId.get(link.source);
    const target = byId.get(link.target);
    const types = [source.type, target.type].sort();

    seen.set(key, {
      key,
      evidence: link.evidence,
      types,
      label: types.map((t) => TYPE_LABELS[t] || t).join(' ↔ '),
    });
  }

  const groups = [
    { key: EVIDENCE.VALIDATED, label: 'Validated links', pairs: [] },
    { key: EVIDENCE.EXTRACTED, label: 'Extracted links', pairs: [] },
  ];
  for (const pair of seen.values()) {
    const group = groups.find((g) => g.key === pair.evidence);
    if (group) group.pairs.push(pair);
  }
  for (const group of groups) group.pairs.sort((a, b) => a.label.localeCompare(b.label));
  return groups.filter((group) => group.pairs.length > 0);
}

/** Qualifiers present in this sub-log, with counts so the UI can show weight. */
export function deriveQualifiers(links) {
  const counts = new Map();
  for (const link of links) {
    counts.set(link.qualifier, (counts.get(link.qualifier) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: key, count }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Detection methods, with counts.
 *
 * The four issue↔PR methods are listed even when this sub-log uses none of them, so
 * a per-method toggle exists regardless of what is loaded. A
 * method you cannot switch off because the current data happens not to use it is a
 * gap in the control, not an absence of one — and F1 exercises only `pr_body`, so
 * without this the other three would be untestable.
 */
export function deriveMethods(links) {
  const counts = new Map();
  for (const method of ISSUE_PR_METHODS) counts.set(method, 0);
  for (const link of links) {
    if (!link.method) continue;
    counts.set(link.method, (counts.get(link.method) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: key, count }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Turn every derived toggle on. Called whenever a new sub-log loads. */
export function resetToggles(state, { relGroups = [], qualifiers = [], methods = [] } = {}) {
  state.relPairs = {};
  for (const group of relGroups) {
    for (const pair of group.pairs) state.relPairs[pair.key] = true;
  }
  state.qualifiers = {};
  for (const qualifier of qualifiers) state.qualifiers[qualifier.key] = true;
  state.methods = {};
  for (const method of methods) state.methods[method.key] = true;

  state.hiddenObjects = new Set();
  state.hiddenCommitGroups = new Set();
  return state;
}

// ---------------------------------------------------------------------------
// Visibility predicates — pure, and the single source of truth for what shows.
// ---------------------------------------------------------------------------

/** Whether an individual object survives its own toggle and its lane's. */
export function isObjectVisible(object, state) {
  if (!object) return false;
  if (state.lanes[object.type] === false) return false;
  return !state.hiddenObjects.has(object.id);
}

/** Whether a node survives every filter that applies to it. */
export function isNodeVisible(node, state, groupsByCommit = new Map()) {
  if (!state.lanes[node.lane]) return false;
  if (node.isComment && state.showComments[node.lane] === false) return false;

  // A burst stands for many commits, and a fold group for many nodes. Either
  // survives while any of its members does — folding is a display choice and must
  // not decide visibility on its members' behalf.
  if (node.isBurst && node.burst) {
    for (const commitId of node.burst.commitIds) {
      if (isCommitInVisibleGroup(commitId, groupsByCommit, state.hiddenCommitGroups)) return true;
    }
    return false;
  }
  if (node.objectId && state.hiddenObjects.has(node.objectId)) return false;
  if (node.lane === 'commit' && node.objectId) {
    return isCommitInVisibleGroup(node.objectId, groupsByCommit, state.hiddenCommitGroups);
  }
  return true;
}

/**
 * Whether a link survives every filter.
 *
 * Five independent conditions, all of which must hold. Each is separated so that a
 * link's absence is attributable to one named control rather than to "the filters".
 *
 * There is no sixth for `qualifier === 'actor'`. Those links are removed from the data
 * instead, which is the honest place for the rule — a predicate that answers "no" for a
 * whole class regardless of state is not a filter, it is a deletion performed late.
 */
export function isLinkVisible(link, byId, state, groupsByCommit = new Map()) {
  if (!linkEndpointsVisible(link, byId, state, groupsByCommit)) return false;

  if (state.relPairs[linkPairKey(link, byId)] === false) return false;
  if (state.qualifiers[link.qualifier] === false) return false;
  if (link.method && state.methods[link.method] === false) return false;

  return true;
}

/** The object half of `isLinkVisible`: both endpoints resolve and are drawn. */
function linkEndpointsVisible(link, byId, state, groupsByCommit) {
  const source = byId.get(link.source);
  const target = byId.get(link.target);
  if (!source || !target) return false;

  if (!isObjectVisible(source, state) || !isObjectVisible(target, state)) return false;

  for (const endpoint of [source, target]) {
    if (endpoint.type !== 'commit') continue;
    if (!isCommitInVisibleGroup(endpoint.id, groupsByCommit, state.hiddenCommitGroups)) return false;
  }
  return true;
}

/**
 * Which relationship controls still govern a link that could be drawn.
 *
 * A control is *available* when at least one link would pass every filter except the
 * control's own — the lanes, the per-object and commit-group hides, and the two other
 * link bags. A pair row with its lane hidden, a qualifier whose every link sits on a
 * switched-off pair, a method no visible link carries: each is inert, dimmed rather
 * than removed, because switching it would change nothing on screen and a control that
 * does nothing reads as a control that is broken. The rule is one rule for all three,
 * so the sidebar cannot apply it to pairs and forget it for qualifiers.
 *
 * Only a control's own bag is excluded, never the other two, so a control switched
 * off by hand stays available and can be switched back on: it dims only when something
 * *else* has emptied it.
 *
 * @returns {{pairs: Set<string>, qualifiers: Set<string>, methods: Set<string>}}
 */
export function relControlAvailability(links, byId, state, groupsByCommit = new Map()) {
  const pairs = new Set();
  const qualifiers = new Set();
  const methods = new Set();
  for (const link of links) {
    if (!linkEndpointsVisible(link, byId, state, groupsByCommit)) continue;
    const pairKey = linkPairKey(link, byId);
    const pairOn = state.relPairs[pairKey] !== false;
    const qualifierOn = state.qualifiers[link.qualifier] !== false;
    const methodOn = !link.method || state.methods[link.method] !== false;
    if (qualifierOn && methodOn) pairs.add(pairKey);
    if (pairOn && methodOn) qualifiers.add(link.qualifier);
    if (pairOn && qualifierOn && link.method) methods.add(link.method);
  }
  return { pairs, qualifiers, methods };
}

/**
 * What to draw while an actor row is merely hovered.
 *
 * Hovering previews a trail; clicking pins it. The two share one drawing path, and this
 * is the whole difference between them — a throwaway selection of exactly one actor,
 * built without touching `state.actors`, so letting go of the mouse cannot disturb what
 * the user has pinned.
 *
 * Returns `null` when there is nothing to preview: no actor, or an actor whose trail is
 * already pinned. Drawing a preview over a pinned trail would double every stroke and
 * make the pinned one appear to brighten on hover, which reads as a state change that
 * did not happen.
 *
 * @returns {{actors: Set<string>}|null} a state-shaped object for `renderActorTrails`
 */
export function actorPreview(actorId, state) {
  if (!actorId) return null;
  if (state.actors.has(actorId)) return null;
  return { actors: new Set([actorId]) };
}

/**
 * The sub-log as currently filtered: only the objects, events and links on screen.
 *
 * Metrics are computed over *this*, not over the whole bundle, because they must
 * respond to the toggles. Hiding comments has to recompute gaps — a
 * gap analysis that silently counts events you have switched off answers a question
 * nobody asked, and would answer "no" to "does this change the bottleneck?" without
 * ever saying so.
 *
 * ⚠️ Folding is **not** filtering. A collapsed burst still contributes all twenty of
 * its commits here, because collapsing is a display choice about density, not a
 * statement that those commits are out of scope. Conflating the two would make the
 * commit count jump when you fold a push.
 */
/**
 * What the sub-log card should count for the ACTIVE MODE, given a summary of the visible
 * selection (`summarizeSubLog(selectVisible(...))`).
 *
 * An actor is drawn, in every mode, only once its trail is pinned — nothing else on the
 * canvas stands for one — so "actors" is the pinned ones that are in the selection,
 * against the payload's total: "0 / 16" says what it means. The two timeline modes draw
 * one mark per event, so the rest of the summary is right as it is. The relationships
 * mode draws one mark per issue, pull request or commit — its events are folded into
 * that mark and its comments into a count on it — so there "artifacts" is the number of
 * marks (the visible issue, PR and commit objects). Counting events there would declare
 * marks that are not on screen, which is exactly what the card exists to not do.
 *
 * A hovered actor row previews its trail without touching `state.actors`, so the card
 * takes the previewed id separately and counts it like a pin for as long as the pointer
 * stays — the number and the canvas then say the same thing.
 *
 * Pure and DOM-free: takes the summary and the visible graph, returns a new summary.
 *
 * @param {object} summary        `summarizeSubLog` over the visible selection
 * @param {object} visible        the visible selection itself (for the actor ids in it)
 * @param {object} state          `st` — reads `mode` and `actors`
 * @param {object} [options]
 * @param {string|null} [options.previewActor]  the actor whose trail is previewed on hover
 */
export function summaryForMode(summary, visible, state, { previewActor = null } = {}) {
  const counts = new Map(summary.counts);
  const visibleActors = new Set(
    visible.objects.filter((object) => object.type === 'actor').map((object) => object.id),
  );
  const drawn = new Set(state.actors);
  if (previewActor) drawn.add(previewActor);
  counts.set('actor', [...drawn].filter((id) => visibleActors.has(id)).length);
  const events =
    state.mode === 'relationships'
      ? LANE_TYPES.reduce((n, type) => n + (counts.get(type) ?? 0), 0)
      : summary.events;
  return { ...summary, counts, events };
}

export function selectVisible(graph, state, groupsByCommit = new Map()) {
  const objects = graph.objects.filter((object) => {
    // `actor` is the only laneless object type.
    // Laneless objects survive every lane filter: there is no control that hides
    // them here, and the actor list and actor card read this same selection.
    if (object.type === 'actor') return true;
    if (!isObjectVisible(object, state)) return false;
    if (object.type === 'commit') {
      return isCommitInVisibleGroup(object.id, groupsByCommit, state.hiddenCommitGroups);
    }
    return true;
  });

  const visibleIds = new Set(objects.map((object) => object.id));
  const byId = new Map(graph.objects.map((object) => [object.id, object]));

  /*
   * Per visible relationship. An event stays while at least one object it is about is
   * drawn, and keeps only the relationships to drawn objects (actors always) — so a push
   * of three commits with one folded away is still one event, about two. An event none
   * of whose objects survive drops. The comment toggle is keyed on the subject's type:
   * a comment is about exactly one issue or pull request, never a push.
   */
  const events = [];
  for (const event of graph.events) {
    if (event.comment) {
      const type = byId.get(subjectOf(event))?.type;
      if (state.showComments[type] === false) continue;
    }
    if (!event.relationships) {
      // Contract v2: one object, one column.
      if (visibleIds.has(event.object_id)) events.push(event);
      continue;
    }
    const kept = event.relationships.filter(
      (rel) => isActorRole(rel.qualifier) || visibleIds.has(rel.object_id),
    );
    if (!kept.some((rel) => !isActorRole(rel.qualifier))) continue;
    events.push(kept.length === event.relationships.length ? event : { ...event, relationships: kept });
  }

  const links = graph.links.filter((link) => isLinkVisible(link, byId, state, groupsByCommit));

  return { meta: graph.meta, objects, events, links };
}

// ---------------------------------------------------------------------------
// what is hidden — the mitigation that makes all this filtering safe
// ---------------------------------------------------------------------------

/**
 * Everything currently filtered out, as structured facts the UI must always show.
 *
 * This is not a nicety. Filtering and saved views leave state the user cannot see:
 * a sparse timeline reads as "this project had few links" when the truth is "you
 * switched the links off". The user cannot distinguish those two states from the
 * picture alone, and a misreading of that kind would go straight into a reported
 * finding. Every control that can subtract therefore reports here, and the summary
 * is non-dismissible while anything is hidden.
 *
 * Returns items rather than a sentence so the renderer can attach a one-click
 * restore to each.
 *
 * @param {object} state
 * @param {object} context  derived vocabulary and object lists for labelling
 */
export function summarizeHidden(state, context = {}) {
  const items = [];
  const { relGroups = [], qualifiers = [], methods = [], objectsById = new Map(), commitGroups = [] } =
    context;

  const hiddenLanes = LANE_TYPES.filter((lane) => state.lanes[lane] === false);
  if (hiddenLanes.length) {
    items.push({
      key: 'lanes',
      label: `${hiddenLanes.map((lane) => TYPE_LABELS[lane] || lane).join(', ')} lane${hiddenLanes.length === 1 ? '' : 's'} hidden`,
      restore: (s) => hiddenLanes.forEach((lane) => (s.lanes[lane] = true)),
    });
  }

  const hiddenComments = Object.keys(state.showComments).filter(
    (lane) => state.showComments[lane] === false,
  );
  if (hiddenComments.length) {
    items.push({
      key: 'comments',
      label: `comments hidden on ${hiddenComments.map((lane) => TYPE_LABELS[lane] || lane).join(', ')}`,
      restore: (s) => hiddenComments.forEach((lane) => (s.showComments[lane] = true)),
    });
  }

  if (state.hiddenObjects.size) {
    const labels = [...state.hiddenObjects]
      .map((id) => objectsById.get(id)?.label || id)
      .sort()
      .join(', ');
    items.push({
      key: 'objects',
      label: `${state.hiddenObjects.size} object${state.hiddenObjects.size === 1 ? '' : 's'} hidden (${labels})`,
      restore: (s) => s.hiddenObjects.clear(),
    });
  }

  if (state.hiddenCommitGroups.size) {
    const labels = [...state.hiddenCommitGroups]
      .map((key) => commitGroups.find((group) => group.key === key)?.label || key)
      .sort()
      .join(', ');
    items.push({
      key: 'commitGroups',
      label: `commits of ${labels} hidden`,
      restore: (s) => s.hiddenCommitGroups.clear(),
    });
  }

  const offPairs = relGroups
    .flatMap((group) => group.pairs)
    .filter((pair) => state.relPairs[pair.key] === false);
  if (offPairs.length) {
    items.push({
      key: 'relPairs',
      label: `${offPairs.length} link class${offPairs.length === 1 ? '' : 'es'} hidden (${offPairs.map((p) => p.label).join(', ')})`,
      restore: (s) => offPairs.forEach((pair) => (s.relPairs[pair.key] = true)),
    });
  }

  const offQualifiers = qualifiers.filter((q) => state.qualifiers[q.key] === false);
  if (offQualifiers.length) {
    items.push({
      key: 'qualifiers',
      label: `qualifier${offQualifiers.length === 1 ? '' : 's'} hidden (${offQualifiers.map((q) => q.label).join(', ')})`,
      restore: (s) => offQualifiers.forEach((q) => (s.qualifiers[q.key] = true)),
    });
  }

  const offMethods = methods.filter((m) => state.methods[m.key] === false);
  if (offMethods.length) {
    items.push({
      key: 'methods',
      label: `detection method${offMethods.length === 1 ? '' : 's'} hidden (${offMethods.map((m) => m.label).join(', ')})`,
      restore: (s) => offMethods.forEach((m) => (s.methods[m.key] = true)),
    });
  }

  return { anyHidden: items.length > 0, items };
}

/**
 * What the Process page's view hides, for its hidden-state banner — the same shape
 * `summarizeHidden` above gives the Trace page: `{anyHidden, items}`, each item a label
 * and a `restore(view)` that undoes that one subtraction. Pure, so the banner's wording
 * and its restores are testable without a DOM.
 *
 * @param {object} view        the page's view state (`dfgView` in main.js)
 * @param {object} vocabulary  `deriveDfgToggles(dfg)` (model/dfg.js)
 * @param {{hiddenByRange?: number}} [counts]  `filterDfg`'s readout, for the range item
 */
export function summarizeDfgHidden(view, vocabulary, counts = {}) {
  const items = [];
  const label = (type) => DFG_TYPE_LABELS[type] || type;

  // `view.lanes` switches a lane's own successions, not the lane: the marks stay.
  const lanes = vocabulary.lanes.filter((lane) => view.lanes?.[lane.type] === false);
  if (lanes.length) {
    items.push({
      key: 'lanes',
      label: `successions within ${lanes.map((lane) => label(lane.type)).join(', ')} hidden`,
      restore: (v) => lanes.forEach((lane) => (v.lanes[lane.type] = true)),
    });
  }
  const pairs = vocabulary.pairs.filter((pair) => view.pairs?.[pair.key] === false);
  if (pairs.length) {
    items.push({
      key: 'pairs',
      label:
        `${pairs.length} link pair${pairs.length === 1 ? '' : 's'} hidden ` +
        `(${pairs.map((pair) => pair.types.map(label).join(' ↔ ')).join(', ')})`,
      restore: (v) => pairs.forEach((pair) => (v.pairs[pair.key] = true)),
    });
  }
  for (const [key, field, rows, noun] of [
    ['evidence', 'linkEvidence', vocabulary.linkEvidence, 'evidence class'],
    ['qualifiers', 'linkQualifiers', vocabulary.linkQualifiers, 'qualifier'],
    ['methods', 'linkMethods', vocabulary.linkMethods, 'detection method'],
  ]) {
    const off = (rows || []).filter((row) => view[field]?.[row.key] === false);
    if (!off.length) continue;
    items.push({
      key,
      label: `${noun}${off.length === 1 ? '' : 's'} hidden (${off.map((row) => row.key).join(', ')})`,
      restore: (v) => off.forEach((row) => (v[field][row.key] = true)),
    });
  }
  const hiddenActivities = view.hiddenActivities ?? new Set();
  if (hiddenActivities.size) {
    const names = [...hiddenActivities]
      .map((k) => k.split('/'))
      .map(([type, activity]) => `${label(type)} ${activityShortLabel(activity)}`)
      .sort()
      .join(', ');
    items.push({
      key: 'activities',
      label: `${hiddenActivities.size} activit${hiddenActivities.size === 1 ? 'y' : 'ies'} hidden (${names})`,
      restore: (v) => v.hiddenActivities.clear(),
    });
  }
  const [low, high] = view.range ?? vocabulary.defaultRange;
  const [dLow, dHigh] = vocabulary.defaultRange;
  const hiddenByRange = counts.hiddenByRange ?? 0;
  if (hiddenByRange > 0 && (low !== dLow || high !== dHigh)) {
    items.push({
      key: 'range',
      label:
        `${hiddenByRange} arrow${hiddenByRange === 1 ? '' : 's'} outside the count range ` +
        `${low.toLocaleString('en-US')}–${high.toLocaleString('en-US')}`,
      restore: (v) => (v.range = [...vocabulary.defaultRange]),
    });
  }
  return { anyHidden: items.length > 0, items };
}

/** Undo every subtraction at once. */
export function restoreAll(state, context) {
  for (const item of summarizeHidden(state, context).items) item.restore(state);
  return state;
}

export { LANE_TYPES };
