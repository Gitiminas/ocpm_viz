import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadObjectGraph } from '../src/data/loadObjectGraph.js';
import { collectInstants } from '../src/model/objectGraph.js';
import { createScales, findLargeGaps, GAP_THRESHOLD_MS, MODES } from '../src/layout/scales.js';
import { packRows, collisionThreshold, ROW_HEIGHT } from '../src/layout/packing.js';
import { computeLaneGeometry, rowY } from '../src/layout/lanes.js';

const fileTransport = async (query) =>
  JSON.parse(await readFile(new URL(`./fixtures/${query.fixture || 'F1'}.json`, import.meta.url), 'utf8'));
const loadF1 = () => loadObjectGraph({ fixture: 'F1' }, { transport: fileTransport });

const MARGIN_LEFT = 180;
const PLOT_WIDTH = 1100;

describe('the two scales agree on the plot edges', () => {
  const instants = [1000, 5000, 900_000];
  const build = (mode) =>
    createScales({
      instants,
      marginLeft: MARGIN_LEFT,
      plotWidth: PLOT_WIDTH,
      mode,
      rankTimes: instants,
      rankMax: instants.length - 1,
    });

  test('absolute mode pins first and last instants to the edges', () => {
    const scales = build('absolute');
    assert.equal(scales.x(instants[0]), MARGIN_LEFT);
    assert.equal(scales.x(instants[2]), MARGIN_LEFT + PLOT_WIDTH);
  });

  test('discrete mode spaces ranks evenly', () => {
    const scales = build('discrete');
    assert.equal(scales.x(null, { rank: 0 }), MARGIN_LEFT);
    assert.equal(scales.x(null, { rank: 1 }), MARGIN_LEFT + PLOT_WIDTH / 2);
    assert.equal(scales.x(null, { rank: 2 }), MARGIN_LEFT + PLOT_WIDTH);
  });

  test('there are exactly two temporal modes, and Highlights is not one of them', () => {
    // Decision 112 removed the compressed axis. Pinned so it cannot creep back under
    // another name without being argued for.
    assert.deepEqual(MODES, ['absolute', 'discrete']);
  });
});

describe('scales are monotonic over F1 in every mode', () => {
  for (const mode of MODES) {
    test(`${mode} preserves temporal order`, async () => {
      const graph = await loadF1();
      const instants = collectInstants(graph);
      const scales = createScales({
        instants,
        marginLeft: MARGIN_LEFT,
        plotWidth: PLOT_WIDTH,
        mode,
        rankTimes: instants,
        rankMax: Math.max(1, instants.length - 1),
      });

      let previous = -Infinity;
      for (const instant of instants) {
        const x = scales.x(instant);
        assert.ok(Number.isFinite(x), `${mode}: non-finite x for ${new Date(instant).toISOString()}`);
        assert.ok(x >= previous, `${mode}: order broken at ${new Date(instant).toISOString()}`);
        previous = x;
      }
    });
  }

  test('positions stay inside the plot area', async () => {
    const graph = await loadF1();
    const instants = collectInstants(graph);
    for (const mode of ['absolute']) {
      const scales = createScales({ instants, marginLeft: MARGIN_LEFT, plotWidth: PLOT_WIDTH, mode });
      for (const instant of instants) {
        const x = scales.x(instant);
        assert.ok(x >= MARGIN_LEFT && x <= MARGIN_LEFT + PLOT_WIDTH, `${mode}: ${x} out of bounds`);
      }
    }
  });
});

describe('degenerate sub-logs do not produce NaN coordinates', () => {
  test('a sub-log spanning zero time collapses to the left edge', () => {
    for (const mode of MODES) {
      const scales = createScales({
        instants: [1700000000000],
        marginLeft: MARGIN_LEFT,
        plotWidth: PLOT_WIDTH,
        mode,
        rankTimes: [1700000000000],
        rankMax: 1,
      });
      const x = scales.x(1700000000000);
      assert.ok(Number.isFinite(x), `${mode} produced ${x}`);
      assert.equal(x, MARGIN_LEFT);
    }
  });

  test('an empty sub-log does not throw', () => {
    const scales = createScales({ instants: [], marginLeft: MARGIN_LEFT, plotWidth: PLOT_WIDTH, mode: 'absolute' });
    assert.ok(Number.isFinite(scales.x(0)));
  });
});

describe('invert round-trips well enough to anchor a zoom', () => {
  test('absolute mode inverts exactly', () => {
    const instants = [1000, 500_000, 900_000];
    const scales = createScales({ instants, marginLeft: MARGIN_LEFT, plotWidth: PLOT_WIDTH, mode: 'absolute' });
    for (const instant of instants) {
      assert.equal(+scales.invert(scales.x(instant)), instant);
    }
  });

  test('discrete mode inverts its own ranks exactly, and interpolates between them', () => {
    // The discrete inverse used to borrow the (removed) compressed scale's inverse as an
    // approximation. It now inverts rank positions: a rank's pixel comes back as that
    // rank's instant, and a pixel between two ranks as an instant between theirs.
    const rankTimes = [1000, 500_000, 900_000];
    const scales = createScales({
      instants: rankTimes,
      marginLeft: MARGIN_LEFT,
      plotWidth: PLOT_WIDTH,
      mode: 'discrete',
      rankTimes,
      rankMax: 2,
    });
    rankTimes.forEach((instant, rank) => {
      assert.equal(+scales.invert(scales.x(null, { rank })), instant);
    });
    const between = +scales.invert(MARGIN_LEFT + PLOT_WIDTH * 0.25);
    assert.ok(between > 1000 && between < 500_000, `${between} is not between ranks 0 and 1`);
    // Off the plot on either side clamps to the ends rather than extrapolating.
    assert.equal(+scales.invert(MARGIN_LEFT - 50), 1000);
    assert.equal(+scales.invert(MARGIN_LEFT + PLOT_WIDTH + 50), 900_000);
  });
});

