# Visual regression baseline

Eleven reference renders of the app captured **before** any generalization work, on 2026-07-30,
against the hardcoded vscode sub-log (issue #242864 → PR #243221 → commits).

**Read-only.** Never regenerate, overwrite or delete one because the app no longer looks like it.
When the app diverges, that is either an expected difference (§3) or a regression to report — in
neither case is the fix to recapture the image.

Task 6 compares against these. Use §2 to match a rendering state to the right image; use §3 so
mandated differences are not misread as regressions.

---

## 1. Common to every image

Invariant across all eleven:

- Repo `microsoft/vscode`, object `Issue #242864`, breadcrumb `Issue #242864 → PR #243221 → commits`
- Sidebar section header reads `OCEL CASE`
- Viewport 1920×1200

True unless the image's row in §2 says otherwise:

- **No focus** (header reads `No focus`) — the sole exception is `…17-36-02`
- **Default zoom, scrolled fully left**, minimap viewport spanning the full track — exceptions are
  `…15-39-12` (zoomed in, scrolled right) and `…17-36-33` (scrolled down)
- **Burst collapsed** into one node badged `21`, labelled `bulk push` — the sole exception is
  `…17-36-33`

---

## 2. The eleven images

### Timeline — mode and zoom coverage

| File | Mode | Zoom & scroll | Toggle state | What it is for |
|---|---|---|---|---|
| `…15-38-45 .png` | **Highlights** | default, left | all tracks on · comments on · both link masters on | Highlights run-grouping: unremarkable commits folded into count badges (`2`, and a dashed group) between the anchors `dcc7479`, `bulk push`, `279244f` |
| `…15-38-53 .png` | **Real** | default, left | as above | Real mode. The commit lane packs into ~6 stacked rows where commits collide; axis runs Mar 09 → Mar 19 |
| `…15-39-02 .png` | **Ordinal** | default, left | as above | Ordinal mode, all 32 commits evenly spaced. Gap bands `≈ 1 day` / `≈ 7 days`; duration annotations `4d 16h` (issue) and `4h 45m` (PR) |
| `…15-39-12 .png` | **Ordinal** | **zoomed in, scrolled right** | as above | The only zoom + horizontal-scroll capture. Minimap viewport window is ~⅓ width, right of centre; sticky lane labels have scrolled out of view; only `7d2f5bb` and `279244f` remain in the viewport |

### Timeline — toggle, focus and aggregation states

| File | Mode | Zoom & scroll | Toggle state | What it is for |
|---|---|---|---|---|
| `…15-39-43 .png` | **Ordinal** | default, left | Issue + PR sub-rows **expanded**, **Comments off on both** · Validated links master **off** (both children off) · Extracted links master **indeterminate**, `Commit ⇔ Issue` off, `Commit ⇔ PR` **on** | The dependency-aware sidebar: an indeterminate master over mixed children. Only extracted commit⇔PR links draw, so the validated commit→PR bundle from `…15-39-02` is absent |
| `…15-40-13 .png` | **Ordinal** | default, left | **Issue track off** · PR + Commit on · PR comments off · **both link masters off** · actor **@connor4312 selected** | Actor trail rendering: green rings on that actor's nodes plus a dashed green trail. Sidebar itself is scrolled down ~50px |
| `…15-40-22 .png` | **Ordinal** | default, left | identical to `…15-40-13` | Same timeline, with the **actor card open** for @connor4312 — the real activity list *after* the artificial 650 ms spinner, not the blurred placeholder |
| `…17-36-02 .png` | **Ordinal** | default, left | all tracks on · both link masters on | **The only focused capture.** Header reads `Focus: 67e6e17`; that commit and its linked PR stay at full opacity while the issue lane and every other commit dim to 0.15. The **degree stepper** pill (`− Deg 1 +`) is anchored to the right of the focused node. Covers `focusSet()` at degree 1 |
| `…17-36-33 .png` | **Highlights** | default, **scrolled down** | all tracks on · both link masters on | **The only expanded-burst capture.** The burst is unfolded into its stacked members with the `−` re-collapse handle and the label `21 commits`; the full link fan from every member to the PR is drawn. Scrolled vertically so the issue and PR lanes are above the viewport |
| `…17-36-51 .png` | **Highlights** | default, left | all tracks on · both link masters on | **Highlights run-group expanded.** The `2` badge from `…15-38-45` is broken out into `eb70000` and `c2676f7` as individual nodes inside a dashed bounding box; the later dashed group stays folded. Burst still collapsed |

### Stats

| File | Page | Toggle state | What it is for |
|---|---|---|---|
| `…15-40-45 .png` | **Stats** | Case statistics on · Milestones on · Activity heatmap disabled (`Soon`) | The 9 metric cards (8 visible, `Actors involved` clipped at the fold), the 6-item milestone list, and the blurred `In progress` fake-heatmap card |

Coverage: Real ×1, Highlights ×3, Ordinal ×6, Stats ×1.

---

## 3. Differences that are mandated, not regressions

Four planned changes will make the app differ from every relevant image. Expect them; do not treat
them as regressions, and do not update the baseline.

| # | Change | Visible effect | Owner |
|---|---|---|---|
| 1 | **Link evidence reclassification** (decision 7) | 29 `ref_match` links move validated → extracted, i.e. solid → dashed with a `?` badge. F1 goes from 32 solid / 2 dashed to 3 solid / 31 dashed. Most visible in `…17-36-33`, where the whole burst link fan is drawn | Task 1 step 7 |
| 2 | **UTC rendering** (decision 9) | Every timestamp shifts **−1 hour**. These screenshots were captured on a UTC+01:00 machine and show local time: the issue opens at `05:15:54Z` in the data but renders `06:15:54` here. Affects axis ticks, tooltips, the milestone list and the stats page | Task 5 |
| 3 | **Burst label from actual member count** | The burst label reads `21` in **nine** of the eleven images — as the collapsed badge, and as `21 commits` on the expanded handle in `…17-36-33`. It must read **20**: 21 is `meta.burst.n_commits`, but only 20 commits carry `in_burst: true` | Task 0 §4 → Task 1 step 2 |
| 4 | **`case` → `subLog` rename** (decision 1) | Sidebar header `OCEL CASE` and the stats page title/card `Case statistics` must no longer contain the word | Task 1 step 6 |
| 5 | **Links coloured by the object they reach** (decision 24) | Link gradients now carry the *target object's* colour along most of their length instead of fading to the qualifier colour at the very end. On F1 this changes link colour only — geometry, positions and node placement are untouched. The one `referenced_issue` link and its `?` badge turn from orange-red to the issue's blurple, because that qualifier had been borrowing the evidence palette | Task 2 |

Everything else — geometry, node positions, lane and row assignment, axis tick placement, gap bands,
glyph shapes, focus dimming, actor trails, tooltip layout — must be unchanged. **Report any other
diff rather than accepting it.**

---

## 4. States still not covered

No image captures these, so Task 6 cannot verify them against a baseline. None is critical; the
two that were — a focused graph and an expanded burst — were captured in the 17-36-* set.

**Interaction states**
- Hover tooltip, and the right-click **pinned** tooltip with its copy affordance
- Minimap mid-drag and mid-handle-resize
- The repo / object combo dropdowns open
- Legend hover highlighting
- The actor card's **pre-click** blurred lookup prompt (only the post-spinner state is captured)
- Focus at **degree 2** — `…17-36-02` covers degree 1 only, so the stepper's effect on the BFS
  radius has no reference

**Rendering states**
- Zoom + scroll in **Real** and **Highlights** modes (only Ordinal is captured zoomed)
- Zoom below default, and either extreme (`MINK` / `MAXK`)
- The stats page **scrolled** — three of the nine cards sit below the fold
- Any window size other than 1920×1200
