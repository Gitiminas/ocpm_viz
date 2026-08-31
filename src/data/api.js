/**
 * The PostgREST transport: one sub-log, fetched over HTTP.
 *
 * The transport swap is a one-function change. Nothing above the data layer knows
 * this file exists — `loadObjectGraph(query,
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
 * ⚠️ **Seeds are database ids, not display numbers.** `issue:<issue_id>`,
 * `pr:<pull_request_id>`, `commit:<sha>` — so `issue:655615214`, never `issue:102358`.
 * The RPC rejects a display number rather than guessing, and says so in its hint; see
 * `searchSeeds` below for the lookup that bridges the two.
 */

import { parseSeedRef, scoreSeedRef } from './seedQuery.js';

/**
 * Where the API is, from the browser's point of view.
 *
 * **Empty, meaning same origin.** `scripts/serve.mjs` proxies `/rpc/*` to PostgREST, so
 * the app and the API share an origin and no CORS is involved — which is also what a
 * real deployment behind nginx does, so development and deployment stay the same shape.
 *
 * An absolute URL still works and is what the Node-side scripts pass, since they have no
 * page origin to be same as.
 */
export const DEFAULT_BASE_URL = '';

/**
 * Turn a PostgREST error body into an `Error` worth reading.
 *
 * PostgREST returns `{code, message, details, hint}`. The `hint` is where this
 * project's own RAISE EXCEPTION guidance lands — "seeds are prefixed database ids,
 * here is the query that resolves a number" — and dropping it would throw away the
 * most useful half of the failure. `PGRST*` codes are the API's own (bad function
 * signature, schema cache stale); `P0001` is ours, raised by `api.get_object_graph`.
 */
/**
 * Wrap a transport-level failure so it names the likely cause.
 *
 * An unreachable PostgREST surfaces from `fetch` as the bare string "fetch failed",
 * which tells a reader nothing — not which server, not that a server is even involved.
 * Since the database source is useless without PostgREST and the app defaults to
 * fixtures, "fetch failed" is exactly the moment someone concludes the tool is broken
 * and switches back, never learning that a process was simply not running.
 */
function errorFromFetch(error, baseUrl) {
  const wrapped = new Error(
    `Could not reach PostgREST at ${baseUrl}.\n` +
      `Start it with:  postgrest postgrest.conf\n` +
      `Or switch the Data source to Fixtures, which needs no database.\n` +
      `(${error.message})`,
  );
  wrapped.cause = error;
  wrapped.unreachable = true;
  return wrapped;
}

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
 * How far `get_object_graph` may expand from the seed, and how far it does by default.
 *
 * ⚠️ **One place for both numbers.** The stepper in the sidebar, this transport's
 * default and its validation all read these; the SQL guard in `api.get_object_graph`
 * (`sql/fe_layer.sql`) enforces the same range server-side. Change them together.
 *
 * `max` is 2: a step is steep and non-obvious — on vscode PR #116416 the sub-log runs
 * 1 → 39 → 42 objects across degrees 0–2 and 291 at 3 — and nothing this tool asks
 * (Q1–Q10) needs the third hop. `default` is 1: the seed and what it directly touches is
 * the question most loads are asking, and one click reaches the second hop when it is
 * not.
 */
export const TRAVERSAL_DEGREE = Object.freeze({ min: 0, max: 2, default: 1 });

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
    const { repo, seed, traversalDegree = TRAVERSAL_DEGREE.default } = query;
    if (
      !Number.isInteger(Number(traversalDegree)) ||
      Number(traversalDegree) < TRAVERSAL_DEGREE.min ||
      Number(traversalDegree) > TRAVERSAL_DEGREE.max
    ) {
      throw new Error(
        `traversalDegree must be an integer from ${TRAVERSAL_DEGREE.min} to ` +
          `${TRAVERSAL_DEGREE.max}, got ${traversalDegree}`,
      );
    }

    // Fail here rather than letting the RPC answer "no repository named null". The
    // query is the thing a preset or a URL encodes, so a malformed one is a bug in
    // the caller and should say which field.
    if (!repo) throw new Error('rpcTransport: query.repo is required');
    if (!seed) throw new Error('rpcTransport: query.seed is required');

    let response;
    try {
      response = await fetchImpl(`${baseUrl}/rpc/get_object_graph`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        // Argument names must match the SQL parameter names exactly — PostgREST resolves
        // the overload by name, and a typo is a 404 "could not find the function",
        // not a 400.
        body: JSON.stringify({ repo, seed, traversal_degree: Number(traversalDegree) }),
      });
    } catch (error) {
      throw errorFromFetch(error, baseUrl);
    }

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
 * Search a repository for seeds matching what someone typed.
 *
 * The gap this closes: people know a pull request as `#102479`, and the RPC keys on
 * `pr:448781946`. Numbers are per-repository display labels and ids are identity, so
 * something has to translate. Doing it here
 * keeps that knowledge in the data layer, where the renderer never has to learn it.
 *
 * ⚠️ **The parse and the ranking are NOT reimplemented server-side, on purpose.**
 * `parseSeedRef` turns "pr #243221" into a structured reference and `scoreSeedRef`
 * ranks exact above prefix above substring; both are already unit-tested and both are
 * what the fixture path uses. A second parser in SQL would give the two transports
 * something to disagree about — the fixture search finding what the database search
 * does not — with nothing to say which was right. So: **SQL filters, JavaScript ranks.**
 * `api.search_seeds` takes the already-parsed reference and returns a permissive
 * superset; the ordering below is the same function the catalogue search uses.
 *
 * Mirrors `searchSeeds` in `fixtures.js` — same input, same output shape — so swapping
 * transports changes nothing above this layer.
 *
 * @param {string} repo    repository name
 * @param {string} input   raw text from the seed box
 * @returns {Promise<Array>} ranked matches: `{id, type, label, title}`
 */
