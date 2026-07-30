/**
 * Drawing the lane contents: lifecycle bars, sequence lines, actor trails, and the
 * nodes themselves.
 *
 * The lifecycle bar is where decision 4 becomes visible. The mockup drew one bar per
 * object from a single `t_start`/`t_end` pair, which cannot represent an issue that
 * was closed and reopened. Here every object draws one bar **per interval**, so a
 * reopened issue renders as several bars on one row.
 */

/* global d3 */

import { formatInstant, formatDuration, escapeHtml } from './format.js';
import { TYPE, COLORS, drawSymbol, typeColor } from './theme.js';
import { objectOpacity } from '../model/graph.js';

/** Commit labels are thinned so they never collide. */
const COMMIT_LABEL_MIN_GAP_PX = 64;

export function renderLifecycleBars({ gBG, index, geometry, state, anchors, focus, laneTypes }) {
  for (const laneType of laneTypes) {
    if (laneType === 'commit' || !state.tracks[laneType]) continue;
    const lane = geometry.get(laneType);
    if (!lane) continue;

    for (const object of index.objectsOfType(laneType)) {
      for (const interval of object.intervals) {
        if (!interval.start || !interval.end) continue;

        const x1 = anchors.xAt(object, interval.start);
        const x2 = anchors.xAt(object, interval.end);
        const width = Math.max(2, x2 - x1);
        // Every object of a lane currently draws its bar on the lane's first row, so
        // two issues whose lifetimes overlap would draw overlapping bars. Allocating
        // a sub-lane when — and only when — temporal overlap forces it is Task 2.
        const y = lane.contentTop;

        const group = gBG
          .append('g')
          .attr('opacity', objectOpacity(object.id, focus))
          .attr('data-legend', laneType);

        group
          .append('rect')
          .attr('x', x1)
          .attr('y', y - 3)
          .attr('width', width)
          .attr('height', 6)
          .attr('rx', 3)
          .attr('fill', typeColor(laneType))
          .attr('fill-opacity', state.mode === 'ordinal' ? 0.08 : 0.18)
          .attr('stroke', typeColor(laneType))
          .attr('stroke-width', 1);

        // Ordinal mode discards real durations, so state the span in text instead.
        if (state.mode === 'ordinal') {
          group
            .append('text')
            .attr('x', (x1 + x2) / 2)
            .attr('y', y - 9)
            .attr('text-anchor', 'middle')
            .attr('font-size', 10)
            .attr('class', 'mono')
            .attr('fill', 'var(--color-neutral-400)')
            .text(formatDuration(+interval.end - +interval.start));
        }
      }
    }
  }
}

/** The dotted spine connecting consecutive nodes within a lane. */
export function renderSequenceLines({ gSeq, nodes, laneTypes, focus }) {
  for (const laneType of laneTypes) {
    const inLane = nodes.filter((n) => n.lane === laneType).sort((a, b) => a.t - b.t);
    for (let i = 1; i < inLane.length; i++) {
      const a = inLane[i - 1];
      const b = inLane[i];
      const isComment = a.isComment || b.isComment;
      gSeq
        .append('path')
        .attr('data-legend', isComment ? 'comments' : null)
        .attr('d', curve(a, b))
        .attr('fill', 'none')
        .attr('stroke', typeColor(laneType))
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', isComment ? '1 5' : null)
        .attr('stroke-linecap', 'round')
        .attr('opacity', focus ? 0.15 : 0.35);
    }
  }
}

export function renderActorTrails({ gHalo, nodes, state, actorColors }) {
  for (const actorId of state.actors) {
    const color = actorColors.get(actorId);
    const mine = nodes.filter((n) => n.actorId === actorId).sort((a, b) => a.t - b.t);

    for (let i = 1; i < mine.length; i++) {
      gHalo
        .append('path')
        .attr('d', curve(mine[i - 1], mine[i]))
        .attr('fill', 'none')
        .attr('stroke', color)
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', '4 6')
        .attr('opacity', 0.8);
    }
    for (const node of mine) {
      gHalo
        .append('circle')
        .attr('cx', node.x)
        .attr('cy', node.y)
        .attr('r', node.isComment ? 10 : 14)
        .attr('fill', 'none')
        .attr('stroke', color)
        .attr('stroke-width', 2.5)
        .attr('opacity', 1);
    }
  }
}

