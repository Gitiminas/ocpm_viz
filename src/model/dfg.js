/**
 * DFG payload validation and normalization.
 *
 * The whole-log directly-follows graph is the second payload this tool consumes, beside
 * the `ObjectGraph` sub-log; its contract is in `docs/DATA_LAYER.md`. The same bargain as
 * `objectGraph.js`: fail loudly on a malformed bundle rather than letting a bad count
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

export const DFG_CONTRACT_VERSION = 2;

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
    for (const field of ['events', 'objects', 'starts', 'ends']) {
      if (badCount(node[field])) problems.push(`${where} has a bad ${field} count`);
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
   * contributes exactly one start and one end, and every event that is not a sequence
   * start follows something. A payload that breaks this is not merely unusual data —
   * the counting itself went wrong.
   */
  for (const type of LANE_TYPES) {
    const nodes = dfg.nodes.filter((n) => n.object_type === type);
    if (!nodes.length) continue;
    const events = nodes.reduce((s, n) => s + n.events, 0);
    const starts = nodes.reduce((s, n) => s + n.starts, 0);
    const ends = nodes.reduce((s, n) => s + n.ends, 0);
    const successions = dfg.edges
      .filter((e) => e.object_type === type)
      .reduce((s, e) => s + e.successions, 0);
    if (starts !== ends) {
      problems.push(`${type}: ${starts} sequence starts but ${ends} ends`);
    }
    if (successions !== events - starts) {
      problems.push(
        `${type}: ${successions} successions but ${events} events over ${starts} sequences ` +
          `demand ${events - starts}`,
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

  const counts = [...dfg.edges, ...dfg.cross_edges].map((e) => e.successions);
  const maxSuccessions = counts.length ? Math.max(...counts) : 0;
  const sorted = [...counts].sort((a, b) => a - b);
  const defaultRange = counts.length
    ? [sorted[Math.floor(0.1 * sorted.length)], maxSuccessions]
    : [1, 1];

  return { lanes, pairs, activities, maxSuccessions, defaultRange };
}

/**
 * Filter the artifact by the page's view, BEFORE layout — the sub-log's own rule, so
 * hiding something re-spreads what remains and an emptied lane collapses.
 *
 * A lane switched off removes its edges but keeps its nodes (the lane's shape stays as
 * context); a hidden activity removes its node and every succession touching it. The
 * counts returned are the readout's: `shown + hiddenByRange + hiddenByToggles` always
 * equals `total`, an edge failing both filters counting once, under toggles.
 */
export function filterDfg(dfg, view = {}) {
  const laneOn = (type) => view.lanes?.[type] !== false;
  const hidden = view.hiddenActivities ?? new Set();
  const nodeOn = (type, activity) => !hidden.has(`${type}/${activity}`);
  const [min, max] = view.range ?? [-Infinity, Infinity];

  let hiddenByToggles = 0;
  let hiddenByRange = 0;
  const keep = (edge, togglePass) => {
    if (!togglePass) {
      hiddenByToggles += 1;
      return false;
    }
    if (edge.successions < min || edge.successions > max) {
      hiddenByRange += 1;
      return false;
    }
    return true;
  };

  const edges = dfg.edges.filter((edge) =>
    keep(
      edge,
      laneOn(edge.object_type) &&
        nodeOn(edge.object_type, edge.from_activity) &&
        nodeOn(edge.object_type, edge.to_activity),
    ),
  );
  const crossEdges = dfg.cross_edges.filter((edge) =>
    keep(
      edge,
      laneOn(edge.from_type) &&
        laneOn(edge.to_type) &&
        view.pairs?.[dfgPairKey(edge.from_type, edge.to_type)] !== false &&
        nodeOn(edge.from_type, edge.from_activity) &&
        nodeOn(edge.to_type, edge.to_activity),
    ),
  );

  const total = dfg.edges.length + dfg.cross_edges.length;
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
