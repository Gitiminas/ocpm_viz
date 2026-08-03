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
 * The two mandated exceptions to rule 2, both settled decisions rather than
 * judgement calls, are the `inferred` → `extracted` rename (decision 7) and the
 * evidence reclassification that follows from it.
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
  [/^event_actor_id$/, LINK_METHOD.EVENT_ACTOR_ID],
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

  return {
    meta: buildMeta(source.meta, objects, source.links),
    objects,
    // Events pass through untouched: they already match the contract.
    events: source.events,
    links: source.links.map(convertLink),
  };
}

function selfCheck(graph, source) {
  const problems = [];
  const objectLinks = graph.links.filter((l) => l.qualifier !== 'actor');
  const validated = objectLinks.filter((l) => l.evidence === 'validated').length;
  const extracted = objectLinks.filter((l) => l.evidence === 'extracted').length;

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
  if (graph.links.length !== source.links.length)
    problems.push('link count changed during conversion');

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
  const objectLinks = graph.links.filter((l) => l.qualifier !== 'actor');
  console.log(
    `Wrote tests/fixtures/F1.json — ${graph.objects.length} objects, ` +
      `${graph.events.length} events, ${graph.links.length} links ` +
      `(${objectLinks.length} object→object: ` +
      `${objectLinks.filter((l) => l.evidence === 'validated').length} validated, ` +
      `${objectLinks.filter((l) => l.evidence === 'extracted').length} extracted).`,
  );
}
