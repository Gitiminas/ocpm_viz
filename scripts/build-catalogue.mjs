/**
 * Build the selection catalogue: which repositories exist, and which seed objects
 * a sub-log can currently be built from.
 *
 *   node scripts/build-catalogue.mjs
 *   node scripts/build-catalogue.mjs --check
 *
 * The app's two selectors — repo, then seed — are populated from this. It stands in
 * for what will become a **search query** against the database: a real picker cannot
 * list every object in kubernetes, so it will search. Modelling that as a catalogue
 * now keeps the interaction honest and makes the eventual swap a change of
 * transport rather than a change of interaction.
 *
 * ⚠️ It lists **only seeds that can actually be served.** With fixtures, a sub-log
 * exists only where one was pre-built; there is no traversal, so an arbitrary commit
 * cannot be seeded from. Offering seeds that cannot be honoured would be mock UI.
 * Repositories that are in scope for RQ2 but hold no data are listed explicitly as
 * unavailable, with the reason, rather than being silently absent.
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
 * Repositories in the thesis scope that currently hold no loadable sub-log.
 *
 * Listed rather than omitted: their absence is a *finding* — the RQ2 limitation
 * about detection coverage is precisely about these two — and a picker that simply
 * did not mention them would hide that.
 */
const UNAVAILABLE_REPOS = [
  {
    name: 'facebook/react',
    reason: 'No sub-log built yet — needs the get_object_graph RPC.',
  },
  {
    name: 'kubernetes/kubernetes',
    reason: 'No sub-log built yet — needs the get_object_graph RPC.',
  },
];

function summarize(graph) {
  const counts = new Map();
  for (const object of graph.objects) {
    counts.set(object.type, (counts.get(object.type) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, n]) => `${n} ${type}${n === 1 ? '' : 's'}`)
    .join(', ');
}

function build() {
  const files = readdirSync(FIXTURE_DIR)
    .filter((name) => /^F\d+\.json$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

  const byRepo = new Map();

  for (const file of files) {
    const id = file.replace('.json', '');
    const graph = JSON.parse(readFileSync(resolve(FIXTURE_DIR, file), 'utf8'));
    const repoName = graph.meta.repo;
    const byId = new Map(graph.objects.map((object) => [object.id, object]));

    if (!byRepo.has(repoName)) {
      byRepo.set(repoName, {
        name: repoName,
        repo_id: graph.meta.repo_id ?? null,
        available: true,
        synthetic: Boolean(graph.meta.data_honesty?.synthetic),
        seeds: [],
      });
    }
    const repo = byRepo.get(repoName);
    // A repository is only "real" if every sub-log under it is; one synthetic
    // fixture sharing a real repo name would make the label a lie.
    repo.synthetic = repo.synthetic || Boolean(graph.meta.data_honesty?.synthetic);

    for (const seed of graph.meta.seed || []) {
      const object = byId.get(seed.id);
      repo.seeds.push({
        id: seed.id,
        type: seed.type,
        label: object?.label || seed.id,
        fixture: id,
        traversal_degree: graph.meta.traversal_degree ?? null,
        yields: summarize(graph),
      });
    }
  }

  const repos = [...byRepo.values()].sort((a, b) => {
    // Real data first, then synthetic, each alphabetically.
    if (a.synthetic !== b.synthetic) return a.synthetic ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  for (const repo of repos) {
    repo.seeds.sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label));
  }

  return {
    generated_at: GENERATED_AT,
    built_by: 'scripts/build-catalogue.mjs',
    note:
      'Seeds listed here are the ones a sub-log can actually be served for. Until the ' +
      'get_object_graph RPC exists there is no traversal, so an arbitrary object cannot ' +
      'be seeded from.',
    repos: [
      ...repos,
      ...UNAVAILABLE_REPOS.map((repo) => ({ ...repo, available: false, synthetic: false, seeds: [] })),
    ],
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
      `${seeds} seeds, ${UNAVAILABLE_REPOS.length} listed as unavailable.`,
  );
}
