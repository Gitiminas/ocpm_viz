/**
 * The three time scales and the coordinate dispatcher.
 *
 * This is the highest-risk logic in the app to port: mode switching lives in
 * exactly one function, and a subtle error here moves every node a little without
 * looking wrong. The compression constants and the interpolation are reproduced
 * from the mockup unchanged.
 *
 *   real        linear in real time
 *   highlights  compressed — each inter-event gap contributes a fixed base plus the
 *               gap itself capped at three hours, so idle periods shrink but order
 *               and relative magnitude survive
 *   ordinal     equal spacing by event rank; real durations are discarded and the
 *               large gaps are annotated separately by the axis
 *
 * Everything here is pure: it takes numbers and returns numbers, so it can be
 * checked without rendering anything.
 */

/** Each gap contributes at least this much width, so simultaneous events separate. */
export const COMPRESSION_BASE_MS = 9 * 60 * 1000;
/** ...and at most this much, so a week of silence does not dominate the axis. */
export const COMPRESSION_CAP_MS = 3 * 60 * 60 * 1000;
/** Gaps longer than this get an annotated band in ordinal mode. */
export const GAP_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export const MODES = ['real', 'highlights', 'ordinal'];

/**
 * Precompute the compressed-axis offsets for a sorted list of instants.
 *
 * Returns cumulative positions in "compressed milliseconds", where index i is the
 * position of `instants[i]`.
 */
export function compressionOffsets(instants) {
  const positions = [0];
  for (let i = 1; i < instants.length; i++) {
    const gap = instants[i] - instants[i - 1];
    positions.push(positions[i - 1] + COMPRESSION_BASE_MS + Math.min(gap, COMPRESSION_CAP_MS));
  }
  return positions;
}

/**
 * Build the coordinate functions for one render pass.
 *
 * @param {object}   options
 * @param {number[]} options.instants   sorted distinct instants (ms) in the sub-log
 * @param {number}   options.marginLeft x of the plot's left edge
 * @param {number}   options.plotWidth  width of the plot area at the current zoom
 * @param {string}   options.mode       one of MODES
 * @param {number[]} options.rankTimes  instant per rank, for ordinal mode
 * @param {number}   options.rankMax    highest rank index, at least 1
 */
export function createScales({
  instants,
  marginLeft,
  plotWidth,
  mode = 'real',
  rankTimes = [],
  rankMax = 1,
}) {
  const first = instants.length ? instants[0] : 0;
  const last = instants.length ? instants[instants.length - 1] : 0;
  const offsets = compressionOffsets(instants);
  const totalCompressed = offsets.length ? offsets[offsets.length - 1] : 0;

  // A sub-log can legitimately span zero time — one instant, or several objects
  // sharing a timestamp. The mockup divided by (t1 - t0) unguarded and produced NaN
  // coordinates, which render as nothing at all. Collapsing to the left edge is the
  // honest degenerate answer.
  const realSpan = last - first;

  function real(t) {
    if (realSpan <= 0) return marginLeft;
    return marginLeft + ((+t - first) / realSpan) * plotWidth;
  }

  function compressed(t) {
    const time = +t;
    if (!instants.length || totalCompressed <= 0) return marginLeft;
    if (time <= first) return marginLeft;
    if (time >= last) return marginLeft + plotWidth;
    for (let i = 1; i < instants.length; i++) {
      if (time <= instants[i]) {
        const span = instants[i] - instants[i - 1] || 1;
        const fraction = (time - instants[i - 1]) / span;
        const position = offsets[i - 1] + fraction * (offsets[i] - offsets[i - 1]);
        return marginLeft + (position / totalCompressed) * plotWidth;
      }
    }
    return marginLeft + plotWidth;
  }

  /**
   * Ordinal position for a bare timestamp, interpolated between the ranks that
   * bracket it. Used for anything without a rank of its own — a lifecycle bar's
   * endpoints, for instance, which must land between the events around them.
   */
  function ordinalTime(t) {
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

  function ordinalRank(rank) {
    return marginLeft + (rank / rankMax) * plotWidth;
  }

  /**
   * The dispatcher. A node with a rank uses it in ordinal mode; anything else falls
   * back to interpolating its timestamp.
   */
  function x(t, node) {
    if (mode === 'real') return real(t);
    if (mode === 'highlights') return compressed(t);
    if (node && node.rank != null) return ordinalRank(node.rank);
    return ordinalTime(t);
  }

  /**
   * Pixel → time, for the minimap's drag-to-zoom time anchoring.
   *
   * Ordinal mode deliberately falls through to the compressed inverse, matching the
   * mockup. It is approximate there — ordinal discards real durations, so no exact
   * inverse exists — and it only affects which instant stays pinned under the cursor
   * while dragging, never a rendered position.
   */
  function invert(px) {
    if (mode === 'real') {
      if (plotWidth <= 0) return new Date(first);
      const fraction = (px - marginLeft) / plotWidth;
      return new Date(first + fraction * realSpan);
    }
    if (!instants.length) return new Date(first);
    const position = ((px - marginLeft) / plotWidth) * totalCompressed;
    for (let i = 1; i < offsets.length; i++) {
      if (position <= offsets[i]) {
        const span = offsets[i] - offsets[i - 1] || 1;
        const fraction = (position - offsets[i - 1]) / span;
        return new Date(instants[i - 1] + fraction * (instants[i] - instants[i - 1]));
      }
    }
    return new Date(last);
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
    real,
    compressed,
    ordinalTime,
    ordinalRank,
    invert,
    first,
    last,
    totalCompressed,
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
 * Gaps worth annotating in ordinal mode, where real duration is otherwise invisible.
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
