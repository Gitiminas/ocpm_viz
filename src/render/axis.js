/**
 * The time axis: ticks, collision-aware labels, and gap annotation.
 *
 * Tick *selection* differs per mode. Real mode asks d3 for a sensible number of
 * round times. Ordinal mode spaces up to nine evenly by rank. (The removed Highlights
 * mode ticked only "meaningful" instants — lifecycle boundaries, out-of-span comments,
 * folded pushes; that selection went with the mode, decision 112.)
 *
 * Label handling is shared and is fussier than it looks: labels that would collide
 * merge, labels that are merely close stagger onto two rows, and seconds appear only
 * where a minute-level label would be ambiguous.
 */

/* global d3 */

import {
  formatDate,
  formatTime,
  formatDateMinute,
  formatDateSecond,
  formatApproxDuration,
} from './format.js';
import { findLargeGaps } from '../layout/scales.js';

/** Labels closer than this merge into one. */
const MERGE_DISTANCE_PX = 14;
/** Labels closer than this stagger onto alternating rows. */
const STAGGER_DISTANCE_PX = 110;

/** Choose tick positions for the active mode. */
export function computeTicks({ mode, scales, zoom, rankOrder, rankMax, plotWidth, marginLeft }) {
  if (mode === 'real') {
    const idealCount = Math.max(3, Math.min(200, Math.round(6 * zoom)));
    return d3
      .scaleUtc()
      .domain([new Date(scales.first), new Date(scales.last)])
      .ticks(idealCount)
      .map((t) => ({ x: scales.x(t), t }));
  }

  const count = Math.min(9, rankOrder.length);
  const seen = new Set();
  const ticks = [];
  for (let k = 0; k < count; k++) {
    const index = Math.round((k * (rankOrder.length - 1)) / Math.max(1, count - 1));
    if (seen.has(index)) continue;
    seen.add(index);
    ticks.push({ x: marginLeft + (index / rankMax) * plotWidth, t: rankOrder[index].t });
  }
  return ticks;
}

/** Build one label per tick, adding seconds only where minutes would be ambiguous. */
function buildLabels(ticks, mode) {
  return ticks.map((tick, i) => {
    if (mode === 'real') {
      const isMidnight = tick.t.getUTCHours() === 0 && tick.t.getUTCMinutes() === 0;
      return i === 0 || isMidnight ? formatDate(tick.t) : formatTime(tick.t);
    }
    const minuteLabel = formatDateMinute(tick.t);
    const collides =
      (i > 0 && formatDateMinute(ticks[i - 1].t) === minuteLabel) ||
      (i < ticks.length - 1 && formatDateMinute(ticks[i + 1].t) === minuteLabel);
    return collides ? formatDateSecond(tick.t) : minuteLabel;
  });
}

/** Merge ticks that land within a few pixels, sharing a date prefix where possible. */
function mergeTicks(ticks, labels) {
  const merged = [];
  ticks.forEach((tick, i) => {
    const previous = merged[merged.length - 1];
    if (previous && tick.x - previous.x < MERGE_DISTANCE_PX) {
      const a = previous.label.match(/^(\w{3} \d{2})\s+(.*)$/);
      const b = labels[i].match(/^(\w{3} \d{2})\s+(.*)$/);
      previous.label = a && b && a[1] === b[1] ? `${a[1]}  ${a[2]} / ${b[2]}` : `${previous.label} / ${labels[i]}`;
    } else {
      merged.push({ x: tick.x, label: labels[i], isFirst: i === 0 });
    }
  });
  return merged;
}

export function renderAxis({
  gAxis,
  mode,
  scales,
  zoom,
  rankOrder,
  rankMax,
  rankTimes,
  plotWidth,
  marginLeft,
  marginTop,
  axisY,
}) {
  gAxis
    .append('line')
    .attr('x1', marginLeft)
    .attr('x2', marginLeft + plotWidth)
    .attr('y1', axisY)
    .attr('y2', axisY)
    .attr('stroke', 'var(--color-neutral-700)')
    .attr('stroke-width', 1);

  // One zone label on the axis rather than a suffix on every tick, which at this
  // density would be unreadable. Tooltips carry "UTC" on each instant instead.
  gAxis
    .append('text')
    .attr('x', marginLeft - 10)
    .attr('y', axisY + 4)
    .attr('text-anchor', 'end')
    .attr('font-size', 10)
    .attr('class', 'mono')
    .attr('fill', 'var(--color-neutral-500)')
    .text('UTC');

  const ticks = computeTicks({
    mode,
    scales,
    zoom,
    rankOrder,
    rankMax,
    plotWidth,
    marginLeft,
  });
  const merged = mergeTicks(ticks, buildLabels(ticks, mode));

  const hasHourTicks =
    mode === 'real' && ticks.some((t) => t.t.getUTCHours() !== 0 || t.t.getUTCMinutes() !== 0);

  let lastX = -1e9;
  let staggered = false;

  for (const tick of merged) {
    const isDateTick = hasHourTicks && (tick.isFirst || !/:/.test(tick.label));
    const closeSpacing = mode !== 'real' && tick.x - lastX < STAGGER_DISTANCE_PX;
    const yOffset = closeSpacing ? (staggered ? 34 : 16) : 16;
    staggered = closeSpacing ? !staggered : false;
    lastX = tick.x;

    gAxis
      .append('line')
      .attr('x1', tick.x)
      .attr('x2', tick.x)
      .attr('y1', marginTop)
      .attr('y2', axisY)
      .attr('stroke', 'var(--color-neutral-800)')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '2 4');

    gAxis
      .append('line')
      .attr('x1', tick.x)
      .attr('x2', tick.x)
      .attr('y1', axisY)
      .attr('y2', axisY + (yOffset > 16 ? yOffset - 10 : 6))
      .attr('stroke', 'var(--color-neutral-500)')
      .attr('stroke-width', closeSpacing && yOffset > 16 ? 1 : 2)
      .attr('stroke-dasharray', closeSpacing && yOffset > 16 ? '2 2' : null);

    gAxis
      .append('text')
      .attr('transform', `translate(${tick.x},${axisY + yOffset}) rotate(-30)`)
      .attr('text-anchor', 'end')
      .attr('font-size', 11)
      .attr('font-weight', isDateTick ? 600 : 400)
      .attr('fill', isDateTick ? 'var(--color-neutral-200)' : 'var(--color-neutral-400)')
      .attr('class', 'mono')
      .text(tick.label);
  }

  // Ordinal mode discards real durations, so silence becomes invisible. Annotate the
  // large gaps with their true length to keep the compression honest.
  if (mode === 'ordinal') {
    for (const gap of findLargeGaps(rankTimes)) {
      const x0 = marginLeft + (gap.fromRank / rankMax) * plotWidth;
      const x1 = marginLeft + (gap.toRank / rankMax) * plotWidth;

      gAxis
        .append('rect')
        .attr('x', x0)
        .attr('y', axisY - 6)
        .attr('width', Math.max(1, x1 - x0))
        .attr('height', 12)
        .attr('fill', 'var(--color-neutral-700)')
        .attr('fill-opacity', 0.35)
        .attr('stroke', 'var(--color-neutral-500)')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '2 2');

      gAxis
        .append('text')
        .attr('x', (x0 + x1) / 2)
        .attr('y', axisY - 11)
        .attr('text-anchor', 'middle')
        .attr('font-size', 10)
        .attr('class', 'mono')
        .attr('fill', 'var(--color-neutral-400)')
        .text(formatApproxDuration(gap.duration));
    }
  }
}
