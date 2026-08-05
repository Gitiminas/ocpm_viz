/**
 * Acceptance gate for `sql/fe_layer.sql`: feed a REAL RPC payload through the same
 * entry point the app uses and require `findGraphProblems` to return `[]`.
 *
 * This is the check the database cannot do for itself. `fe.diag_sanity` proves the SQL
 * is internally consistent; this proves the payload satisfies the *frontend's* contract
 * — the closed activity vocabulary, the four object types, the two evidence classes, the
 * known link methods, and the both-endpoints-are-objects rule (decision 49) — which is
 * the same gate all 13 fixtures pass.
 *
 * The transport here is what `src/data/api.js` becomes in pass 2. It shells out to psql
 * rather than speaking to PostgREST, because PostgREST is not wired up yet and the point
 * of this script is to validate the SQL underneath it: knowing the query returns the
 * right thing is what makes the HTTP layer easy to debug later.
 *
 *   node scripts/rpc-check.mjs [repo] [seed] [degree]
 *   node scripts/rpc-check.mjs microsoft/vscode issue:2902032454 2
 */

import { execFileSync } from 'node:child_process';
import { loadObjectGraph, describeSubLog } from '../src/data/loadObjectGraph.js';
import { findGraphProblems, indexObjectGraph, collectInstants } from '../src/model/objectGraph.js';
import { ACTIVITIES } from '../src/model/activities.js';
import { deriveBursts } from '../src/model/bursts.js';
import { buildNodes, assignRanks } from '../src/layout/nodes.js';
import { createScales } from '../src/layout/scales.js';
import { packRows, objectExtent } from '../src/layout/packing.js';
import { computeLaneGeometry, rowY } from '../src/layout/lanes.js';
import { createAnchors } from '../src/layout/anchors.js';

const DB = process.env.PGDATABASE || 'gharchive_ocpm_viz_wsl';

const [repo = 'microsoft/vscode', seed = 'issue:2902032454', degree = '2'] =
  process.argv.slice(2);

