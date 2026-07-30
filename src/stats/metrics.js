/**
 * Metrics over a loaded sub-log.
 *
 * Computed in JS, over the graph in memory, not precomputed in SQL (decision 12).
 * That is deliberate: metrics must respond to toggles. Hiding comments has to
 * recompute gaps, and a server-side precomputation would silently answer "no".
 *
 * Pure functions over an `ObjectGraph` — no DOM, no fetching — so they can be
 * checked directly against fixtures.
 *
 * ⚠️ Task 4 replaces the presentation of these with a per-object table that
 * aggregates on demand (decision 8). What is here is the generalization of the
 * mockup's nine cards: they assumed exactly one issue and one PR, and would read the
 * wrong object or divide by nothing as soon as there were two.
 */

import { isMilestone, activityLabel } from '../model/activities.js';

/** Total time an object was open, summed across its intervals (decision 4). */
export function objectLifetime(object) {
  let total = 0;
  let complete = true;
  for (const interval of object.intervals) {
    if (interval.start && interval.end) total += +interval.end - +interval.start;
    else complete = false;
  }
  return { total: total || null, complete, intervals: object.intervals.length };
}

/** Per-object durations, the basis of the Task 4 table. */
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
    // Git author strings, a different identity space from `actor` (decision 5).
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

export function linkCounts(graph) {
  const objectLinks = graph.links.filter((link) => link.qualifier !== 'actor');
  return {
    total: objectLinks.length,
    validated: objectLinks.filter((link) => link.evidence === 'validated').length,
    extracted: objectLinks.filter((link) => link.evidence === 'extracted').length,
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
 * Milestone timeline.
 *
 * Every milestone activity in the sub-log, plus each object's opening and the first
 * and last commit — labelled with which object they belong to, since with N issues
 * "Issue closed" alone no longer identifies anything.
 */
export function milestones(graph) {
  const byId = new Map(graph.objects.map((object) => [object.id, object]));
  const entries = [];

  for (const object of graph.objects) {
    if (object.type === 'commit' || object.type === 'actor' || object.type === 'repo') continue;
    const start = object.intervals[0]?.start;
    if (start) entries.push({ label: `${object.label} opened`, time: start, type: object.type });
  }

  for (const event of graph.events) {
    if (!isMilestone(event.activity)) continue;
    const object = byId.get(event.object_id);
    entries.push({
      label: `${object ? object.label : event.object_id} · ${activityLabel(event.activity)}`,
      time: event.time,
      type: object?.type ?? 'issue',
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
 * Computed over whatever events are currently loaded and visible, so the answer
 * follows the toggles — which is the whole reason this is not precomputed in SQL.
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
      actorChanged: mine[i - 1].actor_id !== mine[i].actor_id,
    });
  }
  return gaps;
}
