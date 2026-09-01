/**
 * `loadDfg(query, { transport }) -> DFG` — the data entry point for the whole-log
 * directly-follows graph, the second of the tool's two payloads.
 *
 * The same three steps as `loadObjectGraph`, in the same order and for the same reason:
 * the transport fetches, the validator runs on the RAW bundle so errors quote what
 * actually arrived, and normalization parses on a copy. The query is attached to `meta`
 * for reproducibility; it is not an identity — there is no case notion.
 *
 * No default transport, deliberately: a sub-log defaults to fixtures because the app
 * must start without a database, but which DFG transport applies is the source's call
 * (`data/source.js`), and a silent default here would let a caller load the sample
 * while believing it queried the database.
 */

import { assertValidDfg, normalizeDfg } from '../model/dfg.js';

export async function loadDfg(query = {}, { transport } = {}) {
  if (typeof transport !== 'function') {
    throw new Error('loadDfg: a transport is required — the source decides which');
  }
  const raw = await transport(query);
  assertValidDfg(raw);
  const dfg = normalizeDfg(raw);
  dfg.meta = { ...dfg.meta, query };
  return dfg;
}
