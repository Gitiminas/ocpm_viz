/**
 * Build the selection catalogue: which repositories exist, and which seed objects
 * a sub-log can currently be built from.
 *
 *   node scripts/build-catalogue.mjs
 *   node scripts/build-catalogue.mjs --check
 *
 * The repository selector is populated from this, and the seed box searches it. It
 * stands in for what becomes a **search query** against the database.
 *
 * ⚠️ It carries only what a search result could cheaply return about an object —
 * its type, its number or SHA, its title. It deliberately does **not** say what a
 * seed *yields*, because working that out means running the traversal, and no
 * system can do that for every candidate in a repository holding hundreds of
 * thousands of objects. A catalogue that summarised its results would be a design
 * that quietly cannot scale.
 *
 * ⚠️ It lists **only seeds the fixture source can serve.** A fixture sub-log exists only
 * where one was pre-built; there is no traversal, so an arbitrary commit cannot be seeded
 * from. Offering seeds that cannot be honoured would be mock UI. Repositories with no
 * fixture are listed explicitly as unavailable, with the reason, rather than being
 * silently absent.
 *
 * ⚠️ **This file describes the fixture source alone.** The database source builds its
 * repository list from `api.list_repos` and searches seeds through `api.search_seeds`;
 * neither reads this catalogue.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = resolve(ROOT, 'tests/fixtures');
const TARGET = resolve(FIXTURE_DIR, 'catalogue.json');

/** Fixed, so the catalogue is byte-stable across runs. */
const GENERATED_AT = '2026-07-31T00:00:00Z';

/**
 * Every fixture is listed under ONE picker entry.
 *
 * The picker used to mirror the fixtures' own repositories — microsoft/vscode for F1 and
 * the LIVE samples, synthetic/fixture for the rest — plus react and kubernetes shown
 * disabled with a "switch to Database" reason. Three entries that could not be chosen or
 * differed only in provenance made the fixture picker read like the database one without
 * being one. It now lists exactly what this source can serve, in one bucket; the source
 * toggle's own note is the pointer to the database.
 *
 * ⚠️ **The bucket's name does not change what the data is.** F1 and the LIVE samples are
 * REAL microsoft/vscode data (the one rule of `tests/fixtures/README.md`); each payload's
 * `meta.repo` still says so and everything downstream reads meta, never this label. The
 * label names the SOURCE ("the bundled fixtures"), not the provenance.
 */
const FIXTURE_BUCKET = 'synthetic/fixture';


function build() {
  /*
   * Fixtures first, then any LIVE samples.
   *
   * `LIVE*.json` is a snapshot of real `api.get_object_graph` output written by
   * `scripts/pull-sublog.mjs`, so the picture can be looked at before the app is wired to
   * PostgREST in pass 2. It is listed here because a sub-log that cannot be selected
   * cannot be rendered — but it is kept a separate name class from `F\d+` on purpose:
   * the fixture suites and `build-f1.mjs --check` match `^F\d+\.json$` and must not pick
   * up a snapshot that changes whenever the upstream MVs are refreshed.
   */
  const fixtures = readdirSync(FIXTURE_DIR)
    .filter((name) => /^F\d+\.json$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const samples = readdirSync(FIXTURE_DIR)
    .filter((name) => /^LIVE\d+\.json$/.test(name))
    .sort();
  const files = [...fixtures, ...samples];

  const byRepo = new Map();

  for (const file of files) {
    const id = file.replace('.json', '');
    const graph = JSON.parse(readFileSync(resolve(FIXTURE_DIR, file), 'utf8'));
    // One bucket for everything the source serves; the payload's own
    // meta.repo is untouched and stays the provenance.
    const byId = new Map(graph.objects.map((object) => [object.id, object]));

    if (!byRepo.has(FIXTURE_BUCKET)) {
      byRepo.set(FIXTURE_BUCKET, {
        name: FIXTURE_BUCKET,
        repo_id: null,
        available: true,
        synthetic: true,
        seeds: [],
      });
    }
    const repo = byRepo.get(FIXTURE_BUCKET);

    for (const seed of graph.meta.seed || []) {
      const object = byId.get(seed.id);
      repo.seeds.push({
        id: seed.id,
        type: seed.type,
        label: object?.label || seed.id,
        // The object's own title — cheap for a search to return, unlike anything
        // about the sub-log it would produce.
        title: object?.vmap?.title ?? null,
        fixture: id,
        // Whether the sub-log behind this seed is real data. F1 and the LIVE samples
        // are; the picker's bucket name must not erase that (fixtures/README.md).
        synthetic: Boolean(graph.meta.data_honesty?.synthetic),
      });
    }
  }

  const repos = [...byRepo.values()];

  for (const repo of repos) {
    // Real sub-logs first — F1 is the app's opening picture and the only fixture that
    // may be cited — then by type and label.
    repo.seeds.sort(
      (a, b) =>
        Number(a.synthetic) - Number(b.synthetic) ||
        a.type.localeCompare(b.type) ||
        a.label.localeCompare(b.label),
    );
  }

  return {
    generated_at: GENERATED_AT,
    built_by: 'scripts/build-catalogue.mjs',
    note:
      'Seeds listed here are the ones the FIXTURE source can serve: a sub-log exists only ' +
      'where one was pre-built, so an arbitrary object cannot be seeded from. The database ' +
      'source traverses for real — switch Data source to Database, or use ?source=database.',
    // Nothing unavailable is listed any more: the source
    // toggle's note is the pointer to the database, and a picker of dead rows was the
    // database picker's ghost.
    repos,
  };
}

const catalogue = build();

const servable = catalogue.repos.filter((repo) => repo.available);
if (!servable.length) throw new Error('Catalogue has no available repositories.');
for (const repo of servable) {
  if (!repo.seeds.length) throw new Error(`Repository ${repo.name} is available but has no seeds.`);
}

const json = `${JSON.stringify(catalogue, null, 2)}\n`;

if (process.argv.includes('--check')) {
  let current = null;
  try {
    current = readFileSync(TARGET, 'utf8');
  } catch {
    /* missing counts as stale */
  }
  if (current !== json) {
    console.error('tests/fixtures/catalogue.json is stale. Run: npm run build:fixtures');
    process.exit(1);
  }
  console.log('Catalogue is up to date.');
} else {
  writeFileSync(TARGET, json);
  const seeds = servable.reduce((sum, repo) => sum + repo.seeds.length, 0);
  console.log(
    `Wrote tests/fixtures/catalogue.json — ${servable.length} repositories with data, ` +
      `${seeds} seeds in one bucket.`,
  );
}
