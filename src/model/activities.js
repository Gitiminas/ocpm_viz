/**
 * The closed activity vocabulary (`docs/DATA_LAYER.md`, "Objects, activities, intervals").
 *
 * Closed and complete: anything unmapped is a defect in the adapter, not something
 * to render as a raw enum string. Changing this vocabulary is a research decision,
 * not an implementation detail — it defines what the event log *is*.
 */

/**
 * The closed set of object types — **four**.
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
 * Not every object type gets a lane. `actor` is the one remaining exception: a
 * first-class object — searchable, toggleable, a link endpoint in principle — with no
 * lifecycle interval to draw, so it surfaces through the sidebar and the actor card
 * instead. Object-hood and lane-hood are separate properties, and `actor` is the only
 * place that distinction now shows.
 */
export const LANE_TYPES = ['issue', 'pull_request', 'commit'];

/**
 * Every activity, with the label the UI shows.
 *
 * `label` is the full form used in tooltips; `short` is the inline form drawn next
 * to a node. `objectTypes` lists which object types the activity may legitimately
 * attach to. Every activity names its object type, so each attaches to exactly one.
 */
/*
 * ⚠️ **The keys are the frozen activity vocabulary and do not change here.** They are
 * what the SQL emits, what the fixtures carry and what `isKnownActivity` throws on.
 * Only `label` and `short` moved, and only because they are what a reader sees.
 *
 * They are now **GitHub's own action words** — the verbs on its buttons: Open, Close,
 * Merge, Reopen, Comment. The tool previously used past participles ("Issue opened",
 * "PR merged"), which is neither what GitHub shows on a button nor what process-mining
 * convention calls an activity; both name the *act*, not the state it leaves behind.
 *
 * They are also terse on purpose. Every consumer names the object alongside — the
 * tooltip kicker says "Pull request · event", the landmark list and the actor card both
 * render `${object.label} · ${label}` — so the old form repeated it: "PR #243221 · PR
 * merged" now reads "PR #243221 · Merge".
 *
 * ⚠️ `CommitObserved` keeps its own wording. It is a **synthetic** activity meaning
 * "this commit was seen in a push", not a GitHub action anyone performed; naming
 * it "Push" would claim an act the data does not record. Its oddness is honest.
 */
