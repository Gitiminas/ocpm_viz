/**
 * Metrics over a loaded sub-log.
 *
 * Computed in JS, over the graph in memory, not precomputed in SQL.
 * That is deliberate: metrics must respond to toggles. Hiding comments has to
 * recompute gaps, and a server-side precomputation would silently answer "no".
 *
 * Pure functions over an `SubLog` — no DOM, no fetching — so they can be
 * checked directly against fixtures.
 *
 * The Stats page presents these as a per-object table that aggregates on demand.
 * What is here is the generalization of the mockup's nine cards: they assumed exactly
 * one issue and one PR, and would read the wrong object or divide by nothing as soon
 * as there were two.
 */

import { isLandmark, activityLabel, LANE_TYPES } from '../model/activities.js';

/**
 * Objects with a lane, i.e. with a lifecycle worth tabulating.
 *
 * Asked as `LANE_TYPES`, not as "not `actor`". A negative list happens to be right
 * rather than saying what is meant, and it has to be repeated at every site that
 * needs it. This way the next laneless type is handled by adding it to one array,
 * and it says the thing: an object without a lane has no duration, no gaps and no
 * row in the per-object table.
 */
const hasLane = (object) => LANE_TYPES.includes(object.type);

/** Total time an object was open, summed across its intervals. */
export function objectLifetime(object) {
  let total = 0;
  let complete = true;
  for (const interval of object.intervals) {
    if (interval.start && interval.end) total += +interval.end - +interval.start;
    else complete = false;
  }
  return { total: total || null, complete, intervals: object.intervals.length };
}

