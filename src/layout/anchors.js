/**
 * Where a link should meet an object.
 *
 * Pure geometry: given the drawn nodes, the packed rows and the lane geometry, it
 * answers "what point on screen stands for this object". It lives under `layout/`
 * rather than in the renderer because that answer is arithmetic, and arithmetic
 * that decides where a line lands must be checkable without a browser — a
 * mis-anchored edge is exactly the class of defect a diff cannot show.
 *
 * Three asymmetries are deliberate and each has bitten once:
 *
 *   node vs object   The commit lane draws one node per commit *object*; the issue
 *                    and PR lanes draw one node per *event*. So an object may be
 *                    resolved to a drawn node only in the commit lane — consulting
 *                    `nodeByObject` for a PR yields whichever of its events was
 *                    written last.
 *   row vs lane      An issue or PR meets its link at the row its band was packed
 *                    into, not at the top of its lane. With one object per lane the
 *                    two coincide, which is why the difference stayed invisible
 *                    until a lane held two overlapping objects.
 *   instant vs span  The x of a non-commit endpoint is the glyph for that exact
 *                    instant when one is drawn, so an edge lands *on* the "merged"
 *                    diamond rather than near it.
 */

import { rowY } from './lanes.js';

/**
 * @param {object}  args
 * @param {Array}   args.nodes         every drawn node, carrying `objectId`, `t`, `x`, `y`, `lane`
 * @param {Map}     args.nodeByObject  object id → the single node standing for it
 * @param {Map}     args.geometry      lane type → lane geometry (`computeLaneGeometry`)
 * @param {object}  args.scales        the active x scale
 * @param {Map}     [args.objectRow]   object id → the base row of its sub-lane band
 * @returns {{x, y, xAt, clampToLifecycle, xOfTime}} anchor resolvers
 */
export function createAnchors({ nodes, nodeByObject, geometry, scales, objectRow = new Map() }) {
  /**
   * The single drawn node standing for an object — but only in the commit lane.
   *
   * A commit (or a burst, or a fold group) is exactly one node, so an edge into the
   * commit lane must meet that node at the row it was packed into. An issue or PR is
   * *many* nodes, so `nodeByObject` holds whichever happened to be written last —
   * for the vscode PR, the comment eight days after the merge. Consulting it for a
   * non-commit object is what dragged every link to the right-hand edge.
   */
  function commitNode(anchorId) {
    const node = nodeByObject.get(anchorId);
    return node && node.lane === 'commit' ? node : null;
  }

  /** The node for this object at exactly this instant, if one is drawn. */
  function exactNodeX(objectId, time) {
    for (const node of nodes) {
      if (node.objectId === objectId && +node.t === +time) return node.x;
    }
    return null;
  }

  function xAt(object, time) {
    if (!object) return scales.x(time);
    if (object.type === 'commit') {
      const node = commitNode(object.id);
      return node ? node.x : scales.x(time);
    }
    // Land on the actual glyph for this instant — the "merged" diamond rather than
    // merely near it — falling back to the scale when no node marks that moment.
    const exact = exactNodeX(object.id, time);
    return exact != null ? exact : scales.x(time);
  }

  /**
   * The y an edge meets, which must be the y the object is *drawn* at.
   *
   * For an issue or a PR that is its band's base row — the same row the lifecycle
   * bar uses (`renderLifecycleBars`) — not the lane's content top. Anchoring to the
   * lane top instead sent every link to band 0: with three PRs packed into two
   * bands, edges from the commits of the second-band PR climbed past it to the top
   * of the lane and appeared to arrive at a different pull request.
   */
  function y(anchorId, object) {
    const node = commitNode(anchorId);
    if (node) return node.y;
    // `rowY` already yields 0 for a lane it does not know, which covers a laneless
    // object type (`actor`, `repo`) and an endpoint that resolved to nothing.
    return rowY(geometry, object?.type, objectRow.get(anchorId) ?? 0);
  }

  function x(anchorId, object) {
    const node = commitNode(anchorId);
    if (node) return node.x;
    return xAt(object, object?.intervals?.[0]?.start ?? scales.first);
  }

  /** Slide an endpoint along the object's lifecycle so the edge meets it side-on. */
  function clampToLifecycle(anchorId, object, sourceX) {
    const node = commitNode(anchorId);
    if (node) return node.x;
    const interval = object?.intervals?.[0];
    if (!interval?.start || !interval?.end) return x(anchorId, object);
    const low = xAt(object, interval.start);
    const high = xAt(object, interval.end);
    return Math.max(low, Math.min(high, sourceX));
  }

  return { x, y, xAt, clampToLifecycle, xOfTime: (t) => scales.x(t) };
}
