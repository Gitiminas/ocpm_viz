/**
 * The node and edge model for the **off** time mode.
 *
 * Off mode is the same two-step design procedure as the timeline, run with *relationships*
 * as the primary facet and *time* as the secondary one. Time is not deleted, it is
 * demoted: position stops encoding it and it moves to weaker channels — a fill ramp, edge
 * arrowheads, a time brush, and the hovercard's first row. This module is the primary
 * facet's half of that: what the graph *is*, once time is no longer arranging it.
 *
 * ## One node per object, and that is the substantive difference
 *
 * The timeline draws one node per **event** in the issue and PR lanes — an issue with
 * 288 comments is 290 marks on a row. Here an object is one node and its whole lifecycle
 * is collapsed into it, because clusters are the thing being read and a single busy issue
 * would otherwise dominate the layout with comment traffic. The lifecycle does not
 * disappear: every non-comment event is carried on the node as `lifecycle`, and the
 * comments as a count, for the hovercard to list.
 *
 * ⚠️ **This makes an off-mode node a different thing from a timeline node**, and the UI
 * has to say so rather than let the reader assume the marks correspond. The hovercard
 * kicker reads `Pull request · entire lifecycle` where the timeline's reads
 * `Pull request · event`, and the title is the object's own label rather than an activity
 * word. The pull request has not become an object — it always was one; what changed is
 * how much of it one mark stands for.
 *
 * The commit lane is the exception that needs no rule: it already drew one node per commit
 * *object* (decision 19), so a commit is the same thing in both modes.
 *
 * Pure and DOM-free. Visibility is applied by the caller through the same predicates the
 * timeline uses, so this module never learns what a lane toggle is.
 */

import { isLandmark, isUnmergedClose } from '../model/activities.js';

/**
 * Drawn radius by object type — issue > pull request > commit.
 *
 * ⚠️ **Size lives here, in layout, rather than in `render/theme.js` with the colours.**
 * It is not only an encoding: the force simulation reads it as a node's personal space,
 * so a big node pushes harder than a small one. Two copies of it would be a copy that can
 * drift, and the drawing is the copy that would lose. The renderer reads `node.radius`.
 *
 * Size carries type here **in addition to** shape, not instead of it: the lanes are gone
 * in this mode, so the channel they were carrying has to be picked up somewhere, and the
 * one thing this mode must not do is fall back to colour-for-type — colour is busy
 * carrying time.
 */
export const STRUCTURAL_RADIUS = {
  issue: 15,
  pull_request: 12,
  commit: 6.5,
};

/** A collapsed burst grows with its member count, but sub-linearly so it stays a node. */
export function burstRadius(size) {
  return STRUCTURAL_RADIUS.commit + Math.sqrt(Math.max(1, size)) * 2.2;
}

/**
 * Build the off-mode nodes: one per visible object, plus one per collapsed burst.
 *
 * @param {object}   options
 * @param {object}   options.index            from `indexObjectGraph`
 * @param {Array}    options.bursts           from `deriveBursts`
 * @param {Set}      options.expandedBursts   burst ids the user has unfolded
 * @param {string[]} options.laneTypes        lane-bearing object types
 * @returns {Array} structural nodes
 */
