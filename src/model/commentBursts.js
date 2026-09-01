/**
 * Comment bursts: runs of comments on one object that sit close together in time.
 *
 * The same bargain as commit bursts, for a different reason. A push has a
 * `push_id`, so a commit burst is a fact the data hands us. **Comments have no such key**,
 * so the grouping here is invented and the window that defines it is therefore a control
 * rather than a constant — the reader sets what "close together" means and can see the
 * answer change, instead of trusting a number nobody can inspect.
 *
 * ⚠️ **Time, not count.** The complaint this answers is vertical: kubernetes issue #47532
 * carries 20 comments, and where they cluster the collision packer bumps each one down a
 * row until the lane is taller than the screen. Clustering in *time* is what produces
 * that, so clustering in time is what folds — comments spread over months cost no height
 * and stay individually visible, which a count-based rule would have collapsed anyway.
 *
 * A burst is only worth drawing at two or more; a run of one is just a comment.
 *
 * ⚠️ **A run never crosses a close or a reopen.** Folding is time-only, but a burst's mark
 * is drawn at its first comment, so a run that straddled a lifecycle boundary put a
 * post-close comment inside the open interval — on F1, a comment 7.5 days after the PR
 * closed read as pre-merge traffic at any window of 8 days or more. Runs therefore break
 * at every lifecycle-segment change. The interval end is inclusive: a comment at the
 * closing instant belongs to the life it closed.
 */

/** Default window: comments within a day of each other read as one exchange. */
export const DEFAULT_COMMENT_WINDOW_DAYS = 1;

export const MIN_COMMENT_BURST = 2;

/**
 * Which stretch of the object's lifecycle an instant falls in: before or inside
 * interval i, or in the closed gap after it. The end is INCLUSIVE — a comment at the
 * closing instant belongs to the life it closed — and a null end is still open (+∞).
 * An object with no intervals puts everything in segment 0, which folds as before.
 */
function lifecycleSegment(intervals, time) {
  const t = +time;
  let segment = 0;
  for (const interval of intervals) {
    const start = interval.start ? +interval.start : -Infinity;
    const end = interval.end ? +interval.end : Infinity;
    if (t < start) return segment; // in the gap before this interval
    segment += 1;
    if (t <= end) return segment; // inside it
    segment += 1; // past it: the closed stretch after
  }
  return segment;
}

/**
 * Group each object's comments into runs no more than `windowDays` apart.
 *
 * @param {object}   index       from `indexObjectGraph`
 * @param {string[]} laneTypes   lane-bearing types whose comments can fold (never commit)
 * @param {{windowDays?: number}} options
 * @returns {Array} bursts, each `{id, objectId, lane, eventIds, actorIds, time, end, size}`
 */
export function deriveCommentBursts(index, laneTypes = ['issue', 'pull_request'], options = {}) {
  const windowDays = options.windowDays ?? DEFAULT_COMMENT_WINDOW_DAYS;
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const bursts = [];

  for (const laneType of laneTypes) {
    if (laneType === 'commit') continue;
    for (const object of index.objectsOfType(laneType)) {
      // `eventsOf` is already sorted by time (`indexObjectGraph`), so a single pass
      // chains each run; re-sorting here would be a second opinion about order.
      const comments = index.eventsOf(object.id).filter((event) => event.comment);
      let run = [];

      const flush = () => {
        if (run.length >= MIN_COMMENT_BURST) {
          bursts.push({
            // Keyed on the first event, so a burst keeps its identity across renders and
            // an expanded one stays expanded while nothing about it has changed.
            id: `cburst:${run[0].id}`,
            objectId: object.id,
            lane: laneType,
            eventIds: run.map((event) => event.id),
            // Who wrote them — what the actor trail needs to pass through a fold it
            // would otherwise skip, and to say whether the fold is one voice or several.
            actorIds: [...new Set(run.map((event) => event.actor_id).filter(Boolean))],
            time: run[0].time,
            end: run[run.length - 1].time,
            size: run.length,
          });
        }
        run = [];
      };

      let runSegment = null;
      for (const event of comments) {
        const segment = lifecycleSegment(object.intervals, event.time);
        if (
          run.length &&
          (segment !== runSegment || +event.time - +run[run.length - 1].time > windowMs)
        ) {
          flush();
        }
        runSegment = segment;
        run.push(event);
      }
      flush();
    }
  }

  return bursts;
}

/** event id → the burst that folds it, for the node builder and the visibility rules. */
export function indexCommentBurstsByEvent(bursts) {
  const byEvent = new Map();
  for (const burst of bursts) {
    for (const id of burst.eventIds) byEvent.set(id, burst);
  }
  return byEvent;
}