export function renderNodes({ gNode, nodes, state, focus, tooltip, tweenFrom, handlers, actorLogin }) {
  // Thin commit labels so only well-separated ones are drawn.
  const showLabel = new Set();
  let lastX = -1e9;
  for (const node of nodes
    .filter((n) => n.lane === 'commit' && !n.isBurst && !n.isGroup && !n.inBurst)
    .sort((a, b) => a.x - b.x)) {
    if (node.x - lastX > COMMIT_LABEL_MIN_GAP_PX) {
      showLabel.add(node.id);
      lastX = node.x;
    }
  }

  for (const node of nodes) {
    const dim = node.isGroup ? 1 : objectOpacity(node.objectId, focus);
    const previous = tweenFrom && tweenFrom.get(node.id);
    const startX = previous ? previous.x : node.x;
    const startY = previous ? previous.y : node.y;

    const group = gNode
      .append('g')
      .attr('transform', `translate(${startX},${startY})`)
      .style('cursor', 'pointer')
      .attr('opacity', dim)
      .attr('data-legend', node.lane === 'commit' ? 'commit' : null)
      .on('click', (event) => {
        event.stopPropagation();
        handlers.onNodeClick(event, node);
      });

    tooltip.bind(group, () => nodeTooltipSpec(node, actorLogin));

    // FLIP-style tween: draw at the old position, then animate to the new one.
    if (previous) {
      group
        .transition()
        .duration(450)
        .ease(d3.easeCubicOut)
        .attr('transform', `translate(${node.x},${node.y})`);
    }

    if (node.isGroup) {
      drawGroupBadge(group, node);
      continue;
    }
    if (node.isBurst) {
      drawBurstNode(group, node);
      continue;
    }

    if (node.milestone) {
      group
        .append('circle')
        .attr('r', (node.isComment ? 6 : 8) + 6)
        .attr('fill', 'none')
        .attr('stroke', typeColor(node.lane))
        .attr('stroke-width', 1.5)
        .attr('stroke-opacity', 0.7);
    }

    const size = node.isComment ? 6 : 8;
    const color = typeColor(node.lane);
    drawSymbol(
      group.append('g'),
      TYPE[node.lane].shape,
      size,
      node.isComment ? 'var(--color-bg)' : color,
      color,
      node.isComment ? 2.5 : 2,
    );

    if (node.lane === 'commit') {
      if (showLabel.has(node.id)) {
        group
          .append('text')
          .attr('y', 22)
          .attr('text-anchor', 'middle')
          .attr('font-size', 11)
          .attr('fill', 'var(--color-neutral-500)')
          .attr('class', 'mono')
          .text(node.title);
      }
    } else if (!node.isComment) {
      group
        .append('text')
        .attr('x', 18)
        .attr('y', 0)
        .attr('dominant-baseline', 'central')
        .attr('font-size', 13)
        .attr('font-weight', 500)
        .attr('fill', 'var(--color-text)')
        .text(node.short || node.title);
    }
  }
}

function drawGroupBadge(group, node) {
  group
    .append('rect')
    .attr('x', -13)
    .attr('y', -11)
    .attr('width', 26)
    .attr('height', 22)
    .attr('rx', 5)
    .attr('fill', COLORS.commit)
    .attr('fill-opacity', 0.12)
    .attr('stroke', COLORS.commit)
    .attr('stroke-width', 1.5)
    .attr('stroke-dasharray', '3 3');
  group
    .append('text')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('font-size', 11)
    .attr('font-weight', 700)
    .attr('fill', COLORS.commit)
    .attr('class', 'mono')
    .text(node.groupCount);
}

function drawBurstNode(group, node) {
  group
    .append('rect')
    .attr('x', -14)
    .attr('y', -14)
    .attr('width', 28)
    .attr('height', 28)
    .attr('rx', 6)
    .attr('fill', COLORS.commit)
    .attr('fill-opacity', 0.15)
    .attr('stroke', COLORS.commit)
    .attr('stroke-width', 2);
  group
    .append('text')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('font-size', 12)
    .attr('font-weight', 700)
    .attr('fill', COLORS.commit)
    .attr('class', 'mono')
    // The actual member count, derived from push_id.
    .text(node.burst.size);
  group
    .append('text')
    .attr('y', 28)
    .attr('text-anchor', 'middle')
    .attr('font-size', 10)
    .attr('fill', 'var(--color-neutral-500)')
    .attr('class', 'mono')
    .text('bulk push');
}

/**
 * The "−" handle above an expanded burst, plus its bracket line.
 *
 * One per expanded burst — the mockup drew exactly one, at a literal x.
 */
