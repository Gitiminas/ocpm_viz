import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { relax } from '../src/layout/relax.js';

/**
 * The relaxation pass that finishes the clustered layout.
 *
 * It exists to settle what a per-parent placement rule cannot say — a commit claimed by
 * two pull requests, two clusters of different sizes grazing — without taking the rule's
 * answer away. So the properties worth pinning are: it converges, it is deterministic, a
 * pinned node does not move, and the anchor keeps the result recognisable as the
 * arrangement it started from.
 */

const at = (x, y) => ({ x, y });

/** A hub with `n` leaves hanging off it, all seeded on top of one another. */
function star(n) {
  const nodes = [
    { id: 'hub', radius: 12, charge: 2.6, pinned: true },
    ...Array.from({ length: n }, (_, i) => ({ id: `leaf${i}`, radius: 6, charge: 1 })),
  ];
  const edges = nodes.slice(1).map((node) => ({ source: 'hub', target: node.id }));
  const anchors = new Map(nodes.map((node) => [node.id, at(0, 0)]));
  return { nodes, edges, anchors };
}

describe('the relaxation settles', () => {
  test('a pinned node does not move at all', () => {
    // ⚠️ Roots are pinned by the clustered layout: a middle that drifts is not a middle,
    // and pinning is also what stops springs walking the whole drawing off as a body.
    const { nodes, edges, anchors } = star(6);
    const settled = relax(nodes, edges, { anchors });
    assert.deepEqual(settled.get('hub'), at(0, 0), 'the pinned hub moved');
  });

  test('everything else separates from a common starting point', () => {
    const { nodes, edges, anchors } = star(6);
    const settled = relax(nodes, edges, { anchors });
    const leaves = nodes.slice(1).map((node) => settled.get(node.id));
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        assert.ok(
          Math.hypot(leaves[i].x - leaves[j].x, leaves[i].y - leaves[j].y) > 1,
          'leaves seeded on one point stayed there',
        );
      }
    }
  });

  test('a heavier charge holds others further off', () => {
    // ⚠️ The reason charge is per type. A pull request needs room for a whole fan around
    // it; two commits inside one fan should sit close, because that closeness is what
    // makes the fan read as a group.
    const build = (charge) => {
      const nodes = [
        { id: 'a', radius: 8, charge },
        { id: 'b', radius: 8, charge },
      ];
      const anchors = new Map([
        ['a', at(-30, 0)],
        ['b', at(30, 0)],
      ]);
      return relax(nodes, [], { anchors });
    };
    const light = build(1);
    const heavy = build(3);
    const spread = (m) => Math.abs(m.get('a').x - m.get('b').x);
    assert.ok(spread(heavy) > spread(light), 'charge made no difference to the spacing');
  });

  test('it is deterministic and independent of input order', () => {
    const { nodes, edges, anchors } = star(8);
    const forwards = relax(nodes, edges, { anchors });
    const backwards = relax(nodes.slice().reverse(), edges.slice().reverse(), { anchors });
    for (const node of nodes) {
      assert.deepEqual(forwards.get(node.id), backwards.get(node.id), `${node.id} varied`);
    }
  });

  test('the anchor keeps a node near where the rule put it', () => {
    // Without it this would be a free force layout, which was tried in this branch and
    // rejected: where a cluster landed became arbitrary.
    const nodes = [
      { id: 'a', radius: 8, charge: 1 },
      { id: 'b', radius: 8, charge: 1 },
    ];
    const anchors = new Map([
      ['a', at(-200, 0)],
      ['b', at(200, 0)],
    ]);
    const settled = relax(nodes, [{ source: 'a', target: 'b' }], { anchors, restLength: () => 20 });
    // The spring wants them 20 apart; the anchor wants them 400 apart. Neither wins
    // outright, which is the point — the result has to still look like the input.
    const apart = Math.abs(settled.get('a').x - settled.get('b').x);
    assert.ok(apart > 60, `the spring overwhelmed the anchor: ${apart.toFixed(0)}px apart`);
    assert.ok(apart < 400, 'the anchor ignored the spring entirely');
  });

  test('a seed distinct from the anchor is where it starts, not where it is pulled', () => {
    // ⚠️ What makes this usable during a drag: mid-gesture the seed is wherever everything
    // currently is, while the anchor stays the arrangement's home, so neighbours follow the
    // pointer without the picture forgetting its shape.
    const nodes = [{ id: 'a', radius: 8, charge: 1 }];
    const anchors = new Map([['a', at(0, 0)]]);
    const seed = new Map([['a', at(500, 0)]]);
    const settled = relax(nodes, [], { anchors, seed, iterations: 4 });
    assert.ok(settled.get('a').x < 500, 'it did not move back toward its anchor');
    assert.ok(settled.get('a').x > 0, 'four steps should not carry it all the way home');
  });

  test('a node with no anchor is left out rather than placed at random', () => {
    const settled = relax([{ id: 'ghost', radius: 8 }], [], { anchors: new Map() });
    assert.equal(settled.size, 0);
  });
});
