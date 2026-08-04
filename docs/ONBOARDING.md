# How to understand this project

A reading path, for picking the codebase back up after time away and for the next person who
inherits it. `README.md` says how to *run* it; this says how to *understand* it, and in what order.

The short version: **do not read the documentation front to back.** It is roughly 2,500 lines, and
the docs describe *intent*. Intent and running code can disagree without either looking wrong — that
is exactly where the link-anchoring defect behind decision 37 lived, in the gap between what
`ADAPTER_AND_API.md` promised and what two rendering functions each believed about which row an
object occupies. Only the code and the tests carry that layer.

---

## 1. Run it before you read anything (~30 min)

`npm start`, load F1, and drive the controls first.

- Switch **Real → Highlights → Ordinal**. The three time modes are the core of RQ1 and they are
  hand-written arithmetic in `layout/scales.js`. Watching them move is worth more than reading them.
- Open **Stats**, note the longest idle gap, then **hide comments**. It drops 184h → 112h — and
  *downwards*, which is counterintuitive, because F1's longest gap runs to a comment eight days
  after the merge, so hiding comments deletes the tail rather than merging two gaps. That single
  interaction is decision 29 made visible, and it is the whole argument for computing metrics in JS.
- Load `?fixture=F10` and `?fixture=F13`. F1 is one issue and one PR, so it hides every
  generalization bug. It hid decision 37's for as long as it existed.

## 2. The documents, in this order — and skip three

| Order | Doc | Read it for | How |
|---|---|---|---|
| 1 | `README.md` | orientation, the selection model | in full |
| 2 | **`docs/FRONTEND_DATA_NEEDS.md` §1** | the contract the code actually consumes | **§1 in full, then §4–6** |
| 3 | `docs/ARCHITECTURE.md` | layers, module tree, where visibility is decided | in full — it is short |
| 4 | `docs/DECISIONS.md` §1 | the traps | rationale column only |
| 5 | `docs/ADAPTER_AND_API.md` §3–4 | the evidence rule, the `ObjectGraph` shape | those two sections |
| 6 | `docs/DATA_CONTRACT.md` | reference | skim §0 and the §1 headers; look things up later |

If you read only one, read **`FRONTEND_DATA_NEEDS.md`** — §1 is the whole consumed surface, and §4
is the list of fields that are carried and read by nothing.

> ⚠️ **This table used to open with `docs/EXAMPLE.md`**, described as the one document tracing screen
> → payload → database column for a single issue, and recommended above all others. **It does not
> exist and never did** — `git log --all` has no record of it under that name. `docs/DATABASE.md`,
> deferred below, is the same. Both are corrected here rather than written, because writing them
> from their own descriptions would be inventing the content they claim to document. If someone
> still wants the single-object trace, it is a genuinely good idea and it is unwritten work.
> The `vmap.issue_id` quirk it promised to explain is recorded in `tests/fixtures/README.md`.

Read `DECISIONS.md` for the **rationale** column, not the decision column. Most decisions are obvious
once stated; the rationale is where the thesis argument lives, and it is the half that has to be
defended.

**Skip `MOCKUP_OVERVIEW.md` entirely** — 457 lines describing deleted code, kept only as the written
record of what was superseded. **Skip `DATA_REQUIREMENTS.md`** except §7 (the link table); it
predates decisions 7 and 12 and says so in its own header, so reading it early teaches retired
vocabulary. ~~**Defer `DATABASE.md`** until the local replica actually needs rebuilding.~~ — see the
note above: that file does not exist either, so whether a local replica exists at all is an open
question for whoever next touches the database.

## 3. Then the code, following one datum

Trace a single link — commit `eb70000` → issue #242864 — through the pipeline. This is the order in
the header comment of `src/render/timeline.js`:

```
data/loadObjectGraph.js   the only entry point — small, read it whole
model/objectGraph.js      validation + indexing; strings become Dates here (:118) and nowhere else
model/evidence.js         why that link is dashed. Closed vocabulary, throws on unknown
state/state.js            isLinkVisible / selectVisible — where "why isn't it drawn?" ALWAYS ends
layout/nodes.js           which nodes exist
layout/packing.js         which row each one gets
layout/lanes.js           what y that row is
layout/anchors.js         where the link meets the object
render/links.js           the drawing
```

