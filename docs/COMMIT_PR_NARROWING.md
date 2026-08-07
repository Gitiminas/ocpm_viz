# Which commits belong to a pull request

*Written 2026-08-07. Concerns `fe.commit_pr_link` in `sql/fe_layer.sql`. Settled as
decision 80, replacing decision 61. Prompted by `report2.md`.*

---

## The short version

GitHub never tells us which commits are in a pull request. The best evidence we have is
`ref_match`: *this commit was pushed to the PR's branch while the PR was open.*

That evidence is noisy. Commits land on your branch for two reasons:

1. **You wrote them.** They belong to your PR.
2. **You merged something in** to stay up to date. They are someone else's, just passing
   through.

We now keep a commit only when **GitHub flagged it as new on that PR's own branch**. That
is as close as this data gets to "written for this pull request".

## What changed

We already filtered this. The old rule asked *"was the commit born on some branch other
than main?"* — which removes commits merged in from **main**, but keeps commits merged in
from **a colleague's branch**.

On vscode PR #116416, the old rule kept 87 commits. **52 of them were born on other
people's branches** — `tyriar/116467_2`, `isidorn/notificationsTelemetry`,
`joh/kernelLanguages` — nothing to do with that PR. The new rule keeps 36, and drops none
that were born on the PR's own branch.

| vscode `ref_match` links | |
|---|---|
| Upstream, unfiltered | 71,470 |
| Old rule | 32,262 |
| **New rule** | **20,846** |

## What it costs

The filter is not free. A commit written on the PR's own branch can still fail the test —
if the branch was force-pushed or rebased, or if GitHub truncated the push (it lists at
most 20 commits per push).

| Repository | Pass-throughs removed | Real links lost |
|---|---|---|
| microsoft/vscode | 49,004 | 1,620 |
| facebook/react | 2,319 | 272 |
| kubernetes/kubernetes | 858 | 56 |

**Kubernetes pays and gains nothing** — 56 links lost, no pass-throughs removed. Its
contributors work from forks, where this problem barely happens. We accepted that: the
loss is small and the rule has to be one rule.

`SELECT * FROM fe.diag_ref_match_narrowing` prints both columns per repository, so the
cost stays visible next to the benefit.

## What to say about the numbers

**Always quote a range, never one number.** Every commit-link and issue↔PR figure is a
floor: too low by the force-push and truncation cases above, and the ceiling is the
unfiltered count.

**Never compare raw link counts between repositories.** The filter removes 71% of vscode's
links, 66% of react's and 32% of kubernetes'. That spread is genuine — vscode merges
between branches constantly, kubernetes works from forks — which is exactly why the counts
are not comparable as-is.

## Two things worth remembering

**The report that prompted this measured the wrong baseline.** Its headline example —
commit `f1dc8d3` wrongly attached to two unrelated PRs — was *already* excluded here. It
compared against the shared upstream view, not against our layer. The real gap it found was
the colleague's-branch case, which we had missed.

**Its answer looked like one we had already rejected.** An earlier version of our rule
produced a similar count for PR #116416 and was found to be wrong. The report reaches a
similar number by a different and sounder route. Matching figures are not a matching
method, and dismissing it on the resemblance would have left the defect in place.

## Where it lives

Nowhere near the frontend. Deciding whether a commit was passing through needs the full
push history, so it belongs in the database — `fe.commit_pr_link`, built from
`fe.commit_born_ref` and `fe.pr_head_ref`.

⚠️ **After re-running `sql/fe_layer.sql`, always re-run `sql/postgrest_setup.sql`.**
Replacing an `api` function resets it to `SECURITY INVOKER`, and the app then fails with
*"permission denied for schema fe"* while every local check still passes. This happened
while making this change. `fe_layer.sql` now warns about it; the ordering is still yours.

The shared upstream views are **not** modified. Other researchers read them, and changing
them would silently move everyone's numbers. It is a one-line change worth proposing to
whoever maintains them; until then it lives in our schema.
