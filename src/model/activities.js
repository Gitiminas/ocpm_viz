/**
 * The closed activity vocabulary (`docs/ADAPTER_AND_API.md` §5).
 *
 * Closed and complete: anything unmapped is a defect in the adapter, not something
 * to render as a raw enum string. Changing this vocabulary is a research decision,
 * not an implementation detail — it defines what the event log *is*.
 */

/**
 * The closed set of object types — **four** (decision 39).
 *
 * `repo` was a fifth. It is not an object here: in every upstream materialized view
 * `repo_id` is a partition key rather than a participant, so no activity attaches to
 * it, no link reaches it and it has no lifecycle to draw. The repository is the frame
 * the sub-log is drawn inside, carried once as `meta.repo` / `meta.repo_id`, and a
 * type with a permanently empty branch misleads more than it informs. If cross-repo
 * views ever arrive it returns as a grouping band, not as an object.
 */
export const OBJECT_TYPES = ['issue', 'pull_request', 'commit', 'actor'];

/**
 * Object types that get a timeline lane, in lane order.
 *
 * Not every object type gets a lane (decision 15). `actor` is the one remaining
 * exception: a first-class object — searchable, toggleable, a link endpoint in
 * principle — with no lifecycle interval to draw, so it surfaces through the sidebar
 * and the actor card instead. Object-hood and lane-hood are separate properties, and
 * that distinction is the whole of what decision 15 still governs now that `repo` is
 * not an object at all.
 */
export const LANE_TYPES = ['issue', 'pull_request', 'commit'];

/**
 * Every activity, with the label the UI shows.
 *
 * `label` is the full form used in tooltips; `short` is the inline form drawn next
 * to a node. `objectTypes` lists which object types the activity may legitimately
 * attach to.
 *
 * Note `IssueCommented` on a `pull_request`: that is not a bug. GitHub models PR
 * comments as issue comments — upstream, `mv_pull_request_comments_full` is
 * literally "IssueCommentEvent payloads where the target is a PR" — so the activity
 * legitimately attaches to both. Do not "fix" this into two activities without
 * treating it as the event-log semantics change that it is.
 */
export const ACTIVITIES = {
  IssueOpened: {
    label: 'Issue opened',
    short: 'opened',
    objectTypes: ['issue'],
    landmark: false,
  },
  IssueClosed: {
    label: 'Issue closed',
    short: 'closed',
    objectTypes: ['issue'],
    landmark: true,
  },
  IssueReopened: {
    label: 'Issue reopened',
    short: 'reopened',
    objectTypes: ['issue'],
    landmark: false,
  },
  IssueCommented: {
    label: 'Comment',
    short: 'comment',
    objectTypes: ['issue', 'pull_request'],
    landmark: false,
  },
  PullRequestOpened: {
    label: 'PR opened',
    short: 'opened',
    objectTypes: ['pull_request'],
    landmark: false,
  },
  PullRequestMerged: {
    label: 'PR merged',
    short: 'merged',
    objectTypes: ['pull_request'],
    landmark: true,
  },
  PullRequestClosed: {
    label: 'PR closed',
    short: 'closed',
    objectTypes: ['pull_request'],
    landmark: false,
  },
  PullRequestReopened: {
    label: 'PR reopened',
    short: 'reopened',
    objectTypes: ['pull_request'],
    landmark: false,
  },
  CommitObserved: {
    label: 'Commit observed',
    short: 'commit',
    objectTypes: ['commit'],
    landmark: false,
  },
};

/**
 * Activities rendered with emphasis (a halo ring) — the terminal outcomes.
 *
 * Called *landmarks*, not milestones, and deliberately so: GitHub has a first-class
 * feature called a milestone, and the upstream views carry its columns verbatim
 * (`milestone_id`, `milestone_number`, `milestone_title` on `mv_issues_full` —
 * `DATA_CONTRACT.md` §1). Reusing the word for "an activity we draw with a ring"
 * would collide with a real, differently-meaning field the adapter may one day read.
 * See decision 38.
 */
export const LANDMARK_ACTIVITIES = Object.keys(ACTIVITIES).filter((a) => ACTIVITIES[a].landmark);

export function isKnownActivity(activity) {
  return Object.prototype.hasOwnProperty.call(ACTIVITIES, activity);
}

function lookup(activity) {
  if (!isKnownActivity(activity)) {
    throw new Error(
      `Unknown activity "${activity}". The vocabulary is closed — see ` +
        `docs/ADAPTER_AND_API.md §5. Either the adapter emitted something it should ` +
        `not, or the vocabulary needs extending, which is a research decision.`,
    );
  }
  return ACTIVITIES[activity];
}

/** Full label, e.g. "Issue closed". Throws on an unmapped activity. */
export function activityLabel(activity) {
  return lookup(activity).label;
}

/** Inline label, e.g. "closed". Throws on an unmapped activity. */
export function activityShortLabel(activity) {
  return lookup(activity).short;
}

/** Whether the activity is rendered with landmark emphasis. */
export function isLandmark(activity) {
  return lookup(activity).landmark;
}

/**
 * Collect every vocabulary problem in one pass, so a malformed bundle reports all
 * of its unknown activities at once instead of one per reload.
 *
 * Returns an array of human-readable problems; empty means clean.
 */
export function findActivityProblems(events, objectsById) {
  const problems = [];
  const unknown = new Set();
  const mismatched = new Set();

  for (const event of events) {
    if (!isKnownActivity(event.activity)) {
      unknown.add(event.activity);
      continue;
    }
    const object = objectsById[event.object_id];
    if (!object) continue; // reported separately by objectGraph validation
    const allowed = ACTIVITIES[event.activity].objectTypes;
    if (!allowed.includes(object.type)) {
      mismatched.add(`${event.activity} on a ${object.type} object (allowed: ${allowed.join(', ')})`);
    }
  }

  if (unknown.size) {
    problems.push(
      `unknown activities not in the closed vocabulary: ${[...unknown].sort().join(', ')}`,
    );
  }
  for (const m of [...mismatched].sort()) {
    problems.push(`activity attached to an unexpected object type: ${m}`);
  }
  return problems;
}
