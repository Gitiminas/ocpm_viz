/**
 * Acceptance gate for `sql/fe_layer.sql`: feed a REAL RPC payload through the same
 * entry point the app uses and require `findGraphProblems` to return `[]`.
 *
 * This is the check the database cannot do for itself. `fe.diag_sanity` proves the SQL
 * is internally consistent; this proves the payload satisfies the *frontend's* contract
 * — the closed activity vocabulary, the four object types, the two evidence classes, the
 * known link methods, and the both-endpoints-are-objects rule — which is
 * the same gate all 14 fixtures pass.
 *
 * The transport shells out to `psql` rather than speaking to PostgREST, deliberately: the
 * point is to validate the SQL underneath the HTTP layer, and a payload proved correct
 * here is what makes an HTTP fault easy to place later.
 *
 * ⚠️ **But `psql` connects as the OWNER, and the app connects as `web_anon`** — so for a
 * long time this gate could not see the one failure that takes the app down completely.
 * On 2026-08-07, re-running `fe_layer.sql` reverted every `api` function to
 * `SECURITY INVOKER`, the app died with *"permission denied for schema fe"*, and this
 * script printed **PASS**. The final check now travels that second path. It is one HTTP
 * call, and it is skipped — not failed — when PostgREST is not running, so the gate still
 * works on a machine with only a database.
 *
 *   node scripts/rpc-check.mjs [repo] [seed] [degree]        degree 0..2
 *   node scripts/rpc-check.mjs microsoft/vscode issue:2902032454 2
 *
 *   PGRST_URL=http://localhost:3000   where to find PostgREST (default)
 *   PGRST_SKIP=1                      skip the web_anon probe entirely
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
import { createLayout, STRUCTURAL_LAYOUTS, TEMPORAL_MODES } from '../src/layout/engine.js';
import { footprintPairs } from '../src/layout/cluster.js';

const DB = process.env.PGDATABASE || 'gharchive_ocpm_viz_wsl';

const [repo = 'microsoft/vscode', seed = 'issue:2902032454', degree = '2'] =
  process.argv.slice(2);

/** The RPC transport. One function — the whole of the transport swap. */
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
  fail.push(`meta.contract_version is ${raw.meta.contract_version}, expected 2`);
}

// A timestamp the renderer cannot parse passes findGraphProblems, which only
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

// The vocabulary must be the ten closed activities — and a subset is fine (a small sub-log
// need not exhibit all ten), an extra is not. `Push` is the process map's alone.
const known = new Set(Object.keys(ACTIVITIES));
known.delete('Push');
for (const a of new Set(raw.events.map((e) => e.activity))) {
  if (!known.has(a)) fail.push(`activity "${a}" is outside the closed vocabulary`);
}

// Exactly four qualifiers.
const QUALIFIERS = new Set(['resolves', 'contains_commit', 'merge_commit', 'references_issue']);
for (const q of new Set(raw.links.map((l) => l.qualifier))) {
  if (!QUALIFIERS.has(q)) fail.push(`qualifier "${q}" is not one of the four qualifiers`);
}

// link_methods is an ARRAY, and `method` must be one of its members.
for (const l of raw.links) {
  if (!Array.isArray(l.link_methods)) {
    fail.push(`link ${l.source}->${l.target} has link_methods that is not an array`);
  } else if (l.method && !l.link_methods.includes(l.method)) {
    fail.push(`link ${l.source}->${l.target}: method "${l.method}" absent from link_methods`);
  }
}

// No repo objects, and actors carry no is_bot.
for (const o of raw.objects) {
  if (o.type === 'repo') fail.push(`object ${o.id} has type repo; repo is not an object type`);
  if (o.vmap && 'is_bot' in o.vmap) fail.push(`object ${o.id} carries is_bot; vmap must not`);
}

