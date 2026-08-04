/**
 * The Task 6 verification suite.
 *
 * These are the claims the thesis makes about the renderer, checked rather than
 * asserted. They are deliberately stated as properties over *every* fixture rather
 * than as spot checks, because a spot check passes for the one sub-log it was
 * written against — which is the exact failure mode this whole project exists to
 * remove.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadObjectGraph } from '../src/data/loadObjectGraph.js';
import { indexObjectGraph, collectInstants, findGraphProblems } from '../src/model/objectGraph.js';
import { deriveBursts } from '../src/model/bursts.js';
import { deriveCommitGroups } from '../src/model/commitGroups.js';
import { buildNodes, assignRanks, filterNodes } from '../src/layout/nodes.js';
import { createScales, MODES } from '../src/layout/scales.js';
import { packRows } from '../src/layout/packing.js';
import { computeLaneGeometry } from '../src/layout/lanes.js';
import {
  createState,
  resetToggles,
  deriveRelGroups,
  deriveQualifiers,
  deriveMethods,
  isNodeVisible,
  isLinkVisible,
} from '../src/state/state.js';

const ALL_FIXTURES = [
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6',
  'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13',
];

const fileTransport = async (query) =>
  JSON.parse(await readFile(new URL(`./fixtures/${query.fixture}.json`, import.meta.url), 'utf8'));
const load = (fixture) => loadObjectGraph({ fixture }, { transport: fileTransport });

const LANES = ['issue', 'pull_request', 'commit'];
const MARGIN_LEFT = 180;
const PLOT_WIDTH = 1100;

async function pipeline(fixture, { mode = 'real', state } = {}) {
  const graph = await load(fixture);
  const index = indexObjectGraph(graph);
  const bursts = deriveBursts(index.objectsOfType('commit'));
  const { groupsByCommit } = deriveCommitGroups(
    index.objectsOfType('commit'),
    graph.links,
    index.byId,
  );
  const activeState =
    state ||
    resetToggles(createState(), {
      relGroups: deriveRelGroups(graph.links, index.byId),
      qualifiers: deriveQualifiers(graph.links),
      methods: deriveMethods(graph.links),
    });

  const all = buildNodes({ graph, index, bursts, mode, laneTypes: LANES });
  const nodes = filterNodes(all, (node) => isNodeVisible(node, activeState, groupsByCommit));
  const { rankTimes, rankMax, rankOrder } = assignRanks(nodes);

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

  return { graph, index, state: activeState, groupsByCommit, nodes, rankOrder, geometry, objectRow, scales };
}

describe('every fixture is a valid ObjectGraph', () => {
  for (const fixture of ALL_FIXTURES) {
    test(`${fixture} passes shape validation`, async () => {
      const raw = await fileTransport({ fixture });
      assert.deepEqual(findGraphProblems(raw), []);
    });
  }
});

/**
 * Decisions 41 and 49, as a property of every fixture rather than of one.
 *
 * Ten modules used to open with `if (link.qualifier === 'actor') continue;` — the
 * adjacency builder, the commit grouping, three toggle derivations, the visibility
 * predicate, two metric counts. Every one of them was a restatement of the same
 * fact, and each had to be written separately and could be forgotten separately;
 * `linkCounts` forgetting it would have reported F1 as 45 validated / 31 extracted
 * instead of 3 / 31, in a figure the thesis quotes.
 *
 * They are all gone, so this is what holds the line for them: if a link that is not
 * object→object ever re-enters a payload, it fails here rather than in whichever
 * consumer noticed first.
 */
describe('every link joins two objects', () => {
  for (const fixture of ALL_FIXTURES) {
    test(`${fixture} carries no attribution link and no event endpoint`, async () => {
      const raw = await fileTransport({ fixture });
      const objectIds = new Set(raw.objects.map((object) => object.id));
      const eventIds = new Set(raw.events.map((event) => event.id));

      for (const link of raw.links) {
        assert.notEqual(link.qualifier, 'actor', `${fixture}: actor links were deleted`);
        assert.notEqual(link.method, 'event_actor_id', `${fixture}: the method was deleted`);
        for (const endpoint of [link.source, link.target]) {
          assert.ok(objectIds.has(endpoint), `${fixture}: ${endpoint} is not an object`);
          assert.equal(eventIds.has(endpoint), false, `${fixture}: ${endpoint} is an event`);
        }
      }
    });
  }
});

