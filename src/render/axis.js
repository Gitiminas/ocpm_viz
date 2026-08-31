/**
 * The time axis: ticks, collision-aware labels, and gap annotation.
 *
 * Tick *selection* differs per mode. Absolute mode asks d3 for a sensible number of
 * round times and puts the sub-log's own start at the left edge ahead of them, because
 * d3's round times all sit *inside* the domain and so leave the edge — where the earliest
 * marks are — unlabelled. Discrete mode spaces up to nine evenly by rank; its rank 0 is
 * already the first instant, so it anchors itself. (The removed Highlights mode ticked only
 * "meaningful" instants — lifecycle boundaries, out-of-span comments, folded pushes; that
 * selection went with the mode.)
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
  if (mode === 'absolute') {
    const idealCount = Math.max(3, Math.min(200, Math.round(6 * zoom)));
    const rounds = d3
      .scaleUtc()
      .domain([new Date(scales.first), new Date(scales.last)])
      .ticks(idealCount)
      .map((t) => ({ x: scales.x(t), t }));
    return withStartAnchor(rounds, scales.first, marginLeft);
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

/**
 * Put the sub-log's own start at the left edge, ahead of d3's round times.
 *
 * ⚠️ d3 chooses ticks on round times *inside* the domain, so its first tick is the first
 * interval boundary at or after the earliest instant — midnight only by coincidence. That
 * left the plot's left edge unlabelled, and the leftmost marks stranded to the left of every
 * tick: on kubernetes PR #118316 (2023-05-29 13:38 → 2023-05-30 16:29) d3 ticks 6-hourly from
 * 18:00, so the PR's opening mark sat left of the first tick and read as the previous day.
 * The edge is a real instant — it is exactly where the sub-log begins — so it gets a tick of
 * its own, and it is the one tick whose position is not a round number.
 *
 * A round tick landing on the same instant is dropped rather than drawn twice; the anchor
 * wins, because it is the more precise label for that position.
 *
 * Pure and exported for the tests: `x` comes from the caller because the anchor is the left
 * edge by construction, not by evaluating the scale.
 */
export function withStartAnchor(ticks, first, marginLeft) {
  const start = new Date(first);
  return [
    { x: marginLeft, t: start, anchor: true },
    ...ticks.filter((tick) => +tick.t > +start),
  ];
}

/**
 * Build one label per tick, adding seconds only where minutes would be ambiguous.
 *
 * The anchor is the only absolute tick that is not on a round time, so it is the only one
 * that states a date *and* a clock time; every other label stays a bare date at midnight or
 * a bare time within the day. The anchor is what carries the date for the stretch before the
 * first midnight, which is why no tick needs a first-one special case any more.
 */