// No CommitsPushed activity — the push facts ride on CommitObserved.
if (raw.events.some((e) => e.activity === 'CommitsPushed')) {
  fail.push('a CommitsPushed event is present; push facts ride on CommitObserved');
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
// one another, a link anchored to the top of a lane instead of to its object's own band,
// or a commit whose position cannot be resolved at all.
const LANES = ['issue', 'pull_request', 'commit'];
const MARGIN_LEFT = 180;
const PLOT_WIDTH = 1100;
const layoutFail = [];

for (const mode of TEMPORAL_MODES) {
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

  // Every issue and PR must resolve to a band, and every band to a y. This is the
  // arithmetic that sends every commit link to the top of the PR lane when it is wrong.
  //
  // ⚠️ The COMMIT lane is deliberately excluded: it draws one node per commit OBJECT
  // while the issue and PR lanes draw one node per EVENT, so commits are positioned by
  // their node's own row and never appear in `objectRow`. Asserting otherwise flags every
  // commit in every sub-log, which is the asymmetry between node-hood and object-hood.
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

  if (mode === 'absolute') {
    console.log(
      `layout  ${nodes.length} nodes · ${bursts.length} bursts · bands per lane ` +
        LANES.map((l) => `${l}:${(maxRowByLane.get(l) ?? 0) + 1}`).join(' ') +
        ` · svg height ${Math.round(geometry.height)} px`,
    );
  }
}

// ---- and in the RELATIONSHIPS mode, through both structural arrangements -------------
// The temporal checks above mirror the renderer's pipeline by hand; the structural ones go
// through `createLayout` itself, because that seam is the whole point of the engine and a
// gate that bypassed it would pass a payload the app cannot draw. What real data breaks
// here is different from the timeline: a mark placed outside the box, two marks on top of
// each other, an edge whose end resolves to nothing, or a cluster sitting inside another's
// footprint — none of which is a NaN, all of which the fixture suites pass.
{
  const index = indexObjectGraph(graph);
  const bursts = deriveBursts(index.objectsOfType('commit'));
  const margin = { top: 16, right: 16, bottom: 16, left: 16 };
  const box = { plotWidth: PLOT_WIDTH, plotHeight: 620 };
  const summary = [];

  for (const structuralLayout of STRUCTURAL_LAYOUTS) {
    const tag = `[off/${structuralLayout}]`;
    const layout = createLayout({
      mode: 'relationships',
      graph,
      index,
      laneTypes: LANES,
      visibleLanes: LANES,
      bursts,
      structuralLayout,
      margin,
      ...box,
    });
    const radius = (node) => node.radius ?? 8;

    for (const node of layout.nodes) {
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
        layoutFail.push(`${tag} node ${node.id} at (${node.x}, ${node.y})`);
        continue;
      }
      const r = radius(node);
      if (
        node.x - r < margin.left ||
        node.x + r > margin.left + box.plotWidth ||
        node.y - r < margin.top ||
        node.y + r > margin.top + box.plotHeight
      ) {
        layoutFail.push(`${tag} node ${node.id} lies outside the box at (${node.x.toFixed(0)}, ${node.y.toFixed(0)})`);
      }
    }

    // No two marks on top of each other — the guarantee `separate()` makes in both
    // arrangements, in the coordinates anyone actually sees.
    let overlaps = 0;
    const marks = layout.nodes;
    for (let i = 0; i < marks.length; i++) {
      for (let j = i + 1; j < marks.length; j++) {
        const gap = Math.hypot(marks[i].x - marks[j].x, marks[i].y - marks[j].y);
        if (gap < radius(marks[i]) + radius(marks[j])) overlaps++;
      }
    }
    if (overlaps) layoutFail.push(`${tag} ${overlaps} pair(s) of marks overlap`);

    // Every drawn edge must meet a drawn mark at both ends (a folded push counts for its
    // commits), and the brush needs a span to brush.
    for (const edge of layout.edges) {
      for (const end of [edge.source, edge.target]) {
        const mark = layout.nodeByObject.get(end) ?? layout.nodes.find((n) => n.id === end);
        if (!mark) layoutFail.push(`${tag} edge end ${end} resolves to no mark`);
      }
    }
    if (
      layout.extent &&
      !(Number.isFinite(layout.extent.min) && Number.isFinite(layout.extent.max))
    ) {
      layoutFail.push(`${tag} the time extent is not finite: ${JSON.stringify(layout.extent)}`);
    }

    // The clustered arrangement's own claim: no cluster inside another's footprint.
    //
    // ⚠️ The claim is SOFT (FOOTPRINT_STRENGTH < 1) and it has a capacity limit: a hub
    // with 34 pull requests (kubernetes #68026) has its seed ring scaled down to fit the
    // box while the marks keep their size, and the post-fit separation then nudges marks
    // a little across claim boundaries — measured at 0.91× the claimed distance, with
    // zero overlapping marks and every commit still nearest its own pull request. That is
    // the arrangement degrading gracefully, so a shortfall is REPORTED here and only a
    // mark well inside a foreign cluster (under ¾ of the claim) fails the gate.
    let shortfalls = 0;
    if (structuralLayout === 'cluster') {
      if (!layout.anchorId) layoutFail.push(`${tag} no anchor root was named`);
      const seeds = layout.nodes.map((n) => ({
        id: n.id,
        lane: n.lane,
        radius: radius(n),
        footprint: n.footprint,
        x: n.x,
        y: n.y,
      }));
      const links = layout.edges.map((e) => ({ source: e.source, target: e.target }));
      for (const { a, b, need } of footprintPairs(seeds, links)) {
        const ratio = Math.hypot(a.x - b.x, a.y - b.y) / need;
        if (ratio < 0.75) {
          layoutFail.push(`${tag} ${a.id} sits inside the footprint of ${b.id} (${ratio.toFixed(2)}× the claim)`);
        } else if (ratio < 1) {
          shortfalls++;
        }
      }
    }

    summary.push(
      `${structuralLayout}: ${layout.nodes.length} marks · ${layout.edges.length} edges` +
        (layout.crossings != null ? ` · ${layout.crossings} crossings` : '') +
        (shortfalls ? ` · ${shortfalls} soft footprint shortfall(s)` : ''),
    );
  }
  console.log(`rel     ${summary.join('   ')}`);
}

