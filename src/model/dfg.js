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
 *   - An edge must NOT carry an `evidence` field. A succession is an observation, not a
 *     traceability claim, and dressing it in the link vocabulary would assert a
 *     classification the artifact does not have. The validator rejects it by name.
 *
 * There is no case notion here: succession is counted per object, and across
 * objects only through links (`cross_edges`, whose counts are floors).
 */

import { LANE_TYPES, ACTIVITIES, isKnownActivity } from './activities.js';

export const DFG_CONTRACT_VERSION = 1;

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
    if ('evidence' in edge) {
      problems.push(`${where} carries "evidence"; a succession is not a traceability link`);
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
