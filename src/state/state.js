/**
 * View state.
 *
 * One mutable object, as in the mockup — but the fields that hardcoded a single
 * issue, a single PR and a single burst are now collections.
 *
 * Notable generalizations:
 *   `collapsed: true`        → `expandedBursts: Set`, so N bursts fold independently
 *   `relOpen.inferred`       → `relOpen.extracted` (decision 7)
 *   relationship pair toggles are derived from the links actually present rather
 *   than enumerated as four fixed combinations
 */

import { DEFAULT_BURST_THRESHOLD } from '../model/bursts.js';
import { EVIDENCE } from '../model/evidence.js';
import { LANE_TYPES, TYPE_LABELS } from './labels.js';

export const MIN_ZOOM = 0.55;
export const MAX_ZOOM = 14;

export function createState() {
  return {
    /** Horizontal zoom multiplier. */
    k: 1,
    /** Active time scale: real | highlights | ordinal. */
    mode: 'real',
    /** Focused object id, or null. Client-side highlighting only. */
    focus: null,
    /** BFS depth from the focused object. Capped at 2 by the graph model. */
    focusDegree: 1,
    /** Actor ids whose trails are drawn. */
    actors: new Set(),
    /** Lane visibility. */
    tracks: { issue: true, pull_request: true, commit: true },
    /** Comment visibility, per lane. */
    showComments: { issue: true, pull_request: true },
    /** Sidebar sub-row expansion, per lane. */
    trackOpen: { issue: false, pull_request: false, commit: false },
    /** Link visibility, keyed by evidence × object-type pair. Filled on load. */
    relPairs: {},
    /** Sidebar group expansion, per evidence class. */
    relOpen: { validated: false, extracted: false },
    /** Burst ids the user has unfolded. Empty means every burst is collapsed. */
    expandedBursts: new Set(),
    /** Highlight-mode group keys the user has unfolded. */
    expandedGroups: new Set(),
    /** Collapse a push above this many commits (decision 6). */
    burstThreshold: DEFAULT_BURST_THRESHOLD,
  };
}

/** Stable key for a link's toggle: evidence class plus its sorted type pair. */
export function linkPairKey(link, byId) {
  const source = byId.get(link.source);
  const target = byId.get(link.target);
  if (!source || !target) return null;
  const types = [source.type, target.type].sort().join('_');
  return `${link.evidence}_${types}`;
}

/**
 * Derive the relationship toggle groups from the links actually present.
 *
 * The mockup enumerated exactly four evidence × type-pair combinations, which is
 * correct only for this one sub-log. A sub-log with, say, commit↔issue validated
 * links would have had no toggle for them at all.
 */
export function deriveRelGroups(links, byId) {
  const seen = new Map();

  for (const link of links) {
    if (link.qualifier === 'actor') continue;
    const key = linkPairKey(link, byId);
    if (!key || seen.has(key)) continue;

    const source = byId.get(link.source);
    const target = byId.get(link.target);
    const types = [source.type, target.type].sort();

    seen.set(key, {
      key,
      evidence: link.evidence,
      types,
      label: types.map((t) => TYPE_LABELS[t] || t).join(' ↔ '),
    });
  }

  const groups = [
    { key: EVIDENCE.VALIDATED, label: 'Validated links', pairs: [] },
    { key: EVIDENCE.EXTRACTED, label: 'Extracted links', pairs: [] },
  ];
  for (const pair of seen.values()) {
    const group = groups.find((g) => g.key === pair.evidence);
    if (group) group.pairs.push(pair);
  }
  for (const group of groups) {
    group.pairs.sort((a, b) => a.label.localeCompare(b.label));
  }
  return groups.filter((group) => group.pairs.length > 0);
}

/** Turn every derived pair toggle on. Called whenever a new sub-log loads. */
export function resetRelPairs(state, relGroups) {
  state.relPairs = {};
  for (const group of relGroups) {
    for (const pair of group.pairs) state.relPairs[pair.key] = true;
  }
  return state;
}

export { LANE_TYPES };
