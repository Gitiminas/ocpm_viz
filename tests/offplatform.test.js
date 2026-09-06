import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadSubLog } from '../src/data/loadSubLog.js';
import { indexSubLog } from '../src/model/subLog.js';
import { deriveBursts } from '../src/model/bursts.js';
import { LANE_TYPES } from '../src/model/activities.js';
import { buildNodes } from '../src/layout/nodes.js';
import { buildStructuralNodes } from '../src/layout/structural.js';
import { prOutcomeDistribution, landmarks } from '../src/stats/metrics.js';
import { LEGEND_KEYS } from '../src/render/legend.js';

/**
 * The off-platform merge, in four parts: a landmark, a merge of a different kind (its own
 * outcome), not an unmerged close, and its own ring. F14 is the fixture built to show all
 * four beside a real merge.
 */

const transport = async (query) =>
  JSON.parse(await readFile(new URL(`./fixtures/${query.fixture}.json`, import.meta.url), 'utf8'));
const loadF14 = () => loadSubLog({ fixture: 'F14' }, { transport });

describe('the off-platform merge, end to end on F14', () => {
  test('the payload loads: the activity is in the vocabulary the loader checks', async () => {
    const graph = await loadF14();
    assert.ok(graph.events.some((e) => e.activity === 'PullRequestMergedOffPlatform'));
  });

  test('it is its own PR outcome, never folded into the platform merges', async () => {
    const graph = await loadF14();
    const counts = new Map(prOutcomeDistribution(graph).map((o) => [o.outcome, o.count]));
    assert.equal(counts.get('merged'), 1, 'PR #90, merged on GitHub');
    assert.equal(counts.get('merged off-platform'), 1, 'PR #91');
    assert.equal(counts.get('closed unmerged'), undefined, 'PR #91 delivered; it is not an abandoned PR');
  });

  test('it is a landmark, listed with the others', async () => {
    const graph = await loadF14();
    const entries = landmarks(graph);
    assert.ok(entries.some((e) => e.objectId === 'pr:91' && /Merge \(off-platform\)/.test(e.label)));
    assert.ok(entries.some((e) => e.objectId === 'pr:90' && /· Merge$/.test(e.label)));
  });

  test('timeline marks: the heuristic ring on the off-platform event, the solid ring on the real merge', async () => {
    const graph = await loadF14();
    const index = indexSubLog(graph);
    const nodes = buildNodes({ graph, index, bursts: deriveBursts(index.objectsOfType('commit')), laneTypes: LANE_TYPES });
    // Nodes carry the label, not the raw activity; the off-platform label is unique.
    const off = nodes.find((n) => n.title === 'Merge (off-platform)');
    const real = nodes.find((n) => n.title === 'Merge' && n.objectId === 'pr:90');
    const closed = nodes.find((n) => n.title === 'Close' && n.objectId === 'pr:91');
    assert.ok(off.landmark && off.heuristicLandmark, 'off-platform: landmark AND heuristic');
    assert.ok(real.landmark && !real.heuristicLandmark, 'a real merge is a plain landmark');
    assert.equal(off.unmergedClose, false, 'not an unmerged close (ruling 3)');
    // The PR carries a PullRequestClosed too; both are drawn as they are (ruling 6).
    assert.ok(closed && closed.unmergedClose, 'the GitHub close keeps its dashed ring');
  });

  test('relationships marks: one ring per object, the heuristic one only when no real merge outranks it', async () => {
    const graph = await loadF14();
    const index = indexSubLog(graph);
    const nodes = buildStructuralNodes({ index, bursts: deriveBursts(index.objectsOfType('commit')), expandedBursts: new Set(), laneTypes: LANE_TYPES });
    const pr91 = nodes.find((n) => n.objectId === 'pr:91');
    const pr90 = nodes.find((n) => n.objectId === 'pr:90');
    assert.ok(pr91.landmark && pr91.heuristicLandmark);
    assert.ok(pr90.landmark && !pr90.heuristicLandmark);
  });

  test('the ring has a legend row and a help text of its own', () => {
    assert.ok(LEGEND_KEYS.includes('landmark-heuristic'));
  });
});
