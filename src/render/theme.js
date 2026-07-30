/**
 * Visual encoding: the colours, shapes and glyphs shared by the nodes, links,
 * legend, minimap and tooltip.
 *
 * Colours come from the Nocturne design tokens (`var(--…)`) wherever a token
 * carries the right role. The PR, commit and extracted-link hues have no token, so
 * they are stated in OKLCH on the same perceptual lightness as the accent ramp —
 * see the readme in the `_ds/nocturne-<id>` folder. Do not restyle away from the tokens.
 */

export const COLORS = {
  issue: 'var(--color-accent)',
  pull_request: 'oklch(78% 0.11 68)',
  commit: 'oklch(76% 0.09 205)',
  /** Reserved for extracted links and the "?" badge. */
  extracted: 'oklch(78% 0.13 45)',
};

/** Per-lane visual encoding. Only lane-bearing types appear here (decision 15). */
export const TYPE = {
  issue: { color: COLORS.issue, label: 'Issue', shape: 'circle' },
  pull_request: { color: COLORS.pull_request, label: 'Pull request', shape: 'diamond' },
  commit: { color: COLORS.commit, label: 'Commit / push', shape: 'square' },
};

/**
 * Link qualifier colours. The link gradient runs from the source object's type
 * colour to its qualifier colour, so an edge reads as "from this kind of thing,
 * standing in this relation".
 */
export const QUALIFIER = {
  related_issue: { color: COLORS.issue, label: 'related_issue' },
  referenced_pull_request: { color: COLORS.pull_request, label: 'referenced_pull_request' },
  referenced_issue: { color: COLORS.extracted, label: 'referenced_issue' },
};

/**
 * Per-object shades within a type's hue.
 *
 * When a lane holds several objects, hue alone no longer identifies anything: two
 * PRs are both orange, so a link arriving in the PR lane does not say *which* PR it
 * reaches. Shade supplies that missing channel — hue still reads as the object
 * type, lightness and chroma separate the individuals.
 *
 * **Index 0 is exactly the type's base colour**, deliberately. A sub-log with one
 * issue and one PR therefore renders identically to before this existed, which is
 * what keeps the F1 regression baseline valid.
 *
 * Later shades are stated in OKLCH on the same perceptual lightness scale the
 * design system uses, staying inside each role's hue family and inside the light
 * range that reads on the dark ground (see the Nocturne readme). The issue family
 * cannot be derived from `var(--color-accent)` at runtime, so its variants are
 * pinned to the accent's own blurple; if the theme's accent hue ever moves, index 0
 * follows it and the rest need re-picking.
 */
const OBJECT_SHADES = {
  // Ordered by distance from the base, not by hue: index 1 is the *most* separable
  // shade, because two objects in a lane is by far the commonest case and those two
  // need to be told apart at a glance. Orange versus gold does that; two adjacent
  // oranges do not.
  pull_request: [
    COLORS.pull_request, // base orange
    'oklch(88% 0.12 101)', // gold — maximum separation from the base
    'oklch(67% 0.14 38)', // deep red-orange
    'oklch(79% 0.16 85)', // saturated amber
    'oklch(72% 0.07 58)', // muted brown-orange
    'oklch(84% 0.09 120)', // pale yellow-green edge of the family
  ],
  issue: [
    COLORS.issue, // the accent token itself
    'oklch(78% 0.13 330)', // pink-lilac — maximum separation from the accent
    'oklch(58% 0.15 268)', // deep indigo
    'oklch(84% 0.08 300)', // pale lilac
    'oklch(66% 0.17 305)', // saturated violet
    'oklch(72% 0.06 282)', // muted periwinkle
  ],
  // Commits are one node each rather than spans, so they never need separating
  // from a sibling in the same lane.
  commit: [COLORS.commit],
};

/**
 * The colour for a specific object.
 *
 * `index` is the object's stable position among the objects of its lane, so the
 * same object keeps the same shade across renders and across time modes.
 */
export function objectShade(objectType, index = 0) {
  const shades = OBJECT_SHADES[objectType];
  if (!shades) return typeColor(objectType);
  return shades[index % shades.length];
}

/** How many distinct shades a type can show before the palette repeats. */
export function shadeCount(objectType) {
  return (OBJECT_SHADES[objectType] || [null]).length;
}

/** Actor trail palette, assigned by index. */
export const ACTOR_PALETTE = [
  'oklch(74% 0.12 150)',
  'oklch(74% 0.11 235)',
  'oklch(74% 0.13 25)',
  'oklch(74% 0.12 340)',
  'oklch(74% 0.10 170)',
  'oklch(74% 0.10 110)',
];

export function actorColor(index) {
  return ACTOR_PALETTE[index % ACTOR_PALETTE.length];
}

export function typeColor(objectType) {
  return TYPE[objectType]?.color || 'var(--color-neutral-400)';
}

export function qualifierColor(qualifier) {
  return QUALIFIER[qualifier]?.color || 'var(--color-neutral-400)';
}

/**
 * Stroke weight and dash pattern by evidence class — the visual answer to
 * shortcoming S8. Solid means the platform asserted it; dashed plus a "?" badge
 * means we parsed a convention nobody enforces.
 */
export const EVIDENCE_STYLE = {
  validated: { width: 2.6, dash: null, opacity: 1 },
  extracted: { width: 1.6, dash: '6 6', opacity: 0.7 },
};

export function evidenceStyle(evidence) {
  return EVIDENCE_STYLE[evidence] || EVIDENCE_STYLE.extracted;
}

/** Small inline SVG glyph, for the legend, tooltips and sidebar rows. */
export function glyph(shape, color) {
  if (shape === 'line') {
    return `<svg width="14" height="12"><line x1="0" y1="6" x2="14" y2="6" stroke="${color}" stroke-width="2.4"/></svg>`;
  }
  let inner;
  if (shape === 'circle') inner = `<circle cx="6" cy="6" r="5" fill="${color}"/>`;
  else if (shape === 'diamond') inner = `<path d="M6 1L11 6L6 11L1 6Z" fill="${color}"/>`;
  else inner = `<rect x="1" y="1" width="10" height="10" rx="2" fill="${color}"/>`;
  return `<svg width="12" height="12">${inner}</svg>`;
}

/** Draw a node glyph into an SVG group. */
export function drawSymbol(group, shape, size, fill, stroke, strokeWidth) {
  let element;
  if (shape === 'circle') {
    element = group.append('circle').attr('r', size);
  } else if (shape === 'diamond') {
    const s = size * 1.2;
    element = group.append('path').attr('d', `M0 ${-s}L ${s} 0 L 0 ${s} L ${-s} 0 Z`);
  } else {
    element = group
      .append('rect')
      .attr('x', -size)
      .attr('y', -size)
      .attr('width', 2 * size)
      .attr('height', 2 * size)
      .attr('rx', 2);
  }
  return element
    .attr('fill', fill)
    .attr('stroke', stroke)
    .attr('stroke-width', strokeWidth == null ? 2 : strokeWidth);
}
