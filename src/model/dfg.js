/**
 * DFG payload validation and normalization.
 *
 * The whole-log directly-follows graph is the second payload this tool consumes, beside
 * the `SubLog` payload; its contract is in `docs/DATA_LAYER.md`. The same bargain as
 * `subLog.js`: fail loudly on a malformed bundle rather than letting a bad count
 * surface later as a wrong picture, and collect every problem rather than the first.
 *
 * A DFG carries counts, not instants and not traceability links, so two things that look
 * like omissions are deliberate:
 *   - `normalizeDfg` turns `meta.generated_at` into a `Date` and does nothing else. There
 *     is nothing else to parse; do not "fix" its emptiness.
 *   - An edge must NOT carry a bare `evidence` field. A succession is an observation,
 *     not a traceability claim, and dressing it in the link vocabulary would assert a
 *     classification the artifact does not have. What a CROSS succession does carry,
 *     `link_`-prefixed, is the class of the link it rides on (qualifier, evidence,
 *     method — one class per row, since no linked pair holds two links); the prefix is
 *     the statement that the classification belongs to the link. The validator enforces
 *     the prefix in both directions.
 *
 * There is no case notion here: succession is counted per object, and across
 * objects only through links (`cross_edges`, whose counts are floors).
 */

import { LANE_TYPES, ACTIVITIES, READING_ORDER, isKnownActivity } from './activities.js';
import { EVIDENCE, isKnownMethod } from './evidence.js';

export const DFG_CONTRACT_VERSION = 3;

const LANE_TYPE_SET = new Set(LANE_TYPES);

/** A count field: present, an integer, not negative. */
function badCount(value) {
  return !Number.isInteger(value) || value < 0;
}

function checkActivityOnType(problems, where, activity, type) {
  if (!isKnownActivity(activity)) {
    problems.push(`${where} has unknown activity "${activity}"`);
    return;
  }
  if (!ACTIVITIES[activity].objectTypes.includes(type)) {
    problems.push(`${where} puts "${activity}" on "${type}", which that activity never occurs on`);
  }
}

/**
 * Validate a raw DFG bundle. Returns an array of problems; empty means valid.
 */
