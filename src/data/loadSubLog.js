/**
 * The sub-log data entry point; its sibling `loadDfg.js` is the whole-log one. The
 * payload contracts are in `docs/DATA_LAYER.md`.
 *
 * Nothing above this layer may fetch, parse or reshape data. Everything the
 * renderer sees has passed through one of the two, which is what makes swapping the
 * fixture transport for the PostgREST RPC a one-function change.
 *
 * A `query` describes the sub-log to select — it is *not* an identity. The same
 * event may legitimately belong to many sub-logs, which is precisely what a case id
 * would forbid. These are also the parameters a saved preset or shareable URL encodes,
 * which is how a picture is reproduced.
 */

import { assertValidGraph, normalizeGraph } from '../model/subLog.js';
import { fixtureTransport } from './fixtures.js';
import { upgradeLegacyGraph } from './legacy.js';
import { seedDisplayLabel } from './seedQuery.js';

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
 * @returns {Promise<object>} a validated, normalized `SubLog`
 */
export async function loadSubLog(query = {}, { transport = fixtureTransport } = {}) {
  // A contract-v2 bundle is restated as v3 first (`legacy.js`, for the migration only),
  // so validation and every error message speak the one shape the model understands.
  const raw = upgradeLegacyGraph(await transport(query));
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
 * this project rejects. Naming the query rather than the result keeps the breadcrumb
 * honest when the same events appear in a different sub-log — which, under OCPM,
 * they legitimately can.
 */
export function describeSubLog(graph) {
  const summary = summarizeSubLog(graph);
  const parts = [];
  if (summary.repo) parts.push(summary.repo);
  parts.push(summary.seedLabels.length ? `from ${summary.seedLabels.join(', ')}` : 'no seed recorded');
  if (summary.degree != null) parts.push(`degree ${summary.degree}`);
  parts.push(
    [...summary.counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([type, n]) => `${n} ${type}${n === 1 ? '' : 's'}`)
      .join(', '),
  );
  return parts.join(' · ');
}

/**
 * The facts about a loaded sub-log that the sidebar's info card states.
 *
 * Derived from the graph, never stored on it: the counts are of what the payload carries
 * (every object, whatever the toggles), the span is first event to last, and the labels
 * are the objects' own. DOM-free, so the card's contents are testable without a browser
 * and `describeSubLog` — the one-line form the stats page and `rpc-check.mjs` print —
 * reads the same numbers rather than counting twice.
 *
 * @returns {{repo: string|null, seedLabels: string[], degree: number|null,
 *   counts: Map<string, number>, links: number, events: number,
 *   span: {first: Date, last: Date, ms: number}|null}}
 */
export function summarizeSubLog(graph) {
  const meta = graph.meta || {};
  const byId = new Map(graph.objects.map((o) => [o.id, o]));
  const seedLabels = (meta.seed || []).map((seed) => {
    const object = byId.get(seed.id);
    return object ? seedDisplayLabel({ type: seed.type, label: object.label }) : seed.id;
  });

  const counts = new Map();
  for (const object of graph.objects) {
    counts.set(object.type, (counts.get(object.type) || 0) + 1);
  }

  let first = null;
  let last = null;
  for (const event of graph.events) {
    const t = +event.time;
    if (!Number.isFinite(t)) continue;
    if (first == null || t < first) first = t;
    if (last == null || t > last) last = t;
  }

  return {
    repo: meta.repo ?? null,
    seedLabels,
    degree: meta.traversal_degree ?? null,
    counts,
    links: graph.links.length,
    events: graph.events.length,
    span: first == null ? null : { first: new Date(first), last: new Date(last), ms: last - first },
  };
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
