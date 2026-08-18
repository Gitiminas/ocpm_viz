/**
 * The two time scales of the timeline, and the coordinate dispatcher.
 *
 * This is the highest-risk logic in the app: mode switching lives in exactly one
 * function, and a subtle error here moves every node a little without looking wrong.
 *
 *   real        linear in real time
 *   discrete     equal spacing by event rank; real durations are discarded and the
 *               large gaps are annotated separately by the axis
 *
 * ⚠️ There was a third, *highlights* — a compressed axis where each inter-event gap
 * contributed a fixed base plus the gap capped at three hours. Removed (decision 112):
 * it sat between the other two without answering a question either could not, and it
 * carried its own folding rule for commits. Its one lasting trace is that the discrete
 * inverse below used to borrow the compressed inverse as an approximation; it now has
 * an inverse of its own.
 *
 * Everything here is pure: it takes numbers and returns numbers, so it can be
 * checked without rendering anything.
 */

/** Gaps longer than this get an annotated band in discrete mode. */
export const GAP_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export const MODES = ['absolute', 'discrete'];

/**
 * Build the coordinate functions for one render pass.
 *
 * @param {object}   options
 * @param {number[]} options.instants   sorted distinct instants (ms) in the sub-log
 * @param {number}   options.marginLeft x of the plot's left edge
 * @param {number}   options.plotWidth  width of the plot area at the current zoom
 * @param {string}   options.mode       one of MODES
 * @param {number[]} options.rankTimes  instant per rank, for discrete mode
 * @param {number}   options.rankMax    highest rank index, at least 1
 */
export function createScales({
  instants,
  marginLeft,
  plotWidth,
  mode = 'absolute',
  rankTimes = [],
  rankMax = 1,
}) {
  const first = instants.length ? instants[0] : 0;
  const last = instants.length ? instants[instants.length - 1] : 0;

  // A sub-log can legitimately span zero time — one instant, or several objects
  // sharing a timestamp. The mockup divided by (t1 - t0) unguarded and produced NaN
  // coordinates, which render as nothing at all. Collapsing to the left edge is the
  // honest degenerate answer.
  const realSpan = last - first;

  function absolute(t) {
    if (realSpan <= 0) return marginLeft;
    return marginLeft + ((+t - first) / realSpan) * plotWidth;
  }

  /**
   * Discrete position for a bare timestamp, interpolated between the ranks that
   * bracket it. Used for anything without a rank of its own — a lifecycle bar's
   * endpoints, for instance, which must land between the events around them.
   */
  function discreteTime(t) {
    const time = +t;
    if (!rankTimes.length) return marginLeft;
    if (time <= rankTimes[0]) return marginLeft;
    if (time >= rankTimes[rankTimes.length - 1]) return marginLeft + plotWidth;

    let index = lowerBound(rankTimes, time);
    const lo = Math.max(0, index - 1);
    const hi = Math.min(rankTimes.length - 1, index);
    const loTime = rankTimes[lo];
    const hiTime = rankTimes[hi];
    const fraction = hiTime > loTime ? (time - loTime) / (hiTime - loTime) : 0;
    return marginLeft + ((lo + fraction * (hi - lo)) / rankMax) * plotWidth;
  }

  function discreteRank(rank) {
    return marginLeft + (rank / rankMax) * plotWidth;
  }

  /**
   * The dispatcher. A node with a rank uses it in discrete mode; anything else falls
   * back to interpolating its timestamp.
   */
  function x(t, node) {
    if (mode === 'absolute') return absolute(t);
    if (node && node.rank != null) return discreteRank(node.rank);
    return discreteTime(t);
  }

  /**
   * Pixel → time, for the minimap's drag-to-zoom time anchoring.
   *
   * In discrete mode the inverse interpolates between the two ranks that bracket the
   * pixel — the exact inverse of `discreteTime` for an instant between ranks, and of
   * `discreteRank` at a rank. It only decides which instant stays pinned under the cursor
   * while dragging, never a rendered position. (It used to borrow the removed
   * compressed scale's inverse as an approximation; this is the honest one.)
   */
  function invert(px) {
    if (plotWidth <= 0) return new Date(first);
    const fraction = Math.max(0, Math.min(1, (px - marginLeft) / plotWidth));
    if (mode === 'absolute') return new Date(first + fraction * realSpan);
    if (!rankTimes.length) return new Date(first);
    const rank = fraction * rankMax;
    const lo = Math.min(rankTimes.length - 1, Math.floor(rank));
    const hi = Math.min(rankTimes.length - 1, Math.ceil(rank));
    const loTime = +rankTimes[lo];
    const hiTime = +rankTimes[hi];
    return new Date(loTime + (rank - lo) * (hiTime - loTime));
  }

  /**
   * Where an instant would land if the plot were a different width.
   *
   * Exact rather than approximate: every branch above is affine in `plotWidth`
   * (`marginLeft + fraction × plotWidth`), so rescaling the fraction is the same as
   * rebuilding the scale. The minimap's drag-to-zoom needs this to keep the opposite
   * edge pinned to its instant while the zoom is still changing.
   */
  function xAtZoom(t, otherPlotWidth, node) {
    if (plotWidth <= 0) return marginLeft;
    const fraction = (x(t, node) - marginLeft) / plotWidth;
    return marginLeft + fraction * otherPlotWidth;
  }

  return {
    x,
    xAtZoom,
    absolute,
    discreteTime,
    discreteRank,
    invert,
    first,
    last,
  };
}

/** Index of the first element not less than `value`. */
function lowerBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Gaps worth annotating in discrete mode, where real duration is otherwise invisible.
 * Returns the rank interval each gap spans plus its true duration.
 */
export function findLargeGaps(rankTimes, threshold = GAP_THRESHOLD_MS) {
  const gaps = [];
  for (let i = 1; i < rankTimes.length; i++) {
    const duration = rankTimes[i] - rankTimes[i - 1];
    if (duration > threshold) gaps.push({ fromRank: i - 1, toRank: i, duration });
  }
  return gaps;
}
