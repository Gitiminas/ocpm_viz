# Adapter layer and API contract

Everything between the frozen upstream (`DATA_CONTRACT.md`) and the renderer. This is the only
layer this project creates, and it is deliberately thin: when the real OCEL 2.0 tables land, this
is what gets replaced, and nothing above it should move.

## 1. Where it lives

A dedicated schema owned by this project — not the shared namespace, not a `mv_thesis_*` prefix in
`public`. PostgREST exposes only `api`; the derivations sit in the project schema behind it.

**Plain `VIEW` by default.** Materialize only where a measured query justifies it. Materialization
costs disk, a refresh story, and a staleness hazard; a plain view costs nothing and can be changed
freely. With ~14 GB and 3–4M rows in the largest upstream views, the first lever is **indexes**
(`repo_id`, `issue_id`, `pull_request_id`, `commit_sha`, `push_id`), not materialization.

✅ **Corrected 2026-08-04: indexes on the upstream views are ours to create.** O9 is closed —
`current_user` owns every relation in `public`, so `CREATE INDEX` and `ANALYZE` simply work. This is
the first lever and it is available. What survives is that an index changes a relation other people
read, so it is announced rather than private. The indexes actually created, and the measurements
that justified them, are in `sql/fe_layer.sql` §0. See `DATA_CONTRACT.md` §2.

⚠️ **Plain views cannot be indexed.** Since this layer is plain views by decision 10, every index
goes on the *underlying* MVs — which is the better place anyway: one index there serves every query
touching the table rather than one path through a copy.

### Deployment: `sql/postgrest_setup.sql`

Roles, grants and isolation, run after `fe_layer.sql`. Three roles — `authenticator`
connects, `web_anon` is what a request runs as, `fe_owner` owns the layer and is what the
RPC runs as via `SECURITY DEFINER`. Without that third role `web_anon` would need SELECT
on 14 GB of raw event data; with it, its entire privilege set is USAGE on `api` and
EXECUTE on the functions there. `fe_owner` is deliberately not a superuser, and
`search_path` is pinned on every function.

⚠️ **Everything is applied by looping over the `api` schema, never by naming a function**
(decision 71). Naming them individually means each new one starts out `SECURITY INVOKER`
and therefore broken, and the tempting repair is to widen `web_anon` — which dismantles
the isolation. The file ends in seven assertions that must all read `ok`.

## 2. The derivations

The deciding criterion for precomputation is **not** performance — it is whether the result depends
on the sub-log selection. Fixed properties of the data can be precomputed; anything that changes
when the user flips a toggle cannot.

> ✅ **Both definitions were read on 2026-08-04, and the warning below resolved as it feared.**
> `mv_commit_pr_links` and `mv_issue_to_pr_validated_all` **are** the first two rows of this table,
> already built. Neither is rebuilt: decision 52 records the commit→PR admission rule as *inherited*
> from `mv_commit_pr_links.admitted`, and `mv_issue_to_pr_validated_all` already dedupes to one row
> per (issue, PR) and carries `primary_link_method`, `n_methods` and `link_methods`. There is
> therefore exactly one commit→PR admission rule in this project, which is the outcome that
> mattered.
>
> `object_lifecycles` was the only row still ours and is built, as `fe_interval_issue` /
> `fe_interval_pull_request` in `sql/fe_layer.sql`. **Two caveats on consuming the upstream pair:**
> `link_methods` is a semicolon-joined `text`, not an array, and `mv_issue_to_pr_validated_all` does
> **not** include `mv_issue_pr_links_extended_conventions` — those 205 rows are unioned separately
> with a de-duplication guard.

Three derivations to build. A fourth is listed struck through: it was specified here, then
superseded by decision 12. It stays visible because the reasoning that produced it is what decision
12 acted on, and a reader who finds only three rows will wonder what happened to gaps.