/** Per-object durations, the basis of the per-object table. */
export function perObjectDurations(graph) {
  return graph.objects
    .filter((object) => object.intervals.length > 0)
    .map((object) => ({
      id: object.id,
      type: object.type,
      label: object.label,
      ...objectLifetime(object),
    }));
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Aggregate a per-object duration across N objects of a type.
 *
 * Returns the median rather than the mean: process durations are strongly
 * right-skewed — one issue open for a year drags a mean far away from anything
 * typical — and with a single object the two coincide, so nothing is lost on F1.
 */
export function aggregateDuration(graph, type) {
  const values = graph.objects
    .filter((object) => object.type === type)
    .map((object) => objectLifetime(object).total)
    .filter((total) => total != null);
  return { n: values.length, median: median(values) };
}

export function commitStats(graph) {
  const commits = graph.objects.filter((object) => object.type === 'commit');
  const authors = new Set();
  for (const commit of commits) {
    // Git author strings, a different identity space from `actor`.
    if (commit.vmap?.commit_author_name) authors.add(commit.vmap.commit_author_name);
  }
  const times = commits
    .map((commit) => commit.intervals?.[0]?.start)
    .filter(Boolean)
    .map((t) => +t)
    .sort((a, b) => a - b);

  return {
    count: commits.length,
    authors: authors.size,
    first: times.length ? new Date(times[0]) : null,
    last: times.length ? new Date(times[times.length - 1]) : null,
  };
}

export function commentCounts(graph) {
  const byType = new Map();
  let total = 0;
  const byId = new Map(graph.objects.map((object) => [object.id, object]));

  for (const event of graph.events) {
    if (!event.comment) continue;
    total += 1;
    const type = byId.get(event.object_id)?.type;
    if (type) byType.set(type, (byType.get(type) || 0) + 1);
  }
  return { total, byType };
}

/**
 * Link totals by evidence class.
 *
 * Every link counted here is a traceability link between two objects. Attribution
 * lives on `event.actor_id` alone, never as a link, so it cannot inflate the split.
 * That matters: F1 carries 34 real links, and the 42 attribution links it would have
 * carried were all `validated` — enough to report 45/31 where the answer is 3/31.
 */
export function linkCounts(graph) {
  return {
    total: graph.links.length,
    validated: graph.links.filter((link) => link.evidence === 'validated').length,
    extracted: graph.links.filter((link) => link.evidence === 'extracted').length,
  };
}

/**
 * Lead time from the earliest issue opening to the first commit.
 *
 * Generalized from "the issue" to "the earliest issue", and returns null rather
 * than NaN when either end is missing.
 */
export function leadTimeToFirstCommit(graph) {
  const starts = graph.objects
    .filter((object) => object.type === 'issue')
    .flatMap((object) => object.intervals.map((interval) => interval.start))
    .filter(Boolean)
    .map((t) => +t);
  if (!starts.length) return null;

  const { first } = commitStats(graph);
  if (!first) return null;
  return +first - Math.min(...starts);
}

/**
 * Landmark timeline.
 *
 * Every landmark activity in the sub-log, plus each object's opening and the first
 * and last commit — labelled with which object they belong to, since with N issues
 * "Issue closed" alone no longer identifies anything.
 *
 * Not "milestones": that word is taken by a GitHub feature of its own, whose columns
 * sit on `mv_issues_full` upstream.
 */
export function landmarks(graph) {
  const byId = new Map(graph.objects.map((object) => [object.id, object]));
  const entries = [];

  for (const object of graph.objects) {
    // Commits are excluded on top of the lane rule: a commit is an instant, so
    // "opened" would be the same moment as the commit itself.
    if (!hasLane(object) || object.type === 'commit') continue;
    const start = object.intervals[0]?.start;
    // `objectId` rides along so the renderer can shade the entry by *which* object it
    // belongs to. With N issues the type colour says "an issue" and nothing more, and
    // the label already had to be widened for the same reason.
    if (start) {
      entries.push({
        label: `${object.label} opened`,
        time: start,
        type: object.type,
        objectId: object.id,
      });
    }
  }

  for (const event of graph.events) {
    if (!isLandmark(event.activity)) continue;
    const object = byId.get(event.object_id);
    entries.push({
      label: `${object ? object.label : event.object_id} · ${activityLabel(event.activity)}`,
      time: event.time,
      type: object?.type ?? 'issue',
      objectId: event.object_id,
    });
  }

  const { first, last, count } = commitStats(graph);
  if (first) entries.push({ label: 'First commit', time: first, type: 'commit' });
  if (last && count > 1) entries.push({ label: 'Last commit', time: last, type: 'commit' });

  return entries.sort((a, b) => +a.time - +b.time);
}

/**
 * Idle gaps between consecutive events, per object.
 *
 * Computed over whatever events are currently visible, so the answer follows the
 * toggles — which is the whole reason this is not precomputed in SQL.
 */
export function perObjectGaps(events, objectId) {
  const mine = events
    .filter((event) => event.object_id === objectId)
    .sort((a, b) => +a.time - +b.time);

  const gaps = [];
  for (let i = 1; i < mine.length; i++) {
    gaps.push({
      from: mine[i - 1],
      to: mine[i],
      hours: (+mine[i].time - +mine[i - 1].time) / 3600000,
      // Both sides must name an actor: an opening derived from a later event's payload
      // (`attrs.source === 'payload'`) can carry none, and "unknown → someone" is not a
      // handoff, it is a gap in the record.
      actorChanged:
        mine[i - 1].actor_id != null &&
        mine[i].actor_id != null &&
        mine[i - 1].actor_id !== mine[i].actor_id,
    });
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// the per-object table
// ---------------------------------------------------------------------------

/** How a PR ended. `null` for anything that is not a PR. */
export function prOutcome(object, events) {
  if (object.type !== 'pull_request') return null;
  const activities = new Set(
    events.filter((event) => event.object_id === object.id).map((event) => event.activity),
  );
  if (activities.has('PullRequestMerged')) return 'merged';
  // A merge of a different kind, counted on its own so the distribution
  // never folds a heuristic into the platform's merges.
  if (activities.has('PullRequestMergedOffPlatform')) return 'merged off-platform';
  if (activities.has('PullRequestClosed')) return 'closed unmerged';
  return 'open';
}

/**
 * One row per object — the table that replaces the mockup's nine scalar cards.
 *
 * Those cards assumed exactly one issue and one PR: with two of either they would
 * have reported one arbitrary object's numbers as if they described the sub-log.
 * A per-object row cannot make that mistake, and aggregates are derived from the
 * rows on demand rather than being the only thing available.
 */
export function perObjectMetrics(graph) {
  const eventsByObject = new Map();
  for (const event of graph.events) {
    if (!eventsByObject.has(event.object_id)) eventsByObject.set(event.object_id, []);
    eventsByObject.get(event.object_id).push(event);
  }

  const linkCountByObject = new Map();
  for (const link of graph.links) {
    for (const id of [link.source, link.target]) {
      linkCountByObject.set(id, (linkCountByObject.get(id) || 0) + 1);
    }
  }

  return graph.objects
    .filter(hasLane)
    .map((object) => {
      const events = (eventsByObject.get(object.id) || []).slice().sort((a, b) => a.time - b.time);
      const gaps = perObjectGaps(graph.events, object.id);
      const lifetime = objectLifetime(object);
      const actors = new Set(events.map((event) => event.actor_id).filter(Boolean));

      return {
        id: object.id,
        type: object.type,
        label: object.label || object.id,
        lifetime: lifetime.total,
        complete: lifetime.complete,
        intervals: object.intervals.length,
        events: events.length,
        comments: events.filter((event) => event.comment).length,
        actors: actors.size,
        first: events[0]?.time ?? object.intervals[0]?.start ?? null,
        last: events[events.length - 1]?.time ?? object.intervals[0]?.end ?? null,
        links: linkCountByObject.get(object.id) || 0,
        maxGapHours: gaps.length ? Math.max(...gaps.map((gap) => gap.hours)) : null,
        handoffs: gaps.filter((gap) => gap.actorChanged).length,
        outcome: prOutcome(object, graph.events),
      };
    });
}

/**
 * Aggregate a set of rows — the "on demand" half of the per-object table.
 *
 * Reports median *and* range rather than a mean. Process durations are strongly
 * right-skewed, so a mean sits between the typical case and the outlier and
 * describes neither; the range is what tells you whether the median means anything.
 */
export function aggregateRows(rows) {
  const durations = rows.map((row) => row.lifetime).filter((value) => value != null);
  const sorted = durations.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return {
    n: rows.length,
    withDuration: durations.length,
    median: sorted.length
      ? sorted.length % 2
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2
      : null,
    min: sorted.length ? sorted[0] : null,
    max: sorted.length ? sorted[sorted.length - 1] : null,
    events: rows.reduce((sum, row) => sum + row.events, 0),
    comments: rows.reduce((sum, row) => sum + row.comments, 0),
    links: rows.reduce((sum, row) => sum + row.links, 0),
    handoffs: rows.reduce((sum, row) => sum + row.handoffs, 0),
  };
}

/** Group rows by object type, preserving the lane order. */
export function groupRowsByType(rows, order = ['issue', 'pull_request', 'commit']) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.type)) groups.set(row.type, []);
    groups.get(row.type).push(row);
  }
  return order
    .filter((type) => groups.has(type))
    .map((type) => ({ type, rows: groups.get(type), aggregate: aggregateRows(groups.get(type)) }));
}

