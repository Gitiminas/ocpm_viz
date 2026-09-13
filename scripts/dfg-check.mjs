/**
 * The acceptance gate for the DFG half of the data layer (`sql/fe_layer.sql` §12–§13).
 * Run it after any change there, beside `rpc-check.mjs`, which gates the sub-log half —
 * a sibling rather than an extension because the sub-log gate's layout passes are
 * 240 lines a DFG payload never enters, and the two take different arguments.
 *
 *   node scripts/dfg-check.mjs                       # microsoft/vscode
 *   node scripts/dfg-check.mjs facebook/react
 *   PGRST_URL=http://localhost:3000 node scripts/dfg-check.mjs
 *
 * What it proves, in order: the payload passes the validator; the per-node conservation
 * the validator's per-type totals cannot see (each node's occurrences = starts + inbound
 * successions = ends + outbound, per-type edges only — a cross succession is not part
 * of either object's own sequence arithmetic); that the commit lane's Push occurrences
 * equal the pushed_commit rows of fe.e2o for the repository, so the two pages
 * agree modulo naming; the vocabulary rules hold in the raw
 * JSON text; `loadDfg` accepts it; `layoutDfg` places it finitely inside its box; and
 * one unauthenticated HTTP call reaches `api.get_dfg` as `web_anon` — the only step
 * that would catch the SECURITY INVOKER reset for the NEW function, which the
 * `list_repos` probe in rpc-check cannot. Unreachable PostgREST is a skip, not a
 * failure (`PGRST_URL`, `PGRST_SKIP`).
 */

import { execFileSync } from 'node:child_process';

import { findDfgProblems } from '../src/model/dfg.js';
import { loadDfg } from '../src/data/loadDfg.js';
import { layoutDfg } from '../src/layout/dfg.js';
import { LANE_TYPES } from '../src/model/activities.js';

const DB = process.env.PGDATABASE || 'gharchive_ocpm_viz_wsl';
const [repo = 'microsoft/vscode'] = process.argv.slice(2);