| View | Purpose | Form | Notes |
|---|---|---|---|
| `commit_pr_links` ⚠️ *may exist as `mv_commit_pr_links`* | Commit↔PR attribution | **Materialize** | Match `mv_pull_request_events_full.merge_commit_sha` / `.head_sha` against `mv_push_commits_full.commit_sha`, plus branch-ref match (`head_ref` ↔ `ref`). Expensive join across the two largest views, and a rule-based derivation that must be fixed and inspectable for the RQ2 link counts. Record **which rule matched** so evidence can be graded. Admission rule: open question O2. |
| `issue_pr_links` ⚠️ *may exist as `mv_issue_to_pr_validated_all`* | One deduplicated issue↔PR link table | Plain view first | UNION the **seven** detection-method views plus `mv_issue_pr_links_extended_conventions` (it was four when this row was written); dedupe to one row per (issue, PR); keep `primary_link_method` by priority, `n_methods`, `link_methods`, `validation_status`, temporal columns. Promote to materialized only on measurement. |
| `object_lifecycles` | Lifecycle spans per issue / PR | Plain view | Issues: `issue_created_at` → `issue_closed_at` (+ `issue_state`). PRs: `pr_created_at` → `pr_merged_at` / `pr_closed_at` (+ `pr_is_merged`). Do **not** fold in `mv_pr_offplatform_merges` — decision 48 dropped it; a PR closed unmerged ends at `pr_closed_at`. **Emit interval lists** (decision 4). Fixed property of the data, so safe to precompute. |
| ~~`process_gaps`~~ | ~~Bottleneck / idle-time analysis~~ | **Superseded by decision 12** | Retained for rationale only — do not build this. `LAG`/`LEAD` over the per-object event list → `gap_hours`, `gap_class`, `actor_changed`. The reasoning still holds: gaps depend on which events are in the sub-log, so precomputing globally answers "comments hidden → gaps unchanged" silently. Decision 12 resolves it by computing gaps **in JS over the loaded sub-log**, where they follow the toggles for free. Implemented in `src/stats/metrics.js`. |

> Before building anything, **evaluate the three pre-built activity timelines**
> (`mv_issue_and_issuecomment_activities_full`, `mv_pull_request_and_comment_activities_full`,
> `mv_push_activities`). They already carry a named activity vocabulary and may supply most of the
> event stream. **Report what you find** rather than hand-rolling a UNION by default.

## 3. Link evidence (decision 7)

Nothing in the database pre-classifies links, so the solid-vs-dashed uncertainty cue (S8) is derived
from detection method. **Two classes only: `validated` and `extracted`.** `inferred` is retired
vocabulary and must not appear anywhere.

> **The rule.** A link is **validated** when the platform's own data asserts it — documented GitHub
> syntax that GitHub itself acts on, or an exact identity match. It is **extracted** when we parsed a
> human convention that no system enforces.
>
> State the rule in the thesis, not the table. The table is what the rule produces.

The **Method** column gives the `LINK_METHOD` enum value from `src/model/evidence.js` — that enum
is the vocabulary (decision 20), and every row here must have a member there and vice versa.

