/**
 * The single data entry point (`docs/ADAPTER_AND_API.md` §4).
 *
 * Nothing above this layer may fetch, parse or reshape data. Everything the
 * renderer sees has passed through here, which is what makes swapping the fixture
 * transport for the PostgREST RPC a one-function change.
 *
 * A `query` describes the sub-log to select — it is *not* an identity. The same
 * event may legitimately belong to many sub-logs, which is precisely what a case id
 * would forbid (decision 1). These are also the parameters a saved preset or
 * shareable URL encodes, which is the reproducibility mechanism for the task-based
 * evaluation.
 */

import { assertValidGraph, normalizeGraph } from '../model/objectGraph.js';
import { fixtureTransport } from './fixtures.js';

/**
 * Load, validate and normalize one sub-log.
 *
 * Validation happens on the raw bundle, before normalization, so error messages
 * quote what the transport actually delivered rather than a half-transformed
 * version of it.
 *
 * @param {object} query               what to select
 * @param {{transport?: Function}} options  injectable transport, for tests and for
 *                                          the later PostgREST swap
 * @returns {Promise<object>} a validated, normalized `ObjectGraph`
 */
export async function loadObjectGraph(query = {}, { transport = fixtureTransport } = {}) {
  const raw = await transport(query);
  assertValidGraph(raw);
  const graph = normalizeGraph(raw);
  // Record the query that produced this bundle alongside whatever the transport
  // already reported, so the UI can describe the selection without a stored title.
  graph.meta = { ...graph.meta, query };
  return graph;
}

/**
 * Human-readable description of the sub-log, derived from the query that produced
 * it: **repository, seed, traversal degree, and what came back**.
 *
 * This replaces the mockup's `meta.case` string, which hardcoded
 * "Issue #242864 -> PR #243221 -> commits" and reintroduced exactly the case notion
 * decision 1 removes. Naming the query rather than the result keeps the breadcrumb
 * honest when the same events appear in a different sub-log — which, under OCPM,
 * they legitimately can.
 */
export function describeSubLog(graph) {
  const meta = graph.meta || {};
  const seeds = meta.seed || [];
  const byId = new Map(graph.objects.map((o) => [o.id, o]));

  const seedLabels = seeds.map((seed) => {
    const object = byId.get(seed.id);
    return object ? `${seed.type.replace('_', ' ')} ${object.label}` : seed.id;
  });

  const parts = [];
  if (meta.repo) parts.push(meta.repo);
  parts.push(seedLabels.length ? `from ${seedLabels.join(', ')}` : 'no seed recorded');
  if (meta.traversal_degree != null) parts.push(`degree ${meta.traversal_degree}`);

  const counts = new Map();
  for (const object of graph.objects) {
    counts.set(object.type, (counts.get(object.type) || 0) + 1);
  }
  parts.push(
    [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([type, n]) => `${n} ${type}${n === 1 ? '' : 's'}`)
      .join(', '),
  );

  return parts.join(' · ');
}

/**
 * The seed objects of a loaded sub-log, for the UI to mark as its origin.
 *
 * The seed is not privileged in the data — OCPM has no case, and every object in
 * the bundle is equally an object. It is privileged only in the *query*, which is
 * why this reads from `meta` rather than from anything about the objects.
 */
export function seedObjects(graph) {
  const byId = new Map(graph.objects.map((o) => [o.id, o]));
  return (graph.meta?.seed || []).map((seed) => byId.get(seed.id)).filter(Boolean);
}
