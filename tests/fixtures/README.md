# Fixtures

Every fixture is a complete `ObjectGraph` (`docs/ADAPTER_AND_API.md` §4) that can be loaded
through `loadObjectGraph()` exactly as a real sub-log would be.

| ID | Sub-log | Property it exists to exhibit | Status |
|---|---|---|---|
| F1 | The vscode example the mockup was built around | **regression baseline** — real data | built |
| F2 | One issue, two PRs, sequential | they must share one sub-lane | built |
| F3 | One issue, two PRs, overlapping | each must get its own sub-lane | built |
| F4 | Two overlapping issues, one PR | the same rule applies to issues | built |
| F5 | One commit referenced by two PRs | extra edges, no extra layout | built |
| F6 | Zero commits | the commit lane may be empty | built |
| F7 | Two bursts plus loose commits | burst handling works for N, not 1 | built |
| F8 | A PR with no linked issue | nothing may assume an issue exists | built |
| F9 | An issue opened, closed, reopened, closed | two bars on one row | built |
| F13 | Two concurrent PRs, several commits each, one commit shared | many links into one lane stay individually readable | built |
| F10 | Deliberately large sub-log (few hundred commits) | render behaviour at scale | Task 6 |
| F11 | All four issue↔PR detection methods present | per-method toggles | Task 6 |
| F12 | Mixed evidence on one object pair, `n_methods > 1` | multi-method agreement | Task 6 |

**Every synthesized fixture ships with an assertion proving it exhibits its property**
(`tests/sublanes.test.js`, first describe block). This is not ceremony: an "overlapping PRs"
fixture whose PRs do not actually overlap passes every layout test while verifying nothing, and
that failure mode is completely invisible.

### F2–F9 are synthetic — never cite them

```
npm run build:fixtures      # regenerate F1 and F2–F9
```

Built by `scripts/build-synthetic-fixtures.mjs`. They are **not real GitHub data**; each carries
`meta.data_honesty.synthetic` saying so, and the sidebar labels them. They exist to exercise
structures F1 cannot reach. No figure, count or claim about real workflow behaviour may come from
them.

---

## F1 — `F1.json`

Built from `ocel-data.json` by `scripts/build-f1.mjs`. **Do not hand-edit it.**

```
node scripts/build-f1.mjs            # regenerate
node scripts/build-f1.mjs --check    # fail if the committed fixture is stale
```

38 objects (1 issue, 1 PR, 32 commits, 4 actors) · 42 events · 76 links (34 object→object,
42 event→actor).

`ocel-data.json` stays in the repo unmodified as the source. The conversion makes **shape
changes only, never value changes**, with two mandated exceptions noted below.

### What the conversion does

| Source | F1 |
|---|---|
| `t_start` / `t_end` per object | `intervals: [{start, end}]` (decision 4); `[]` where there is no lifecycle |
| `evidence: "inferred"` | `"extracted"` (decision 7) |
| `evidence` values | recomputed from the detection method by the rule in `ADAPTER_AND_API.md` §3 |
| `method` free-text prose | the `LINK_METHOD` enum, plus `link_methods` and `n_methods` |
| `meta.case`, `meta.title`, `meta.orientation` | removed — decision 1 forbids a case notion, and the breadcrumb is derived from the query instead |
| `meta.burst` | removed — bursts derive from `push_id` |
| `meta` | gains `seed`, `traversal_degree`, `active_object_types`, `active_link_methods`, `generated_at` |

### The two value changes, and why they are not freehand edits

**Evidence reclassification.** 29 `ref_match` links move from validated to extracted, so F1 goes
from 32 solid / 2 dashed to **3 validated / 31 extracted**. The three survivors are one `pr_body`
match and two `head_sha` matches. This is decision 7 applied, not a correction — and the script
asserts the 3/31 split rather than trusting it.

**Method prose dropped.** The source's free-text `method` is replaced by the enum rather than
carried alongside it, because nothing upstream produces that prose: a field only this fixture
could populate would make F1 an unfaithful model of a real sub-log. What is lost is which
specific keyword or SHA matched; the adapter supplies that properly as `link_convention` /
`ref_scope` when it lands.

### Quirks carried through unchanged

These are genuine oddities of the source. They are preserved, not fixed — **do not treat F1 as
the model for id handling.** A real sub-log will not look like this.

- **`vmap.issue_id` is `null`.** The issue is keyed on repo + number (`issue:242864`).
  *Resolved as a documented exception, not backfilled.* The real `issue_id` is not present
  anywhere in the source, so supplying one would mean fabricating data. The real API keys on
  `issue_id` from `issues_identity` / `mv_issue_id_to_number`; F1 therefore exercises the
  renderer's id handling but **cannot** validate id-based joins.
- **12 of 32 commits have `burst_id: null`** and `in_burst: false`.
- **`vmap.in_burst` / `vmap.burst_id` are still present** on commit objects. They are carried
  because the rule is to preserve values — but **nothing reads them.** Bursts are derived from
  `push_id`, which is why the burst renders with its true size of 20 and not the 21 that
  `meta.burst.n_commits` claimed. Leaving the stale fields visible is deliberate: it keeps the
  discrepancy inspectable instead of hiding the defect the derivation fixes.
- **No `repo` objects.** `repo` is a real object type (decision 15), but the source carries the
  repo only as a string field on each object and in `meta`. Synthesizing repo objects and their
  links would be fabricating relationships, so F1 has none. Consequence: **the `repo` object
  type is not exercised by F1** and needs a synthesized fixture or the real API.

### What F1 cannot verify

- **Only one issue and one PR**, so it cannot catch a regression in multi-object layout. That is
  what F2–F5 exist for.
- **Only two of the four issue↔PR detection methods** appear (`pr_body`; the rest of the object
  links are commit attribution), so the per-method toggles in Task 3 are unverifiable here —
  hence F11.
- **Every link has `n_methods: 1`**, so multi-method agreement is unexercised — hence F12.
- **No reopen**, so every object yields exactly one interval — hence F9.
- **`generated_at` is fixed**, not `now()`, so the fixture is byte-stable across runs.
