/**
 * Short display labels for object types, used in sidebar toggles and link labels.
 *
 * Separate from `render/theme.js` so that state derivation — which is DOM-free and
 * unit tested — does not have to import the rendering module.
 */

/** One entry per member of `OBJECT_TYPES`. The object types are closed at four. */
export const TYPE_LABELS = {
  issue: 'Issue',
  pull_request: 'PR',
  commit: 'Commit',
  actor: 'Actor',
};

export { LANE_TYPES } from '../model/activities.js';
