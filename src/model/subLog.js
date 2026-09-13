/**
 * `SubLog` shape validation and indexing.
 *
 * The contract is in `docs/DATA_LAYER.md`. This module fails loudly on a
 * malformed bundle rather than letting a missing field surface later as an empty
 * lane or a link drawn to nowhere — those failure modes are invisible in a diff and
 * exactly what the renderer must not be asked to absorb.
 *
 * There is no case notion here, deliberately. `meta` records the query
 * that produced the sub-log, for reproducibility; it is not an identity.
 */

import { OBJECT_TYPES, findActivityProblems, isActorRole } from './activities.js';
import { isKnownMethod } from './evidence.js';

const OBJECT_TYPE_SET = new Set(OBJECT_TYPES);

/*
 * The three readers of an event's object relations. Everything above the model reads
 * events through these and never through a field, so the shape of the relation is one
 * module's business. An event relates to the objects it is about (`subject`, or the
 * commits a push carried) and, under a role qualifier, to its actor — the OCEL 2.0
 * event-to-object relation, `docs/DATA_LAYER.md`.
 *
 * Dual-read, for the migration: a contract-v2 event carries `object_id` and `actor_id`
 * instead of `relationships`, and the helpers answer the same for both shapes.
 */

/** The ids of the objects the event is about, in payload order — never the actor. */
export function objectsOf(event) {
  if (event.relationships) {
    return event.relationships.filter((r) => !isActorRole(r.qualifier)).map((r) => r.object_id);
  }
  return event.object_id ? [event.object_id] : [];
}

/**
 * The one object an issue or pull-request activity is about, or null. A push has no
 * subject — it is about every commit it carried — so callers that need "the" object of
 * a Push must ask `objectsOf` and say which one they mean.
 */
export function subjectOf(event) {
  if (event.relationships) {
    return event.relationships.find((r) => r.qualifier === 'subject')?.object_id ?? null;
  }
  return event.object_id ?? null;
}

/** The actor's object id, or null when the record names none. */
export function actorOf(event) {
  if (event.relationships) {
    return event.relationships.find((r) => isActorRole(r.qualifier))?.object_id ?? null;
  }
  return event.actor_id ?? null;
}

/**
 * Validate a raw bundle. Returns an array of problems; empty means valid.
 *
 * Collects everything rather than throwing on the first fault, so one reload
 * reports the whole picture.
 */
export function findGraphProblems(graph) {
  const problems = [];

  if (!graph || typeof graph !== 'object') return ['bundle is not an object'];
  for (const key of ['meta', 'objects', 'events', 'links']) {
    if (!(key in graph)) problems.push(`bundle is missing "${key}"`);
  }
  if (problems.length) return problems;

  if (!Array.isArray(graph.objects)) problems.push('"objects" is not an array');
  if (!Array.isArray(graph.events)) problems.push('"events" is not an array');
  if (!Array.isArray(graph.links)) problems.push('"links" is not an array');
  if (problems.length) return problems;

  const byId = Object.create(null);
  for (const object of graph.objects) {
    if (!object.id) {
      problems.push('an object has no id');
      continue;
    }
    if (byId[object.id]) problems.push(`duplicate object id "${object.id}"`);
    byId[object.id] = object;

    if (!OBJECT_TYPE_SET.has(object.type)) {
      problems.push(
        `object "${object.id}" has type "${object.type}"; the closed set is ` +
          `${OBJECT_TYPES.join(', ')}`,
      );
    }
    if (!Array.isArray(object.intervals)) {
      // Interval lists, always present. An object with no lifecycle carries `[]`,
      // which is a fact rather than missing data.
      problems.push(`object "${object.id}" has no intervals array`);
    } else {
      for (const interval of object.intervals) {
        if (!interval || !interval.start) {
          problems.push(`object "${object.id}" has an interval with no start`);
        }
      }
    }
  }

  for (const event of graph.events) {
    if (!event.id) problems.push('an event has no id');
    if (!event.time) problems.push(`event "${event.id}" has no time`);
    if (!byId[event.object_id]) {
      problems.push(`event "${event.id}" references unknown object "${event.object_id}"`);
    }
  }

  problems.push(...findActivityProblems(graph.events, byId));

  /*
   * **Both endpoints of a link must be objects.** Accepting an event id as well only
   * made a mistake harder to see. A link to an event id passes every downstream check
   * quietly — `byId.get` misses, so `isLinkVisible` returns false — and the link simply
   * never appears, which is precisely the "wrong picture, no error" failure this
   * validator exists to catch.
   *
   * The event ids are still collected, but only to say *which* mistake was made:
   * naming an event where an object belongs is the plausible error, and a bare
   * "unknown source" would send the reader looking for a missing object.
   */
  const eventIds = new Set(graph.events.map((e) => e.id));
  for (const link of graph.links) {
    for (const [end, id] of [
      ['source', link.source],
      ['target', link.target],
    ]) {
      if (byId[id]) continue;
      problems.push(
        eventIds.has(id)
          ? `link ${link.source}→${link.target} has event "${id}" as its ${end}; both ` +
            `endpoints must be objects`
          : `link references unknown ${end} "${id}"`,
      );
    }
    if (link.evidence !== 'validated' && link.evidence !== 'extracted') {
      problems.push(
        `link ${link.source}→${link.target} has evidence "${link.evidence}"; the only ` +
          `classes are validated and extracted`,
      );
    }
    if (link.method && !isKnownMethod(link.method)) {
      problems.push(`link ${link.source}→${link.target} has unknown method "${link.method}"`);
    }
  }

  return problems;
}

