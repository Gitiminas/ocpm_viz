/**
 * Pull one REAL whole-log directly-follows graph out of the database and write it where
 * the fixtures source can serve it.
 *
 *   node scripts/pull-dfg.mjs                    # the default sample, DFG1 (vscode)
 *   node scripts/pull-dfg.mjs DFG1 facebook/react
 *
 * ⚠️ **What this writes is a SAMPLE, not a fixture** — the same rule `pull-sublog.mjs`
 * states for the LIVE sub-logs. It is a snapshot of whatever `api.get_dfg` returned on
 * the day it was run, against `fe.dfg_mat` as last refreshed; it exists so the process
 * map can be looked at without a database, and `tests/dfg.test.js` asserts only that it
 * passes the validator — its SHAPE, never a count. `DFG*`-named so the fixture suites
 * and builders, which match `^F\d+\.json$` and `^LIVE\d+\.json$`, do not pick it up,
 * and it is not in the catalogue, which maps seeds to sub-logs and a DFG has no seed.
 *
 * To remove every trace:  rm tests/fixtures/DFG1.json
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.PGDATABASE || 'gharchive_ocpm_viz_wsl';

// vscode by default: the repository with the widest activity coverage — every one of
// the map's ten activities occurs (nine plus Push), including the off-platform merge.
const [id = 'DFG1', repo = 'microsoft/vscode'] = process.argv.slice(2);

const sql = `SELECT api.get_dfg('${repo.replace(/'/g, "''")}')`;
const dfg = JSON.parse(
  execFileSync('psql', ['-d', DB, '-Atc', sql], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  }),
);

// Say what this is, in the payload itself — a snapshot that did not announce itself
// as a snapshot would be the same class of mistake as an undated document.
dfg.meta.source = {
  ...dfg.meta.source,
  sample: id,
  built_by: 'scripts/pull-dfg.mjs',
  pulled_at: new Date().toISOString(),
  note:
    'DFG SAMPLE, not a fixture. A snapshot of api.get_dfg output, for looking at the ' +
    'process map. Only its shape is asserted; re-pull rather than edit it.',
};

const target = resolve(ROOT, 'tests/fixtures', `${id}.json`);
writeFileSync(target, `${JSON.stringify(dfg, null, 2)}\n`);

console.log(`wrote ${target}`);
console.log(
  `  ${repo} · ${dfg.nodes.length} activity nodes · ${dfg.edges.length} succession ` +
    `edges · ${dfg.cross_edges.length} cross edges`,
);
