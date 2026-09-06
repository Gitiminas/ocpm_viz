/**
 * Fixture transport: serve a sub-log for a `{repo, seed}` query from local JSON.
 *
 * This is the transport used until the RPC exists, and it is deliberately shaped
 * like the real thing rather than like a file picker. A query names **a repository
 * and a seed object**; what comes back is the sub-log reached by traversing
 * outwards from that seed. Swapping to PostgREST means writing a sibling transport
 * that answers the same query against `get_sublog` — nothing above the data
 * layer changes.
 *
 * ⚠️ The honest limitation: there is no traversal here. A fixture is a sub-log that
 * was *already* built, so a seed can only be served if someone pre-built it. The
 * catalogue therefore lists only servable seeds and the UI offers only those. A
 * picker that accepted any object and quietly returned something else would be
 * worse than one that admits its range.
 */

import { parseSeedRef, scoreSeedRef } from './seedQuery.js';

/** Where fixture JSON and the catalogue are served from, relative to the page. */
const BASE = './tests/fixtures/';

let cataloguePromise = null;

/**
 * The selection catalogue: repositories, and the seeds each can serve.
 *
 * Cached, because repopulating the combos would otherwise refetch it. It stands in
 * for what becomes a search endpoint — a real picker cannot enumerate every object
 * in kubernetes, so it will search, and modelling that now keeps the interaction
 * honest.
 */
export function loadCatalogue() {
  if (!cataloguePromise) {
    cataloguePromise = fetch(`${BASE}catalogue.json`).then((response) => {
      if (!response.ok) {
        throw new Error(
          `Could not load the sub-log catalogue (HTTP ${response.status}). ` +
            `The app must be served over http — ES modules and fetch are both blocked ` +
            `on file:// . Run: npm start`,
        );
      }
      return response.json();
    });
  }
  return cataloguePromise;
}

/** Drop the cached catalogue. */
export function clearCatalogueCache() {
  cataloguePromise = null;
}

/**
 * Search a repository's seeds.
 *
 * This is the operation the seed box performs on every keystroke, and it is the one
 * that has to survive contact with a real repository: there is no list to
 * enumerate, so the interaction is "name the object you want". Against fixtures the
 * search runs locally over what is servable; against the RPC it becomes a query,
 * and nothing above the data layer notices.
 *
 * `limit` exists because a real search returns the top matches, never all of them.
 */
export function searchSeeds(catalogue, repoName, input, { limit = 20 } = {}) {
  const repo = catalogue.repos.find((entry) => entry.name === repoName && entry.available);
  if (!repo) return [];

  const ref = parseSeedRef(input);
  return repo.seeds
    .map((seed) => ({ seed, score: scoreSeedRef(ref, seed) }))
    .filter((entry) => entry.score >= 0)
    // Best match first, then a stable alphabetical order so equal scores do not
    // shuffle between keystrokes.
    .sort((a, b) => b.score - a.score || a.seed.label.localeCompare(b.seed.label, undefined, { numeric: true }))
    .slice(0, limit)
    .map((entry) => entry.seed);
}

/**
 * Resolve a query to the fixture that serves it.
 *
 * Accepts either a real query (`{repo, seed}`) or a direct fixture address
 * (`{fixture}`). The latter exists for tests and for `?fixture=` links and is a
 * property of *this* transport only — the RPC transport will understand the query
 * and nothing else.
 */
export function resolveSeed(catalogue, query) {
  if (query?.fixture) return { fixture: query.fixture };

  const available = catalogue.repos.filter((repo) => repo.available);
  const repo = query?.repo ? available.find((entry) => entry.name === query.repo) : available[0];

  if (!repo) {
    const known = catalogue.repos.map((entry) => entry.name).join(', ');
    throw new Error(`No sub-log available for repository "${query?.repo}". Known: ${known}`);
  }

  const seed = query?.seed ? repo.seeds.find((entry) => entry.id === query.seed) : repo.seeds[0];

  if (!seed) {
    throw new Error(
      `No sub-log has been built from seed "${query?.seed}" in ${repo.name}. ` +
        `Seeding from an arbitrary object needs the get_sublog RPC; until then ` +
        `only these are servable: ${repo.seeds.map((entry) => entry.id).join(', ')}`,
    );
  }
  return { fixture: seed.fixture, repo, seed };
}

export async function fixtureTransport(query) {
  const catalogue = await loadCatalogue();
  const { fixture } = resolveSeed(catalogue, query);

  const url = `${BASE}${fixture}.json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load sub-log ${fixture} from ${url} (HTTP ${response.status}).`);
  }
  return response.json();
}

