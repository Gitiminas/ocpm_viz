/**
 * Build fixture F1 from `ocel-data.json`.
 *
 *   node scripts/build-f1.mjs            # writes tests/fixtures/F1.json
 *   node scripts/build-f1.mjs --check    # verifies the committed fixture is current
 *
 * F1 is the regression baseline: the vscode sub-log the mockup was built around
 * (issue #242864 → PR #243221 → its commits), reshaped into the `ObjectGraph`
 * contract in `docs/ADAPTER_AND_API.md` §4.
 *
 * Two rules govern this script:
 *
 *   1. `ocel-data.json` is the untouched original and is never written to.
 *   2. **Shape changes only, never values.** Nothing is renamed, rounded, filled in
 *      or "corrected" because it looks wrong. Where the source is odd — a null
 *      `issue_id`, 12 commits with a null `burst_id` — the oddity is carried through
 *      and documented in `tests/fixtures/README.md`, because an undetectable
 *      freehand edit would silently invalidate the regression baseline.
 *
 * The three mandated exceptions to rule 2, all settled decisions rather than
 * judgement calls, are the `inferred` → `extracted` rename (decision 7), the
 * evidence reclassification that follows from it, and the removal of the 42
 * event→actor attribution links (decision 41).
 *
 * The third is a *deletion*, which rule 2 would normally forbid outright, so it is
 * checked rather than trusted: `selfCheck` proves the dropped links are exactly
 * reproducible from `event.actor_id` before allowing the build to succeed. A
 * deletion that can be reconstructed from a column that stays is a change of shape
 * wearing a change of value's clothes; one that cannot would be data loss.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyLink, LINK_METHOD, isKnownMethod } from '../src/model/evidence.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SOURCE = resolve(ROOT, 'ocel-data.json');
const TARGET = resolve(ROOT, 'tests/fixtures/F1.json');

/**
 * Fixed, not `new Date()`: a timestamp that moved on every run would make the
 * fixture non-reproducible and churn the diff. This records when the conversion
 * was authored, which is what the reproducibility stamp is for.
 */
const GENERATED_AT = '2026-07-30T00:00:00Z';

/**
 * The source records detection methods as free-text prose. Map each distinct
 * string onto the machine enum. Exhaustive by construction: an unrecognised string
 * throws rather than falling through to a default, because a mislabelled method
 * silently changes the evidence class and therefore the solid/dashed rendering.
 */
const METHOD_FROM_PROSE = [
  [/^ref_match$/, LINK_METHOD.REF_MATCH],
  [/head-SHA match/i, LINK_METHOD.HEAD_SHA],
  [/^PR body:/i, LINK_METHOD.PR_BODY],
  /*
   * "merge commit message 'Merge pull request #243221'" once mapped to a
   * `merge_commit_message` method of its own. Decision 42 deleted that value — no
   * upstream view emits it — so the row folds into `commit_message`, which is what
   * it always was: a PR reference parsed out of a commit message. The pattern must
   * stay rather than fall through to the row below, whose `^` anchor would not
   * match this prose, and the evidence class is unchanged (both are `extracted`).
   */
  [/^merge commit message/i, LINK_METHOD.COMMIT_MESSAGE],
  [/^commit message/i, LINK_METHOD.COMMIT_MESSAGE],
  /*
   * `event_actor_id` had a row here. Decision 41 deleted the method along with the
   * links that carried it, and the row goes with it rather than being kept "just in
   * case": the actor links are dropped by `partitionLinks` before any prose is
   * mapped, so reaching this table with that string would mean the drop failed to
   * catch one — and the throw below is the right answer to that.
   */
];

function methodFromProse(prose) {
  for (const [pattern, method] of METHOD_FROM_PROSE) {
    if (pattern.test(prose)) return method;
  }
  throw new Error(
    `Unrecognised link method prose: ${JSON.stringify(prose)}.\n` +
      `Add a pattern to METHOD_FROM_PROSE and classify it in src/model/evidence.js. ` +
      `Refusing to guess: the evidence class decides whether the link renders solid or dashed.`,
  );
}

/**
 * `t_start` / `t_end` → `intervals` (decision 4).
 *
 * A single start/end pair cannot represent a reopened issue. F1 contains no reopen,
 * so every object here yields exactly one interval — but the shape is what the
 * renderer consumes, so the baseline must already carry it. Objects with no
 * lifecycle (actors, and repos when they arrive) yield an empty list rather than a
 * null pair: "this object has no intervals" is a fact, not missing data.
 */
function toIntervals(object) {
  if (!object.t_start && !object.t_end) return [];
  return [{ start: object.t_start, end: object.t_end }];
}

