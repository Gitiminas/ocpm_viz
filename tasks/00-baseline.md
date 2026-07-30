# Task 0 — Establish the baseline

There is no second version of the app to consolidate — `new_code.html` was input to Claude Design
during mockup creation, not part of this project. What remains is establishing a trustworthy
starting point.

**Do not start Task 1 until all four are done.**

## 1. Inventory the visual regression baseline ✅ already captured

`screenshots/` holds reference renders of the app taken **before** any generalization work. They are
read-only: never regenerate, overwrite or "update" them, and never delete one because the app no
longer looks like it.

- List what is there and describe what each one shows — which time mode, zoom level, scroll position
  and toggle state.
- Write that inventory into `screenshots/README.md` so Task 6 can compare against the right image
  without guessing.
- Flag any rendering state that is **not** covered, so I can decide whether to capture more now.

## 2. Confirm the file inventory

Expected top level: `OCEL Timeline.dc.html`, `support.js`, `ocel_data.json`, `.thumbnail`, `_ds/`.

- Confirm the data file's exact name (`ocel_data.json` vs `ocel-data.json`) — F1 is derived from it.
- Confirm `_ds/` contains the Nocturne tokens and nothing else that is application code.
- Report anything present that the docs don't mention.

## 3. Confirm the coordinate function name

`MOCKUP_OVERVIEW.md` names it `X(t, node)`; an earlier feature inventory called it
`place(time/rank, lane)`. The inventory described a pre-mockup variant, so `X` is expected —
grep and confirm. Use one name from here on.

## 4. Note the burst count defect

`meta.burst.n_commits` says 21; only 20 commit objects carry `in_burst: true`. This is a hardcoding
artifact of the single example and needs no investigation.

**The general requirement:** a burst node's label is always derived from its actual member count,
never read from metadata. Fix it that way in Task 1 and the discrepancy cannot recur.

## 5. Set up the test runner

Tests are a graded deliverable, so this is not deferred. Pick something that runs native ES modules
with no build step, add one trivial passing test, and record the command in `CLAUDE.md`.
