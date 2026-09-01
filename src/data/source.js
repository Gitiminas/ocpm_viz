/**
 * Which data source the app is talking to — fixtures on disk, or the database.
 *
 * Both are real and both stay. The fixtures are the test corpus and the visual
 * baseline; they exercise shapes real data does not conveniently contain (a reopened
 * issue, three PRs in two bands, a commit inside two overlapping PRs) and they must
 * keep loading. The database is what the tool is actually for.
 *
 * So this module is the seam, and it exists to keep `main.js` from growing a branch
 * everywhere it touches data. Four operations, two implementations, one shape:
 *
 *   listRepos()                  what can be asked about
 *   searchSeeds(repo, text)      what can be asked for
 *   loadSubLog(query)            the answer
 *   loadDfg(repo)                the whole-log directly-follows graph
 *
 * ⚠️ **`searchSeeds` is async in both.** The fixture version has nothing to await, but
 * making the shapes differ would push the difference up into the caller, which is the
 * one thing this module exists to prevent. `loadDfg` follows the same rule.
 *
 * Selection is by URL, `?source=`, defaulting to fixtures. That is deliberate for now:
 * the database source needs PostgREST running, and a tool that fails to start when a
 * server is down would be worse than one that starts on fixtures and says so.
 */

import { loadObjectGraph } from './loadObjectGraph.js';
import { loadDfg } from './loadDfg.js';
import {
  loadCatalogue,
  searchSeeds as searchFixtureSeeds,
  fixtureTransport,
  dfgSampleTransport,
} from './fixtures.js';
import {
  rpcTransport,
  dfgTransport,
  searchSeeds as searchDatabaseSeeds,
  listRepos as listDbRepos,
} from './api.js';

export const SOURCES = ['fixtures', 'database'];

/** What `?source=` selects, defaulting to fixtures. */
export function sourceFromUrl(search = globalThis.location?.search ?? '') {
  const value = new URLSearchParams(search).get('source');
  return SOURCES.includes(value) ? value : 'fixtures';
}

/**
 * The fixture source: a pre-built sub-log per seed, served from JSON on disk.
 *
 * Its honest limitation, unchanged from `fixtures.js`: there is no traversal. A seed
 * resolves only where a sub-log was already built, which is why the catalogue lists
 * exactly what is servable and the UI offers nothing else.
 */
function fixtureSource() {
  let cataloguePromise = null;
  const catalogue = () => (cataloguePromise ??= loadCatalogue());

  return {
    name: 'fixtures',
    async listRepos() {
      return (await catalogue()).repos;
    },
    async searchSeeds(repo, text, options) {
      return searchFixtureSeeds(await catalogue(), repo, text, options);
    },
    loadSubLog(query) {
      return loadObjectGraph(query, { transport: fixtureTransport });
    },
    // The sample, whatever repository is picked; the page shows the sample's own
    // meta.repo rather than pretending it matches the picker.
    loadDfg() {
      return loadDfg({}, { transport: dfgSampleTransport });
    },
    /*
     * The first servable seed, so opening the app shows something.
     *
     * ⚠️ Falls back to the first *available repository* when none is named, because a
     * bare `/` is the normal way to open the app and it carries no `?repo=`. The
     * fixture transport always did this internally; when the seed choice moved up
     * here, dropping it meant a plain visit showed "choose something to start from"
     * with a repository already selected — which is nonsense, and is what an
     * incomplete extraction of an implicit behaviour looks like.
     */
    async defaultSeed(repo) {
      const repos = (await catalogue()).repos;
      const entry =
        (repo && repos.find((r) => r.name === repo && r.available)) ||
        (!repo && repos.find((r) => r.available));
      return entry?.seeds?.[0]?.id ?? null;
    },
    // Fixtures were built at a fixed traversal degree; nothing can change it.
    traversalEditable: false,
    emptySeedMessage: (described, repo) =>
      `No sub-log built from ${described} in ${repo}. Seeding from an arbitrary object ` +
      `needs the database source — add ?source=database`,
  };
}

/** The database source: PostgREST in front of `api.get_object_graph`. */
function databaseSource() {
  return {
    name: 'database',
    listRepos: listDbRepos,
    searchSeeds: searchDatabaseSeeds,
    loadSubLog(query) {
      return loadObjectGraph(query, { transport: rpcTransport });
    },
    loadDfg(repo) {
      return loadDfg({ repo }, { transport: dfgTransport });
    },
    /*
     * **There is no default seed, and that is the design, not a gap.**
     *
     * The selection is a *query*: a repository AND an object to traverse out from. A
     * repository on its own is an incomplete query, and the seed is chosen by search, so
     * there is no list for a default to come from — you cannot enumerate hundreds of
     * thousands of objects to take the first. Inventing one (the newest issue, say) would
     * put an arbitrary sub-log on screen that the user did not ask for and cannot account
     * for. So the app asks, which is what the seed box is for.
     */
    async defaultSeed() {
      return null;
    },
    traversalEditable: true,
    emptySeedMessage: (described, repo) => `No ${described} found in ${repo}.`,
  };
}

/** Build the source named by `?source=`, or the one asked for. */
export function createSource(name = sourceFromUrl()) {
  return name === 'database' ? databaseSource() : fixtureSource();
}

/**
 * Decide what a query means before anything is fetched: load it, or ask for a seed.
 *
 * Extracted from `main.js` because it is a three-case decision with a trap in it, and
 * buried in DOM code the trap was invisible. The cases:
 *
 *   1. `?fixture=F1`   a DIRECT ADDRESS, not a query. Carries no seed by design and
 *                      must not be asked for one — this is how the tests and
 *                      already-written-down links name a specific bundle.
 *   2. repo + seed     a complete query. Load it.
 *   3. repo, no seed   incomplete. The fixture source may offer its first servable
 *                      seed; the database source cannot, so: prompt.
 *
 * Case 1 is the trap. The first version of the missing-seed fix tested only for a seed,
 * so every `?fixture=` link started showing "choose something to start from" instead of
 * the fixture — a regression caught by opening one, not by any test. Hence this
 * function, and hence the suite around it.
 *
 * @returns {Promise<{action:'load'|'prompt', query?:object, repo?:string}>}
 */
export async function resolveQuery(query, source) {
  if (query?.fixture) return { action: 'load', query };

  const seed = query?.seed || (await source.defaultSeed(query?.repo));
  if (!seed) return { action: 'prompt', repo: query?.repo };

  return { action: 'load', query: { ...query, seed } };
}