const quote = (value) => value.replace(/'/g, "''");

// The fact the cross-edge attribution leans on: no linked pair carries two links, so a
// succession inherits ONE (qualifier, evidence, method). Verified 2026-09-01; asserted
// here so it fails loudly the day an fe.link change breaks it.
const duplicatePairs = execFileSync(
  'psql',
  [
    '-d',
    DB,
    '-Atc',
    'SELECT count(*) FROM (SELECT repo_id, source, target FROM fe.link_mat ' +
      'GROUP BY 1, 2, 3 HAVING count(*) > 1) d',
  ],
  { encoding: 'utf8' },
).trim();
if (duplicatePairs !== '0') {
  console.error(
    `\nFAIL — ${duplicatePairs} (source, target) pair(s) carry more than one link; ` +
      'the DFG attributes each cross succession to its pair’s ONE link, and that ' +
      'just stopped being true.',
  );
  process.exit(1);
}
console.log('gate    one link per pair in fe.link_mat   ✓');

const started = Date.now();
const text = execFileSync('psql', ['-d', DB, '-Atc', `SELECT api.get_dfg('${quote(repo)}')`], {
  encoding: 'utf8',
  maxBuffer: 512 * 1024 * 1024,
});
const raw = JSON.parse(text);
console.log(`rpc     api.get_dfg('${repo}')   ${text.length} B in ${Date.now() - started} ms`);

const fail = [];

// ---- the validator, then the checks it deliberately does not make --------------------
const problems = findDfgProblems(raw);
if (problems.length) fail.push(...problems.map((p) => `validator: ${p}`));

for (const type of LANE_TYPES) {
  for (const node of raw.nodes.filter((n) => n.object_type === type)) {
    const inbound = raw.edges
      .filter((e) => e.object_type === type && e.to_activity === node.activity)
      .reduce((s, e) => s + e.successions, 0);
    const outbound = raw.edges
      .filter((e) => e.object_type === type && e.from_activity === node.activity)
      .reduce((s, e) => s + e.successions, 0);
    if (node.occurrences !== node.starts + inbound) {
      fail.push(
        `${type}/${node.activity}: ${node.occurrences} occurrences but ${node.starts} starts + ` +
          `${inbound} inbound successions`,
      );
    }
    if (node.occurrences !== node.ends + outbound) {
      fail.push(
        `${type}/${node.activity}: ${node.occurrences} occurrences but ${node.ends} ends + ` +
          `${outbound} outbound successions`,
      );
    }
    if (node.events > node.occurrences) {
      fail.push(`${type}/${node.activity}: ${node.events} events over ${node.occurrences} occurrences`);
    }
  }
}

// Trace and the map count the same relation: the map's commit/Push node has one
// occurrence per pushed_commit row of fe.e2o for the repository, and one event per
// distinct push among them — the rows the sub-log RPC emits as a push's relationships.
// Read off the live view, so the materialization is checked against its definition.
const push = raw.nodes.find((n) => n.object_type === 'commit' && n.activity === 'Push');
if (push) {
  const [occurrences, events] = execFileSync(
    'psql',
    [
      '-d',
      DB,
      '-Atc',
      `SELECT count(*) || '|' || count(DISTINCT event_id) FROM fe.e2o ` +
        `WHERE repo_id = ${Number(raw.meta.repo_id)} AND qualifier = 'pushed_commit'`,
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split('|');
  if (String(push.occurrences) !== occurrences) {
    fail.push(
      `commit/Push has ${push.occurrences} occurrences but fe.e2o holds ${occurrences} ` +
        `pushed_commit rows for repo ${raw.meta.repo_id}`,
    );
  }
  if (String(push.events) !== events) {
    fail.push(`commit/Push has ${push.events} events but fe.e2o holds ${events} pushes with commits`);
  }
}

// §12.1: the sequence-ends table counts the same starts and ends the map does, node by
// node — it was computed in the same (time, id) order over the same E2O layer, and this
// is what lets the node card's tile and the sidebar's "n of total" name one number.
const sequenceCounts = JSON.parse(
  execFileSync(
    'psql',
    [
      '-d',
      DB,
      '-Atc',
      `SELECT COALESCE(jsonb_agg(jsonb_build_object('type', t, 'activity', a, 'edge', e, 'n', n)), '[]') ` +
        `FROM (SELECT object_type t, first_activity a, 'start' e, count(*) n FROM fe.dfg_sequence_mat ` +
        `WHERE repo_id = ${Number(raw.meta.repo_id)} GROUP BY 1, 2 ` +
        `UNION ALL SELECT object_type, last_activity, 'end', count(*) FROM fe.dfg_sequence_mat ` +
        `WHERE repo_id = ${Number(raw.meta.repo_id)} GROUP BY 1, 2) s`,
    ],
    { encoding: 'utf8' },
  ),
);
const sequenceCount = (type, activity, edge) =>
  sequenceCounts.find((r) => r.type === type && r.activity === activity && r.edge === edge)?.n ?? 0;
for (const node of raw.nodes) {
  for (const [edge, field] of [['start', 'starts'], ['end', 'ends']]) {
    const n = sequenceCount(node.object_type, node.activity, edge);
    if (n !== node[field]) {
      fail.push(
        `${node.object_type}/${node.activity}: the map says ${node[field]} ${field} but ` +
          `fe.dfg_sequence_mat holds ${n} objects whose sequence ${edge}s there`,
      );
    }
  }
}

// The vocabulary rules, checked against the raw text so a field the parser ignores
// still counts: no case notion, and no BARE link vocabulary on successions — the
// key-form regexes (`"evidence":`) cannot match the sanctioned link_-prefixed keys,
// whose quote sits before the `l`.
if (/"case/i.test(text)) fail.push('the raw payload contains a "case…" key');
for (const bare of ['evidence', 'qualifier', 'method']) {
  if (new RegExp(`"${bare}"\\s*:`).test(text)) {
    fail.push(`the raw payload carries a bare "${bare}" key; the link's class is link_${bare}`);
  }
}

if (fail.length) {
  console.error(`\nFAIL — ${fail.length} problem(s):`);
  for (const line of fail.slice(0, 40)) console.error(`  - ${line}`);
  process.exit(1);
}
console.log('gate    validator, per-node conservation, Push = fe.e2o pushed_commit, sequence ends, vocabulary   ✓');

// ---- the sequence-objects RPC, on the listable activities ----------------------------
for (const [type, activity, edge] of [
  ['issue', 'IssueOpened', 'start'],
  ['issue', 'IssueClosed', 'end'],
  ['pull_request', 'PullRequestMerged', 'end'],
  ['commit', 'Push', 'start'],
]) {
  const listed = JSON.parse(
    execFileSync(
      'psql',
      ['-d', DB, '-Atc', `SELECT api.list_sequence_objects('${quote(repo)}', '${type}', '${activity}', '${edge}', 5)`],
      { encoding: 'utf8' },
    ),
  );
  const node = raw.nodes.find((n) => n.object_type === type && n.activity === activity);
  const expected = node ? node[edge === 'start' ? 'starts' : 'ends'] : 0;
  if (listed.meta.total !== expected) {
    fail.push(`list_sequence_objects(${type}, ${activity}, ${edge}).meta.total is ${listed.meta.total}, the map says ${expected}`);
  }
  if (!Array.isArray(listed.rows) || listed.rows.length > 5) fail.push(`list_sequence_objects returned ${listed.rows?.length} rows for max_results 5`);
  for (const row of listed.rows || []) {
    if (!/^(issue|pr|commit):/.test(row.id) || row.type !== type || !row.label || !row.at) {
      fail.push(`list_sequence_objects row is not a loadable seed: ${JSON.stringify(row)}`);
    }
  }
  for (let i = 1; i < (listed.rows || []).length; i++) {
    if (listed.rows[i - 1].at < listed.rows[i].at) fail.push('list_sequence_objects rows are not most-recent-first');
  }
  // A commit row names the push its sequence edge belongs to, so the list can group by it.
  if (type === 'commit') {
    for (const row of listed.rows || []) {
      if (!Number.isInteger(row.push_id) || !Number.isInteger(row.push_commits)) {
        fail.push(`commit row ${row.id} carries no push_id / push_commits`);
      }
    }
  }
}
if (fail.length) {
  console.error(`\nFAIL — ${fail.length} problem(s):`);
  for (const line of fail.slice(0, 40)) console.error(`  - ${line}`);
  process.exit(1);
}
console.log('gate    api.list_sequence_objects: totals match the map, rows are seeds, most recent first   ✓');

// ---- through the real loader and the real layout -------------------------------------
const dfg = await loadDfg({ repo }, { transport: async () => raw });
const layout = layoutDfg(dfg, { width: 1100 });

const layoutFail = [];
for (const node of layout.nodes) {
  if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
    layoutFail.push(`${node.object_type}/${node.activity} has a non-finite position`);
  }
  if (node.x < 0 || node.x > layout.width || node.y < 0 || node.y > layout.height) {
    layoutFail.push(`${node.object_type}/${node.activity} sits outside the box`);
  }
}
const seen = new Set();
for (const node of layout.nodes) {
  const at = `${Math.round(node.x)},${Math.round(node.y)}`;
  if (seen.has(at)) layoutFail.push(`two activity nodes share ${at}`);
  seen.add(at);
}
for (const edge of [...layout.edges, ...layout.crossEdges]) {
  for (const point of edge.points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      layoutFail.push(`edge ${edge.from_activity}→${edge.to_activity} has a non-finite point`);
    }
  }
}
if (layoutFail.length) {
  console.error(`\nFAIL — layout: ${layoutFail.length} problem(s):`);
  for (const line of layoutFail.slice(0, 40)) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(
  `gate    loadDfg + layoutDfg: ${layout.nodes.length} nodes, ` +
    `${layout.edges.length}+${layout.crossEdges.length} edges, finite and in-box   ✓`,
);

// ---- and the app reaches it as web_anon, not as the owner ----------------------------
if (process.env.PGRST_SKIP) {
  console.log('gate    web_anon over HTTP   — skipped (PGRST_SKIP)');
} else {
  const base = process.env.PGRST_URL || 'http://localhost:3000';
  let response = null;
  try {
    response = await fetch(`${base}/rpc/get_dfg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ repo }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    console.log(`gate    web_anon over HTTP   — skipped (nothing listening at ${base})`);
  }
  if (response) {
    if (!response.ok) {
      const body = await response.text();
      console.error(`\nFAIL — PostgREST answered ${response.status} as web_anon:`);
      console.error(`  ${body.slice(0, 300)}`);
      if (/permission denied/i.test(body)) {
        console.error(
          '\n  This is the SECURITY INVOKER regression, on the NEW function. Fix:\n' +
            `\n      psql -d ${DB} -f sql/postgrest_setup.sql\n`,
        );
      }
      process.exit(1);
    }
    const body = await response.json();
    console.log(`gate    web_anon reaches api.get_dfg over HTTP (${body.nodes.length} nodes)   ✓`);

    // The new function too: a SECURITY INVOKER reset on it would fail only here.
    const listed = await fetch(`${base}/rpc/list_sequence_objects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ repo, object_type: 'issue', activity: 'IssueClosed', edge: 'end', max_results: 3 }),
      signal: AbortSignal.timeout(10000),
    });
    if (!listed.ok) {
      console.error(`\nFAIL — PostgREST answered ${listed.status} as web_anon on list_sequence_objects:`);
      console.error(`  ${(await listed.text()).slice(0, 300)}`);
      process.exit(1);
    }
    const listedBody = await listed.json();
    console.log(`gate    web_anon reaches api.list_sequence_objects over HTTP (${listedBody.meta.total} closes)   ✓`);
  }
}

console.log(
  `\nnodes ${raw.nodes.length} · edges ${raw.edges.length} · cross ${raw.cross_edges.length}`,
);
console.log('\nPASS');