describe('ordering is monotonic in every time mode, for every fixture', () => {
  for (const fixture of ALL_FIXTURES) {
    test(`${fixture} preserves temporal order in all three modes`, async () => {
      for (const mode of MODES) {
        const { nodes } = await pipeline(fixture, { mode });

        // Compared between *distinct* instants only. Simultaneous nodes have no
        // defined order along x and none is required — F1's issue closes at the
        // same second as its last commit lands, and which of the two is drawn
        // first is arbitrary. What must hold is that a later instant is never
        // drawn left of an earlier one.
        const byInstant = new Map();
        for (const node of nodes) {
          const key = +node.t;
          if (!byInstant.has(key)) byInstant.set(key, []);
          byInstant.get(key).push(node.x);
        }
        const instants = [...byInstant.keys()].sort((a, b) => a - b);

        for (let i = 1; i < instants.length; i++) {
          const previousMax = Math.max(...byInstant.get(instants[i - 1]));
          const currentMin = Math.min(...byInstant.get(instants[i]));
          assert.ok(
            currentMin >= previousMax - 0.001,
            `${fixture}/${mode}: ${new Date(instants[i]).toISOString()} draws at ${currentMin}, ` +
              `left of ${new Date(instants[i - 1]).toISOString()} at ${previousMax}`,
          );
        }
      }
    });
  }
});

describe('every drawn link resolves to endpoints that are also drawn', () => {
  for (const fixture of ALL_FIXTURES) {
    test(`${fixture} draws no link into empty space`, async () => {
      const { graph, index, state, groupsByCommit, nodes } = await pipeline(fixture);
      const bursts = deriveBursts(index.objectsOfType('commit'));
      const foldedInto = new Map();
      for (const burst of bursts) {
        for (const id of burst.commitIds) foldedInto.set(id, burst.id);
      }
      const drawn = new Set(nodes.map((node) => node.objectId).filter(Boolean));

      for (const link of graph.links) {
        if (!isLinkVisible(link, index.byId, state, groupsByCommit)) continue;
        for (const endpoint of [link.source, link.target]) {
          const anchor = foldedInto.get(endpoint) || endpoint;
          assert.ok(
            drawn.has(anchor) || drawn.has(endpoint),
            `${fixture}: link endpoint ${endpoint} has nothing on screen`,
          );
        }
      }
    });
  }
});

describe('lane geometry never overlaps', () => {
  for (const fixture of ALL_FIXTURES) {
    test(`${fixture} stacks its lanes without collision`, async () => {
      const { geometry } = await pipeline(fixture);
      const lanes = LANES.map((lane) => geometry.lanes.get(lane)).filter(Boolean);
      for (let i = 1; i < lanes.length; i++) {
        assert.equal(
          lanes[i].top,
          lanes[i - 1].top + lanes[i - 1].height,
          `${fixture}: lane ${i} does not start where lane ${i - 1} ends`,
        );
      }
      assert.ok(Number.isFinite(geometry.height) && geometry.height > 0);
    });
  }
});

describe('the four issue-PR detection method toggles each work independently (F11)', () => {
  const METHODS = ['pr_body', 'branch_name', 'pr_title', 'issue_comment'];

  for (const method of METHODS) {
    test(`switching off ${method} removes only its links`, async () => {
      const { graph, index, state, groupsByCommit } = await pipeline('F11');
      const before = graph.links.filter((l) =>
        isLinkVisible(l, index.byId, state, groupsByCommit),
      );
      assert.equal(before.length, 4, 'F11 starts with one link per method');

      state.methods[method] = false;
      const after = graph.links.filter((l) => isLinkVisible(l, index.byId, state, groupsByCommit));

      assert.equal(after.length, 3, `${method}: exactly one link should go`);
      assert.equal(after.some((l) => l.method === method), false);
      for (const other of METHODS.filter((m) => m !== method)) {
        assert.ok(after.some((l) => l.method === other), `${other} must be untouched`);
      }
    });
  }

  test('switching all four off leaves no issue-PR links at all', async () => {
    const { graph, index, state, groupsByCommit } = await pipeline('F11');
    for (const method of METHODS) state.methods[method] = false;
    const remaining = graph.links.filter((l) =>
      isLinkVisible(l, index.byId, state, groupsByCommit),
    );
    assert.equal(remaining.length, 0);
  });
});