/** The RPC transport. One function — exactly the swap `ADAPTER_AND_API.md` §4 promises. */
function rpcTransport(query) {
  const sql = `SELECT api.get_object_graph(
                 ${quote(query.repo)}, ${quote(query.seed)}, ${Number(query.traversalDegree)})`;
  const out = execFileSync('psql', ['-d', DB, '-Atc', sql], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function quote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

const query = { repo, seed, traversalDegree: Number(degree) };

const started = Date.now();
const raw = rpcTransport(query);
const fetchMs = Date.now() - started;

// ---- the gate -----------------------------------------------------------------------
const problems = findGraphProblems(raw);

console.log(`RPC     api.get_object_graph(${repo}, ${seed}, ${degree})`);
console.log(`payload ${JSON.stringify(raw).length.toLocaleString()} bytes in ${fetchMs} ms`);
console.log(
  `counts  ${raw.objects.length} objects · ${raw.events.length} events · ${raw.links.length} links`,
);

if (problems.length) {
  console.error(`\nFAIL — findGraphProblems returned ${problems.length} problem(s):`);
  for (const p of problems.slice(0, 40)) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('gate    findGraphProblems() === []   ✓');

// ---- the checks the validator does not make ------------------------------------------
// Not redundant with the validator: these are contract facts it has no opinion about, and
// each maps to something that would render wrongly rather than error.
const fail = [];

if (raw.meta.contract_version !== 2) {
  fail.push(`meta.contract_version is ${raw.meta.contract_version}, expected 2 (decision 45)`);
}

// Decision 55: a timestamp the renderer cannot parse passes findGraphProblems, which only
// checks that `time` is non-empty, and then reaches the layout as NaN.
for (const e of raw.events) {
  if (Number.isNaN(Date.parse(e.time))) fail.push(`event ${e.id} has unparseable time "${e.time}"`);
}
for (const o of raw.objects) {
  for (const iv of o.intervals) {
    if (iv.start && Number.isNaN(Date.parse(iv.start))) {
      fail.push(`object ${o.id} has unparseable interval start "${iv.start}"`);
    }
    if (iv.end && Number.isNaN(Date.parse(iv.end))) {
      fail.push(`object ${o.id} has unparseable interval end "${iv.end}"`);
    }
  }
}

// The vocabulary must be the nine of decision 40 — and a subset is fine (a small sub-log
// need not exhibit all nine), an extra is not.
const known = new Set(Object.keys(ACTIVITIES));
for (const a of new Set(raw.events.map((e) => e.activity))) {
  if (!known.has(a)) fail.push(`activity "${a}" is outside the closed vocabulary`);
}

// Decision 43: exactly four qualifiers.
const QUALIFIERS = new Set(['resolves', 'contains_commit', 'merge_commit', 'references_issue']);
for (const q of new Set(raw.links.map((l) => l.qualifier))) {
  if (!QUALIFIERS.has(q)) fail.push(`qualifier "${q}" is outside the four of decision 43`);
}

// Decision 20 / R6: link_methods is an ARRAY, and `method` must be one of its members.
for (const l of raw.links) {
  if (!Array.isArray(l.link_methods)) {
    fail.push(`link ${l.source}->${l.target} has link_methods that is not an array`);
  } else if (l.method && !l.link_methods.includes(l.method)) {
    fail.push(`link ${l.source}->${l.target}: method "${l.method}" absent from link_methods`);
  }
}

// Decision 39: no repo objects, and actors carry no is_bot (decision 47).
for (const o of raw.objects) {
  if (o.type === 'repo') fail.push(`object ${o.id} has type repo (decision 39 removed it)`);
  if (o.vmap && 'is_bot' in o.vmap) fail.push(`object ${o.id} carries is_bot (decision 47)`);
}

// Decision 44: no CommitsPushed activity — the push facts ride on CommitObserved.
if (raw.events.some((e) => e.activity === 'CommitsPushed')) {
  fail.push('a CommitsPushed event is present (decision 44 rejected it)');
}

if (fail.length) {
  console.error(`\nFAIL — ${fail.length} contract problem(s) the validator does not check:`);
  for (const f of fail.slice(0, 40)) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('gate    contract extras (version, times, qualifiers, methods)   ✓');

// ---- and it must survive the loader, not just the validator ---------------------------
const graph = await loadObjectGraph(query, { transport: rpcTransport });
console.log(`loader  ${describeSubLog(graph)}`);

// ---- and it must LAY OUT, which is where real data breaks first ----------------------
// The validator checks the payload's shape; this runs the actual layout pipeline the
// renderer runs. It is not a substitute for looking at the picture, but it catches the
// class of fault that makes a picture wrong rather than absent: a NaN x-position (a bad
// timestamp reaching the scale), a lifecycle bar with no width, glyphs stacked on top of
// one another, a link anchored to the top of a lane instead of to its object's own band
// (decision 37), or a commit whose position cannot be resolved at all.
const LANES = ['issue', 'pull_request', 'commit'];
const MARGIN_LEFT = 180;
const PLOT_WIDTH = 1100;
const layoutFail = [];

for (const mode of ['real', 'highlights', 'ordinal']) {
  const index = indexObjectGraph(graph);
  const bursts = deriveBursts(index.objectsOfType('commit'));
  const nodes = buildNodes({ graph, index, bursts, mode, laneTypes: LANES });
  const { rankTimes, rankMax } = assignRanks(nodes);
  const scales = createScales({
    instants: collectInstants(graph),
    marginLeft: MARGIN_LEFT,
    plotWidth: PLOT_WIDTH,
    mode,
    rankTimes,
    rankMax,
  });
  for (const node of nodes) node.x = scales.x(node.t, node);

  const laneObjects = new Map(LANES.map((lane) => [lane, index.objectsOfType(lane)]));
  const { maxRowByLane, objectRow } = packRows(nodes, LANES, { laneObjects });
  const geometry = computeLaneGeometry(LANES, maxRowByLane, { top: 32, bottom: 150 });

  for (const node of nodes) {
    if (!Number.isFinite(node.x)) layoutFail.push(`[${mode}] node ${node.id} has x=${node.x}`);
  }

  // Mirror the renderer exactly (render/timeline.js:166): a node's y comes from the row
  // it was packed into. Doing this AFTER computeLaneGeometry and BEFORE createAnchors is
  // not incidental ordering — the anchor resolver reads `node.y` for commits.
  for (const node of nodes) node.y = rowY(geometry.lanes, node.lane, node.row);
  for (const node of nodes) {
    if (!Number.isFinite(node.y)) layoutFail.push(`[${mode}] node ${node.id} has y=${node.y}`);
  }

  // Every issue and PR must resolve to a band, and every band to a y. Decision 37: this is
  // the arithmetic that sent every commit link to the top of the PR lane when it was wrong.
  //
  // ⚠️ The COMMIT lane is deliberately excluded. Decision 19: the commit lane draws one
  // node per commit OBJECT while the issue and PR lanes draw one node per EVENT, so
  // commits are positioned by their node's own row and never appear in `objectRow`.
  // Asserting otherwise flags every commit in every sub-log — which it did, and which is
  // the asymmetry decision 19 exists to record.
  for (const lane of ['issue', 'pull_request']) {
    for (const object of index.objectsOfType(lane)) {
      const row = objectRow.get(object.id);
      if (row == null) {
        layoutFail.push(`[${mode}] ${lane} ${object.id} was packed into no band`);
        continue;
      }
      if (!Number.isFinite(rowY(geometry.lanes, lane, row))) {
        layoutFail.push(`[${mode}] object ${object.id} resolves to a non-finite y`);
      }
    }
  }

  // Every commit needs exactly one interval or it cannot be placed at all
  // (layout/nodes.js positions a commit at intervals[0].start).
  for (const c of index.objectsOfType('commit')) {
    if (c.intervals.length !== 1) {
      layoutFail.push(`[${mode}] commit ${c.id} has ${c.intervals.length} intervals, expected 1`);
    }
  }

  // Lifecycle extents must be finite and forward-going.
  for (const lane of ['issue', 'pull_request']) {
    for (const object of index.objectsOfType(lane)) {
      const extent = objectExtent(object);
      if (!extent) continue;
      if (!Number.isFinite(+extent.start) || !Number.isFinite(+extent.end)) {
        layoutFail.push(`[${mode}] object ${object.id} has a non-finite extent`);
      } else if (+extent.end < +extent.start) {
        layoutFail.push(`[${mode}] object ${object.id} ends before it starts`);
      }
    }
  }

  // Link endpoints must resolve to finite coordinates, or the line is drawn to nowhere.
  // Same construction as render/timeline.js:170, burst members included — a collapsed
  // burst is one node standing for many commit objects, and a link into a folded commit
  // must meet the burst it was folded into.
  const nodeByObject = new Map();
  for (const node of nodes) {
    if (node.isGroup) {
      for (const member of node.members) nodeByObject.set(member.objectId, node);
    } else if (node.objectId) {
      nodeByObject.set(node.objectId, node);
    }
  }
  const anchors = createAnchors({
    nodes,
    nodeByObject,
    geometry: geometry.lanes,
    scales,
    objectRow,
  });
  for (const link of graph.links) {
    for (const end of [link.source, link.target]) {
      const object = index.byId.get(end);
      const ax = anchors.x(end, object);
      const ay = anchors.y(end, object);
      if (!Number.isFinite(ax) || !Number.isFinite(ay)) {
        layoutFail.push(`[${mode}] link endpoint ${end} anchors to (${ax}, ${ay})`);
      }
    }
  }

  if (mode === 'real') {
    console.log(
      `layout  ${nodes.length} nodes · ${bursts.length} bursts · bands per lane ` +
        LANES.map((l) => `${l}:${(maxRowByLane.get(l) ?? 0) + 1}`).join(' ') +
        ` · svg height ${Math.round(geometry.height)} px`,
    );
  }
}

if (layoutFail.length) {
  console.error(`\nFAIL — ${layoutFail.length} layout problem(s):`);
  for (const f of layoutFail.slice(0, 40)) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('gate    layout in all three time modes (finite, banded, anchored)   ✓');

const byType = {};
for (const o of raw.objects) byType[o.type] = (byType[o.type] || 0) + 1;
const acts = {};
for (const e of raw.events) acts[e.activity] = (acts[e.activity] || 0) + 1;
const quals = {};
for (const l of raw.links) {
  const k = `${l.qualifier}/${l.evidence}`;
  quals[k] = (quals[k] || 0) + 1;
}
console.log('\nobjects   ', byType);
console.log('activities', acts);
console.log('links     ', quals);
console.log('\nPASS');
