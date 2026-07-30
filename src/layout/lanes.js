/**
 * Lane geometry: where each lane starts, how tall it is, and where its rows sit.
 *
 * A lane's height depends on how many rows its contents needed, so geometry is
 * computed after packing, not before.
 *
 * Only three of the five object types get a lane (decision 15) — `actor` and `repo`
 * are objects without lifecycles and surface through the sidebar and info cards
 * instead. `laneTypes` is therefore passed in rather than assumed.
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