export function assertValidGraph(graph) {
  const problems = findGraphProblems(graph);
  if (problems.length) {
    throw new Error(
      `Malformed SubLog (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
  }
  return graph;
}

/**
 * Parse every timestamp once, into a copy.
 *
 * The input bundle is never mutated: it may be a fixture shared across tests, and a
 * module that silently rewrites its input cannot be reasoned about in isolation.
 *
 * All times are UTC. `Date` parses the trailing `Z` as UTC correctly;
 * it is *rendering* that must also be pinned to UTC, which is why formatting lives
 * in one module rather than being spread across the renderer.
 */
export function normalizeGraph(graph) {
  return {
    meta: graph.meta,
    objects: graph.objects.map((object) => ({
      ...object,
      intervals: (object.intervals || []).map((interval) => ({
        start: interval.start ? new Date(interval.start) : null,
        end: interval.end ? new Date(interval.end) : null,
      })),
    })),
    events: graph.events.map((event) => ({ ...event, time: new Date(event.time) })),
    links: graph.links.map((link) => ({ ...link })),
  };
}

/**
 * Build the lookups the rest of the app reads.
 *
 * Everything here is a **collection**. The mockup took `filter(...)[0]` for the
 * issue and the PR and silently discarded the rest; nothing in this module may
 * privilege a single object of a type.
 */
export function indexSubLog(graph) {
  const byId = new Map();
  for (const object of graph.objects) byId.set(object.id, object);

  const objectsByType = new Map();
  for (const type of OBJECT_TYPES) objectsByType.set(type, []);
  for (const object of graph.objects) {
    if (!objectsByType.has(object.type)) objectsByType.set(object.type, []);
    objectsByType.get(object.type).push(object);
  }

  const eventsByObject = new Map();
  for (const event of graph.events) {
    if (!eventsByObject.has(event.object_id)) eventsByObject.set(event.object_id, []);
    eventsByObject.get(event.object_id).push(event);
  }
  for (const events of eventsByObject.values()) events.sort((a, b) => a.time - b.time);

  /*
   * The actor who pushed a commit **first**, and only that.
   *
   * The actor on a `CommitObserved` event is the *pusher*, a different identity space
   * from `vmap.commit_author_name` — no heuristic join between them.
   *
   * ⚠️ **This is not the answer to "who pushed this commit".** A commit is usually
   * pushed by several accounts — 89% of vscode's repeatedly-observed commits, up to
   * fifteen — so anything asking about pushers has to read the events, not this map.
   * It used to be filled by overwriting on every event, which meant "whichever push
   * happened to be written last" and silently discarded the rest; that is what made
   * clicking an actor highlight nothing. Taking the earliest is at least deterministic
   * and means something.
   */
  const pusherByCommit = new Map();
  const firstPushAt = new Map();
  for (const event of graph.events) {
    if (event.activity !== 'CommitObserved') continue;
    const earliest = firstPushAt.get(event.object_id);
    if (earliest != null && +earliest <= +event.time) continue;
    firstPushAt.set(event.object_id, event.time);
    pusherByCommit.set(event.object_id, event.actor_id);
  }

  const eventCountByActor = new Map();
  for (const event of graph.events) {
    if (!event.actor_id) continue;
    eventCountByActor.set(event.actor_id, (eventCountByActor.get(event.actor_id) || 0) + 1);
  }

  return {
    byId,
    objectsByType,
    eventsByObject,
    pusherByCommit,
    eventCountByActor,
    objectsOfType: (type) => objectsByType.get(type) || [],
    eventsOf: (objectId) => eventsByObject.get(objectId) || [],
  };
}

/**
 * Every distinct instant in the sub-log, sorted.
 *
 * Drives both the real and compressed time scales, so it must include lifecycle
 * interval bounds as well as event times — an object whose span extends past its
 * last event still needs its endpoint on the axis.
 */
export function collectInstants(graph) {
  const instants = new Set();
  for (const event of graph.events) instants.add(+event.time);
  for (const object of graph.objects) {
    for (const interval of object.intervals) {
      if (interval.start) instants.add(+interval.start);
      if (interval.end) instants.add(+interval.end);
    }
  }
  return [...instants].sort((a, b) => a - b);
}
