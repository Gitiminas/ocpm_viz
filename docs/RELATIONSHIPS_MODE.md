# The relationships time mode — the structural mode

What the relationships time mode is, how to see it, where it lives, what it is known not to do well,
and the traps its construction paid for. **The design decisions are in `DECISIONS.md` 95–109
and are not repeated here**; this file is the orientation and the field notes.

Branch `feat/time-mode-off`, written 2026-08-18. Began life as a handover note
(`OFF_MODE_WIP.md`) and was rewritten as a permanent record when the branch closed.

---

## 1. What the feature is

A third time mode beside `absolute` / `discrete` — the two timelines spend position on time
(x) and object identity (y); **relationships** releases the time axis so position can encode
*relationship structure* instead. Time is demoted, not deleted — it survives on edge
arrowheads, a time brush, and the hovercard (decision 95). ⚠️ Built and first documented as
the "off" mode, beside "real", "highlights" and "ordinal"; renamed by decision 113 after
Highlights was removed (112). Decisions 95–112 and the branch name `feat/time-mode-off`
use the old words — read `off` as `relationships`, `real` as `absolute`, `ordinal` as
`discrete`.

Original brief: `/home/minas/projects/Time_Modes_Off.md`, outside the repo, with a mockup at
`/mnt/c/Users/Gedim/Desktop/Thesis Tool/UI_Mockup_Meeting/time_off_structural_mode_sized.png`.
⚠️ Three of its acceptance criteria were **deliberately overridden or deferred** — the fill
ramp (99), click-to-re-layout (100) and the mode-to-mode tween (108).

## 2. How to see it

```
npm start                                          # then http://localhost:8000
npm test                                           # 674 assertions, no browser

node scripts/shot.mjs F10 --mode relationships --layout cluster --width 1500 --height 900
node scripts/shot.mjs --repo kubernetes/kubernetes --seed issue:235959617 \
     --degree 2 --mode relationships --layout cluster        # needs PostgREST up
node scripts/rpc-check.mjs kubernetes/kubernetes issue:355336120 2   # the gate, relationships mode included
```

URL parameters, all for reproducibility: `?mode=relationships`, `?layout=layered|cluster`,
`?brush=0.2,0.8`, `?focus=<objectId>&focusDegree=2`. `shot.mjs` has a flag for each.

Sub-logs worth looking at: **F10** (one issue, three fans — clusters at their best),
**kubernetes #47532** `issue:235959617` (three issues, cross-linked pull requests, a mesh —
rows at their best), **kubernetes #68026** `issue:355336120` (one issue, 34 pull requests —
the capacity limit of both arrangements).

## 3. Architecture

| File | Role |
|---|---|
| `src/layout/engine.js` | `createLayout()` — picks temporal or structural and returns one shape (`kind`). **The one mode branch** (decision 96). |
| `src/layout/structural.js` | The relationships-mode node/edge model: one node per object, bursts, arrowhead direction, brush maths |
| `src/layout/layered.js` | Rows (Sugiyama). Also owns `assignLayers`, `hashId`, `LAYER_ORDER` |
| `src/layout/cluster.js` | Clusters. Balloon seed, then d3-force. Owns the shared force config (`withForces`), `forceFootprint`, `createDragSimulation` |
| `src/render/structural.js` | Drawing, hovercards, dragging |
| `src/render/motion.js` | Settle + idle drift, `pushApart` |
| `src/render/pan.js` | Drag the background to pan, once zoomed in (decision 118) |
| `vendor/d3-force.js` | 15.7 KB, d3-force 3.0.0, ISC, unmodified. See `vendor/README.md` |

`layout/` stays DOM-free and is exercised in bare Node. That is the project's own test of
whether a module is in the right folder, and it is what forced the vendoring decision (104).

What the renderer decides before the layout runs: only the **frame** — `frame()` in
`render/timeline.js` hands the engine the margin and plot size for the active engine
(decision 107). Everything after `createLayout` reads `layout.kind`.

Measured (1100×620 box): zero overlapping marks and nothing outside the box on F1, F13, F10,
kubernetes #47532 @ degree 2 and kubernetes #68026 @ degrees 1–2. Layout costs 9–50 ms.
`scripts/rpc-check.mjs` runs both arrangements against a real payload and was run over ten
real sub-logs (vscode, kubernetes, react; degrees 1–3, before decision 110 capped the range
at 2) — all pass.

## 4. Known weak points

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
- **Label collisions** where pull requests sit close — a 34-fan hub is unreadable by label
  in either arrangement, though the *shape* still reads. The halo keeps labels legible, not
  clean. The obvious next step is a label-placement pass (offset by quadrant, or hide labels
  below a density and show them on hover); nothing is built.
- **A saved view carrying `mode: relationships` restores its controls and chrome** (`markMode` runs
  on preset apply), but a full round-trip — save in relationships mode, reload, apply — has not been
  checked by eye.
- **F3 lays out in a vertical line** (0% of the width). Three nodes with a pinned root and
  no commits — degenerate, but it looks odd.
- **`velocityDecay` (0.55) in `cluster.js` is the drag feel dial.** Lower rings for
  seconds; higher feels like the solver it replaced.

## 5. Traps already paid for — do not rediscover these

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
    after it right, the row ends up 1400px wide in a 980px box, and — since relationships mode
    cannot scroll sideways — the right-hand third is silently lost. The trigger is
    order-versus-alignment conflict, so a synthetic case needs *both*: the test that pins
    it shares a commit between the second and the last pull request; sharing between the
    first and the last does not trigger it.