| Link | Method | Class | Why |
|---|---|---|---|
| Issue ↔ PR | `pr_body` — closing keyword, e.g. "Closes #N" | `validated` | Documented GitHub syntax; GitHub auto-closes on it |
| Issue ↔ PR | `branch_name` — e.g. `fix/123` | `extracted` | Team convention, unenforced |
| Issue ↔ PR | `pr_title` | `extracted` | Convention |
| Issue ↔ PR | `issue_comment` | `extracted` | Convention |
| Commit → PR | `merge_commit_sha` / `head_sha` — exact SHA match | `validated` | Identity match, not parsing |
| Issue ↔ PR | `pr_title_gh`, `pr_body_gh` — `gh-123` in the title or body | `extracted` | Project convention; GitHub does not act on it |
| Issue ↔ PR | `pr_title_for` — `For #123` in the title | `extracted` | Convention |
| Issue ↔ PR | `pr_title_symfony` — Symfony's PR-title convention | `extracted` | Convention |
| Issue ↔ PR | `pr_body_fixed_tickets` — a "Fixed tickets" row in a PR-body template | `extracted` | Convention, template-specific |
| Issue ↔ PR | `pr_body_refs` — `Refs #123` in the body | `extracted` | Convention. In the body like `pr_body`, but a reference closes nothing, so the rule separates them |
| Issue ↔ PR ✅ *corrected 2026-08-04* | `closed_via_commit` — GitHub's own closed-via-commit record | `validated` | The platform states it; nothing is parsed. **Endpoints settled (decision 53): issue ↔ PR.** `mv_issue_pr_links_closed_via_commit` is keyed on `issue_id` + `pull_request_id` and has no `commit_sha` column. ⚠️ The view is **empty (0 rows)**, so this method contributes nothing to any current figure |
| Commit → PR | `ref_match` — branch-ref match (`head_ref` ↔ `ref`) | `extracted` | Convention. From `mv_commit_pr_links` — a genuine commit endpoint. ⚠️ **Narrowed by decision 80** (which replaced 61): admitted only where GitHub flagged the commit new on the pull request's *own* head branch, because merging anything into a long-lived branch otherwise attributes every incoming commit to the PR (vscode PR #116416: 217 → 36). It is **not** dropped — for most commits it is the only evidence there is, since GH Archive's PR payload never lists a PR's commits. Figures are a **floor**; raw `ref_match` is the ceiling |
| Issue ↔ PR ✅ *corrected 2026-08-04* | `proximity` — matched on closeness in time alone | `extracted` | The weakest method in the enum. Nothing is asserted and nothing is parsed — only two timestamps are near each other. **Endpoints settled (decision 53): issue ↔ PR**, keyed on `issue_id` + `pull_request_id`; the view carries `close_delta_seconds`, not a commit. Report its share separately in any RQ2 count |
| Commit → Issue **and** Issue ↔ PR | `commit_message` — regex over the message | `extracted` | Convention. Sub-grade with `link_convention` / `ref_scope`. **Two upstream views emit this**: `mv_commit_message_issue_links_all` (commit → issue, qualifier `references_issue`) and `mv_issue_pr_links_commit_message` (issue ↔ PR, qualifier `resolves`). ⚠️ The second is **derived from commit→PR attribution** (`JOIN mv_commit_pr_links … AND cpr.admitted`), so it inherits the admission rule; decision 62 narrows it to match the commit→PR rule (decision 61, replaced by 80), which cut vscode's issue↔PR pairs 11,326 → 5,934 at the time and moves again with 80. One value, two relationships, by **decision 50** — the qualifier carries the endpoints, and every per-method count must group by `(method, qualifier)`. ⚠️ Cross-repo refs are **dropped**, not graded weaker (decision 54): the view names no target repository, so they cannot be resolved to an object |

> Sixteen link methods, and every one of them links two **objects** (decision 42). Three values have
> been deleted and none returns without an upstream source that emits it: `merge_commit_message`
> (decision 42 — no view emits it), `offplatform_commit_message` (decision 48) and `event_actor_id`
> (decision 41).
>
> These rows were classified in `src/model/evidence.js` before this table recorded them.
> `commit_message` follows the rule unambiguously — it parses text.
>
> ✅ **The endpoint types are settled, 2026-08-04 (decision 53), and this table was wrong.** The
> columns of all seven upstream method views were read from `pg_attribute`: every one is keyed on
> `issue_id` + `pull_request_id`, and neither `mv_issue_pr_links_closed_via_commit` nor
> `mv_issue_pr_links_proximity` carries a `commit_sha` column at all. `closed_via_commit` and
> `proximity` are **issue ↔ PR**; the rows above have been corrected. The evidence classes were
> never in doubt and are unchanged — the rule asks whether GitHub asserts the link, not which two
> objects it joins.
>
> The only link sources with a genuine commit endpoint are `mv_commit_pr_links` (commit ↔ PR;
> methods `merge_commit_sha`, `head_sha`, `ref_match`) and `mv_commit_message_issue_links_all`
> (commit → issue; method `commit_message`).
>
> **Why `event_actor_id` is gone, and why it is the instructive one.** It was an identity match on a
> column GitHub supplies, so `validated` followed the rule and the classification was never wrong.
> It was *redundant*: an `Event → Actor` link restated `event.actor_id`, which the event already
> carries and which is the only thing any renderer reads. Being redundant, it was also dangerous to
> count — it supplied 42 of F1's 76 links, all validated, so the naive split was 45/31 where the
> traceability story is 3/31. Ten separate call sites existed to subtract it before counting. The
> links are deleted from the payload and attribution is single-sourced on `event.actor_id`; a link
> now always means traceability, and no figure has to be qualified with which kind of edge it
> counted.