function convertObject(source) {
  const { t_start, t_end, ...rest } = source;
  return {
    ...rest,
    intervals: toIntervals(source),
  };
}

function convertLink(source) {
  const method = methodFromProse(source.method);
  const methods = [method];
  return {
    source: source.source,
    target: source.target,
    qualifier: source.qualifier,
    evidence: classifyLink(methods),
    method,
    link_methods: methods,
    n_methods: methods.length,
  };
}
// The source's free-text `method` prose ("PR body: 'Closes #242864'", "…message-inferred,
// ~9.38% reliability class") is deliberately *replaced* by the enum, not carried alongside
// it. Three reasons, in order of weight:
//   1. Nothing upstream produces that prose. A field only this fixture could populate would
//      make F1 an unfaithful model of a real sub-log — the opposite of a regression baseline.
//   2. `ObjectGraph` (ADAPTER_AND_API.md §4) has no prose field; tasks/01 specifies the
//      prose becomes an enum.
//   3. The prose embeds the retired word `inferred` and restates the evidence class, so
//      keeping it would either violate decision 7 or require rewording it — and rewording is
//      exactly the undetectable freehand edit this script exists to avoid.
// What is lost is which specific keyword or SHA matched. When the adapter lands it supplies
// that properly, as `link_convention` / `ref_scope` from `mv_commit_message_issue_links_all`.

/**
 * Split the source links into the ones F1 keeps and the ones decision 41 drops.
 *
 * The dropped set is returned rather than discarded here, so `selfCheck` can prove
 * it was redundant instead of the script asserting so in a comment.
 */
function partitionLinks(sourceLinks) {
  return {
    kept: sourceLinks.filter((link) => link.qualifier !== 'actor'),
    dropped: sourceLinks.filter((link) => link.qualifier === 'actor'),
  };
}

function buildMeta(sourceMeta, objects, sourceLinks) {
  const seeds = [{ id: 'issue:242864', type: 'issue' }];
  const activeObjectTypes = [...new Set(objects.map((o) => o.type))].sort();

  return {
    repo: sourceMeta.repo,
    repo_id: sourceMeta.repo_id,

    // `meta` records the query that produced the sub-log, for reproducibility — it
    // is not an identity (decision 1). There is deliberately no `case` key, and the
    // UI derives its breadcrumb from these fields rather than from a stored string.
    seed: seeds,

    // The sub-log reaches commits from the issue seed via the PR: issue → PR is one
    // hop, PR → commit is two. Recorded as the traversal that would reproduce this
    // selection. This is the *server-side* degree; it is unrelated to the
    // client-side focus BFS, which is capped at 2 for highlighting only.
    traversal_degree: 2,

    active_object_types: activeObjectTypes,
    active_link_methods: [...new Set(sourceLinks.map((l) => methodFromProse(l.method)))].sort(),

    generated_at: GENERATED_AT,
    activity_scope: sourceMeta.activity_scope,

    data_honesty: {
      commit_time: sourceMeta.data_honesty.commit_time,
      // Renamed from `inferred_edges` and reworded: `inferred` is retired
      // vocabulary (decision 7). The set of links this describes also changes —
      // see tests/fixtures/README.md.
      extracted_edges:
        'Links we parsed from an unenforced human convention (branch-ref matches, ' +
        'commit-message references) render dashed with a "?" badge.',
      validated_edges:
        "Links the platform's own data asserts (a closing keyword in the PR body, " +
        'an exact SHA match) render solid.',
      author_note: sourceMeta.data_honesty.author_note,
    },

    source: {
      fixture: 'F1',
      derived_from: 'ocel-data.json',
      built_by: 'scripts/build-f1.mjs',
    },
  };
}

function build() {
  const source = JSON.parse(readFileSync(SOURCE, 'utf8'));
  const objects = source.objects.map(convertObject);
  const { kept } = partitionLinks(source.links);

  return {
    meta: buildMeta(source.meta, objects, kept),
    objects,
    // Events pass through untouched: they already match the contract. They also
    // carry `actor_id`, which is now the only statement of who did what.
    events: source.events,
    links: kept.map(convertLink),
  };
}

/**
 * Prove that dropping the actor links loses nothing (decision 41).
 *
 * Two checks, and they do **different** jobs — worth keeping straight, because it is
 * easy to describe the second as if it did the first's work:
 *
 *   1. Every dropped link is exactly one (event, that event's own `actor_id`) pair.
 *      *This* is the loss check. A link asserting an actor the event does not name
 *      would take that attribution with it when dropped, and the actor would vanish
 *      from the trails and the actor card with no error anywhere.
 *   2. Every event naming an actor was covered by one of those links. This one
 *      cannot prevent loss — the attribution is on the event either way. It checks
 *      the *premise* decision 41 records: that the two representations were a strict
 *      bijection, not that one was a subset of the other. If it fails, nothing is
 *      lost, but the source has stopped being what the decision says it is, and for a
 *      regression baseline whose job is to be a fixed point that is worth failing on.
 *
 * Returns problems rather than throwing, so one run reports everything.
 */