describe('row packing', () => {
  const node = (id, lane, x, extra = {}) => ({ id, lane, x, t: x, ...extra });

  test('nodes far apart share row 0', () => {
    const nodes = [node('a', 'commit', 0), node('b', 'commit', 500)];
    packRows(nodes, ['commit']);
    assert.equal(nodes[0].row, 0);
    assert.equal(nodes[1].row, 0);
  });

  test('colliding nodes stack into successive rows', () => {
    const nodes = [node('a', 'commit', 0), node('b', 'commit', 5), node('c', 'commit', 10)];
    const { maxRowByLane } = packRows(nodes, ['commit']);
    assert.deepEqual(
      nodes.map((n) => n.row),
      [0, 1, 2],
    );
    assert.equal(maxRowByLane.get('commit'), 2);
  });

  test('no two nodes in one row sit closer than the collision threshold', async () => {
    const graph = await loadF1();
    const instants = collectInstants(graph);
    const scales = createScales({ instants, marginLeft: MARGIN_LEFT, plotWidth: PLOT_WIDTH, mode: 'absolute' });

    const nodes = graph.events.map((e) => ({
      id: e.id,
      lane: graph.objects.find((o) => o.id === e.object_id).type,
      t: +e.time,
      x: scales.x(+e.time),
      isComment: e.comment,
    }));
    const lanes = ['issue', 'pull_request', 'commit'];
    packRows(nodes, lanes);

    for (const lane of lanes) {
      const threshold = collisionThreshold(lane);
      const inLane = nodes.filter((n) => n.lane === lane);
      for (let i = 0; i < inLane.length; i++) {
        for (let j = i + 1; j < inLane.length; j++) {
          if (inLane[i].row !== inLane[j].row) continue;
          assert.ok(
            Math.abs(inLane[i].x - inLane[j].x) >= threshold,
            `${lane}: ${inLane[i].id} and ${inLane[j].id} overlap in row ${inLane[i].row}`,
          );
        }
      }
    }
  });

  test('comments start below the lifecycle row in issue and PR lanes', () => {
    const nodes = [node('c', 'issue', 0, { isComment: true })];
    packRows(nodes, ['issue']);
    assert.equal(nodes[0].row, 1);
  });

  test('commit comments have no separate row, since the commit lane has none', () => {
    const nodes = [node('c', 'commit', 0, { isComment: true })];
    packRows(nodes, ['commit']);
    assert.equal(nodes[0].row, 0);
  });

  test('the commit lane packs tighter than the issue lane', () => {
    assert.ok(collisionThreshold('commit') < collisionThreshold('issue'));
  });
});

describe('lane geometry', () => {
  const margin = { top: 32, bottom: 150 };

  test('lanes stack without overlapping', () => {
    const maxRow = new Map([
      ['issue', 1],
      ['pull_request', 0],
      ['commit', 3],
    ]);
    const { lanes, height } = computeLaneGeometry(['issue', 'pull_request', 'commit'], maxRow, margin);

    const issue = lanes.get('issue');
    const pr = lanes.get('pull_request');
    const commit = lanes.get('commit');

    assert.equal(issue.top, margin.top);
    assert.equal(pr.top, issue.top + issue.height);
    assert.equal(commit.top, pr.top + pr.height);
    assert.equal(height, commit.top + commit.height + margin.bottom);
  });

  test('a lane needing more rows is taller by exactly the row pitch', () => {
    const one = computeLaneGeometry(['commit'], new Map([['commit', 0]]), margin);
    const two = computeLaneGeometry(['commit'], new Map([['commit', 1]]), margin);
    assert.equal(two.lanes.get('commit').height - one.lanes.get('commit').height, ROW_HEIGHT);
  });

  test('hiding a lane removes its height entirely', () => {
    const maxRow = new Map([
      ['issue', 0],
      ['commit', 0],
    ]);
    const all = computeLaneGeometry(['issue', 'commit'], maxRow, margin);
    const fewer = computeLaneGeometry(['commit'], maxRow, margin);
    assert.ok(fewer.height < all.height);
    assert.equal(fewer.lanes.get('commit').top, margin.top);
  });

  test('rows are spaced by the row pitch', () => {
    const { lanes } = computeLaneGeometry(['commit'], new Map([['commit', 2]]), margin);
    assert.equal(rowY(lanes, 'commit', 1) - rowY(lanes, 'commit', 0), ROW_HEIGHT);
  });
});

describe('large gap annotation', () => {
  test('only gaps beyond the threshold are reported', () => {
    const day = 24 * 60 * 60 * 1000;
    const times = [0, 1000, 1000 + 2 * day, 1000 + 2 * day + 500];
    const gaps = findLargeGaps(times);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].fromRank, 1);
    assert.equal(gaps[0].toRank, 2);
    assert.equal(gaps[0].duration, 2 * day);
    assert.equal(GAP_THRESHOLD_MS, day);
  });

  test('F1 has the two gaps the discrete baseline shows', async () => {
    const graph = await loadF1();
    const instants = collectInstants(graph);
    const gaps = findLargeGaps(instants);
    // The discrete screenshots annotate bands of roughly 1 day and roughly 7 days.
    assert.equal(gaps.length, 2);
    const days = gaps.map((g) => Math.round(g.duration / (24 * 60 * 60 * 1000)));
    assert.deepEqual(days, [1, 7]);
  });
});
