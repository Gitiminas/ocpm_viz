/**
 * Pull one REAL sub-log out of the database and write it where the app can render it.
 *
 *   node scripts/pull-sublog.mjs                       # the default sample, LIVE1
 *   node scripts/pull-sublog.mjs LIVE2 facebook/react issue:25223795 2
 *
 * ⚠️ **What this writes is a SAMPLE, not a fixture, and the two must not be confused.**
 * A fixture is a small, hand-shaped sub-log that exists to exercise one property and is
 * committed as a stable test input (`tests/fixtures/README.md`). A sample is a snapshot
 * of whatever `api.get_sublog` returned on the day it was run, against MVs that
 * were last refreshed 2026-08-02. It is here so the picture can be LOOKED AT — `npm test`
 * covers the arithmetic and cannot see the picture — and for no other reason. Nothing
 * asserts against it, and it is `LIVE*`-named so `scripts/build-f1.mjs --check` and the
 * fixture suites, which match `^F\d+\.json$`, do not pick it up.
 *
 * This exists because wiring the app to PostgREST is pass 2. Knowing the query underneath
 * already returns the right thing is what makes that pass easy to debug.
 *
 * To remove every trace:
 *   rm tests/fixtures/LIVE*.json && node scripts/build-catalogue.mjs
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.PGDATABASE || 'gharchive_ocpm_viz_wsl';

/*
 * The default sample is vscode PR #116416, chosen for coverage rather than size: it is
 * the only sub-log found that carries all four object types, all four qualifiers, both
 * evidence classes, a collapsed burst and multi-band lanes at once — so if the renderer
 * is wrong about any of them, it is wrong here.
 */
const [id = 'LIVE1', repo = 'microsoft/vscode', seed = 'pr:571599565', degree = '2'] =
  process.argv.slice(2);

const sql = `SELECT api.get_sublog('${repo.replace(/'/g, "''")}', '${seed.replace(/'/g, "''")}', ${Number(degree)})`;
const graph = JSON.parse(
  execFileSync('psql', ['-d', DB, '-Atc', sql], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  }),
);

/*
 * Say what this is, in the payload itself. `meta.source` is the field a reader checks to
 * find out where a bundle came from, and a snapshot of live data that did not announce
 * itself as a snapshot would be the same class of mistake as an undated document.
 */
graph.meta.source = {
  ...graph.meta.source,
  sample: id,
  built_by: 'scripts/pull-sublog.mjs',
  pulled_at: new Date().toISOString(),
  note:
    'LIVE SAMPLE, not a fixture. A snapshot of api.get_sublog output, for looking ' +
    'at the picture. Nothing asserts against it; re-pull rather than edit it.',
};

const target = resolve(ROOT, 'tests/fixtures', `${id}.json`);
writeFileSync(target, `${JSON.stringify(graph, null, 2)}\n`);

const counts = {};
for (const o of graph.objects) counts[o.type] = (counts[o.type] || 0) + 1;
console.log(`wrote ${target}`);
console.log(`  ${repo} · seed ${seed} · degree ${degree}`);
console.log(
  `  ${graph.objects.length} objects (${Object.entries(counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ')}) · ${graph.events.length} events · ${graph.links.length} links`,
);
console.log('\nNow run:  node scripts/build-catalogue.mjs && npm start');