export function renderBurstHandles({ gNode, bursts, state, geometry, anchors, tooltip, handlers }) {
  const lane = geometry.get('commit');
  if (!lane || !state.tracks.commit) return;

  for (const burst of bursts) {
    if (!state.expandedBursts.has(burst.id)) continue;

    const x = anchors.xOfTime(burst.time);
    const y = lane.contentTop - 20;
    const color = COLORS.commit;

    gNode
      .append('line')
      .attr('x1', x)
      .attr('x2', x)
      .attr('y1', y + 12)
      .attr('y2', lane.contentTop + (lane.rows - 1) * 36)
      .attr('stroke', color)
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '4 4')
      .attr('opacity', 0.6);

    const handle = gNode
      .append('g')
      .attr('transform', `translate(${x},${y})`)
      .style('cursor', 'pointer')
      .on('click', (event) => {
        event.stopPropagation();
        handlers.onCollapseBurst(burst);
      });

    tooltip.bind(handle, () => ({
      accent: 'var(--color-accent)',
      shape: 'square',
      kicker: 'Commit · bulk push',
      title: `Collapse ${burst.size} commits`,
      rows: [['Push', escapeHtml(burst.pushId), 'mono']],
      note: 'Click to fold these commits back into one bulk-push node.',
    }));

    handle
      .append('rect')
      .attr('x', -16)
      .attr('y', -12)
      .attr('width', 32)
      .attr('height', 24)
      .attr('rx', 6)
      .attr('fill', 'var(--color-neutral-900)')
      .attr('stroke', color)
      .attr('stroke-width', 2);
    handle
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('font-size', 18)
      .attr('font-weight', 700)
      .attr('fill', color)
      .text('−');

    gNode
      .append('text')
      .attr('x', x + 24)
      .attr('y', y)
      .attr('dominant-baseline', 'central')
      .attr('font-size', 11)
      .attr('font-weight', 600)
      .attr('fill', 'var(--color-neutral-500)')
      .attr('class', 'mono')
      .text(`${burst.size} commits`);
  }
}

/** Dashed bounding boxes around expanded highlight groups. */
export function renderGroupBoxes({ gBG, nodes }) {
  const boxes = new Map();
  for (const node of nodes) {
    if (!node.groupKey || node.isGroup) continue;
    const box = boxes.get(node.groupKey) || { minX: Infinity, maxX: -Infinity, y: node.y };
    box.minX = Math.min(box.minX, node.x);
    box.maxX = Math.max(box.maxX, node.x);
    box.y = node.y;
    boxes.set(node.groupKey, box);
  }
  for (const box of boxes.values()) {
    gBG
      .append('rect')
      .attr('x', box.minX - 16)
      .attr('y', box.y - 14)
      .attr('width', box.maxX - box.minX + 32)
      .attr('height', 28)
      .attr('rx', 8)
      .attr('fill', 'none')
      .attr('stroke', COLORS.commit)
      .attr('stroke-width', 1.3)
      .attr('stroke-dasharray', '3 3')
      .attr('opacity', 0.55);
  }
}

function nodeTooltipSpec(node, actorLogin) {
  if (node.isGroup) {
    return {
      accent: COLORS.commit,
      shape: 'square',
      kicker: 'Commit · group',
      title: `${node.groupCount} commits folded`,
      rows: [
        ['From', formatInstant(node.groupStart), 'time'],
        ['To', formatInstant(node.groupEnd), 'time'],
      ],
      note: 'Grouped between highlighted commits to declutter the Highlights view. Click to expand.',
    };
  }

  if (node.isBurst) {
    return {
      accent: 'var(--color-accent)',
      shape: 'square',
      kicker: 'Commit · bulk push',
      title: `${node.burst.size} commits in one push`,
      rows: [
        ['Time', formatInstant(node.t), 'time'],
        ['Push', escapeHtml(node.burst.pushId), 'mono'],
        ['Commits', String(node.burst.size)],
      ],
      note: 'First-seen in a PushEvent, not real commit times. Click the node to expand.',
    };
  }

  if (node.lane === 'commit') {
    const vmap = node.object.vmap || {};
    const message = vmap.commit_message || '—';
    return {
      accent: COLORS.commit,
      shape: 'square',
      kicker: 'Commit',
      title: `${escapeHtml(String(vmap.commit_sha || node.object.label).slice(0, 10))}…`,
      rows: [
        ['Time', formatInstant(node.t), 'time'],
        ['Author', escapeHtml(vmap.commit_author_name || '—')],
        ['Ref', escapeHtml(vmap.ref || '—'), 'mono'],
        ['Push', escapeHtml(vmap.push_id ?? '—'), 'mono'],
        ['Message', escapeHtml(message.length > 72 ? `${message.slice(0, 72)}…` : message)],
      ],
      note: 'Time = first observed in a PushEvent (not real git commit time).',
    };
  }

  const type = TYPE[node.lane];
  const rows = [
    ['Time', formatInstant(node.t), 'time'],
    ['Actor', `@${escapeHtml(actorLogin(node.actorId))}`],
    ['Object', escapeHtml(node.object.label)],
  ];
  if (node.event?.attrs?.auto_closed) {
    rows.push(['Auto-close', escapeHtml(String(node.event.attrs.auto_closed).replace(/^via /, ''))]);
  }
  return {
    accent: type.color,
    shape: type.shape,
    kicker: `${type.label}${node.isComment ? ' · comment' : ' · event'}`,
    title: escapeHtml(node.title),
    rows,
    note: '',
  };
}

function curve(a, b) {
  const midX = (a.x + b.x) / 2;
  return `M${a.x},${a.y} C ${midX},${a.y} ${midX},${b.y} ${b.x},${b.y}`;
}
