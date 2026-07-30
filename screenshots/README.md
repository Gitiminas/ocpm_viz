# Visual regression baseline

Eight reference renders of the app captured **before** any generalization work, on 2026-07-30,
against the hardcoded vscode sub-log (issue #242864 → PR #243221 → commits).

**Read-only.** Never regenerate, overwrite or delete one because the app no longer looks like it.
When the app diverges, that is either an expected difference (§3) or a regression to report — in
neither case is the fix to recapture the image.

Task 6 compares against these. Use §2 to match a rendering state to the right image; use §3 so
mandated differences are not misread as regressions.

---

## 1. Common to every image

Unless a row in §2 says otherwise:

- Repo `microsoft/vscode`, object `Issue #242864`, breadcrumb `Issue #242864 → PR #243221 → commits`
- **No focus** (header reads `No focus`) — no image captures a focused/dimmed graph
- Default zoom, scrolled fully left — the minimap viewport window spans the full track
- Burst **collapsed**, rendered as one node badged `21` labelled `bulk push`
- Sidebar shows `OCEL CASE` as the section header
- Viewport 1920×1200

---

## 2. The eight images

| File | Page / mode | Zoom & scroll | Toggle state | What it is for |
|---|---|---|---|---|
| `…15-38-45 .png` | Timeline · **Highlights** | default, left | all tracks on · comments on · both link masters on | Highlights mode with run-grouping: unremarkable commits folded into count badges (`2`, dashed groups) between the anchors `dcc7479`, `bulk push`, `279244f` |
| `…15-38-53 .png` | Timeline · **Real** | default, left | as above | Real mode. The commit lane packs into ~6 stacked rows where commits collide; axis runs Mar 09 → Mar 19 |
| `…15-39-02 .png` | Timeline · **Ordinal** | default, left | as above | Ordinal mode, all 32 commits evenly spaced. Gap bands `≈ 1 day` / `≈ 7 days`; duration annotations `4d 16h` (issue) and `4h 45m` (PR) |
| `…15-39-12 .png` | Timeline · **Ordinal** | **zoomed in, scrolled right** | as above | The only zoom + horizontal-scroll capture. Minimap viewport window is ~⅓ width, right of centre; sticky lane labels have scrolled out of view; only `7d2f5bb` and `279244f` remain in the viewport |
| `…15-39-43 .png` | Timeline · **Ordinal** | default, left | Issue + PR sub-rows **expanded**, **Comments off on both** · Validated links master **off** (both children off) · Extracted links master **indeterminate**, `Commit ⇔ Issue` off, `Commit ⇔ PR` **on** | The dependency-aware sidebar: an indeterminate master over mixed children. Only extracted commit⇔PR links draw, so the validated commit→PR bundle from `…15-39-02` is absent |
| `…15-40-13 .png` | Timeline · **Ordinal** | default, left | **Issue track off** · PR + Commit on · PR comments off · **both link masters off** · actor **@connor4312 selected** | Actor trail rendering: green rings on that actor's nodes plus a dashed green trail. Sidebar itself is scrolled down ~50px |
| `…15-40-22 .png` | Timeline · **Ordinal** | default, left | identical to `…15-40-13` | Same timeline, with the **actor card open** for @connor4312 — the real activity list *after* the artificial 650 ms spinner, not the blurred placeholder |
| `…15-40-45 .png` | **Stats** page | not scrolled | dashboards: Case statistics on · Milestones on · Activity heatmap disabled (`Soon`) | The 9 metric cards (8 visible, `Actors involved` clipped at the fold), the 6-item milestone list, and the blurred `In progress` fake-heatmap card |

Mode coverage: Real ×1, Highlights ×1, Ordinal ×5, Stats ×1.

---

## 3. Differences that are mandated, not regressions

Four planned changes will make the app differ from every relevant image. Expect them; do not treat
them as regressions, and do not update the baseline.

| # | Change | Visible effect | Owner |
|---|---|---|---|
| 1 | **Link evidence reclassification** (decision 7) | 29 `ref_match` links move validated → extracted, i.e. solid → dashed with a `?` badge. F1 goes from 32 solid / 2 dashed to 3 solid / 31 dashed | Task 1 step 7 |
| 2 | **UTC rendering** (decision 9) | Every timestamp shifts **−1 hour**. These screenshots were captured on a UTC+01:00 machine and show local time: the issue opens at `05:15:54Z` in the data but renders `06:15:54` here. Affects axis ticks, tooltips, the milestone list and the stats page | Task 5 |
| 3 | **Burst label from actual member count** | The collapsed burst badge reads `21` in six of these images (all but `…15-39-12` and the stats page). It must read **20** — 21 is `meta.burst.n_commits`, but only 20 commits carry `in_burst: true` | Task 0 §4 → Task 1 step 2 |
| 4 | **`case` → `subLog` rename** (decision 1) | Sidebar header `OCEL CASE` and the stats page title/card `Case statistics` must no longer contain the word | Task 1 step 6 |

Everything else — geometry, node positions, lane and row assignment, axis tick placement, gap bands,
glyph shapes, actor trails, tooltip layout — must be unchanged. **Report any other diff rather than
accepting it.**

---

## 4. States not covered

No image captures these, so Task 6 cannot verify them against a baseline. Flagged for a decision on
whether to capture more before the app changes:

**Interaction states**
- Any **focused** graph — all eight read `No focus`, so focus dimming, the focus BFS at degree 1 vs 2,
  and the degree stepper are entirely uncovered
- Hover tooltip, and the right-click **pinned** tooltip with its copy affordance
- Minimap mid-drag and mid-handle-resize
- The repo / object combo dropdowns open
- Legend hover highlighting
- The actor card's **pre-click** blurred lookup prompt (only the post-spinner state is captured)

**Rendering states**
- Burst **expanded** — all six burst-bearing images show it collapsed, so the expanded members and
  the `−` re-collapse handle have no reference
- Highlights-mode run groups **expanded**
- Zoom + scroll in **Real** and **Highlights** modes (only Ordinal is captured zoomed)
- Zoom below default, and either extreme (`MINK` / `MAXK`)
- The stats page **scrolled** — three of the nine cards sit below the fold
- Any window size other than 1920×1200

The highest-value gaps are the **expanded burst** and a **focused** graph: both are core to the
generalization work, and both are cheap to capture now and impossible to capture later.