export function findDfgProblems(dfg) {
  const problems = [];

  if (!dfg || typeof dfg !== 'object') return ['bundle is not an object'];
  for (const key of ['meta', 'nodes', 'edges', 'cross_edges']) {
    if (!(key in dfg)) problems.push(`bundle is missing "${key}"`);
  }
  if (problems.length) return problems;

  if (dfg.meta.dfg_contract_version !== DFG_CONTRACT_VERSION) {
    problems.push(
      `dfg_contract_version is ${dfg.meta.dfg_contract_version}; this consumer understands ` +
        `${DFG_CONTRACT_VERSION}`,
    );
  }
  for (const key of ['nodes', 'edges', 'cross_edges']) {
    if (!Array.isArray(dfg[key])) problems.push(`"${key}" is not an array`);
  }
  if (problems.length) return problems;

  for (const node of dfg.nodes) {
    const where = `node ${node.object_type}/${node.activity}`;
    if (!LANE_TYPE_SET.has(node.object_type)) {
      problems.push(`${where} has object_type "${node.object_type}"; the lanes are ${LANE_TYPES.join(', ')}`);
    } else {
      checkActivityOnType(problems, where, node.activity, node.object_type);
    }
    for (const field of ['events', 'occurrences', 'objects', 'starts', 'ends']) {
      if (badCount(node[field])) problems.push(`${where} has a bad ${field} count`);
    }
    // An occurrence is one event–object pair, so an event with no object is not here at
    // all and every event counted has at least one occurrence. Below-equal only on Push.
    if (!badCount(node.events) && !badCount(node.occurrences) && node.events > node.occurrences) {
      problems.push(
        `${where} has ${node.events} events but ${node.occurrences} occurrences; every ` +
          `event relates to at least one object`,
      );
    }
  }

  for (const edge of dfg.edges) {
    const where = `edge ${edge.object_type}: ${edge.from_activity}→${edge.to_activity}`;
    if (!LANE_TYPE_SET.has(edge.object_type)) {
      problems.push(`${where} has object_type "${edge.object_type}"`);
    } else {
      checkActivityOnType(problems, where, edge.from_activity, edge.object_type);
      checkActivityOnType(problems, where, edge.to_activity, edge.object_type);
    }
    for (const field of ['successions', 'objects']) {
      if (badCount(edge[field])) problems.push(`${where} has a bad ${field} count`);
    }
    if ('evidence' in edge) {
      problems.push(`${where} carries "evidence"; a succession is not a traceability link`);
    }
    for (const field of ['link_qualifier', 'link_evidence', 'link_method']) {
      if (field in edge) {
        problems.push(`${where} carries "${field}"; a per-type succession rides no link`);
      }
    }
  }

  for (const edge of dfg.cross_edges) {
    const where = `cross edge ${edge.from_type}/${edge.from_activity}→${edge.to_type}/${edge.to_activity}`;
    for (const [end, type] of [['from_type', edge.from_type], ['to_type', edge.to_type]]) {
      if (!LANE_TYPE_SET.has(type)) problems.push(`${where} has ${end} "${type}"`);
    }
    if (LANE_TYPE_SET.has(edge.from_type)) {
      checkActivityOnType(problems, where, edge.from_activity, edge.from_type);
    }
    if (LANE_TYPE_SET.has(edge.to_type)) {
      checkActivityOnType(problems, where, edge.to_activity, edge.to_type);
    }
    if (edge.from_type === edge.to_type) {
      // Links join objects of different types by construction; a same-type cross edge
      // means the derivation bled a per-object succession into the cross set.
      problems.push(`${where} joins two objects of the same type`);
    }
    for (const field of ['successions', 'pairs']) {
      if (badCount(edge[field])) problems.push(`${where} has a bad ${field} count`);
    }
    /*
     * The prefix rule, enforced both ways: a cross succession CARRIES its link's
     * classification (`link_*`, one class per row, since no pair holds two links),
     * but never wears the bare names — those would claim the succession itself is
     * validated or extracted, which no observation is.
     */
    for (const bare of ['evidence', 'qualifier', 'method']) {
      if (bare in edge) {
        problems.push(
          `${where} carries "${bare}"; the link's class is link_${bare}, and a ` +
            `succession itself has none`,
        );
      }
    }
    if (typeof edge.link_qualifier !== 'string' || !edge.link_qualifier) {
      problems.push(`${where} has no link_qualifier`);
    }
    if (!Object.values(EVIDENCE).includes(edge.link_evidence)) {
      problems.push(
        `${where} has link_evidence "${edge.link_evidence}"; the only classes are ` +
          `validated and extracted`,
      );
    }
    if (!isKnownMethod(edge.link_method)) {
      problems.push(`${where} has unknown link_method "${edge.link_method}"`);
    }
  }

  /*
   * Per-type conservation, which holds for any honestly-counted payload: every object
   * contributes exactly one start and one end, and every occurrence that is not a
   * sequence start follows something. In OCCURRENCES, not events: a push of n commits
   * sits in n sequences, once each. A payload that breaks this is not merely unusual
   * data — the counting itself went wrong.
   */
  for (const type of LANE_TYPES) {
    const nodes = dfg.nodes.filter((n) => n.object_type === type);
    if (!nodes.length) continue;
    const occurrences = nodes.reduce((s, n) => s + n.occurrences, 0);
    const starts = nodes.reduce((s, n) => s + n.starts, 0);
    const ends = nodes.reduce((s, n) => s + n.ends, 0);
    const successions = dfg.edges
      .filter((e) => e.object_type === type)
      .reduce((s, e) => s + e.successions, 0);
    if (starts !== ends) {
      problems.push(`${type}: ${starts} sequence starts but ${ends} ends`);
    }
    if (successions !== occurrences - starts) {
      problems.push(
        `${type}: ${successions} successions but ${occurrences} occurrences over ${starts} ` +
          `sequences demand ${occurrences - starts}`,
      );
    }
  }

  return problems;
}

