/**
 * Write one sub-log as an OCEL 2.0 JSON log (`src/model/ocel.js`).
 *
 *   node scripts/export-ocel.mjs F1                       # to stdout
 *   node scripts/export-ocel.mjs LIVE2 --out /tmp/LIVE2.ocel.json
 *   node scripts/export-ocel.mjs --repo microsoft/vscode --seed pr:571599565 --degree 2 --out x.json
 *
 * A fixture name reads `tests/fixtures/<name>.json`; `--repo`/`--seed` asks the running
 * PostgREST (`scripts/serve.mjs` proxy at :8000, or `OCPM_RPC` for another base) for a
 * live sub-log. Either way the bundle goes through `loadSubLog`, so what is exported is
 * what the app would draw, and the export is checked by `findOcelProblems` before it is
 * written. `scripts/ocel-check.py` reads the result back with pm4py.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { loadSubLog } from '../src/data/loadSubLog.js';
import { toOcelJson, findOcelProblems } from '../src/model/ocel.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const fixture = positional[0];
const repo = flag('repo');
const seed = flag('seed');
const degree = Number(flag('degree') ?? 2);
const out = flag('out');

if (!fixture && !(repo && seed)) {
  console.error('usage: export-ocel.mjs <fixture> [--out file] | --repo <name> --seed <id> [--degree n] [--out file]');
  process.exit(2);
}

const fileTransport = async (query) =>
  JSON.parse(await readFile(new URL(`../tests/fixtures/${query.fixture}.json`, import.meta.url), 'utf8'));

const rpcTransport = async (query) => {
  const base = process.env.OCPM_RPC ?? 'http://localhost:8000/rpc';
  const response = await fetch(`${base}/get_sublog`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: query.repo, seed: query.seed, traversal_degree: query.traversalDegree }),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
};

const graph = fixture
  ? await loadSubLog({ fixture }, { transport: fileTransport })
  : await loadSubLog({ repo, seed, traversalDegree: degree }, { transport: rpcTransport });

const log = toOcelJson(graph);
const problems = findOcelProblems(log);
if (problems.length) {
  console.error(`FAIL — the export breaks ${problems.length} rule(s):`);
  for (const p of problems.slice(0, 40)) console.error(`  - ${p}`);
  process.exit(1);
}

const text = JSON.stringify(log, null, 1);
if (out) {
  await writeFile(out, text);
  console.error(
    `wrote ${out} — ${log.objectTypes.length} object types, ${log.eventTypes.length} event types, ` +
      `${log.objects.length} objects, ${log.events.length} events, ` +
      `${log.events.reduce((n, e) => n + e.relationships.length, 0)} E2O rows, ` +
      `${log.objects.reduce((n, o) => n + (o.relationships?.length ?? 0), 0)} O2O rows`,
  );
} else {
  process.stdout.write(text);
}