if (layoutFail.length) {
  console.error(`\nFAIL — ${layoutFail.length} layout problem(s):`);
  for (const f of layoutFail.slice(0, 40)) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('gate    layout in every time mode, both structural arrangements   ✓');

// ---- and the app reaches it as web_anon, not as the owner ----------------------------
/**
 * The second path: PostgREST, over HTTP, unauthenticated.
 *
 * Everything above runs as the database owner and therefore cannot observe a permissions
 * regression at all. `api.list_repos` reads `fe.seed_lookup`, so one call to it exercises
 * exactly what breaks: an `api` function that is no longer `SECURITY DEFINER` runs as
 * `web_anon`, which by design can read nothing in `fe`.
 *
 * Unreachable is a **skip**, not a failure — PostgREST is a separate process and this gate
 * has to stay useful without it. Reachable-and-refusing is a failure, because that is the
 * app being broken.
 */
async function checkWebAnon() {
  if (process.env.PGRST_SKIP) {
    console.log('gate    web_anon over HTTP   — skipped (PGRST_SKIP)');
    return;
  }
  const base = process.env.PGRST_URL || 'http://localhost:3000';

  let response;
  try {
    response = await fetch(`${base}/rpc/list_repos`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    console.log(`gate    web_anon over HTTP   — skipped (nothing listening at ${base})`);
    return;
  }

  if (response.ok) {
    const rows = await response.json();
    console.log(`gate    web_anon reaches the RPC over HTTP (${rows.length} repos)   ✓`);
    return;
  }

  const body = await response.text();
  console.error(`\nFAIL — PostgREST answered ${response.status} as web_anon:`);
  console.error(`  ${body.slice(0, 300)}`);
  if (/permission denied/i.test(body)) {
    console.error(
      '\n  This is the SECURITY INVOKER regression. `fe_layer.sql` replaced the api\n' +
        '  functions and reset them, so they now run as web_anon instead of as their\n' +
        '  owner. Fix:\n' +
        `\n      psql -d ${DB} -f sql/postgrest_setup.sql\n`,
    );
  } else if (/schema cache|PGRST202/i.test(body)) {
    console.error(
      '\n  PostgREST is holding a stale schema cache. Reload it (NOTIFY pgrst,\n' +
        "  'reload schema') or restart the process.\n",
    );
  }
  process.exit(1);
}

await checkWebAnon();

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