export function buildStructuralNodes({
  index,
  bursts = [],
  expandedBursts = new Set(),
  laneTypes = ['issue', 'pull_request', 'commit'],
}) {
  const nodes = [];

  const collapsed = bursts.filter((burst) => !expandedBursts.has(burst.id));
  const foldedCommitIds = new Set();
  for (const burst of collapsed) {
    for (const id of burst.commitIds) foldedCommitIds.add(id);
  }

  for (const laneType of laneTypes) {
    for (const object of index.objectsOfType(laneType)) {
      // A commit inside a collapsed burst is represented by the burst, not by itself.
      // Without this a 20-commit push contributes 20 nodes and swamps the layout — the
      // same density argument decision 6 makes for the timeline, with more force here
      // because the force simulation gives every node a share of the space.
      if (foldedCommitIds.has(object.id)) continue;

      const events = index.eventsOf(object.id);
      const lifecycle = events
        .filter((event) => !event.comment)
        .map((event) => ({
          activity: event.activity,
          time: event.time,
          actorId: event.actor_id ?? null,
          landmark: isLandmark(event.activity),
          unmergedClose: isUnmergedClose(event.activity),
        }));

      nodes.push({
        id: `n_${object.id}`,
        lane: laneType,
        objectId: object.id,
        object,
        // The instant the whole node stands for: when this object first appeared. It is
        // what the colour ramp reads and what the hovercard shows as its first row, so
        // that "the hovercard still shows the real timestamp first" holds in every mode.
        t: firstInstant(object, events),
        tLast: lastInstant(object, events),
        actorId: events[0]?.actor_id ?? null,
        title: object.label || object.id,
        // Never a comment node: comments are folded into the object they belong to. The
        // flag is carried because `isNodeVisible` reads it, and a comment toggle must
        // not silently delete an entire issue from the picture.
        isComment: false,
        landmark: lifecycle.some((entry) => entry.landmark),
        unmergedClose: lifecycle.some((entry) => entry.unmergedClose),
        lifecycle,
        commentCount: events.length - lifecycle.length,
        eventCount: events.length,
        actorIds: [...new Set(events.map((event) => event.actor_id).filter(Boolean))],
        radius: STRUCTURAL_RADIUS[laneType] ?? STRUCTURAL_RADIUS.commit,
      });
    }
  }

  for (const burst of collapsed) {
    nodes.push({
      id: `n_${burst.id}`,
      lane: 'commit',
      objectId: burst.id,
      object: {
        id: burst.id,
        type: 'commit',
        label: `${burst.size} commits`,
        vmap: { push_id: burst.pushId },
      },
      t: burst.time,
      tLast: burst.time,
      actorId: null,
      title: `${burst.size} commits`,
      isComment: false,
      landmark: false,
      unmergedClose: false,
      lifecycle: [],
      commentCount: 0,
      eventCount: burst.size,
      actorIds: [],
      isBurst: true,
      burst,
      radius: burstRadius(burst.size),
    });
  }

  return nodes;
}

/** When this object first appeared: its earliest interval start, else its first event. */
function firstInstant(object, events) {
  const start = object.intervals?.[0]?.start ?? null;
  const firstEvent = events[0]?.time ?? null;
  if (start && firstEvent) return +start <= +firstEvent ? start : firstEvent;
  return start || firstEvent;
}

/** The last thing that happened to it: its latest interval end, else its last event. */
function lastInstant(object, events) {
  let latest = null;
  for (const interval of object.intervals || []) {
    for (const instant of [interval.start, interval.end]) {
      if (instant && (!latest || +instant > +latest)) latest = instant;
    }
  }
  const lastEvent = events[events.length - 1]?.time ?? null;
  if (lastEvent && (!latest || +lastEvent > +latest)) latest = lastEvent;
  return latest;
}

/**
 * Turn the sub-log's links into edges between structural nodes.
 *
 * Both endpoints are resolved through the node list, which is what folds a link into a
 * burst: a link reaching a commit inside a collapsed push arrives at the push instead.
 * That mirrors `buildAdjacency` (`model/graph.js`), and for the same reason — a mark
 * that is drawn must be reachable, or focusing a pull request fails to highlight the push
 * that delivered its commits.
 *
 * A link whose endpoint is not drawn produces no edge. A link whose *both* endpoints fold
 * into the same node produces none either: an edge from a node to itself says nothing and
 * the force simulation cannot draw one.
 *
 * @param {Array} links   the links to draw — already filtered by the caller
 * @param {Array} nodes   the surviving structural nodes
 * @returns {Array<{id, source, target, link, evidence, qualifier}>}
 */
