# Link fanning: what it is, how it broke, and what it does now

*Written 2026-08-05. Concerns `src/render/links.js` in `ocpm_viz`. Settled as decision 68;
closes the first half of open question O12.*

---

## TL;DR

When two link lines would land exactly on top of each other, the tool nudges them a few
pixels apart so you can see there are two. That's "fanning", and it was added because a
link really did vanish underneath another one.

It worked fine when a couple of links overlapped. Then real data arrived. One vscode pull
request contains **85 commits**, all pushed within an hour, so all 85 links piled onto the
same spot — and nudging each one 5px apart smeared them across **425 pixels**. The sidebar
said *one pull request*. The picture showed what looked like dozens.

That's the worst kind of bug this project can have: nothing errors, nothing is missing,
the picture is just wrong. And it got worse the more commits a PR had — so it was worst
exactly where you'd most want to trust it.

**The fix:** fan up to 6 links. Past that, draw one line and put a `×85` badge on it.

You lose the ability to pick out each individual line — but at 85 you never had that
anyway, and every one of those commits is still drawn in the commit lane. What you gain is
a picture that says *"one pull request, 85 commits"* instead of implying eighty-five
somethings.

---

## Why fanning exists at all

It isn't decoration. It was added (decision 25) because of a real failure in fixture F5.

F5 has one commit that belongs to two overlapping pull requests. Both links leave the same
commit at the same x and go almost straight up. The one reaching the *nearer* PR band is a
strict sub-segment of the one reaching the further band — so it is drawn, and then
completely painted over.

The buried link was the **extracted** one. So the dashed stroke and its `?` badge — the
uncertainty cue this whole tool exists to display — silently disappeared underneath a
solid line. A viewer would have seen one confident connection where there were two, one of
them uncertain.

Hence the rule: **links that would be drawn on top of one another get separated, and only
those.** Links that already diverge are left exactly where they are, so nothing moves
without cause.

## How it worked

In `computeLinkOffsets`:

1. Group links into **bundles** — same source endpoint, and target x within
   `SAME_COLUMN_PX` (2px) of each other. That is the definition of "would overlap".
2. Sort each bundle by where it's going, so the fan reads top-to-bottom instead of in
   arrival order.
3. Give link *i* of *n* a lateral offset of `(i − (n−1)/2) × LINK_SPREAD_PX`, with
   `LINK_SPREAD_PX = 5`.
4. Shift the **whole line** by that offset, not just one end, so fanned links stay
   parallel rather than re-converging.

For n = 2 that's ±2.5px: two visible lines, nothing else disturbed. Exactly right.

## What went wrong

**The offset grows linearly with bundle size, and nothing capped it.**

```
n =  2   →   5px total spread     fine
n =  6   →  30px                  still reads as distinct lines
n = 20   → 100px                  starting to look like a region
n = 85   → 425px                  a wall
```

The offset is applied to both ends. So at the shared end — the pull request — 85 lines
arrive at 85 different x positions spread across 425px, each with its own visual terminus.
A viewer reads arrival points as objects. The lane caption said `1 pull_request`; the
picture said otherwise.

Rendered, it wasn't even 85 distinguishable lines. It was a solid orange scribble.

### Why no test caught it

Every automated check passed throughout, and would have kept passing:

- The **payload was correct.** 85 genuine `contains_commit` links, correct endpoints.
- The **layout gate passed** — every position finite, every endpoint anchored, every
  object banded. Smeared coordinates are still perfectly valid coordinates.
- The **fan's own test passed.** It uses F5, which has *two* coincident links. It asserted
  they were separated. They were.
- **F10**, the large fixture, has 300 commits — but spread across 3 pull requests, so no
  single endpoint ever accumulated more than a few links.

So the failure needed two things at once that no fixture had: a large number of links
*and* one shared endpoint. Real data has that constantly; hand-built fixtures didn't.

It was found by opening the app and looking at it.

## The fix

```js
const MAX_FANNED_LINKS = 6;
```

- Bundle of 6 or fewer → fan as before, unchanged.
- Bundle of more than 6 → every offset is 0, so they draw as **one** visible line, and the
  bundle's first link carries a `×N` badge at the shared end.

Six is where a full fan is still 30px and reads as separate lines, and past which the
shared end starts to look like several objects rather than one.

### The trade, stated plainly

| | before | after |
|---|---|---|
| See that a link exists under another | yes, up to ~6 | yes, up to 6 |
| See each of 85 individually | no — they smeared | no |
| See that there are 85 | no | **yes, labelled** |
| Read the PR as one object | **no** | yes |

Nothing visible was lost. At 85 links you could not pick out an individual line before the
change either; you could only see an indistinct mass that misrepresented the object count.
And every one of those commits is independently drawn in the commit lane, so the
information is on screen regardless — the links were never the only evidence of them.

Declaring the count rather than silently overlapping follows the project's standing rule
that **anything hidden is declared** (decision 27). Previously the crowding hid links
without saying so; now the collapse announces itself.

## How it's tested now

A test builds a synthetic sub-log of **20 coincident links** from one pull request and
asserts two things:

- all links share **one** start x (they were not spread)
- exactly one `×20` label is emitted

Both are checked headlessly through the real `renderLinks`, with a fake d3 selection that
records what was written to it.

**The harness had to be fixed first.** It recorded attributes but threw away `.text()` —
so neither the `×N` count *nor the existing `?` evidence badge* could ever have been
asserted. That gap is why a badge-related regression could have slipped through silently;
it's closed now.

## What is still open

**O12(b): event glyphs stack without bound.** A kubernetes issue with 288 comments in a
short window allocates **52 bands for a single issue** and produces an SVG 5,654px tall.

That is crowding, not deception — the picture is hard to read but it isn't lying — which
is why it was left. The likely direction is to give the issue and PR lanes the same
burst-collapse treatment commits already have.

## The general lesson

Both halves of O12 come from the same place: **layout rules tuned against small
hand-built fixtures, meeting real data for the first time.**

The fan was correct for the case it was designed against and wrong an order of magnitude
up. Nothing in the fixture corpus could have revealed that, because the fixtures were
built to exercise *shapes* — a reopen, two overlapping PRs, a commit in two PRs — not
*scale*. The scale case only exists in the real database.

Worth remembering for anything else that computes a per-item visual offset: ask what it
does at n = 100, and check it against real data rather than a fixture.
