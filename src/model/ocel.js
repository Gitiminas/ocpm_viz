/**
 * `toOcelJson(graph)` — a loaded `SubLog` as an OCEL 2.0 JSON exchange-format log.
 *
 * The sub-log already has the OCEL 2.0 components (`docs/DATA_LAYER.md`): typed objects
 * with attributes, typed events with attributes, the event-to-object relation on every
 * event (`relationships`), and the object-to-object relation (`links`). This module only
 * restates them in the standard's serialisation — the same shape as the sample export
 * `online-appendix/C6_ocel2.json` — so a process-mining library can read what the tool
 * draws. Nothing is derived here; a fact absent from the sub-log is absent from the export.
 *
 * What the standard has no place for, and is therefore dropped, is said once, here:
 *   - a link's `evidence`, `method`, `link_methods`, `n_methods`. OCEL 2.0's O2O row is
 *     (source, target, qualifier) and nothing else; the qualifier stays the plain
 *     relationship (`resolves`, `contains_commit`, …), and the evidence grading that
 *     draws a link dashed does not travel. The `SubLog` payload remains the record of it.
 *   - `meta`. The query and its provenance are not part of a log.
 *
 * Two conventions the standard leaves to the writer:
 *   - Object attributes are timestamped. Everything in `vmap`, plus the display `label`, is
 *     a static value and is stamped `1970-01-01T00:00:00Z` (the standard's "time 0"). The
 *     lifecycle is the one dynamic attribute: `state` becomes `open` at each interval's
 *     start and `closed` at its end, so the change history OCEL 2.0 asks for is the
 *     intervals restated.
 *   - Attribute types are inferred from the values (`string`, `float`, `boolean`), the
 *     three the sample uses. The standard's formal model asks attribute names to be
 *     disjoint across types; `comment` on every event type, `label` on every object type
 *     and `ref`/`push_id` on both commits and pushes are shared by design here, and a
 *     reader that enforces disjointness will say so. Known deviation.
 */

import { isActorRole } from './activities.js';

const TIME_ZERO = '1970-01-01T00:00:00Z';

const iso = (t) => (t instanceof Date ? t.toISOString() : t);

function valueType(value) {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'float';
  return 'string';
}

/** The attribute declarations of one type: every name seen, typed by its first non-null value. */
function declareAttributes(rows) {
  const types = new Map();
  for (const row of rows) {
    for (const { name, value } of row) {
      if (value == null) continue;
      if (!types.has(name)) types.set(name, valueType(value));
    }
  }
  return [...types].map(([name, type]) => ({ name, type }));
}

function objectAttributes(object) {
  const attributes = [];
  for (const [name, value] of Object.entries(object.vmap ?? {})) {
    if (value == null) continue;
    attributes.push({ name, time: TIME_ZERO, value });
  }
  if (object.label != null) attributes.push({ name: 'label', time: TIME_ZERO, value: object.label });
  for (const interval of object.intervals ?? []) {
    if (interval.start) attributes.push({ name: 'state', time: iso(interval.start), value: 'open' });
    if (interval.end) attributes.push({ name: 'state', time: iso(interval.end), value: 'closed' });
  }
  return attributes;
}

function eventAttributes(event) {
  const attributes = [];
  for (const [name, value] of Object.entries(event.attrs ?? {})) {
    if (value == null) continue;
    attributes.push({ name, value });
  }
  if (typeof event.comment === 'boolean') attributes.push({ name: 'comment', value: event.comment });
  return attributes;
}

/**
 * @param {object} graph  a `SubLog` as `loadSubLog` returns it (times as `Date`), or raw
 * @returns {{objectTypes: Array, eventTypes: Array, objects: Array, events: Array}}
 */
