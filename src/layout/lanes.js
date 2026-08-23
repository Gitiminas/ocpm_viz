/**
 * Lane geometry: where each lane starts, how tall it is, and where its rows sit.
 *
 * A lane's height depends on how many rows its contents needed, so geometry is
 * computed after packing, not before.
 *
 * Three of the four object types get a lane — `actor` has no lifecycle to draw and
 * surfaces through the sidebar and the actor card instead. It is the only such type.
 * `laneTypes` is therefore passed in rather than assumed.
 */

import { ROW_HEIGHT, LANE_PAD_TOP, LANE_PAD_BOTTOM } from './packing.js';

/**
 * @param {string[]} lanes  visible lane types, in display order
 * @param {Map<string, number>} maxRowByLane  highest row index used per lane
 * @param {{top: number, bottom: number}} margin
 * @returns {{lanes: Map, height: number}} per-lane geometry and total svg height
 */
export function computeLaneGeometry(lanes, maxRowByLane, margin) {
  const geometry = new Map();
  let y = margin.top;

  for (const lane of lanes) {
    const rows = (maxRowByLane.get(lane) ?? 0) + 1;
    const height = LANE_PAD_TOP + rows * ROW_HEIGHT + LANE_PAD_BOTTOM;
    geometry.set(lane, {
      top: y,
      contentTop: y + LANE_PAD_TOP,
      height,
      rows,
    });
    y += height;
  }

  return { lanes: geometry, height: y + margin.bottom };
}

/** y of a given row within a lane. */
export function rowY(geometry, lane, row) {
  const laneGeometry = geometry.get(lane);
  if (!laneGeometry) return 0;
  return laneGeometry.contentTop + row * ROW_HEIGHT;
}
