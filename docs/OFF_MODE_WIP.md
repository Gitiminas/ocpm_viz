# Time mode "off" — working state

**Temporary.** This is a handover note for work in progress on `feat/time-mode-off`, not a
design record. When the branch merges, the decisions in §4 move to `DECISIONS.md` and this
file is deleted. It exists because the work spans more sessions than one context holds.

Written 2026-08-18. Branch `feat/time-mode-off`, 24 commits ahead of `main`, **658 tests
across 115 suites, all passing**.

---

## 1. What the feature is

A fourth time mode beside `real` / `highlights` / `ordinal`. The three timelines spend
position on time (x) and object identity (y); **off** releases the time axis so position can
encode *relationship structure* instead. Time is demoted, not deleted — it survives on edge
arrowheads, a time brush, and the hovercard.

Original brief: `/home/minas/projects/Time_Modes_Off.md`, with a mockup at
`/mnt/c/Users/Gedim/Desktop/Thesis Tool/UI_Mockup_Meeting/time_off_structural_mode_sized.png`.
⚠️ Several points in that brief were **deliberately overridden** — see §4.

## 2. How to see it

```
npm start                                          # then http://localhost:8000
npm test                                           # 658 assertions, no browser

node scripts/shot.mjs F10 --mode off --layout cluster
node scripts/shot.mjs --repo kubernetes/kubernetes --seed issue:235959617 \
     --degree 2 --mode off --layout cluster        # needs PostgREST up
```

URL parameters, all for reproducibility: `?mode=off`, `?layout=layered|cluster`,
`?brush=0.2,0.8`, `?focus=<objectId>&focusDegree=2`. `shot.mjs` has a flag for each.

## 3. Architecture

| File | Role |
|---|---|
| `src/layout/engine.js` | `createLayout()` — picks temporal or structural. **The one mode branch.** |
| `src/layout/structural.js` | The off-mode node/edge model: one node per object, bursts, arrowhead direction, brush maths |
| `src/layout/layered.js` | Layout A — rows (Sugiyama). Also owns `assignLayers`, `hashId` |
| `src/layout/cluster.js` | Layout B — clusters. Balloon seed, then d3-force. Owns the shared force config |
| `src/render/structural.js` | Drawing, hovercards, dragging |
| `src/render/motion.js` | Settle + idle drift, `pushApart` |
| `vendor/d3-force.js` | 15.7 KB, d3-force 3.0.0, ISC, unmodified. See `vendor/README.md` |

`layout/` stays DOM-free and is exercised in bare Node. That is the project's own test of
whether a module is in the right folder, and it is what forced the vendoring decision.

## 4. Decisions already made — do not re-litigate without reading these

1. **One node per object**, not per event. An issue with 288 comments is one circle; its
   lifecycle is listed in the hovercard, whose kicker reads `· entire lifecycle` so it
   cannot be mistaken for a timeline mark.
2. **No folding rule of its own.** Folding is `push_id` and nothing else (decision 94).
   Two tests pin this so a future "just group these too" has to be argued for.
3. **Not a tree.** A commit in two pull requests stays ONE node, drawn between them.
   Duplicating it would let a reader count it twice; dropping an edge would hide the
   convergence OCPM exists to show.
