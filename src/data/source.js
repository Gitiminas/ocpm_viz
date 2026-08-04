/**
 * Which data source the app is talking to — fixtures on disk, or the database.
 *
 * Both are real and both stay. The 13 fixtures are the test corpus and the visual
 * baseline; they exercise shapes real data does not conveniently contain (a reopened
 * issue, three PRs in two bands, a commit inside two overlapping PRs) and they must
 * keep loading. The database is what the tool is actually for.
 *
 * So this module is the seam, and it exists to keep `main.js` from growing a branch
 * everywhere it touches data. Three operations, two implementations, one shape:
 *
 *   listRepos()                  what can be asked about
 *   searchSeeds(repo, text)      what can be asked for
 *   loadSubLog(query)            the answer
 *
 * ⚠️ **`searchSeeds` is async in both.** The fixture version has nothing to await, but
 * making the shapes differ would push the difference up into the caller, which is the
 * one thing this module exists to prevent.
 *
 * Selection is by URL, `?source=`, defaulting to fixtures. That is deliberate for now:
 * the database source needs PostgREST running, and a tool that fails to start when a
 * server is down would be worse than one that starts on fixtures and says so.
 */

import { loadObjectGraph } from './loadObjectGraph.js';
import { loadCatalogue, searchSeeds as searchFixtureSeeds, fixtureTransport } from './fixtures.js';
import { rpcTransport, searchSeeds as searchDatabaseSeeds, listRepos as listDbRepos } from './api.js';

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
    traversalEditable: true,
    emptySeedMessage: (described, repo) => `No ${described} found in ${repo}.`,
  };
}

/** Build the source named by `?source=`, or the one asked for. */
export function createSource(name = sourceFromUrl()) {
  return name === 'database' ? databaseSource() : fixtureSource();
}