export function buildLabels(ticks, mode) {
  return ticks.map((tick, i) => {
    if (mode === 'absolute') {
      if (tick.anchor) return formatDateMinute(tick.t);
      const isMidnight = tick.t.getUTCHours() === 0 && tick.t.getUTCMinutes() === 0;
      return isMidnight ? formatDate(tick.t) : formatTime(tick.t);
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
      merged.push({ x: tick.x, label: labels[i], isFirst: i === 0, anchor: !!tick.anchor });
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
    mode === 'absolute' && ticks.some((t) => t.t.getUTCHours() !== 0 || t.t.getUTCMinutes() !== 0);

  let lastX = -1e9;
  let staggered = false;

  for (const tick of merged) {
    // The anchor names the day, so it is emphasised whatever rhythm the round ticks fell into.
    const isDateTick = tick.anchor || (hasHourTicks && !/:/.test(tick.label));
    const closeSpacing = mode !== 'absolute' && tick.x - lastX < STAGGER_DISTANCE_PX;
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

  // Discrete mode discards real durations, so silence becomes invisible. Annotate the
  // large gaps with their true length to keep the compression honest.
  if (mode === 'discrete') {
    const gaps = findLargeGaps(rankTimes).map((gap) => ({
      ...gap,
      x0: marginLeft + (gap.fromRank / rankMax) * plotWidth,
      x1: marginLeft + (gap.toRank / rankMax) * plotWidth,
    }));

    // Every gap keeps its band — bands sit between consecutive ranks and cannot overlap.
    // The LABELS can: zoomed out on kubernetes #47532 they drew over each other until
    // none read. Colliding labels merge into ONE that states the total and the count
    // ("≈ 1 year (4 gaps)"), because the honest quantity for a crowded stretch is the
    // sum of its silences — a first attempt kept only the biggest gap's label, and
    // "≈ 5 months" over a region hiding nearly a year under-reported it. Zooming in
    // spreads the bands and the groups fall apart into individual labels by themselves.
    for (const group of mergeGapLabels(gaps)) {
      for (const gap of group.gaps) {
        gAxis
          .append('rect')
          .attr('x', gap.x0)
          .attr('y', axisY - 6)
          .attr('width', Math.max(1, gap.x1 - gap.x0))
          .attr('height', 12)
          .attr('fill', 'var(--color-neutral-700)')
          .attr('fill-opacity', 0.35)
          .attr('stroke', 'var(--color-neutral-500)')
          .attr('stroke-width', 1)
          .attr('stroke-dasharray', '2 2');
      }
      gAxis
        .append('text')
        .attr('x', group.x)
        .attr('y', axisY - 11)
        .attr('text-anchor', 'middle')
        .attr('font-size', 10)
        .attr('class', 'mono')
        .attr('fill', 'var(--color-neutral-400)')
        .text(group.label);
    }
  }
}

/** Roughly what a 10px mono label covers, plus breathing room between neighbours. */
const GAP_LABEL_PX_PER_CHAR = 6.2;
const GAP_LABEL_GAP_PX = 8;

/** A group's label: one gap speaks for itself; several state the sum and say so. */
function gapGroupLabel(gaps) {
  if (gaps.length === 1) return formatApproxDuration(gaps[0].duration);
  const total = gaps.reduce((sum, gap) => sum + gap.duration, 0);
  return `${formatApproxDuration(total)} (${gaps.length} gaps)`;
}

/** Where a group's label sits and how far it reaches, centred over the group's bands. */
function labelExtent(gaps) {
  const label = gapGroupLabel(gaps);
  const x = (gaps[0].x0 + gaps[gaps.length - 1].x1) / 2;
  const half = (label.length * GAP_LABEL_PX_PER_CHAR) / 2;
  return { label, x, lo: x - half, hi: x + half };
}

/**
 * Group the gap bands whose labels would collide, left to right, until every label fits.
 *
 * Each group is labelled with the SUM of its gaps' durations and their count. Summing is
 * the honest aggregate — the label claims total silence across the stretch, not one long
 * gap, and the count is what says so. Merging runs to a fixed point because a merged
 * label is wider than either original and can collide with its own neighbour in turn.
 *
 * Pure and exported for the tests: takes `{x0, x1, duration}` in x order, returns
 * `{gaps, label, x}` groups.
 */
export function mergeGapLabels(gaps) {
  let groups = [...gaps]
    .sort((a, b) => a.x0 - b.x0)
    .map((gap) => ({ gaps: [gap], ...labelExtent([gap]) }));

  for (let merged = true; merged; ) {
    merged = false;
    const next = [];
    for (const group of groups) {
      const last = next[next.length - 1];
      if (last && group.lo < last.hi + GAP_LABEL_GAP_PX) {
        const gaps = [...last.gaps, ...group.gaps];
        next[next.length - 1] = { gaps, ...labelExtent(gaps) };
        merged = true;
      } else {
        next.push(group);
      }
    }
    groups = next;
  }
  return groups.map(({ gaps, label, x }) => ({ gaps, label, x }));
}