> ⚠️ **Expect a visible shift.** Branch-ref matching (`ref_match`) supplies 29 of F1's 34 links,
> which split 3 `validated` / 31 `extracted`. Reclassifying `ref_match` moves most of the timeline
> from solid to dashed. That is the honest result and it strengthens the S8 answer — do not treat it
> as a regression. Recorded as mandated baseline difference #1 in `VERIFICATION.md`.
>
> ⚠️ **This holds for F1, and does NOT generalise to real sub-logs — decisions 61/80 changed the
> proportions.** F1 is built from `ocel-data.json`, where every commit on the branch is present. On
> real RPC payloads the narrowing keeps only 18,652 of 78,299 admitted `ref_match` pairs, so the
> commit lane is now mostly `validated` (55,119 + 56,853 solid against 15,042 dashed) rather than
> mostly dashed. The uncertainty cue survives and still has work to do; it is no longer the
> dominant visual. Do not quote F1's 3/31 split as characteristic of a live sub-log.

**Optional strengthening, if time allows.** `pr_body` is the one row where the rule is arguable: the
view regex-parses the body rather than observing GitHub's auto-close. It can be corroborated by
checking for an issue-close event shortly after the PR merge. Not required; worth a sentence in the
limitations either way.

Multi-method agreement raises confidence — carry `n_methods` and `link_methods` to the tooltip.

## 4. Access pattern

One RPC returning one composed bundle: `POST /rpc/get_object_graph`.

The frontend never queries individual views. Consequence: adding derived views does **not** simplify
the API — the RPC is the API surface. The views exist for SQL readability and for the thesis's own
link-count reporting.

Single adapter `loadObjectGraph(query) -> ObjectGraph` is the **only** data entry point. Implement
first against local fixtures; swapping to `fetch()` must be a one-function change.

```
query = {
  repo,              // repository name — identity by id once the RPC exists
  seed,              // object id to traverse out from; ANY object type is valid
  traversalDegree,   // how far to expand. Fixed by the fixture today
}
```

The UI states exactly this (decision 33): pick a repository, then pick the object to start
from. A commit is as valid a seed as an issue — no object type is privileged, which is the
whole point. The seed is privileged in the *query* only, never in the returned data, so
`meta.seed` records it and nothing about the objects marks them as special.

Until the RPC exists, the fixture transport can only serve seeds that were pre-built, so it
also answers a `{fixture}` address for tests. The RPC transport will understand the query and
nothing else.

```
ObjectGraph = {
  meta:    { repo, repo_id, seed:[{id,type}], traversal_degree,
             active_object_types, active_link_methods, generated_at,
             activity_scope, data_honesty:{…}, source },
  objects: [ { id, type, label, repo, intervals:[{start,end}], time_semantics, vmap:{…} } ],
  events:  [ { id, activity, time, object_id, actor_id, repo, comment, attrs:{…} } ],
  links:   [ { source, target, qualifier, evidence, method, link_methods:[…], n_methods } ]
}
```

This is the shape the fixtures actually carry — verified against `tests/fixtures/F1.json`. Three
notes on fields that are easy to get wrong:

- **`source` and `target` are object ids.** Never an event id: the validator rejects one, by name
  (decision 49). The RPC must therefore state who performed an event through `events[].actor_id`
  and never as a link, which is decision 41 — a link means traceability between two objects and
  nothing else.
