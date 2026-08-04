/**
 * The PostgREST transport: one sub-log, fetched over HTTP.
 *
 * This is the swap `docs/ADAPTER_AND_API.md` §4 promised would be a one-function
 * change. Nothing above the data layer knows it exists — `loadObjectGraph(query,
 * { transport })` takes it, validates what comes back, and the renderer cannot tell
 * a fixture from a live payload. That is the whole point of the seam, and it is why
 * this file is small.
 *
 *   import { loadObjectGraph } from './loadObjectGraph.js';
 *   import { rpcTransport } from './api.js';
 *
 *   const graph = await loadObjectGraph(
 *     { repo: 'microsoft/vscode', seed: 'pr:448781946', traversalDegree: 2 },
 *     { transport: rpcTransport },
 *   );
 *
 * ⚠️ **Seeds are database ids, not display numbers** (decision 51). `issue:<issue_id>`,
 * `pr:<pull_request_id>`, `commit:<sha>` — so `issue:655615214`, never `issue:102358`.
 * The RPC rejects a display number rather than guessing, and says so in its hint; see
 * `resolveSeed` below for the lookup that bridges the two.
 */

/**
 * Where PostgREST is listening.
 *
 * Same-origin would be better and is what a deployment behind nginx should do (the
 * PostgREST docs have a section on exactly this). Until then the dev server is on
 * :8000 and PostgREST on :3000, so this is absolute and CORS applies.
 */
export const DEFAULT_BASE_URL = 'http://localhost:3000';

/**
 * Turn a PostgREST error body into an `Error` worth reading.
 *
 * PostgREST returns `{code, message, details, hint}`. The `hint` is where this
 * project's own RAISE EXCEPTION guidance lands — "seeds are prefixed database ids,
 * here is the query that resolves a number" — and dropping it would throw away the
 * most useful half of the failure. `PGRST*` codes are the API's own (bad function
 * signature, schema cache stale); `P0001` is ours, raised by `api.get_object_graph`.
 */
function errorFromBody(status, body) {
  const parts = [];
  parts.push(body?.message || `PostgREST returned HTTP ${status}`);
  if (body?.hint) parts.push(`Hint: ${body.hint}`);
  if (body?.details) parts.push(`Details: ${body.details}`);

  const error = new Error(parts.join('\n'));
  error.status = status;
  error.code = body?.code;
  error.hint = body?.hint;
  return error;
}

/**
 * Build a transport bound to a particular PostgREST instance.
 *
 * Injectable rather than hardcoded so tests can point it at a stub and a deployment
 * can point it at a real origin without editing this file.
 */
export function createRpcTransport({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('No fetch available. Pass fetchImpl, or run on Node 18+ / a browser.');
  }

  return async function rpcTransport(query = {}) {
    const { repo, seed, traversalDegree = 2 } = query;

    // Fail here rather than letting the RPC answer "no repository named null". The
    // query is the thing a preset or a URL encodes, so a malformed one is a bug in
    // the caller and should say which field.
    if (!repo) throw new Error('rpcTransport: query.repo is required');
    if (!seed) throw new Error('rpcTransport: query.seed is required');

    const response = await fetchImpl(`${baseUrl}/rpc/get_object_graph`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      // Argument names must match the SQL parameter names exactly — PostgREST resolves
      // the overload by name, and a typo is a 404 "could not find the function",
      // not a 400.
      body: JSON.stringify({ repo, seed, traversal_degree: Number(traversalDegree) }),
    });

    if (!response.ok) {
      let body = null;
      try {
        body = await response.json();
      } catch {
        // A non-JSON error body means something in front of PostgREST answered —
        // a proxy, or nothing listening at all. Keep the status, lose nothing else.
      }
      throw errorFromBody(response.status, body);
    }

    return response.json();
  };
}

/** A transport against the default instance, for the common case. */
export const rpcTransport = createRpcTransport();

/**
 * Resolve what someone typed into the seed object id the RPC wants.
 *
 * The gap this closes: people know pull requests by `#102479`, and the RPC keys on
 * `pr:448781946`. Numbers are per-repository and renameable-free but they are *not*
 * ids, and decision 51 chose ids deliberately — so something has to translate, and
 * doing it here keeps that knowledge in the data layer rather than in the renderer.
 *
 * Backed by `fe.seed_lookup`, which PostgREST exposes read-only. Returns the matches
 * ranked by the same rules `seedQuery.js` applies to the fixture catalogue, so the
 * two search paths behave alike.
 *
 * ⚠️ **Not wired up yet.** `fe.seed_lookup` does not exist and the app still searches
 * the fixture catalogue; this is the shape the next step needs, written down here so
 * the seam is visible rather than discovered later. See README "Status".
 */
export async function resolveSeed() {
  throw new Error(
    'resolveSeed is not implemented: the app still resolves seeds through the fixture ' +
      'catalogue (src/data/fixtures.js). Wiring search to the database needs a ' +
      'fe.seed_lookup view exposed through the api schema — see README "Status".',
  );
}