/**
 * How the PRs in this sub-log ended.
 *
 * A distribution rather than a count, because "3 merged" alone hides whether the
 * other two were closed unmerged or are still open — and closed-unmerged is a
 * conformance deviation worth seeing.
 */
export function prOutcomeDistribution(graph) {
  const counts = new Map();
  for (const object of graph.objects) {
    const outcome = prOutcome(object, graph.events);
    if (!outcome) continue;
    counts.set(outcome, (counts.get(outcome) || 0) + 1);
  }
  return [...counts.entries()].map(([outcome, count]) => ({ outcome, count }));
}

/**
 * Cross-object lead times.
 *
 * ⚠️ These are the metrics that do **not** generalize cleanly. "Issue → PR opened"
 * is one number only when there is one issue and one PR; with several of either
 * there are many such intervals and no principled way to pick one. Rather than drop
 * them or quietly report an arbitrary pair, each is computed **earliest to
 * earliest** and labelled as such, so the reader knows exactly which two instants
 * were subtracted. Per-object figures in the table are the honest unit; these are a
 * summary of the sub-log's overall shape.
 */
export function leadTimes(graph) {
  const earliestStart = (type) => {
    const starts = graph.objects
      .filter((object) => object.type === type)
      .flatMap((object) => object.intervals.map((interval) => interval.start))
      .filter(Boolean)
      .map((time) => +time);
    return starts.length ? Math.min(...starts) : null;
  };

  const earliestActivity = (activity) => {
    const times = graph.events
      .filter((event) => event.activity === activity)
      .map((event) => +event.time);
    return times.length ? Math.min(...times) : null;
  };

  const issueOpened = earliestStart('issue');
  const prOpened = earliestStart('pull_request');
  const { first: firstCommit } = commitStats(graph);
  const prMerged = earliestActivity('PullRequestMerged');
  const issueClosed = earliestActivity('IssueClosed');

  const between = (from, to) => (from == null || to == null ? null : to - from);

  return [
    {
      label: 'First issue → first commit',
      value: between(issueOpened, firstCommit ? +firstCommit : null),
    },
    { label: 'First issue → first PR', value: between(issueOpened, prOpened) },
    { label: 'First merge → first issue close', value: between(prMerged, issueClosed) },
  ].filter((entry) => entry.value != null);
}

/**
 * The largest idle gaps anywhere in the sub-log, longest first.
 *
 * The bottleneck view: where did this process actually wait? `actorChanged` marks a
 * gap that spans a handoff, which is a different phenomenon from one person simply
 * being slow.
 */
export function largestGaps(graph, limit = 5) {
  const byId = new Map(graph.objects.map((object) => [object.id, object]));
  const gaps = [];

  for (const object of graph.objects) {
    if (!hasLane(object)) continue;
    for (const gap of perObjectGaps(graph.events, object.id)) {
      gaps.push({
        objectId: object.id,
        label: byId.get(object.id)?.label || object.id,
        type: object.type,
        hours: gap.hours,
        from: gap.from.time,
        to: gap.to.time,
        actorChanged: gap.actorChanged,
      });
    }
  }
  return gaps.sort((a, b) => b.hours - a.hours).slice(0, limit);
}
