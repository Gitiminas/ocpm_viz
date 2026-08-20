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
import { ROW_HEIGHT } from '../layout/packing.js';
import { rowY } from '../layout/lanes.js';

/** Commit labels are thinned so they never collide. */
const COMMIT_LABEL_MIN_GAP_PX = 64;

export function renderLifecycleBars({
  gBG,
  index,
  geometry,
  state,
  anchors,
  focus,
  laneTypes,
  objectRow = new Map(),
  objectColors = new Map(),
}) {
  for (const laneType of laneTypes) {
    if (laneType === 'commit' || !state.lanes[laneType]) continue;
    const lane = geometry.get(laneType);
    if (!lane) continue;

    for (const object of index.objectsOfType(laneType)) {
      if (state.hiddenObjects?.has(object.id)) continue;
      // An object draws one bar per interval, all on its own sub-lane row, so a
      // reopened issue reads as several bars belonging to one object and two
      // concurrent issues never share a row.
      const row = objectRow.get(object.id) ?? 0;
      // Shade by object, not by type: with two PRs in a lane the hue says "pull
      // request" but only the shade says *which* pull request.
      const color = objectColors.get(object.id) || typeColor(laneType);

      for (const interval of object.intervals) {
        if (!interval.start || !interval.end) continue;

        const x1 = anchors.xAt(object, interval.start);
        const x2 = anchors.xAt(object, interval.end);
        const width = Math.max(2, x2 - x1);
        // One formula for "the y of a row", shared with the link anchors. When this
        // was written out here a second time, the two drifted: the bar moved down to
        // its band while every link into it stayed at the top of the lane.
        const y = rowY(geometry, laneType, row);

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
          .attr('fill', color)
          .attr('fill-opacity', state.mode === 'discrete' ? 0.08 : 0.18)
          .attr('stroke', color)
          .attr('stroke-width', 1);

        // Discrete mode discards real durations, so state the span in text instead.
        if (state.mode === 'discrete') {
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

/**
 * The spine connecting consecutive nodes.
 *
 * Grouped **per object** in the issue and PR lanes, not per lane. With one issue
 * and one PR the two are the same thing, which is why the mockup could get away
 * with per-lane — but as soon as a lane holds two objects, a per-lane spine
 * zigzags between them and draws a sequence between unrelated PRs that does not
 * exist. Per object, the line is what it claims to be: this object's own history,
 * traceable across the whole timeline.
 *
 * The commit lane stays per-lane deliberately. Each commit is its own object, so
 * per-object would draw nothing at all; the chronological spine through the commit
 * stream is the meaningful reading there.
 */
export function renderSequenceLines({ gSeq, nodes, laneTypes, focus, objectColors = new Map() }) {
  for (const laneType of laneTypes) {
    const inLane = nodes.filter((n) => n.lane === laneType);
    const groups =
      laneType === 'commit'
        ? [inLane]
        : [...groupBy(inLane, (node) => node.objectId ?? '·').values()];

    for (const group of groups) {
      const ordered = group.slice().sort((a, b) => a.t - b.t);
      for (let i = 1; i < ordered.length; i++) {
        const a = ordered[i - 1];
        const b = ordered[i];
        const isComment = a.isComment || b.isComment;
        gSeq
          .append('path')
          .attr('data-legend', isComment ? 'comments' : 'sequence')
          .attr('d', curve(a, b))
          .attr('fill', 'none')
          .attr('stroke', objectColors.get(a.objectId) || typeColor(laneType))
          .attr('stroke-width', 2)
          .attr('stroke-dasharray', isComment ? '1 5' : null)
          .attr('stroke-linecap', 'round')
          .attr('opacity', focus ? 0.15 : 0.35);
      }
    }
  }
}

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

/**
 * The points on the timeline that belong to one actor.
 *
 * ⚠️ **For a commit this is per *push*, not per commit.** A commit is pushed by several
 * accounts — 89% of vscode's repeatedly-observed commits are, up to fifteen — so "did
 * this actor touch this commit" has no single answer, and the old test (`node.actorId
 * === actorId`, against a map holding one arbitrary pusher) gave a wrong one in both
 * directions: it drew a trail through commits an actor never pushed and skipped the
 * ones they did. Selecting an actor in the sidebar therefore appeared to do nothing.
 *
 * Each observation is its own point, at the moment and row it is drawn, so an actor's
 * trail passes through exactly the pushes they made — the first observation on the
 * glyph, a later one on the repeat row.
 */
export function actorPoints(nodes, actorId) {
  const points = [];
  for (const node of nodes) {
    if (node.observations?.length) {
      node.observations.forEach((observation, i) => {
        if (observation.actorId !== actorId) return;
        points.push({
          x: observation.x ?? node.x,
          y: observation.y ?? node.y,
          t: observation.time,
          // The ring hugs what it marks: the full glyph, or the smaller repeat marker.
          ring: i === 0 ? 14 : 10,
        });
      });
      continue;
    }
    if (node.actorId === actorId) {
      points.push({ x: node.x, y: node.y, t: node.t, ring: node.isComment ? 10 : 14 });
    }
  }
  return points.sort((a, b) => +a.t - +b.t);
}

export function renderActorTrails({ gHalo, nodes, state, actorColors }) {
  for (const actorId of state.actors) {
    const color = actorColors.get(actorId);
    const mine = actorPoints(nodes, actorId);

    for (let i = 1; i < mine.length; i++) {
      gHalo
        .append('path')
        .attr('data-legend', 'actor-trail')
        .attr('d', curve(mine[i - 1], mine[i]))
        .attr('fill', 'none')
        .attr('stroke', color)
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', '4 6')
        .attr('opacity', 0.8);
    }
    for (const point of mine) {
      gHalo
        .append('circle')
        .attr('data-legend', 'actor-trail')
        .attr('cx', point.x)
        .attr('cy', point.y)
        .attr('r', point.ring)
        .attr('fill', 'none')
        .attr('stroke', color)
        .attr('stroke-width', 2.5)
        .attr('opacity', 1);
    }
  }
}

/**
 * Which legend row explains this node.
 *
 * One place, so a mark can never be drawn without an entry that names it — the gap this
 * closes is that only commits carried a tag, leaving comments, bursts, folded runs and
 * every issue/PR glyph unexplained and unhighlightable.
 */
export function legendKeyFor(node) {
  if (node.isCommentBurst) return 'comment-burst';
  if (node.isBurst) return 'burst';
  if (node.isComment) return 'comments';
  return node.lane;
}

export function renderNodes({
  gNode,
  nodes,
  state,
  focus,
  tooltip,
  tweenFrom,
  handlers,
  actorLogin,
  objectColors = new Map(),
}) {
  // Thin commit labels so only well-separated ones are drawn.
  const showLabel = new Set();
  let lastX = -1e9;
  for (const node of nodes
    .filter((n) => n.lane === 'commit' && !n.isBurst && !n.inBurst)
    .sort((a, b) => a.x - b.x)) {
    if (node.x - lastX > COMMIT_LABEL_MIN_GAP_PX) {
      showLabel.add(node.id);
      lastX = node.x;
    }
  }

  for (const node of nodes) {
    const dim = objectOpacity(node.objectId, focus);
    const previous = tweenFrom && tweenFrom.get(node.id);
    const startX = previous ? previous.x : node.x;
    const startY = previous ? previous.y : node.y;

    const group = gNode
      .append('g')
      .attr('transform', `translate(${startX},${startY})`)
      .style('cursor', 'pointer')
      .attr('opacity', dim)
      // Every node names the legend row that explains it. Only commits were tagged
      // before, so hovering "Issue" lit its lifecycle bar and none of its glyphs.
      .attr('data-legend', legendKeyFor(node))
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

    if (node.isBurst) {
      drawBurstNode(group, node);
      continue;
    }
    if (node.isCommentBurst) {
      drawCommentBurst(group, node, objectColors.get(node.objectId) || typeColor(node.lane));
      continue;
    }

    const nodeColor = objectColors.get(node.objectId) || typeColor(node.lane);

    if (node.landmark && node.heuristicLandmark) {
      // The off-platform merge (decision 123): a landmark by ruling, a heuristic by
      // nature. Same ring, same slot — but dotted and in the extracted colour, the
      // tool's one consistent cue for "parsed, not asserted" (decision 7), so the
      // emphasis claims no more than the data does.
      group
        .append('circle')
        .attr('data-legend', 'landmark-heuristic')
        .attr('r', (node.isComment ? 6 : 8) + 6)
        .attr('fill', 'none')
        .attr('stroke', COLORS.extracted)
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '1.5 3')
        .attr('stroke-opacity', 0.9);
    } else if (node.landmark) {
      group
        .append('circle')
        .attr('data-legend', 'landmark')
        .attr('r', (node.isComment ? 6 : 8) + 6)
        .attr('fill', 'none')
        .attr('stroke', nodeColor)
        .attr('stroke-width', 1.5)
        .attr('stroke-opacity', 0.7);
    }

    /*
     * A pull request that ended without merging: the landmark ring's counterpart, drawn
     * **dashed and muted**. Terminal, but not the terminal the process was aiming at.
     *
     * ⚠️ **Not a hollow diamond, which was the obvious idea and is already taken.** In
     * the issue and PR lanes a *comment* is drawn as the lane's own shape hollowed
     * (`isComment` below fills it with the page background), so a hollow diamond would
     * make an abandoned pull request read as a comment — the exact collision that made
     * the commit-lane repeat markers squares rather than circles. Fill and shape are
     * both spoken for, and colour is too: the shade carries *which* object (see
     * `assignObjectColors`), so recolouring this glyph would break the one cue that
     * lets a reader trace a link back to its pull request. A ring is what is left, and
     * being the same device as the merged landmark is the point — same slot in the
     * vocabulary, opposite outcome.
     */
    if (node.unmergedClose) {
      group
        .append('circle')
        .attr('data-legend', 'closed-unmerged')
        .attr('r', (node.isComment ? 6 : 8) + 6)
        .attr('fill', 'none')
        .attr('stroke', 'var(--color-neutral-500)')
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '3 3')
        .attr('stroke-opacity', 0.9);
    }

    // Before the glyph, so the primary observation stays the strongest mark on the row.
    if (node.lane === 'commit') drawRepeatObservations(group, node, tooltip, actorLogin);

    const size = node.isComment ? 6 : 8;
    drawSymbol(
      group.append('g'),
      TYPE[node.lane].shape,
      size,
      node.isComment ? 'var(--color-bg)' : nodeColor,
      nodeColor,
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

/**
 * The same SHA, observed again — one hollow marker per later push, on the commit
 * lane's reserved repeat row, joined to the glyph by a dashed elbow.
 *
 * The alternative was a node per observation, which would read as several commits and
 * would break the one-commit-one-node invariant that `layout/anchors.js`, bursts and
 * commit groups all rest on. Keeping one glyph and marking the repeats says what is
 * true — *one* commit, seen three times — and it is what fills the stretch of axis
 * that these observations were already stretching but drawing nothing into.
 *
 * They sit on their own row rather than beside the glyph so the commit row keeps
 * meaning "a commit happened here"; a re-push is a sighting, not a commit.
 *
 * Coordinates are relative because the enclosing group is translated to the node.
 */
function drawRepeatObservations(group, node, tooltip, actorLogin) {
  const repeats = (node.observations || []).slice(1);
  if (!repeats.length) return;

  const last = repeats[repeats.length - 1];
  const dy = (last.y ?? node.y) - node.y;

  // Down to the repeat row, then along it — an elbow rather than a diagonal, so the
  // drop reads as "the same commit, one row down" instead of as a link to elsewhere.
  group
    .append('path')
    .attr('data-legend', 'repeat-observation')
    .attr('d', `M0,0 L0,${dy} L${last.x - node.x},${dy}`)
    .attr('fill', 'none')
    .attr('stroke', COLORS.commit)
    .attr('stroke-width', 1)
    .attr('stroke-dasharray', '2 3')
    .attr('opacity', 0.5);

  repeats.forEach((repeat, i) => {
    const marker = group
      .append('g')
      .attr('transform', `translate(${repeat.x - node.x},${(repeat.y ?? node.y) - node.y})`)
      .attr('data-legend', 'repeat-observation')
      .attr('opacity', 0.9)
      .style('cursor', 'pointer');

    /*
     * A hollow **square**, not a hollow circle. The circle is the comment glyph in the
     * issue and PR lanes, and reusing it here would make a re-push read as a comment —
     * the shape vocabulary has to stay one-to-one or it stops being a vocabulary. The
     * square is the commit family's own shape, hollowed to say "not a new commit".
     */
    drawSymbol(marker, 'square', 4.5, 'var(--color-bg)', COLORS.commit, 1.5);

    /*
     * ⚠️ **Each marker answers for itself.** They used to inherit the commit's card,
     * so three marks a week apart all reported the same time, ref and push — the
     * reader could see there were three and could not tell which one was under the
     * cursor. A mark that cannot be identified is decoration.
     */
    if (tooltip) {
      tooltip.bind(marker, () => repeatTooltipSpec(node, repeat, i, actorLogin));
    }
  });
}

/** The card for one later push: which observation, whose, where, and when. */
function repeatTooltipSpec(node, repeat, i, actorLogin) {
  const total = node.observations.length;
  const sha = String(node.object?.vmap?.commit_sha || node.object?.label || '');
  return {
    accent: COLORS.commit,
    shape: 'square',
    kicker: 'Commit · later push',
    title: `${escapeHtml(sha.slice(0, 10))}…`,
    rows: [
      ['Observation', `${i + 2} of ${total}`],
      ['Time', formatInstant(repeat.time), 'time'],
      ['Pushed by', `@${escapeHtml(actorLogin(repeat.actorId))}`],
      ['Branch', escapeHtml(shortRef(repeat.ref)), 'mono'],
      ['Push', escapeHtml(String(repeat.pushId ?? '—')), 'mono'],
      ['First seen', formatInstant(node.t), 'time'],
    ],
    note:
      'The same commit observed again — it reached another branch. This is a sighting, ' +
      'not a new commit; the solid glyph on the row above is where it first appeared.',
  };
}

/**
 * A folded run of comments: the lane's own shape, hollow like a single comment, sized to
 * hold a count.
 *
 * Hollow because it *is* comments — the one place the comment cue belongs. It is bigger
 * than a single comment glyph and carries a number, which is what separates "several"
 * from "one" without inventing a shape; a commit burst is a rounded square with a count
 * for the same reason, in its own lane's vocabulary.
 */
function drawCommentBurst(group, node, color) {
  drawSymbol(group, TYPE[node.lane].shape, 11, 'var(--color-bg)', color, 2);
  group
    .append('text')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('font-size', 10)
    .attr('font-weight', 700)
    .attr('fill', color)
    .attr('class', 'mono')
    .text(node.commentBurst.size);
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
  if (!lane || !state.lanes.commit) return;

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
      .attr('y2', lane.contentTop + (lane.rows - 1) * ROW_HEIGHT)
      .attr('stroke', color)
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '4 4')
      .attr('opacity', 0.6);

    const handle = gNode
      .append('g')
      .attr('data-tip', 'fold.handle')
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

/**
 * Where an unfolded comment run sits, so it can be folded back.
 *
 * Pure: it takes positioned nodes and returns the span each expanded run occupies. Split
 * out because "which runs are open and where" is arithmetic that should be checkable
 * without drawing — the handle it feeds is the only way back once a run is open, and a
 * run whose extent is computed wrong is a control the reader cannot find.
 */
export function expandedCommentRuns(nodes, commentBursts, expanded) {
  const runs = [];
  for (const burst of commentBursts) {
    if (!expanded.has(burst.id)) continue;
    const ids = new Set(burst.eventIds);
    const members = nodes.filter((node) => node.event && ids.has(node.event.id));
    if (!members.length) continue;
    runs.push({
      burst,
      minX: Math.min(...members.map((node) => node.x)),
      maxX: Math.max(...members.map((node) => node.x)),
      y: Math.min(...members.map((node) => node.y)),
      size: members.length,
    });
  }
  return runs;
}

/**
 * The fold-back control for an unfolded comment run.
 *
 * Mirrors `renderBurstHandles`, and for the same reason: expanding is one click and
 * collapsing has to be one too. Without it the only way back was reloading the sub-log,
 * which throws away every other toggle the reader had set.
 */
export function renderCommentBurstHandles({
  gNode,
  nodes,
  commentBursts,
  state,
  tooltip,
  handlers,
}) {
  for (const run of expandedCommentRuns(nodes, commentBursts, state.expandedCommentBursts)) {
    const color = typeColor(run.burst.lane);
    const y = run.y - 22;

    gNode
      .append('path')
      .attr('d', `M${run.minX},${y + 10} L${run.minX},${run.y} M${run.minX},${y + 10} L${run.maxX},${y + 10} L${run.maxX},${run.y}`)
      .attr('fill', 'none')
      .attr('stroke', color)
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '3 3')
      .attr('opacity', 0.55);

    const handle = gNode
      .append('g')
      .attr('data-legend', 'comment-burst')
      .attr('transform', `translate(${(run.minX + run.maxX) / 2},${y})`)
      .style('cursor', 'pointer')
      .on('click', (event) => {
        event.stopPropagation();
        handlers.onCollapseCommentBurst(run.burst);
      });

    tooltip.bind(handle, () => ({
      accent: color,
      shape: TYPE[run.burst.lane].shape,
      kicker: `${TYPE[run.burst.lane].label} · comments`,
      title: `Fold ${run.burst.size} comments back`,
      rows: [
        ['From', formatInstant(run.burst.time), 'time'],
        ['To', formatInstant(run.burst.end), 'time'],
      ],
      note: 'Click to fold this run back into one mark.',
    }));

    handle
      .append('rect')
      .attr('x', -15)
      .attr('y', -10)
      .attr('width', 30)
      .attr('height', 20)
      .attr('rx', 6)
      .attr('fill', 'var(--color-neutral-900)')
      .attr('stroke', color)
      .attr('stroke-width', 1.5);
    handle
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('font-size', 16)
      .attr('font-weight', 700)
      .attr('fill', color)
      .text('\u2212');
  }
}

export function nodeTooltipSpec(node, actorLogin) {
  if (node.isCommentBurst) {
    const burst = node.commentBurst;
    return {
      accent: TYPE[node.lane].color,
      shape: TYPE[node.lane].shape,
      kicker: `${TYPE[node.lane].label} · comments`,
      title: `${burst.size} comments in ${formatDuration(+burst.end - +burst.time) || 'one moment'}`,
      rows: [
        ['From', formatInstant(burst.time), 'time'],
        ['To', formatInstant(burst.end), 'time'],
        ['On', escapeHtml(node.object.label)],
      ],
      note:
        'Comments close together in time, folded into one mark. Click to expand. Folding ' +
        'is a display choice — every one of them still counts in the statistics.',
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
    const observations = node.observations || [];
    const repeated = observations.length > 1;

    /*
     * ⚠️ **"Git author" and "Pushed by" are two different identity spaces and the labels
     * have to say so** (decision 5). `commit_author_name` is the string inside the commit;
     * the actor on a `CommitObserved` event is whoever *pushed* it, and they are never
     * joined — the upstream author email is anonymised, so there is nothing to join on.
     * The bare label "Author" invited the obvious reading that the sidebar's actor was
     * that author: on react, @flarnie pushed 218 observations written by 27 different
     * people and authored none of them. Naming the role is the whole fix.
     */
    const rows = [
      ['Time', formatInstant(node.t), 'time'],
      ['Git author', escapeHtml(vmap.commit_author_name || '—')],
    ];

    /*
     * ⚠️ `vmap.ref` and `vmap.push_id` describe the **first** observation only. Printing
     * them alone on a commit seen on three branches states that it reached one — the
     * wrong-picture-no-error failure, on the field a reader would use to trace where a
     * change went. So a repeated commit lists every observation instead, each with its
     * own pusher: a repeated commit usually has several, and no single "pushed by" line
     * could be true of all of them.
     */
    if (repeated) {
      const pushers = new Set(observations.map((observation) => observation.actorId));
      const branches = new Set(observations.map((observation) => shortRef(observation.ref)));
      rows.push({
        label: 'Observed',
        value:
          `${plural(observations.length, 'push', 'pushes')} · ` +
          `${plural(branches.size, 'branch', 'branches')} · ` +
          `${plural(pushers.size, 'account', 'accounts')}`,
        items: observations.map((observation) => ({
          primary: `@${escapeHtml(actorLogin(observation.actorId))} → ${escapeHtml(shortRef(observation.ref))}`,
          secondary: formatInstant(observation.time),
        })),
      });
    } else {
      rows.push(['Pushed by', `@${escapeHtml(actorLogin(observations[0]?.actorId ?? node.actorId))}`]);
      rows.push(['Ref', escapeHtml(vmap.ref || '—'), 'mono']);
      rows.push(['Push', escapeHtml(vmap.push_id ?? '—'), 'mono']);
    }

    rows.push(['Message', escapeHtml(message.length > 72 ? `${message.slice(0, 72)}…` : message)]);

    return {
      accent: COLORS.commit,
      shape: 'square',
      kicker: 'Commit',
      title: `${escapeHtml(String(vmap.commit_sha || node.object.label).slice(0, 10))}…`,
      rows,
      note: repeated
        ? 'Seen in more than one push — the same commit reaching another branch. The solid ' +
          'glyph is the first observation; the hollow markers are the rest. Pushers are ' +
          'GitHub accounts; the git author is not one and is never matched to one.'
        : 'Time = first observed in a PushEvent (not real git commit time). The git author ' +
          'is a commit string, not a GitHub account, and the two are never matched.',
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
  // The comment's own words (decision 124): the payload ships the first 500 characters
  // on the event's attrs, the card shows the opening lines and expands under the pointer.
  // Raw text here — `excerptHtml` in render/tooltip.js is the one place it is escaped.
  if (node.isComment && node.event?.attrs?.comment_excerpt) {
    rows.push({
      excerptText: node.event.attrs.comment_excerpt,
      truncated: Boolean(node.event.attrs.comment_truncated),
    });
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

/** `2 branches`, `1 branch`. */
function plural(n, singular, plural_) {
  return `${n} ${n === 1 ? singular : plural_}`;
}

/** `refs/heads/15-stable` → `15-stable`. The prefix is on every ref and says nothing. */
function shortRef(ref) {
  if (!ref) return '—';
  return String(ref).replace(/^refs\/(heads|tags)\//, '');
}

function curve(a, b) {
  const midX = (a.x + b.x) / 2;
  return `M${a.x},${a.y} C ${midX},${a.y} ${midX},${b.y} ${b.x},${b.y}`;
}
