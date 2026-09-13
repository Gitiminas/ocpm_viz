/**
 * Builders for the events the suites write inline (contract v3, `docs/DATA_LAYER.md`).
 * Not a suite: the directory keeps it out of `node --test`'s discovery.
 */

import { actorRoleOf } from '../../src/model/activities.js';

/** An issue or pull-request event about one object, with its actor under the activity's role. */
export function subjectEvent(id, activity, time, objectId, { actorId = null, comment = false, repo, attrs } = {}) {
  const relationships = [{ object_id: objectId, qualifier: 'subject' }];
  if (actorId) relationships.push({ object_id: actorId, qualifier: actorRoleOf(activity) });
  return {
    id,
    activity,
    time,
    ...(repo !== undefined ? { repo } : {}),
    comment,
    ...(attrs !== undefined ? { attrs } : {}),
    relationships,
  };
}

/** A push about every commit it carried, with its pusher. */
export function pushEvent(id, time, commitIds, { actorId = null, repo, attrs } = {}) {
  const relationships = commitIds.map((object_id) => ({ object_id, qualifier: 'pushed_commit' }));
  if (actorId) relationships.push({ object_id: actorId, qualifier: 'pusher' });
  return {
    id,
    activity: 'Push',
    time,
    ...(repo !== undefined ? { repo } : {}),
    comment: false,
    ...(attrs !== undefined ? { attrs } : {}),
    relationships,
  };
}
