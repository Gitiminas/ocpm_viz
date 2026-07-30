# Task 2 — Multi-object layout

**Rule: allocate a sub-lane only when temporal overlap forces it.**

- Multiple PRs **sequentially** → same PR lane, more nodes along the timeline.
- Multiple PRs **overlapping in time** → each gets its own sub-lane within the PR lane.
- Multiple **issues** → identical rule. Consistency across types is required (a CD *consistency*
  concern: similar semantics must take similar syntactic form).
- A commit linked to **multiple PRs** → just additional edges. The link model already supports this;
  no layout change.

> 💡 The existing row-packing loop (L512–518) already bumps a node to the next row on collision. The
> generalization is to pack **per object** — an object's whole span claims a row — rather than per
> node. Build on that loop; don't replace it.

An object's identity must stay visually traceable across the whole timeline, and links must remain
readable when N > 1 on both ends.