describe('multi-method agreement and mixed evidence survive the pipeline (F12)', () => {
  test('a link agreed by three methods is validated and carries its count', async () => {
    const { graph } = await pipeline('F12');
    const multi = graph.links.find((link) => link.n_methods > 1);
    assert.equal(multi.n_methods, 3);
    assert.equal(multi.evidence, 'validated');
    assert.deepEqual(multi.link_methods.sort(), ['branch_name', 'pr_body', 'pr_title']);
  });

  test('both evidence classes on one pair remain two distinguishable links', async () => {
    const { graph, index, state, groupsByCommit } = await pipeline('F12');
    const visible = graph.links.filter((l) => isLinkVisible(l, index.byId, state, groupsByCommit));
    const commitToPr = visible.filter((l) => l.qualifier === 'referenced_pull_request');
    assert.equal(commitToPr.length, 2);
    assert.deepEqual(commitToPr.map((l) => l.evidence).sort(), ['extracted', 'validated']);
  });

  test('hiding the extracted class leaves the validated link on the same pair', async () => {
    const { graph, index, state, groupsByCommit } = await pipeline('F12');
    for (const key of Object.keys(state.relPairs)) {
      if (key.startsWith('extracted')) state.relPairs[key] = false;
    }
    const visible = graph.links.filter((l) => isLinkVisible(l, index.byId, state, groupsByCommit));
    assert.equal(visible.every((l) => l.evidence === 'validated'), true);
    assert.ok(visible.some((l) => l.qualifier === 'referenced_pull_request'));
  });
});

describe('the large sub-log behaves (F10)', () => {
  test('300 commits lay out without collision or non-finite positions', async () => {
    for (const mode of MODES) {
      const { nodes } = await pipeline('F10', { mode });
      // Not a count assertion: with bursts folded by default, 300 commits are
      // *supposed* to draw as a few dozen nodes. The next test covers that.
      assert.ok(nodes.some((node) => node.lane === 'commit'), `${mode}: commit lane is empty`);
      for (const node of nodes) {
        assert.ok(Number.isFinite(node.x), `${mode}: ${node.id} has x=${node.x}`);
        assert.ok(Number.isInteger(node.row) && node.row >= 0);
      }
    }
  });

  test('folding reduces the drawn commit count substantially', async () => {
    const graph = await load('F10');
    const index = indexObjectGraph(graph);
    const bursts = deriveBursts(index.objectsOfType('commit'));
    const folded = buildNodes({ graph, index, bursts, expandedBursts: new Set(), laneTypes: LANES });
    const expanded = buildNodes({
      graph,
      index,
      bursts,
      expandedBursts: new Set(bursts.map((b) => b.id)),
      laneTypes: LANES,
    });

    const foldedCommits = folded.filter((n) => n.lane === 'commit').length;
    const expandedCommits = expanded.filter((n) => n.lane === 'commit').length;
    assert.equal(expandedCommits, 300);
    assert.ok(foldedCommits < expandedCommits / 2, 'folding must actually reduce density');
  });

  test('layout stays within a sane time budget', async () => {
    // Not a benchmark, a tripwire. ARCHITECTURE says report it rather than
    // pre-optimise, so this fails loudly if a change makes the largest fixture slow.
    const started = performance.now();
    await pipeline('F10', { mode: 'ordinal' });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 3000, `F10 layout took ${Math.round(elapsed)}ms`);
  });
});