- **`data_honesty`** ⚠️ **is not rendered by the sidebar, and this bullet used to say it was.**
  Corrected 2026-08-04 against the code: `grep -rn data_honesty src/` returns **nothing**. No module
  under `src/` reads the field. The only consumer anywhere is `scripts/build-catalogue.mjs:72,79`,
  which reads the single sub-key `data_honesty.synthetic` at build time to mark synthetic fixtures
  in the catalogue; `main.js:543` then renders that catalogue flag as a "synthetic" note. The
  commit-time and extracted-edge caveats it is supposed to carry are in fact hardcoded English in
  the renderer — `nodes.js:468` is the commit-time one — which is precisely SPEC G11.

  So the sentence to keep is the *warning*, not the claim: a transport that drops `data_honesty`
  removes nothing from the UI today, which is exactly why G11 says a field whose removal is
  invisible is worse than no field. `sql/fe_layer.sql` emits it, so wiring it up stays a
  one-function change on the render side; until then do not describe it as an S8 disclosure that
  the UI makes.
- **`link_methods` is the array; `method` is the primary one.** Decision 20 requires both plus
  `n_methods`, and nothing free-text.

**Reserved, not yet carried.** `validation_status`, `ref_scope` and `link_convention` are named in
`DATA_REQUIREMENTS.md` §7 and in the sub-grading promise of §3 above, but no fixture populates them
and the shape above does not include them — the upstream columns exist, the adapter does not yet.
They land with the RPC, on `links`. Until then they are planned, not required; do not write code
that assumes their presence.

### Known limitation: one object per event

`events` carry a single `object_id`. OCEL 2.0's event-to-object relation is many-valued, and
`ARCHITECTURE.md` states that one event touching several objects is exactly what OCPM exists to
show. The current model expresses convergence through `links` between objects rather than through
events, which is sufficient for the activities in scope — each has an unambiguous subject, and the
actor is carried separately on `actor_id`.

It is nonetheless a real gap at the point where OCPM is most distinctive, and it is a promise this
layer does not currently keep: a shape that cannot express E2O multiplicity is not swappable to
real OCEL 2.0 tables without changing the contract above it. **Deliberately deferred, not
overlooked** — tracked as open question O10. Migration sketch: `object_id` → `object_ids: […]`,
8 call sites across `src/model/activities.js`, `src/model/objectGraph.js` and `src/state/state.js`,
plus the 13 fixtures, both build scripts and the bundle-shape tests. Cheapest before the renderer
grows more dependants on the current grouping.

`meta` records **the query**, for reproducibility — not an identity. Those same parameters are what
a saved preset / shareable URL encodes, which is the reproducibility mechanism for the task-based
evaluation.

**Two degrees, kept apart:** `meta.traversal_degree` is server-side — how far the sub-log was
expanded, 0–2 and 1 when unstated (decisions 110–111; `TRAVERSAL_DEGREE` in `src/data/api.js`
and the guard in `api.get_object_graph` agree, and must be changed together). The client-side focus BFS (`focusSet()`, capped at 2) controls only highlighting within an
already-loaded sub-log. Do not conflate the names.

## 5. Activity vocabulary

Closed and complete. Fail visibly on anything unmapped rather than rendering a raw enum.

Present in the current data: `IssueOpened`, `IssueCommented`, `IssueClosed`, `PullRequestOpened`,
`PullRequestMerged`, `PullRequestClosed`, `CommitObserved`.
Mapped in code, absent from data: `IssueReopened`, `PullRequestReopened`.

**Nothing is to be added.** `PullRequestMergedOffPlatform` was once listed here as a must-add from
`mv_pr_offplatform_merges`; decision 48 removed it. The vocabulary is the nine activities above and
`mv_pr_offplatform_merges` is not consumed. Note the consequence for the adapter: the pre-built
timeline `mv_pull_request_and_comment_activities_full` **depends on** that view
(`DATA_CONTRACT.md` §3), so whichever `activity_type` it emits for an off-platform merge maps to
`PullRequestClosed` — the GitHub fact, which is that the PR was closed unmerged. Anything else
throws, which is the intended behaviour.

**Landmark activities** (rendered with emphasis): `IssueClosed`, `PullRequestMerged`.