export function buildStructuralEdges(links, nodes) {
  const nodeIdByObject = new Map();
  for (const node of nodes) {
    if (node.isBurst && node.burst) {
      for (const commitId of node.burst.commitIds) nodeIdByObject.set(commitId, node.id);
      continue;
    }
    if (node.objectId) nodeIdByObject.set(node.objectId, node.id);
  }

  const edges = [];
  links.forEach((link, i) => {
    const source = nodeIdByObject.get(link.source);
    const target = nodeIdByObject.get(link.target);
    if (!source || !target || source === target) return;
    edges.push({
      // Indexed rather than keyed on the endpoints: one pair can carry several links,
      // and two of them differing only in evidence is exactly the case decision 25's fan
      // exists for. Collapsing them here would bury the extracted one before anything
      // downstream got the chance to keep it visible.
      id: `e_${i}_${source}__${target}`,
      source,
      target,
      link,
      evidence: link.evidence,
      qualifier: link.qualifier,
    });
  });
  return edges;
}

/**
 * Group edges that share a node pair, so the renderer can draw a bundle once.
 *
 * The pair is unordered — `a→b` and `b→a` are the same two marks on the screen — but the
 * *drawn* direction is not decided here. It is decided by time (see `edgeDirection`),
 * because in this mode an arrowhead is a time cue rather than a statement about the
 * link's semantics.
 */
export function bundleEdges(edges) {
  const bundles = new Map();
  for (const edge of edges) {
    const key = edge.source < edge.target
      ? `${edge.source}||${edge.target}`
      : `${edge.target}||${edge.source}`;
    if (!bundles.has(key)) bundles.set(key, { key, edges: [] });
    bundles.get(key).edges.push(edge);
  }
  return [...bundles.values()];
}

/**
 * Which way an edge's arrowhead points: from the earlier endpoint to the later one.
 *
 * ⚠️ **Temporal precedence, not link direction, and the distinction matters.** A link's
 * `source`/`target` records a *relation* — `resolves` runs PR→issue — and drawing that as
 * an arrow would assert a reading direction the data does not have. The arrowhead is one
 * of the channels time was demoted to, so it has to answer a question about time: which
 * of these two things happened first. Where the two instants are equal, or either is
 * missing, there is no precedence to show and the edge is drawn without a head rather
 * than with an arbitrary one.
 *
 * @returns {1|-1|0} 1 = source→target, -1 = target→source, 0 = no arrowhead
 */
export function edgeDirection(edge, nodesById) {
  const from = nodesById.get(edge.source)?.t;
  const to = nodesById.get(edge.target)?.t;
  if (!from || !to) return 0;
  if (+from === +to) return 0;
  return +from < +to ? 1 : -1;
}

/**
 * The sub-log's time span, for the fill ramp and the time brush.
 *
 * Read off the structural nodes rather than off the graph, so it describes what is
 * actually on screen: hiding a lane narrows the ramp to what remains, exactly as the
 * statistics recompute over the visible sub-log (decision 12). Returns `null` when
 * nothing has a timestamp, which a one-object sub-log with no intervals can produce.
 */
export function timeExtent(nodes) {
  let min = null;
  let max = null;
  for (const node of nodes) {
    for (const instant of [node.t, node.tLast]) {
      if (!instant) continue;
      const value = +instant;
      if (!Number.isFinite(value)) continue;
      if (min == null || value < min) min = value;
      if (max == null || value > max) max = value;
    }
  }
  return min == null ? null : { min, max };
}

/**
 * Where a node sits in the sub-log's time span, as a fraction from 0 (earliest) to 1.
 *
 * The time brush reads this. A span of zero — one object, or several sharing an instant —
 * returns 0 for everything rather than dividing by zero: with no spread to show, the
 * honest answer is that the ramp says nothing here.
 */
export function timeFraction(instant, extent) {
  if (!instant || !extent) return 0;
  const span = extent.max - extent.min;
  if (span <= 0) return 0;
  const fraction = (+instant - extent.min) / span;
  return Math.max(0, Math.min(1, fraction));
}