export function toOcelJson(graph) {
  const objects = graph.objects.map((object) => ({
    id: object.id,
    type: object.type,
    attributes: objectAttributes(object),
  }));
  // O2O rides on the SOURCE object, as the sample does; an object with no outgoing link
  // carries no `relationships` key at all.
  const bySource = new Map();
  for (const link of graph.links) {
    if (!bySource.has(link.source)) bySource.set(link.source, []);
    bySource.get(link.source).push({ objectId: link.target, qualifier: link.qualifier });
  }
  for (const object of objects) {
    const relationships = bySource.get(object.id);
    if (relationships) object.relationships = relationships;
  }

  const events = graph.events.map((event) => ({
    id: event.id,
    type: event.activity,
    time: iso(event.time),
    attributes: eventAttributes(event),
    relationships: (event.relationships ?? []).map((r) => ({
      objectId: r.object_id,
      qualifier: r.qualifier,
    })),
  }));

  const objectTypes = [...new Set(objects.map((o) => o.type))].sort().map((name) => ({
    name,
    attributes: declareAttributes(objects.filter((o) => o.type === name).map((o) => o.attributes)),
  }));
  const eventTypes = [...new Set(events.map((e) => e.type))].sort().map((name) => ({
    name,
    attributes: declareAttributes(events.filter((e) => e.type === name).map((e) => e.attributes)),
  }));

  return { objectTypes, eventTypes, objects, events };
}

/**
 * The structural rules of the format, checked on an export. Returns problems; empty means
 * clean. Kept beside the writer so a test and a script assert the same thing: the four
 * top-level keys and nothing else; every relationship resolving to an object; event and
 * object ids disjoint; every attribute declared for its type; object attributes carrying a
 * time and event attributes carrying none; every `Push` about at least one commit.
 */
export function findOcelProblems(log) {
  const problems = [];
  const keys = Object.keys(log ?? {}).sort();
  if (keys.join(',') !== 'eventTypes,events,objectTypes,objects') {
    problems.push(`top-level keys are ${keys.join(', ')}; the format has exactly objectTypes, eventTypes, objects, events`);
    return problems;
  }
  const objectIds = new Set(log.objects.map((o) => o.id));
  const eventIds = new Set(log.events.map((e) => e.id));
  for (const id of eventIds) if (objectIds.has(id)) problems.push(`"${id}" is both an event and an object`);
  if (objectIds.size !== log.objects.length) problems.push('duplicate object id');
  if (eventIds.size !== log.events.length) problems.push('duplicate event id');

  const declared = (types, name) => new Set((types.find((t) => t.name === name)?.attributes ?? []).map((a) => a.name));
  for (const object of log.objects) {
    const names = declared(log.objectTypes, object.type);
    if (!log.objectTypes.some((t) => t.name === object.type)) problems.push(`object ${object.id} has undeclared type ${object.type}`);
    for (const a of object.attributes) {
      if (!names.has(a.name)) problems.push(`object ${object.id}: attribute ${a.name} not declared for ${object.type}`);
      if (!a.time) problems.push(`object ${object.id}: attribute ${a.name} carries no time`);
    }
    for (const r of object.relationships ?? []) {
      if (!objectIds.has(r.objectId)) problems.push(`object ${object.id} relates to unknown ${r.objectId}`);
      if (!r.qualifier) problems.push(`object ${object.id}: an O2O row has no qualifier`);
    }
  }
  for (const event of log.events) {
    const names = declared(log.eventTypes, event.type);
    if (!log.eventTypes.some((t) => t.name === event.type)) problems.push(`event ${event.id} has undeclared type ${event.type}`);
    if (!event.time) problems.push(`event ${event.id} has no time`);
    for (const a of event.attributes) {
      if (!names.has(a.name)) problems.push(`event ${event.id}: attribute ${a.name} not declared for ${event.type}`);
      if ('time' in a) problems.push(`event ${event.id}: attribute ${a.name} carries a time`);
    }
    for (const r of event.relationships) {
      if (!objectIds.has(r.objectId)) problems.push(`event ${event.id} relates to unknown ${r.objectId}`);
      if (!r.qualifier) problems.push(`event ${event.id}: an E2O row has no qualifier`);
    }
    if (event.type === 'Push' && !event.relationships.some((r) => r.qualifier === 'pushed_commit')) {
      problems.push(`push ${event.id} carries no commit`);
    }
    if (!event.relationships.some((r) => !isActorRole(r.qualifier))) {
      problems.push(`event ${event.id} is about no object`);
    }
  }
  return problems;
}
