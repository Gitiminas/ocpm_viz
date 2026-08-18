# Time mode "off" — working state

**Temporary.** This is a handover note for work in progress on `feat/time-mode-off`, not a
design record. When the branch merges, the decisions in §4 move to `DECISIONS.md` and this
file is deleted. It exists because the work spans more sessions than one context holds.

Written 2026-08-18, updated the same day after the cluster/drag fixes below. Branch
`feat/time-mode-off`, 27 commits ahead of `main`, **674 tests across 118 suites, all
passing**.

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
npm test                                           # 674 assertions, no browser

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
10. **A hub claims its whole cluster's room, not just its own mark.** `forceFootprint` in
    `cluster.js` keeps two unrelated marks `footprint + footprint + gap` apart, where a
    hub's footprint is the reach of the fan hanging off it. Exempt: ancestor/descendant
    (a fan sits inside its issue's footprint by design), co-parents (two issues sharing a
    PR are legitimately close — the shared node is drawn between them), and leaf–leaf
    (that is the collision force's job). Siblings are *not* exempt: sharing a parent is
    what makes two PRs neighbours, not a licence to overlap. `footprintPairs` is exported
    and its exemptions are each pinned by a test. Measured on kubernetes #47532 and F10:
    every claim holds in the fitted picture.
11. **A drag rearranges the neighbourhood and leaves the picture's orientation alone.**
    `createDragSimulation` now: (a) draws every free mark toward where it stood when the
    gesture began (home springs, 0.08), except the marks *linked to* the one in hand,
    which are the neighbourhood being rearranged and follow freely; (b) keeps the
    layout's anchor root pinned unless it is the mark in hand; (c) ranges the charge at
    260px so unlinked marks stop pushing each other; (d) runs the footprint force, so a
    fan pushed into another fan makes it step aside *as a fan*. Before: on kubernetes
    #47532 the anchor issue itself travelled 256px during a drag, all 23 unrelated marks
    moved >30px (one 500px), and on F10 three marks left the box. After: anchor 0px, F10
    max unrelated 56px and nothing outside, no commit→PR link stretched >1.5×. Reported
    as "once you start moving items it messes up the orientation".
12. **Off mode has its own frame, and the mode's chrome is settled BEFORE the layout
    measures the surface.** `STRUCTURAL_MARGIN` (16px) in `render/timeline.js` replaces
    the timeline's `MARGIN` (180/120/150/32 — lane labels and axis, which off mode does
    not draw); `frame()` is the renderer's one look at the mode before `createLayout`.
    `markMode` in `main.js` now hides the minimap and shows the brush *before* the render
    that follows a mode change, and runs on preset apply too. Together these were the
    "cramped" complaint: on a 1500×900 window the layout was fitted into 850×498 of a
    1150×680 surface, and then the surface grew underneath it. The picture is now about
    twice its former linear size at the same viewport. `MAX_FILL_SCALE` was blamed and
    was not the cause — see its comment.

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

1. ~~**Mode-to-mode tween.**~~ **Dropped, 2026-08-18 — a decision, not an omission.**
   Switching between a timeline and off mode cuts. It is presentation only: no question in
   Q1–Q10 and no metric depends on it, the motion cannot be verified headlessly (only its
   end frames can), and the closing work below is worth more within the timebox. If a
   successor wants it: `captureTween` (`render/timeline.js`) already snapshots per-node
   positions and the structural renderer reports live marks; the missing piece is a pure
   mapping in `layout/` between the timeline's per-EVENT nodes and off mode's per-OBJECT
   nodes — the natural rule is an object ↔ its first event mark (its open/first-observed
   glyph, which `nodeByObject` already resolves), and a push ↔ its burst node by `push_id`.
   Goes into `DECISIONS.md` as "deferred; presentation only" when §4 migrates.
