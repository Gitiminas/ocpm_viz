/**
 * Object-to-object links: the traceability edges.
 *
 * Evidence is encoded in the stroke — solid for validated, dashed with a "?" badge
 * for extracted. That is the visual answer to shortcoming S8 and the reason most of
 * this sub-log now reads as uncertain: reclassifying branch-ref matches moved 29 of
 * 34 links from solid to dashed. That is the honest result.
 *
 * Collapsed bursts complicate this. Twenty commits folded into one node would draw
 * twenty near-identical edges to the same PR, so links from folded commits are
 * aggregated onto their burst and drawn once.
 */

import { escapeHtml } from './format.js';
import { qualifierColor, typeColor, evidenceStyle, COLORS } from './theme.js';
import { isLinkVisible } from '../state/state.js';

function evidenceBadge(evidence) {
  const color = evidence === 'validated' ? 'var(--color-accent-300)' : COLORS.extracted;
  return (
    `<span class="badge" style="background:var(--color-neutral-900);color:${color};` +
    `border-color:transparent">${evidence}</span>`
  );
}

/**
 * Resolve an object id to what is actually on screen: a folded commit renders as
 * its burst, everything else as itself.
 */
function makeAnchorResolver(burstsByCommit, expandedBursts) {
  return (objectId) => {
    const burst = burstsByCommit.get(objectId);
    if (burst && !expandedBursts.has(burst.id)) return { id: burst.id, folded: true, burst };
    return { id: objectId, folded: false };
  };
}

/**
 * Lateral separation between links that would otherwise be drawn on top of one
 * another. Small enough to stay within the source glyph, large enough to read.
 */
const LINK_SPREAD_PX = 5;

/**
 * How many coincident links are worth separating before a count says it better.
 *
 * Six is where a fan still reads as distinct lines at LINK_SPREAD_PX (30px total) and
 * beyond which the shared endpoint starts to look like several objects rather than one.
 */
const MAX_FANNED_LINKS = 6;
/** Target x values closer than this are treated as the same column. */
const SAME_COLUMN_PX = 2;

/**
 * Fan links that leave the same node and arrive in the same column.
 *
 * This is not cosmetic. A commit inside two overlapping PRs' spans produces two
 * *straight vertical* links at the identical x; the one reaching the nearer band is
 * a strict sub-segment of the one reaching the farther band, so it is completely
 * hidden. In F5 the buried link was the extracted one — meaning the dashed line and
 * its "?" badge, the uncertainty cue this tool exists to show, disappeared under a
 * solid line.
 *
 * Only links that actually coincide are spread, so a source whose links already
 * diverge is left exactly where it was.
 *
 * @returns {Map<object, number>} link → lateral offset in px
 */
