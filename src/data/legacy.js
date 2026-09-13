/**
 * Contract v2 → v3, for the migration only. Deleted once every fixture and the RPC
 * emit v3 natively (`docs/DATA_LAYER.md`, "The SubLog payload").
 *
 * A v2 event carries one `object_id` and an `actor_id` column, and a push arrives taken
 * apart into one `CommitObserved` per commit. A v3 event carries `relationships`
 * (OCEL 2.0 event-to-object), and a push is ONE `Push` event about every commit it
 * carried. The upgrade is a re-statement, not a derivation: every fact in the v2 bundle
 * is in the v3 one and nothing is invented — a push's attrs are the first member's
 * attrs verbatim, so a synthetic fixture whose observations carried `{}` yields a push
 * carrying `{}`.
 *
 * Grouping. Commit observations belong to one push when they share the push id, the
 * instant and the pusher. The id comes from `attrs.push_id`, else from the commit
 * object's `vmap.push_id` (the synthetic fixtures carry it there only), else the event
 * stands alone. The instant is in the key on purpose: F10 gives the commits of one push
 * different hours by construction, and re-timing them would move three hundred glyphs.
 * The push's id is `push:<PushEvent id>` where the v2 id was `commit_obs:<id>:<index>`
 * (the RPC's shape), else `push:<push_id>`, suffixed `:<k>` when one push id yields
 * several groups.
 */

import { actorRoleOf } from '../model/activities.js';

const OBS_ID = /^commit_obs:(\d+):\d+$/;

function isLegacy(raw) {
  if (raw?.meta?.contract_version === 3) return false;
  return Array.isArray(raw?.events) && raw.events.some((event) => 'object_id' in event);
}

function relationshipsOf(event) {
  const relationships = [{ object_id: event.object_id, qualifier: 'subject' }];
  if (event.actor_id) {
    relationships.push({ object_id: event.actor_id, qualifier: actorRoleOf(event.activity) });
  }
  return relationships;
}

function stripColumns(event) {
  const { object_id, actor_id, ...rest } = event;
  void object_id;
  void actor_id;
  return rest;
}

export function upgradeLegacyGraph(raw) {
  if (!isLegacy(raw)) return raw;

  const vmapPushId = new Map();
  for (const object of raw.objects ?? []) {
    if (object?.type === 'commit' && object.vmap?.push_id != null) {
      vmapPushId.set(object.id, object.vmap.push_id);
    }
  }

  const events = [];
  const groups = new Map(); // grouping key → push under construction
  const idsByPush = new Map(); // push_id → how many groups it has produced

  for (const event of raw.events) {
    if (event.activity !== 'CommitObserved') {
      events.push({ ...stripColumns(event), relationships: relationshipsOf(event) });
      continue;
    }
    const pushId = event.attrs?.push_id ?? vmapPushId.get(event.object_id) ?? null;
    const key = `${pushId ?? event.id}|${event.time}|${event.actor_id ?? ''}`;
    let push = groups.get(key);
    if (!push) {
      const fromObs = OBS_ID.exec(event.id);
      let id;
      if (fromObs) {
        id = `push:${fromObs[1]}`;
      } else if (pushId != null) {
        const k = idsByPush.get(pushId) ?? 0;
        idsByPush.set(pushId, k + 1);
        id = k === 0 ? `push:${pushId}` : `push:${pushId}:${k}`;
      } else {
        id = `push:${event.id}`;
      }
      push = {
        ...stripColumns(event),
        id,
        activity: 'Push',
        relationships: [],
      };
      groups.set(key, push);
      events.push(push);
    }
    push.relationships.push({ object_id: event.object_id, qualifier: 'pushed_commit' });
  }
  // The pusher after the commits: non-actor relationships first is the RPC's order.
  for (const event of raw.events) {
    if (event.activity !== 'CommitObserved' || !event.actor_id) continue;
    const pushId = event.attrs?.push_id ?? vmapPushId.get(event.object_id) ?? null;
    const push = groups.get(`${pushId ?? event.id}|${event.time}|${event.actor_id ?? ''}`);
    if (push && !push.relationships.some((r) => r.qualifier === 'pusher')) {
      push.relationships.push({ object_id: event.actor_id, qualifier: 'pusher' });
    }
  }

  // The RPC orders events by (time, id); keep that so a merged push sits where its
  // observations sat.
  events.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    ...raw,
    meta: { ...raw.meta, contract_version: 3, upgraded_from: raw.meta?.contract_version ?? 2 },
    events,
  };
}