export async function searchSeeds(repo, input, { limit = 20, transport } = {}) {
  const ref = parseSeedRef(input);

  /*
   * Naming nothing finds nothing — and deliberately does NOT mirror the fixture search,
   * which enumerates its catalogue for an empty query. The asymmetry is the difference
   * between the sources rather than an inconsistency: 16 fixture seeds are a list worth
   * showing, and a repository is not. With every filter NULL the RPC answers with whatever
   * the stable key orders first — commits by SHA ascending — so an empty box used to open
   * on `commit 0000a70, commit 0000f18, …`, which is not a starting point for anything and
   * cost a 200-row round trip to produce. Returning nothing lets `emptyMessage` say what
   * the box actually wants, which is what it was written for and could never reach.
   */
  if (!ref) return [];

  const search = transport || createSearchTransport();

  const rows = await search({
    repo,
    // `null` rather than `undefined`: JSON.stringify drops undefined keys, and a
    // dropped key makes PostgREST look for a different function signature — a 404
    // that reads like the function is missing rather than like an argument is absent.
    seed_type: ref?.type ?? null,
    number_query: ref?.number != null ? String(ref.number) : null,
    sha_prefix: ref?.shaPrefix ?? null,
    // ⚠️ Free text ONLY when there is no number and no SHA, mirroring `scoreSeedRef`
    // exactly. That function ignores its text branch whenever a number or SHA is
    // present, so sending text alongside one asks the server for candidates the ranker
    // will always discard — and buys an 82 ms title scan on every numeric search to
    // produce them. The server's filter and the client's ranker have to agree about
    // what counts as a match, or the extra work is invisible and permanent.
    //
    // A type word on its own ("pr") also lands here with empty text, and must stay
    // null: it is a filter, not a search, and should narrow rather than match nothing.
    text_query:
      ref?.text && ref.number == null && ref.shaPrefix == null ? ref.text : null,
    // Ask for more than we return, because the server orders by a stable key and the
    // real ranking happens here — trimming to `limit` before ranking would discard
    // better matches than it keeps.
    max_results: Math.min(200, limit * 5),
  });

  return rows
    .map((seed) => ({ seed, score: scoreSeedRef(ref, seed) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score || String(a.seed.label).localeCompare(String(b.seed.label)))
    .slice(0, limit)
    .map(({ seed }) => seed);
}

/** The `search_seeds` half of the API, built the same way as the graph transport. */
export function createSearchTransport({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('No fetch available. Pass fetchImpl, or run on Node 18+ / a browser.');
  }

  return async function searchTransport(params) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/rpc/search_seeds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(params),
      });
    } catch (error) {
      throw errorFromFetch(error, baseUrl);
    }

    if (!response.ok) {
      let body = null;
      try {
        body = await response.json();
      } catch {
        /* see errorFromBody */
      }
      throw errorFromBody(response.status, body);
    }
    return response.json();
  };
}

/**
 * The repositories the database can serve, and whether each has anything to seed from.
 *
 * The one enumerable thing in this API: there are three repositories against hundreds
 * of thousands of objects, so a list is honest here where it would be a lie for seeds.
 *
 * Shaped like the fixture catalogue's `repos` so the selector does not care which
 * source it is reading — including `available` and a `reason` when false, because an
 * unavailable repository is *shown with its reason* rather than quietly omitted.
 */
export async function listRepos({ baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/rpc/list_repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}',
    });
  } catch (error) {
    throw errorFromFetch(error, baseUrl);
  }

  if (!response.ok) {
    let body = null;
    try {
      body = await response.json();
    } catch {
      /* see errorFromBody */
    }
    throw errorFromBody(response.status, body);
  }

  const rows = await response.json();
  return rows.map((row) => ({
    name: row.name,
    repo_id: row.repo_id,
    available: row.available,
    reason: row.reason,
    // Nothing from the database is synthetic; the flag exists so the selector can label
    // fixture repositories, and must be present either way or the label reads undefined.
    synthetic: false,
    // Deliberately absent from the API and deliberately empty here: seeds are searched,
    // never listed. The key exists so callers written against the fixture
    // catalogue do not have to special-case its absence.
    seeds: [],
    // How many objects are searchable — a count, not a list, so it says "there is
    // plenty here" without pretending anything can be enumerated.
    seeds_total: Number(row.seeds),
  }));
}