function computeLinkOffsets(entries) {
  const offsets = new Map();
  const bundles = new Map();

  /*
   * ⚠️ **Coincidence is bundled from BOTH ends, because either can be the shared one.**
   *
   * The first version keyed only on the source, which was right while the fixtures
   * stored commit→PR: several links leaving one commit for PRs in the same column. The
   * database stores that same relationship the other way — `contains_commit` is PR →
   * commit — so F5's case became several links *arriving* at one commit from PRs, with
   * different sources and one shared target. Same picture, same buried link, and the
   * source-only key stopped seeing it entirely.
   *
   * A link can land in both bundles; the first to claim it wins, which is enough because
   * an offset only has to make it distinguishable from the ones it coincides with.
   */
  const add = (key, entry) => {
    if (!bundles.has(key)) bundles.set(key, []);
    bundles.get(key).push(entry);
  };

  for (const entry of entries) {
    const targetColumn = Math.round(entry.tx / SAME_COLUMN_PX);
    const sourceColumn = Math.round(entry.sx / SAME_COLUMN_PX);
    add(`from:${entry.sourceAnchor.id}|${targetColumn}`, entry);
    add(`into:${entry.targetAnchor.id}|${sourceColumn}`, entry);
  }

  const crowded = new Map();
  const claimed = new Set();

  for (const bundle of [...bundles.values()].sort((a, b) => b.length - a.length)) {
    const fresh = bundle.filter((entry) => !claimed.has(entry.link));
    if (fresh.length < 2) continue;
    for (const entry of fresh) claimed.add(entry.link);
    bundle.length = 0;
    bundle.push(...fresh);

    /*
     * ⚠️ **Past a point, fanning stops separating and starts lying.**
     *
     * The fan exists so a link hidden underneath another is still visible, and
     * it was designed against F5's two coincident links. It scales badly: a
     * pull request containing 35 commits pushed in the same hour puts 35
     * links in one bundle, and spreading them 5px apart smears the shared endpoint
     * across 175px. The lane caption then says *one* pull request while the picture
     * shows a wall of arrival points — which reads as many. That is a wrong picture
     * with no error, and it is worst exactly where a PR carries the most work.
     *
     * So beyond MAX_FANNED_LINKS the bundle is drawn coincident — one visible line —
     * and its size is declared with a count badge instead. That trades "you can see
     * each of the 85" for "you can see there are 85", which is the honest trade: at
     * 85 you could not see each of them anyway, and the commits themselves are all
     * drawn in the commit lane regardless. Declaring the count rather than silently
     * overlapping keeps the rule that anything hidden is declared.
     */
    if (bundle.length > MAX_FANNED_LINKS) {
      for (const entry of bundle) offsets.set(entry.link, 0);
      // The first entry carries the badge for the whole bundle.
      bundle.sort((a, b) => a.ty - b.ty);
      crowded.set(bundle[0].link, bundle.length);
      continue;
    }

    // Order by where each link is going, so the fan reads top-to-bottom rather
    // than in whatever order the links happened to arrive.
    bundle.sort((a, b) => a.ty - b.ty);
    bundle.forEach((entry, i) => {
      offsets.set(entry.link, (i - (bundle.length - 1) / 2) * LINK_SPREAD_PX);
    });
  }
  return { offsets, crowded };
}

