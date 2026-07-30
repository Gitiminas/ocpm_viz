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
 * Human-readable description of the sub-log, derived from the query.
 *
 * This replaces the mockup's `meta.case` string, which hardcoded
 * "Issue #242864 -> PR #243221 -> commits" and reintroduced exactly the case notion
 * decision 1 removes. Describing the selection instead of naming it keeps the
 * breadcrumb honest when the same events appear in a different sub-log.
 */
export function describeSubLog(graph) {
  const meta = graph.meta || {};
  const seeds = meta.seed || [];
  const byId = new Map(graph.objects.map((o) => [o.id, o]));

  const seedLabels = seeds.map((seed) => {
    const object = byId.get(seed.id);
    return object ? object.label : seed.id;
  });

  const parts = [];
  parts.push(seedLabels.length ? `seed ${seedLabels.join(', ')}` : 'no seed recorded');
  if (meta.traversal_degree != null) parts.push(`traversal degree ${meta.traversal_degree}`);

  const counts = new Map();
  for (const object of graph.objects) {
    counts.set(object.type, (counts.get(object.type) || 0) + 1);
  }
  const composition = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, n]) => `${n} ${type}${n === 1 ? '' : 's'}`)
    .join(', ');
  parts.push(composition);

  return parts.join(' · ');
}