export const ACTIVITIES = {
  IssueOpened: {
    label: 'Open',
    short: 'open',
    objectTypes: ['issue'],
    landmark: false,
  },
  IssueClosed: {
    label: 'Close',
    short: 'close',
    objectTypes: ['issue'],
    landmark: true,
  },
  IssueReopened: {
    label: 'Reopen',
    short: 'reopen',
    objectTypes: ['issue'],
    landmark: false,
  },
  IssueCommented: {
    label: 'Comment',
    short: 'comment',
    objectTypes: ['issue'],
    landmark: false,
  },
  PullRequestOpened: {
    label: 'Open',
    short: 'open',
    objectTypes: ['pull_request'],
    landmark: false,
  },
  PullRequestCommented: {
    label: 'Comment',
    short: 'comment',
    objectTypes: ['pull_request'],
    landmark: false,
  },
  PullRequestMerged: {
    label: 'Merge',
    short: 'merge',
    objectTypes: ['pull_request'],
    landmark: true,
  },
  /*
   * A merge GitHub did not perform: the PR was closed unmerged and its commits turned up
   * in a push within minutes (upstream's `mv_pr_offplatform_merges`, a ±15-minute
   * `delta_seconds` heuristic). It IS a landmark (the process reached its end), it is
   * NOT an unmerged close (it delivered), and it is drawn with its OWN ring — dotted, in
   * the extracted colour — so it is emphasised like a merge and visibly not one. The
   * label says so in words as well.
   */
  PullRequestMergedOffPlatform: {
    label: 'Merge (off-platform)',
    short: 'merged off-platform',
    objectTypes: ['pull_request'],
    landmark: true,
    /** The only activity whose ring says "emphasised, but a heuristic". */
    heuristic: true,
  },
  PullRequestClosed: {
    label: 'Close',
    short: 'close',
    objectTypes: ['pull_request'],
    landmark: false,
  },
  PullRequestReopened: {
    label: 'Reopen',
    short: 'reopen',
    objectTypes: ['pull_request'],
    landmark: false,
  },
  CommitObserved: {
    label: 'Commit observed',
    short: 'commit',
    objectTypes: ['commit'],
    landmark: false,
  },
  /*
   * The process map's commit-lane activity, and the map's only private one. Trace never
   * emits it — fe.event's whitelist stays at ten and takes a push apart into one
   * CommitObserved per commit — and the map never emits CommitObserved: its E2O layer
   * (sql/fe_layer.sql §12.0) keeps one real event per push, related to every commit it
   * carried, so a push of n commits is one event with n occurrences. Upstream calls it
   * CommitsPushed. It IS a GitHub action, hence the verb.
   */
  Push: {
    label: 'Push',
    short: 'push',
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
 * `DATA_CONTRACT.md` §3). Reusing the word for "an activity we draw with a ring"
 * would collide with a real, differently-meaning field the adapter may one day read.
 */
export const LANDMARK_ACTIVITIES = Object.keys(ACTIVITIES).filter((a) => ACTIVITIES[a].landmark);

/**
 * The lifecycle READING order, left to right: open, comment, merge, close, reopen.
 * NOT the declaration order above — that lists IssueClosed before IssueCommented, which
 * would bend the dominant open → comment → close traffic backwards wherever activities
 * are laid out or listed in sequence (the process map's rows, its sidebar). One list,
 * covering exactly the closed vocabulary; the guard throws if an activity is ever added
 * without a slot here, so it cannot silently vanish from an ordered surface.
 */
export const READING_ORDER = [
  'IssueOpened',
  'PullRequestOpened',
  'IssueCommented',
  'PullRequestCommented',
  'PullRequestMerged',
  'PullRequestMergedOffPlatform',
  'IssueClosed',
  'PullRequestClosed',
  'IssueReopened',
  'PullRequestReopened',
  'CommitObserved',
  'Push',
];
for (const activity of Object.keys(ACTIVITIES)) {
  if (!READING_ORDER.includes(activity)) {
    throw new Error(`model/activities.js: no reading-order slot for activity "${activity}"`);
  }
}

export function isKnownActivity(activity) {
  return Object.prototype.hasOwnProperty.call(ACTIVITIES, activity);
}

/**
 * A landmark that is a heuristic rather than a platform fact — today only the
 * off-platform merge. Drawn with its own ring so the emphasis does not
 * claim more than the data does; see `render/nodes.js` and `render/structural.js`.
 */
export function isHeuristicLandmark(activity) {
  const entry = ACTIVITIES[activity];
  return Boolean(entry && entry.landmark && entry.heuristic);
}

function lookup(activity) {
  if (!isKnownActivity(activity)) {
    throw new Error(
      `Unknown activity "${activity}". The vocabulary is closed — see ` +
        `docs/DATA_LAYER.md. Either the adapter emitted something it should ` +
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
 * A pull request that ended **without** being merged.
 *
 * `PullRequestClosed` already means exactly this, and the reason is worth stating
 * because it is not obvious from the name: GitHub emits **one** closing event, and a
 * merge is that event carrying `pr_is_merged = true`. Upstream splits the two before we
 * see them (`PullRequestMerged` 67,216 · `PullRequestClosed` 26,366), so a
 * `PullRequestClosed` is never a merge and the two never coincide — measured across all
 * three repositories, **no** pull request carries both at the same instant.
 *
 * `PullRequestMergedOffPlatform` is deliberately NOT an unmerged close: on GitHub the
 * PR was closed unmerged, but the commits were delivered, and the tool treats that as a
 * merge of a different kind. The two PRs in the database that
 * carry both a `PullRequestClosed` and an off-platform merge draw both, as they are.
 *
 * It matters because the outcome is the question an issue-to-merge study asks, and
 * 22,341 of 87,647 closed pull requests here were abandoned rather than merged. Without
 * the dashed ring the outcome would be legible only by reading the label: `opened` and
 * `closed` draw the identical glyph.
 */
export function isUnmergedClose(activity) {
  return activity === 'PullRequestClosed';
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
    if (!object) continue; // reported separately by subLog validation
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