function checkActorLinksAreRedundant(dropped, source) {
  const problems = [];
  const eventById = new Map(source.events.map((event) => [event.id, event]));
  const actorIds = new Set(
    source.objects.filter((object) => object.type === 'actor').map((object) => object.id),
  );

  const covered = new Set();
  for (const link of dropped) {
    const event = eventById.get(link.source);
    if (!event) {
      problems.push(`actor link ${link.source}→${link.target} does not start at a known event`);
      continue;
    }
    if (!actorIds.has(link.target)) {
      problems.push(`actor link ${link.source}→${link.target} does not end at an actor object`);
      continue;
    }
    if (event.actor_id !== link.target) {
      problems.push(
        `actor link ${link.source}→${link.target} disagrees with the event's own ` +
          `actor_id "${event.actor_id}" — dropping it would lose attribution`,
      );
      continue;
    }
    covered.add(event.id);
  }

  for (const event of source.events) {
    if (event.actor_id && !covered.has(event.id)) {
      problems.push(`event ${event.id} names an actor that no dropped link accounted for`);
    }
  }
  return problems;
}

function selfCheck(graph, source) {
  const problems = [];
  const { kept, dropped } = partitionLinks(source.links);
  const validated = graph.links.filter((l) => l.evidence === 'validated').length;
  const extracted = graph.links.filter((l) => l.evidence === 'extracted').length;

  // The reclassification is the one change that alters how F1 renders, so assert
  // the predicted split rather than trusting it. Predicted in tasks/01: of the 34
  // object links, only the single pr_body match and the two head-SHA matches
  // survive as validated.
  if (validated !== 3) problems.push(`expected 3 validated object links, got ${validated}`);
  if (extracted !== 31) problems.push(`expected 31 extracted object links, got ${extracted}`);

  if (graph.objects.length !== source.objects.length)
    problems.push('object count changed during conversion');
  if (graph.events.length !== source.events.length)
    problems.push('event count changed during conversion');

  // The link count *does* change now, by exactly the actor links and nothing else.
  if (dropped.length !== 42) problems.push(`expected 42 actor links to drop, found ${dropped.length}`);
  if (graph.links.length !== kept.length)
    problems.push('link count changed by something other than the actor-link drop');
  if (graph.links.some((l) => l.qualifier === 'actor'))
    problems.push('an actor link survived the conversion (decision 41)');
  problems.push(...checkActorLinksAreRedundant(dropped, source));

  if (JSON.stringify(graph).includes('inferred'))
    problems.push('retired vocabulary "inferred" survives in the output');

  for (const l of graph.links) {
    if (!isKnownMethod(l.method)) problems.push(`link carries unknown method ${l.method}`);
  }

  // Every object must carry intervals, even if empty — the renderer reads the field
  // unconditionally.
  for (const o of graph.objects) {
    if (!Array.isArray(o.intervals)) problems.push(`object ${o.id} has no intervals array`);
  }

  if (problems.length) {
    throw new Error(`F1 conversion self-check failed:\n  - ${problems.join('\n  - ')}`);
  }
}

const source = JSON.parse(readFileSync(SOURCE, 'utf8'));
const graph = build();
selfCheck(graph, source);

const json = JSON.stringify(graph, null, 2) + '\n';

if (process.argv.includes('--check')) {
  let current = null;
  try {
    current = readFileSync(TARGET, 'utf8');
  } catch {
    console.error('tests/fixtures/F1.json is missing. Run: node scripts/build-f1.mjs');
    process.exit(1);
  }
  if (current !== json) {
    console.error('tests/fixtures/F1.json is stale. Run: node scripts/build-f1.mjs');
    process.exit(1);
  }
  console.log('F1 is up to date.');
} else {
  mkdirSync(dirname(TARGET), { recursive: true });
  writeFileSync(TARGET, json);
  const { dropped } = partitionLinks(source.links);
  console.log(
    `Wrote tests/fixtures/F1.json — ${graph.objects.length} objects, ` +
      `${graph.events.length} events, ${graph.links.length} object→object links ` +
      `(${graph.links.filter((l) => l.evidence === 'validated').length} validated, ` +
      `${graph.links.filter((l) => l.evidence === 'extracted').length} extracted). ` +
      `Dropped ${dropped.length} event→actor links, each verified redundant with ` +
      `event.actor_id (decision 41).`,
  );
}
