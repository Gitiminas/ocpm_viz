# Task 6 — Verification

I cannot reliably eyeball D3 correctness, so prove it. This is not optional and not last-if-time.

## Fixtures

F1 comes from the conversion script built in Task 1. F2–F9 are synthesized. F10 and any real
vscode / react / kubernetes sub-logs need database access and wait until the RPC exists.

**Every synthesized fixture ships with an assertion proving it exhibits its property.** An
"overlapping PRs" fixture whose PRs do not overlap passes while testing nothing — that failure mode
is invisible and defeats the purpose of the whole set.

| ID | Sub-log |
|---|---|
| F1 | Current vscode example — **regression baseline.** Built from `ocel-data.json` by the conversion script in Task 1. ⚠️ Exercises only **one** of the four issue↔PR detection methods (`pr_body`), so it cannot verify the per-method toggles |
| F2 | One issue → multiple PRs, **sequential** (expect: one lane, more nodes) |
| F3 | One issue → multiple PRs, **overlapping** (expect: sub-lanes) |
| F4 | Multiple issues → one PR |
| F5 | Commit linked to multiple PRs |
| F6 | Sub-log with **zero** commits |
| F7 | Sub-log with **multiple** bursts |
| F8 | PR with **no** linked issue (orphan seed) |
| F9 | Issue **reopened** (open → close → reopen → close) — must render as multiple intervals |
| F10 | Deliberately large sub-log (few hundred commits) |
| F11 | **All four detection methods present** (`pr_body`, `branch_name`, `pr_title`, `issue_comment`), so each toggle can be switched independently and verified |
| F12 | Mixed evidence — validated and extracted links on the same object pair, with `n_methods > 1` |

## Then

1. Assertions on layout math — node counts per lane, no overlap within a row, links resolve to real
   endpoints, ordering monotonic in each time mode, sub-lane allocated **only** on temporal overlap,
   reopened objects yielding multiple bars.
2. Confirm F1 unchanged vs `screenshots/`, using the inventory in `screenshots/README.md` to match
   each reference image to the same mode, zoom and scroll state. Compare against **every** image
   that covers a state F1 can reach, not just one. Expected differences: link evidence styling only
   (Task 1 step 7). Report any other diff rather than accepting it.
3. Report what each fixture renders and anything ambiguous.
4. Flag **every** place you guessed rather than silently choosing.

## Also report, for the thesis limitations section

**Per-repo issue↔PR link counts broken down by detection method.**

The four available methods key on GitHub's standard conventions (closing keywords, `fix/123` branch
names, `#N` in titles and comments). Project-specific conventions such as `gh-N`, `bug #N` and
`For #N` — common in **kubernetes and react, two of the three selected repositories** — are not
covered. If link detection is systematically weaker there than on vscode, apparent cross-repository
process differences may be artifacts of detection coverage rather than real behaviour, which is a
direct threat to **RQ2**.

Quantify the per-repo coverage so the limitation can be stated with numbers rather than hedged.

**Possible mitigation if the gap is large:** commit-message-based issue→PR linking, joining
`mv_commit_message_issue_links_all` through `commit_pr_links`, which would recover some recall.