`src/state/state.js` is the highest-value file in the repository. Every filter is a pure predicate
there, and the architecture is built so that adding a filter means editing one file and its tests.
Understanding `isLinkVisible` and `selectVisible` is roughly 40% of the app's behaviour.

`src/render/timeline.js` is the orchestrator. Read it last, and read it as a table of contents rather
than as logic.

## 4. The tests are the executable specification

Run `npm test` and read the **test names** as a list of guarantees — 377 statements about what must
be true, maintained in a way prose is not. Then read two files properly:

- `tests/sublanes.test.js` — the layout invariants, including the "each fixture must actually exhibit
  the property it claims" block. Without that block, an "overlapping PRs" fixture whose PRs do not
  overlap would pass every layout test while verifying nothing.
- `tests/verification.test.js` — the cross-cutting invariants over all 13 fixtures.

`tests/fixtures/README.md` says what each of F1–F13 exists to prove. Knowing that F5 is "the buried
link" and F13 is "a commit inside two PRs" turns them from opaque names into a debugging toolkit:
when something looks wrong, you will know which fixture isolates it.

## 5. The thing that beats reading: break it on purpose

The highest-value exercise. Change one line, run `npm test`, see which assertions fail. It maps code
to consequence far faster than reading, and it reveals what the suite does *not* cover — which
matters more.

| Change | Expected |
|---|---|
| `layout/lanes.js` `rowY` → return `contentTop` | 7 failures, on exactly the multi-object fixtures (F3, F4, F5, F10, F13). This is decision 37's defect, reproducible in one line |
| `model/evidence.js` — move `pr_body` out of `VALIDATED_METHODS` | F1's 3/31 validated/extracted split fails |
| `layout/packing.js` — drop `pull_request` from `SUB_LANE_TYPES` | F3, F4, F13 collapse into one band |
| `state/state.js` — invert one condition in `isLinkVisible` | some toggle test catches it; **some conditions won't be caught.** That gap is the useful discovery |

## 6. On D3 specifically

The live D3 surface in the entire codebase is **five call sites**:

- `d3.select` — `render/timeline.js:46`, `render/minimap.js:38`, `render/minimap.js:48`
- `d3.scaleUtc()` — `render/axis.js:92`, and *only* to choose tick positions in Real mode
- `d3.easeCubicOut` — `render/nodes.js:222`, one tween

Everything else is hand-written: the three time modes (`layout/scales.js`), the path geometry, the
gradients, the row packing. So "learning D3" for this codebase means learning the **selection
API** — `select().append().attr()` — and nothing else. A general D3 tutorial would teach force
layouts, data joins and transitions that do not appear here.

The one D3 subtlety that matters is recorded in `render/format.js:6–18`: `d3.scaleTime` *chooses*
ticks on local midnights, which is why decision 32 exists and why the formatters are hand-written.
That class of bug is silent — the output looks fine and is wrong by an hour.

## 7. Where understanding turns into work

Once through the above, the frontier is the three open questions in `DECISIONS.md` §2:

- **O2** — the commit→PR admission rule. Gates commit-lane density and the RQ2 link counts.
- **O9** — indexes on upstream views. Whether a local replica exists to measure them on is itself
  unknown: the `DATABASE.md` this line used to cite was never committed.
- **O10** — one object per event, or many. Cheapest to change *now*: 8 call sites, and the number
  grows with every renderer that depends on the current grouping.

Reading §2 last, with the code already in your head, is when those stop being abstract.

---

## One standing caveat

The documentation here is unusually thorough, which makes it easy to trust past the point where it
is still true. When a document and the code disagree, **the code is what runs**.
`FRONTEND_DATA_NEEDS.md` is the document most likely to stay accurate, because it was derived by
reading the source rather than written alongside it — and it states that rule in its own header.

`VERIFICATION.md` §4 is the other honest anchor: it lists what has *not* been verified. Read it
whenever you are about to claim the tool does something.