export function assertValidDfg(dfg) {
  const problems = findDfgProblems(dfg);
  if (problems.length) {
    throw new Error(
      `Malformed DFG (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
  }
  return dfg;
}

/** The stable key for a cross-type pair, types sorted — the `linkPairKey` convention. */
export function dfgPairKey(typeA, typeB) {
  return [typeA, typeB].sort().join('_');
}

/**
 * Fold the per-class cross rows back into ONE arrow per directed edge, keeping the
 * classes as `members` for the hovercard's breakdown. Sums are exact: no linked pair
 * carries two links (asserted by the dfg-check gate), so members of one arrow never
 * share a pair. Members sort by weight, then class keys, so the breakdown is
 * deterministic whatever order the rows arrived in.
 */
export function aggregateCrossEdges(crossEdges) {
  const byArrow = new Map();
  for (const edge of crossEdges) {
    const key = `${edge.from_type}/${edge.from_activity}|${edge.to_type}/${edge.to_activity}`;
    if (!byArrow.has(key)) {
      byArrow.set(key, {
        from_type: edge.from_type,
        from_activity: edge.from_activity,
        to_type: edge.to_type,
        to_activity: edge.to_activity,
        successions: 0,
        pairs: 0,
        members: [],
      });
    }
    const arrow = byArrow.get(key);
    arrow.successions += edge.successions;
    arrow.pairs += edge.pairs;
    arrow.members.push(edge);
  }
  for (const arrow of byArrow.values()) {
    arrow.members.sort(
      (a, b) =>
        b.successions - a.successions ||
        `${a.link_qualifier}/${a.link_evidence}/${a.link_method}`.localeCompare(
          `${b.link_qualifier}/${b.link_evidence}/${b.link_method}`,
        ),
    );
  }
  return [...byArrow.values()];
}

/**
 * The Process page's toggle vocabulary, derived from the loaded artifact the way the
 * sub-log sidebar derives its rows from the loaded graph — never from a fixed list.
 *
 * `defaultRange` starts the count slider with the bottom decile of edges hidden: the
 * p10 boundary over every edge count, and the smallest count on a bundle too small for
 * a decile to mean anything (the default then hides nothing).
 */
export function deriveDfgToggles(dfg) {
  const lanes = LANE_TYPES.filter((type) => dfg.nodes.some((n) => n.object_type === type)).map(
    (type) => ({ type, edges: dfg.edges.filter((e) => e.object_type === type).length }),
  );

  const byPair = new Map();
  for (const edge of dfg.cross_edges) {
    const key = dfgPairKey(edge.from_type, edge.to_type);
    if (!byPair.has(key)) {
      byPair.set(key, { key, types: [edge.from_type, edge.to_type].sort(), successions: 0 });
    }
    byPair.get(key).successions += edge.successions;
  }
  const pairs = [...byPair.values()].sort((a, b) => a.key.localeCompare(b.key));

  const activities = [];
  for (const { type } of lanes) {
    for (const activity of READING_ORDER) {
      const node = dfg.nodes.find((n) => n.object_type === type && n.activity === activity);
      if (node) activities.push({ type, activity, events: node.events });
    }
  }

  // The three link-class vocabularies, each row a summed succession count — the
  // deriveQualifiers shape, over what the artifact actually carries.
  const classGroup = (field) => {
    const byValue = new Map();
    for (const edge of dfg.cross_edges) {
      const value = edge[field];
      byValue.set(value, (byValue.get(value) ?? 0) + edge.successions);
    }
    return [...byValue.entries()]
      .map(([key, successions]) => ({ key, successions }))
      .sort((a, b) => a.key.localeCompare(b.key));
  };
  const linkEvidence = classGroup('link_evidence');
  const linkQualifiers = classGroup('link_qualifier');
  const linkMethods = classGroup('link_method');

  // The range and the width scale live in ARROW units: the raw cross rows are per link
  // class, but what is drawn, sized and sliced by count is the aggregate arrow.
  const arrows = aggregateCrossEdges(dfg.cross_edges);
  const counts = [...dfg.edges, ...arrows].map((e) => e.successions);
  const maxSuccessions = counts.length ? Math.max(...counts) : 0;
  const sorted = [...counts].sort((a, b) => a - b);
  const defaultRange = counts.length
    ? [sorted[Math.floor(0.1 * sorted.length)], maxSuccessions]
    : [1, 1];

  return {
    lanes,
    pairs,
    activities,
    linkEvidence,
    linkQualifiers,
    linkMethods,
    crossArrows: arrows.length,
    maxSuccessions,
    defaultRange,
  };
}

/**
 * Filter the artifact by the page's view, BEFORE layout — the sub-log's own rule, so
 * hiding something re-spreads what remains and an emptied lane collapses.
 *
 * A lane switched off removes its edges but keeps its nodes (the lane's shape stays as
 * context); a hidden activity removes its node and every succession touching it. Cross
 * rows run a three-stage pipeline: the toggles (lane, pair, activity, AND the three
 * link-class maps) filter the per-class rows, `aggregateCrossEdges` folds the survivors
 * into one arrow each, and the count range then applies to each ARROW's total — the
 * slider filters what is drawn, and what is drawn is aggregates.
 *
 * The counts are the readout's, in DRAWN-ARROW units: `shown + hiddenByRange +
 * hiddenByToggles` always equals `total`, an arrow whose every class is toggled off
 * counting once under toggles, and a partially filtered arrow counting as shown (its
 * lower count is the hovercard's story). The returned `cross_edges` are the aggregates,
 * members attached.
 */
export function filterDfg(dfg, view = {}) {
  const laneOn = (type) => view.lanes?.[type] !== false;
  const hidden = view.hiddenActivities ?? new Set();
  const nodeOn = (type, activity) => !hidden.has(`${type}/${activity}`);
  const [min, max] = view.range ?? [-Infinity, Infinity];
  const inRange = (edge) => edge.successions >= min && edge.successions <= max;

  let hiddenByToggles = 0;
  let hiddenByRange = 0;

  const edges = dfg.edges.filter((edge) => {
    const togglePass =
      laneOn(edge.object_type) &&
      nodeOn(edge.object_type, edge.from_activity) &&
      nodeOn(edge.object_type, edge.to_activity);
    if (!togglePass) {
      hiddenByToggles += 1;
      return false;
    }
    if (!inRange(edge)) {
      hiddenByRange += 1;
      return false;
    }
    return true;
  });

  // Stage 1: the toggles, per class row.
  const survivingRows = dfg.cross_edges.filter(
    (edge) =>
      laneOn(edge.from_type) &&
      laneOn(edge.to_type) &&
      view.pairs?.[dfgPairKey(edge.from_type, edge.to_type)] !== false &&
      nodeOn(edge.from_type, edge.from_activity) &&
      nodeOn(edge.to_type, edge.to_activity) &&
      view.linkEvidence?.[edge.link_evidence] !== false &&
      view.linkQualifiers?.[edge.link_qualifier] !== false &&
      view.linkMethods?.[edge.link_method] !== false,
  );
  // Stages 2 and 3: aggregate, then range the aggregates.
  const survivingArrows = aggregateCrossEdges(survivingRows);
  const crossEdges = survivingArrows.filter((arrow) => {
    if (!inRange(arrow)) {
      hiddenByRange += 1;
      return false;
    }
    return true;
  });
  hiddenByToggles += aggregateCrossEdges(dfg.cross_edges).length - survivingArrows.length;

  const total = dfg.edges.length + aggregateCrossEdges(dfg.cross_edges).length;
  return {
    dfg: {
      ...dfg,
      nodes: dfg.nodes.filter((n) => nodeOn(n.object_type, n.activity)),
      edges,
      cross_edges: crossEdges,
    },
    shown: edges.length + crossEdges.length,
    total,
    hiddenByRange,
    hiddenByToggles,
  };
}

/**
 * Which Process-page controls still govern a succession that could be drawn — the
 * Trace sidebar's `relControlAvailability`, for `filterDfg`'s toggles.
 *
 * A lane row is available while some per-type edge of that lane has both activities
 * shown. A pair row is available while both lanes are on and some cross row of the pair
 * passes the activity hides and the three class bags. A class row (evidence, qualifier,
 * method) is available while some cross row carrying that class passes the lanes, the
 * pair, the activity hides and the other two bags. As on the Trace page, only the
 * control's own bag is excluded, so a row switched off by hand can always be switched
 * back on. The count range is not a toggle and takes no part.
 *
 * @returns {{lanes: Set<string>, pairs: Set<string>, linkEvidence: Set<string>,
 *   linkQualifiers: Set<string>, linkMethods: Set<string>}}
 */
export function dfgControlAvailability(dfg, view = {}) {
  const laneOn = (type) => view.lanes?.[type] !== false;
  const hidden = view.hiddenActivities ?? new Set();
  const nodeOn = (type, activity) => !hidden.has(`${type}/${activity}`);
  const on = (bag, key) => bag?.[key] !== false;

  const lanes = new Set();
  for (const edge of dfg.edges) {
    if (nodeOn(edge.object_type, edge.from_activity) && nodeOn(edge.object_type, edge.to_activity)) {
      lanes.add(edge.object_type);
    }
  }

  const pairs = new Set();
  const linkEvidence = new Set();
  const linkQualifiers = new Set();
  const linkMethods = new Set();
  for (const edge of dfg.cross_edges) {
    if (!laneOn(edge.from_type) || !laneOn(edge.to_type)) continue;
    if (!nodeOn(edge.from_type, edge.from_activity) || !nodeOn(edge.to_type, edge.to_activity)) continue;
    const pairKey = dfgPairKey(edge.from_type, edge.to_type);
    const pairOn = on(view.pairs, pairKey);
    const evidenceOn = on(view.linkEvidence, edge.link_evidence);
    const qualifierOn = on(view.linkQualifiers, edge.link_qualifier);
    const methodOn = on(view.linkMethods, edge.link_method);
    if (evidenceOn && qualifierOn && methodOn) pairs.add(pairKey);
    if (pairOn && qualifierOn && methodOn) linkEvidence.add(edge.link_evidence);
    if (pairOn && evidenceOn && methodOn) linkQualifiers.add(edge.link_qualifier);
    if (pairOn && evidenceOn && qualifierOn) linkMethods.add(edge.link_method);
  }
  return { lanes, pairs, linkEvidence, linkQualifiers, linkMethods };
}

/**
 * The count slider's scale: logarithmic, because succession counts span five orders of
 * magnitude and a linear slider would spend nearly all its travel on the top decade.
 * Edge counts are ≥ 1 by construction (an edge exists because a succession was
 * observed), so the [1, max] domain loses nothing. Shared by the slider and the
 * readout, so the label always names the exact count the filter uses.
 */
export function dfgRangeScale(maxSuccessions) {
  const usable = maxSuccessions > 1;
  return {
    countAt(fraction) {
      if (!usable) return 1;
      const f = Math.min(1, Math.max(0, fraction));
      return Math.min(maxSuccessions, Math.max(1, Math.round(Math.exp(f * Math.log(maxSuccessions)))));
    },
    fractionOf(count) {
      if (!usable) return 0;
      const c = Math.min(maxSuccessions, Math.max(1, count));
      return Math.log(c) / Math.log(maxSuccessions);
    },
  };
}

/**
 * Parse the one timestamp, into a copy. The input is never mutated (it may be a shared
 * sample); everything else in a DFG is a count and needs no parsing — see the header.
 */
export function normalizeDfg(dfg) {
  return {
    ...dfg,
    meta: {
      ...dfg.meta,
      generated_at: dfg.meta.generated_at ? new Date(dfg.meta.generated_at) : null,
    },
  };
}
