# Task 1 — Kill the single-issue / single-PR assumptions

The core of the generalization. **Stop and check in when this is done** — don't run end-to-end
before I see something.

Prerequisite: Task 0 complete, including the visual baseline. Line numbers are approximate and predate any edits (`MOCKUP_OVERVIEW.md` §10 has the full inventory).

## Do

1. **The `[0]` singletons (core bug), L219–220:**
   ```js
   var issueObj = objs.filter(function(o){return o.type==='issue';})[0];
   var prObj    = objs.filter(function(o){return o.type==='pull_request';})[0];
   ```
   Grabs the *first* issue and PR, silently discards the rest. Threaded through `buildNodes()`
   (L360–398), highlights-mode ticks (L584–611), lane sub-labels (L559), `renderStats()`
   (L1227–1281). Replace with collections; make every consumer iterate.

2. **Hardcoded burst timestamp, L214:** `BURST_T = parse('2025-03-10T18:32:11Z')` — a literal date
   in source, assuming a single burst from `DATA.meta.burst`. Generalize to **N bursts, or zero**,
   grouped by `push_id`. `crossAdj` burst folding (L237–245) must work for N. **A burst's label is
   derived from its actual member count**, never read from metadata — that is what caused the 21/20
   discrepancy in the example data.

3. **Hardcoded activity vocabulary,** `actTitle()` / `shortTitle()` (L399–403), plus milestone
   detection by literal string compare inside `buildNodes()`. Produce the closed vocabulary from
   `ADAPTER_AND_API.md` §5 and **fail visibly** on anything unmapped. Include
   `PullRequestMergedOffPlatform`.

4. **Single lifecycle span.** Move to interval lists (decision 4) so reopened issues render as
   multiple bars.

5. **Dead controls.** The repo/object combos (`setupCombo`, L265) are populated but no `onSelect` is
   passed, so selecting does nothing. Wire to `loadObjectGraph()` and re-render.

6. **Vocabulary rename** (open question O4). Two words, everywhere — data, constants, comments, UI:
   - `case` → `subLog`. The data blob has `meta.case`; the UI says "case info header", "case title",
     "Case Statistics". Decision 1 forbids the word.
   - `inferred` → `extracted`. Includes the `evidence` field values and the `INFER_C` constant. The
     sidebar already says "Extracted"; the data does not. Decision 7.

7. **Reclassify link evidence** per `ADAPTER_AND_API.md` §3. Branch-name and branch-ref matches move
   from validated to extracted. Expect most links in F1 to change from solid to dashed — this is
   correct, not a regression, and the F1 baseline comparison must account for it.

8. **Split into modules** per `ARCHITECTURE.md`, confirming the structure with me first (O8).

9. **Introduce `loadObjectGraph(query) -> ObjectGraph`** as the only data entry point, implemented
   against local fixture files. Swapping to `fetch()` must be a one-function change. Contract in
   `ADAPTER_AND_API.md` §4. The bundle carries objects, events and links only — **no precomputed
   metrics** (decision 12).

## Keep — this code is good and must survive

The three time scales (`xReal` / `xComp` / `xOrdinalTime`, L301–330) including the compression maths
and gap annotation · symbol/glyph rendering · the tooltip system including pin-to-copy ·
`focusSet()` BFS (L492) · the row-packing collision loop (L512–518) · minimap drag-to-zoom ·
solid-vs-dashed evidence rendering and the "?" badge · position tweening across mode changes ·
the sidebar toggle architecture.

## Building fixture F1

`ocel-data.json` is close to the `ObjectGraph` shape but not identical. Convert it with a **small,
committed script** (`tests/fixtures/build-f1.js` or similar) producing `tests/fixtures/F1.json`.

- **`ocel-data.json` stays in the repo unmodified.** It is the untouched original.
- **Shape changes only. Never values.** Do not rename labels, round timestamps, fill nulls, or
  "correct" anything that looks wrong in the source.

Transformations required:

| Source | Target |
|---|---|
| `t_start` / `t_end` on each object | `intervals: [{start, end}]` |
| `meta.case` | removed — decision 1 |
| `meta.burst` (`n_commits: 21`) | removed. Bursts derive from `push_id`; the real member count is 20 |
| `evidence: "inferred"` | `"extracted"` |
| `method` free-text prose | a machine enum, plus `n_methods` |
| `meta` | add seed object(s), `traversal_degree`, active types/links, `generated_at` |

Known quirks to carry through **unchanged**: one object has `vmap.issue_id: null`; 12 commits have
`burst_id: null`. Real sub-logs will not look like this — do not treat F1 as the model for id
handling.

Method enum mapping for F1's 34 object links: `ref_match` (29), head-SHA match (2), PR body (1),
commit message (1), merge commit message (1). Under decision 7 this yields roughly **3 validated /
31 extracted**, against 32/2 today.

## Build fixture F1 with a script, not by hand

`ocel-data.json` is the source. It does **not** match the target `ObjectGraph` shape and must be
converted:

| Now | Target |
|---|---|
| `t_start` / `t_end` per object | `intervals: [{start, end}]` (decision 4) |
| `evidence: "inferred"` | `"extracted"` (decision 7) |
| `evidence` values | reclassified per `ADAPTER_AND_API.md` §3 |
| `meta.case`, `meta.title`, `meta.orientation` | `meta` records the query: seed, traversal degree, active types, `generated_at` |
| `meta.burst` (single object) | list of N bursts |

Write this as a **committed, re-runnable conversion script** — `scripts/build-f1.mjs` or similar.
Do not hand-edit 38 objects, 42 events and 76 links: an error in a freehand rewrite is undetectable
and would silently invalidate the regression baseline. Leave `ocel-data.json` untouched as the source.

**Expected reclassification.** Of the 34 object→object links, 32 are currently `validated`. Under the
new rule only 3 remain — one `pr_body` match and two head-SHA matches. The 29 `ref_match` links
become `extracted`. F1 therefore goes from 32 solid / 2 dashed to **3 solid / 31 dashed**.

**Identity mismatch to resolve.** `vmap.issue_id` is `null`; the fixture keys issue identity on
repo + number (`issue:242864`) with a note that the id was not available. The real API will key on
`issue_id`. Decide whether F1 is backfilled with real ids or kept as a documented exception, and say
which.

## Note on the F1 baseline

F1 must render identically **except** for link evidence styling, which changes by design (step 7):
29 links move from solid to dashed. Geometry, node positions, lane assignment, axis ticks and
tooltips must be unchanged. Report any other diff explicitly rather than updating the baseline.