4. **Colour means "which object"**, as in every other mode. ⚠️ Overrides the brief's
   acceptance criteria 3 and 5, which asked for a light-to-dark time ramp on the fill. It
   was built and removed: a lone issue came out pale lilac instead of the accent blurple,
   pull requests lost their orange, and anyone carrying the mapping across from the
   timeline or the statistics page was misled (decision 86's objection).
5. **Focus does not re-lay-out.** ⚠️ Overrides the brief's "re-centre and lay out its
   n-level neighbourhood". Moving the picture on a click destroys object constancy and
   makes two views incomparable. Graded dimming gives the reading without moving anything.
6. **Two layouts, both kept.** Rows read as a process direction and win on meshes; clusters
   read as grouping and win on hub-shaped sub-logs. Neither is right in general.
7. **Motion is presentation only.** Both layouts are pure functions of the sub-log; the
   drift is an offset that integrates to zero, and a test asserts that.
8. **A drag stores an OFFSET**, not a position, so the layout stays pure and clearing the
   offsets restores the computed arrangement exactly.
9. **Vendored d3-force rather than installed.** No package manager, no bundler, and a
   browser cannot resolve a bare specifier without one.

## 5. What is done

- Both layouts, switchable from a **Rows / Clusters** toggle that appears only in off mode.
- Node model, bundled edges (one line per evidence class), arrowheads by temporal
  precedence, legend rows, hovercards with right-click pinning.
- Time brush — one rail, two handles, in the slot the minimap vacates. Tests span
  **overlap**, so an issue open March–June shows when you brush April.
- Focus with degree-of-interest falloff (1 → 0.72 → 0.4 → dim), graded in off mode only so
  the timeline's screenshot baseline is untouched.
- Motion: settle ~620 ms, idle drift, `prefers-reduced-motion` honoured, drift frozen
  during a gesture, `shot.mjs` forces reduced motion so screenshots stay comparable.
- Dragging: live d3-force simulation, neighbours follow, nudges recorded on `end`, reset
  folded into the existing zoom-reset pill.

Measured (1100×620 box): zero overlapping marks and nothing outside the box on F1, F13,
F10 and kubernetes #47532 @ degree 2. Layout costs 9–20 ms.

## 6. What is NOT done

1. **Mode-to-mode tween.** Switching between a timeline and off mode cuts. `captureTween`
   exists and the structural renderer already reports live marks; the missing piece is
   mapping a timeline's per-event nodes onto off mode's per-object nodes.
2. **Verification sweep.** `scripts/rpc-check.mjs` still exercises three modes, not four.
   Off mode has never been run against more than two real sub-logs.
3. **The write-up.** No `DECISIONS.md` entry exists yet — §4 above is the raw material.
   `ARCHITECTURE.md`, `README.md` and `simple_architecture.md` all still describe three
   modes and one layout engine.
4. **Label collisions** where two pull requests sit close. The halo keeps them legible, not
   clean.
5. **`?mode=off` is not in any preset.** `serializeState` carries `mode`, so a saved view
   should restore it — unverified.

## 7. Known weak points

- **Clusters on a mesh.** kubernetes #47532 has 3 issues, cross-linked pull requests and 7
  level-skipping links. Rows are the better layout there; clusters are readable but busy.
- **F3 lays out in a vertical line** (0% of the width). Three nodes with a pinned root and
  no commits — degenerate, but it looks odd.
- **`velocityDecay` (0.55) in `cluster.js` is the drag feel dial.** Lower rings for
  seconds; higher feels like the solver it replaced.

## 8. Traps already paid for — do not rediscover these

1. **The fit scales positions but NOT radii.** Anything measured after `centreInBox` is in
   post-scale pixels. This has caused three separate bugs: overlaps reappearing after the
   fit (twice, in both layouts) and a wrong diagnosis that "the springs are losing" when
   observed link lengths ran past their rest lengths. Divide by the fit scale before
   comparing anything to a configured distance.
2. **`forceLink` MUTATES the link array**, replacing ids with node references. Sharing one
   array across two simulations silently binds the second to the first's nodes. Both
   callers build links fresh; a test did not, and a neighbour travelled 18px instead of 370.
3. **d3-force charges are NEGATIVE.** A hand-written repulsion term multiplying
   `charge_i × charge_j` turns two negatives into a huge positive — this produced a 14,000×
   force and flung neighbours off screen.
4. **`cdn.jsdelivr.net/npm/d3-force@3/+esm` inlines nothing.** It imports three siblings by
   absolute jsdelivr path and is useless vendored. Use the esm.sh bundled build.
5. **Barycentre ordering is not monotonic.** Keep the best arrangement *seen*, not the last.
6. **Angles wrap.** Use a circular mean, and cut a circular ordering at its largest gap.
7. **A test that fails may be asserting the wrong property.** Three did here: F7 has no
   links at all; "a commit is nearer its own PR than any other" is false for a wide group;
   "a lone issue sits at the canvas centre" is false once the fit centres the *drawing*.

## 9. Where to pick up

Step 6.1 (the tween) is the last feature; 6.2 and 6.3 are the closing work and should not
be skipped — the docs currently describe a tool that no longer exists.