2. ~~**Verification sweep.**~~ **Done, 2026-08-18.** `scripts/rpc-check.mjs` now runs off
   mode through `createLayout` in both arrangements: finite positions, inside the box, no
   overlapping marks, every edge end resolves, finite extent, and the clustered
   arrangement's footprint claims (soft shortfalls reported; under ¾ of a claim fails).
   Run over ten real sub-logs (vscode, kubernetes, react; degrees 1–3; 5 to 46 marks):
   all PASS. Two defects found and fixed on the way, both on the biggest hub in the
   database, kubernetes #68026 (one issue, 34 pull requests): the layered row overflowed
   the box (trap 8.11 below), and the clustered footprints fell short by up to 9% — the
   latter is a capacity limit, not a bug (zero overlapping marks, every commit nearest its
   own PR), and the gate says so rather than failing.
3. **The write-up.** No `DECISIONS.md` entry exists yet — §4 above is the raw material.
   `ARCHITECTURE.md`, `README.md` and `simple_architecture.md` all still describe three
   modes and one layout engine.
4. **Label collisions** where two pull requests sit close. The halo keeps them legible, not
   clean.
5. **`?mode=off` is not in any preset.** `serializeState` carries `mode`, and applying a
   preset now calls `markMode`/`markLayout` so the controls and chrome follow the restored
   mode — but a full round-trip (save in off mode, reload, apply) is still unverified by
   eye.

## 7. Known weak points

- **Clusters on a mesh.** kubernetes #47532 has 3 issues, cross-linked pull requests and 7
  level-skipping links. Rows are the better layout there; clusters are readable but busy.
  Better since the footprint force (fans no longer graze) and the frame fix (twice the
  size), but the two minor issues still sit inside the main issue's neighbourhood — they
  are co-parents of its pull requests, so that is where the links put them.
- **The clustered drawing is round, and the box is wide.** A balloon layout fills its
  height and leaves ~half the width; the anisotropic centring in `cluster.js` softens
  this only slightly. Not fixed; a non-uniform stretch would distort distances, which
  the layout's claim forbids.
- **Dragging a fan into another fan moves the other fan a long way** (measured up to
  ~330px on kubernetes #47532) — intact, commits and all, but far. That is the footprint
  force keeping its promise; if it reads as too eager, `FOOTPRINT_STRENGTH` is the dial.
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
8. **The surface is measured when the layout runs, and the chrome around it must already
   be in its final state.** The minimap was hidden from `onRendered` — after the layout
   had fitted the drawing into a surface the minimap was still shortening. Nothing errors;
   the picture is just half the size it has room for, and every measurement of the layout
   in Node says it is fine. Anything else that changes the column's height (banner, brush)
   has the same power. `markMode` runs first now; keep it that way.
9. **Headless Edge lays the page out in a viewport ~90px shorter than `--window-size`,
   then captures at the full size.** `window.innerHeight` reads 807 for a 900px window
   while the app renders. A real browser fires `resize` and re-renders; the screenshot
   does not, so a viewport-fitted drawing is ~10% smaller in a shot than on a screen of
   the same size. Compare fill between shots, never against the box. Noted in `shot.mjs`.
10. **A d3 custom force gets its nodes from `initialize`, and pairs are best decided
    there.** `forceFootprint` computes its constrained pairs once, in `initialize`, from
    the links and lanes; doing it per tick would be O(n²) work for nothing, and doing it
    outside would need the caller to know which nodes the simulation resolved.

11. **A forward chain only closes gaps that are too small; it never closes gaps that are
    too big.** `separateRow` in `layered.js` promised a right-to-left sweep and only
    shifted the row. When one mark near the left end of the row order is aligned toward
    the centre (a commit shared with a mark at the far end), the chain pushes every mark
    after it right, the row ends up 1400px wide in a 980px box, and — since off mode
    cannot scroll sideways — the right-hand third is silently lost. The trigger is
    order-versus-alignment conflict, so a synthetic case needs *both*: the test that pins
    it shares a commit between the second and the last pull request; sharing between the
    first and the last does not trigger it.
## 9. Where to pick up

6.1 is dropped and 6.2 is done. What remains is 6.3, the write-up: migrate §4 into
`DECISIONS.md` (as numbered decisions, with the tween deferral), then bring
`ARCHITECTURE.md`, `README.md` and the two untracked `simple_*.md` files current — they
still describe three modes and one layout engine — and delete this file. The known weak
points in §7 (label collisions above all) are polish for whatever time is left.