export function renderLinks({
  gLink,
  defs,
  links,
  byId,
  anchors,
  state,
  focus,
  burstsByCommit,
  tooltip,
  objectColors = new Map(),
  groupsByCommit = new Map(),
}) {
  const resolve = makeAnchorResolver(burstsByCommit, state.expandedBursts);
  const drawn = new Set();

  // Every filter lives in one predicate in state.js, so a link's absence is always
  // attributable to a single named control.
  const visible = links.filter((link) => isLinkVisible(link, byId, state, groupsByCommit));

  // Resolve every endpoint first, so overlapping links can be detected and fanned
  // before any of them is drawn.
  const entries = [];
  for (const link of visible) {
    const source = byId.get(link.source);
    const target = byId.get(link.target);
    const sourceAnchor = resolve(link.source);
    const targetAnchor = resolve(link.target);
    const folded = sourceAnchor.folded || targetAnchor.folded;

    // When either end is folded, many links collapse onto the same visible pair.
    // Draw the first and let it represent the rest.
    const key = `${sourceAnchor.id}|${targetAnchor.id}|${link.qualifier}|${link.evidence}`;
    if (folded) {
      if (drawn.has(key)) continue;
      drawn.add(key);
    }

    const sx = anchors.x(sourceAnchor.id, source);
    const sy = anchors.y(sourceAnchor.id, source);
    const ty = anchors.y(targetAnchor.id, target);
    // Slide the target end along the target's lifecycle bar so the edge meets it at
    // the nearest point rather than always at its start.
    const tx = anchors.clampToLifecycle(targetAnchor.id, target, sx);

    entries.push({ link, source, target, sourceAnchor, targetAnchor, folded, sx, sy, tx, ty });
  }

  const { offsets, crowded } = computeLinkOffsets(entries);

  // Gradients are rebuilt every render because both endpoints move. One per drawn
  // link, keyed by the *anchored* endpoints so folded links share a gradient.
  defs.selectAll('*').remove();

  for (const entry of entries) {
    const { link, source, target, sourceAnchor, targetAnchor, folded, sy, ty } = entry;
    // Shift the whole line sideways rather than only one end, so fanned links stay
    // parallel instead of converging again at the top.
    const offset = offsets.get(link) || 0;
    const sx = entry.sx + offset;
    const tx = entry.tx + offset;

    const gradientId = `grad_${cssId(sourceAnchor.id)}_${cssId(targetAnchor.id)}_${link.qualifier}_${link.evidence}`;
    const gradient = defs
      .append('linearGradient')
      .attr('id', gradientId)
      .attr('gradientUnits', 'userSpaceOnUse')
      .attr('x1', sx)
      .attr('y1', sy)
      .attr('x2', tx)
      .attr('y2', ty);
    const targetColor = objectColors.get(target.id) || qualifierColor(link.qualifier);
    gradient
      .append('stop')
      .attr('offset', '0%')
      .attr('stop-color', objectColors.get(sourceAnchor.id) || typeColor(source.type));
    // The target's shade is reached at 45% rather than 100%, so most of the line
    // carries it. The far end is where links converge and overlap, so a colour that
    // only appears there is a colour you cannot use to trace a line back to its
    // object — which is the whole point of shading them.
    gradient.append('stop').attr('offset', '45%').attr('stop-color', targetColor);
    gradient.append('stop').attr('offset', '100%').attr('stop-color', targetColor);

    const isExtracted = link.evidence === 'extracted';
    const style = evidenceStyle(link.evidence);
    const inFocus =
      !focus ||
      (focus.has(link.source) && focus.has(link.target)) ||
      (sourceAnchor.folded && focus.has(sourceAnchor.id)) ||
      (targetAnchor.folded && focus.has(targetAnchor.id));

    const midY = (sy + ty) / 2;
    const path = `M${sx},${sy} C ${sx},${midY} ${tx},${midY} ${tx},${ty}`;

    const group = gLink.append('g').attr('opacity', inFocus ? style.opacity : 0.1);
    group
      .append('path')
      .attr('data-legend', isExtracted ? 'link-extracted' : 'link-validated')
      .attr('data-grad', `url(#${gradientId})`)
      .attr('d', path)
      .attr('fill', 'none')
      .attr('stroke', `url(#${gradientId})`)
      .attr('stroke-width', style.width)
      .attr('stroke-dasharray', style.dash);

    /*
     * A bundle too crowded to fan says how big it is. Drawn whether or not the link is
     * in focus and whatever its evidence class, because the count is a fact about the
     * data rather than an uncertainty cue.
     */
    const crowd = crowded.get(link);
    if (crowd) {
      const color = objectColors.get(target.id) || qualifierColor(link.qualifier);
      const label = `×${crowd}`;
      group
        .append('rect')
        .attr('data-legend', 'link-crowded')
        .attr('x', sx - 7 - label.length * 3.2)
        .attr('y', sy - 9)
        .attr('width', 14 + label.length * 6.4)
        .attr('height', 18)
        .attr('rx', 9)
        .attr('fill', 'var(--color-bg)')
        .attr('stroke', color)
        .attr('stroke-width', 1.5);
      group
        .append('text')
        .attr('x', sx)
        .attr('y', sy)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .attr('font-size', 10)
        .attr('font-weight', 700)
        .attr('fill', color)
        .attr('class', 'mono')
        .text(label);
    }

    /*
     * There is no "?" badge on an extracted link.
     *
     * It circled a question mark on top of a dashed stroke that already says the same
     * thing, so a dense sub-log paid one extra glyph per uncertain link to repeat a cue
     * the line carries on its own. The dash is the uncertainty cue, the
     * legend names it, and the tooltip still spells it out in words.
     */

    // A wide transparent path on top, so a 1.6px dashed line is still easy to hit.
    const buildSpec = () => ({
      accent: qualifierColor(link.qualifier),
      shape: 'line',
      kicker: `OCEL link · ${link.qualifier}`,
      title: `${escapeHtml(source.label || source.id)} &rarr; ${escapeHtml(target.label || target.id)}`,
      rows: [
        ['Evidence', evidenceBadge(link.evidence)],
        ['Method', escapeHtml(link.method || '—'), 'mono'],
        link.n_methods > 1 ? ['Methods agreeing', String(link.n_methods)] : null,
      ],
      note: folded
        ? 'Standing in for every folded commit’s link to this artifact. Expand the push to see them individually.'
        : '',
    });

    tooltip.bind(
      gLink
        .append('path')
        .attr('d', path)
        .attr('fill', 'none')
        .attr('stroke', '#000')
        .attr('stroke-opacity', 0)
        .attr('stroke-width', 16)
        .style('cursor', 'pointer'),
      buildSpec,
    );
  }
}

/** Ids contain characters like `:` and `/` that are not safe in a CSS selector. */
function cssId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}
