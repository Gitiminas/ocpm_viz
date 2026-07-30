# Task 3 — Everything toggleable, plus named saved views

Independent toggles for:

- each **object type / lane** (issue, pull_request, commit, actor, repo)
- each **link class**, split by qualifier *and* by evidence (validated vs extracted)
- each of the **4 link detection methods** (`pr_body`, `branch_name`, `pr_title`, `issue_comment`)
  so any single method can be excluded without code changes
- comments on/off per lane (partly present via `st.showComments`)
- burst collapse/expand per burst, plus the size threshold (decision 6)

Extend the existing `st` state object and the sidebar `REL_GROUPS` structure (L247–254) rather than
inventing a parallel mechanism.

## Named saved views (presets)

- Serialize the entire `st` toggle state to one plain object.
- Save / load / rename / delete named presets; persist in `localStorage`.
- **Encode a preset into a shareable URL.** The task-based evaluation must be reproducible by
  someone else on another machine — "load this URL" is the cheapest guarantee everyone sees an
  identical configuration.
- Ship **3–4 built-in presets** (e.g. *Everything*, *Validated links only*, *Lifecycle without
  commits*, *Commit integration focus*). These double as zero-interaction defaults and as
  evaluation material.

> **CD rationale — thesis-relevant, record it.** Presets are an *abstraction manager* in Green's
> exact sense ("if the user is allowed to modify abstractions, the system always requires a
> redefinition sub-device"). They cut **repetition viscosity**, raise **provisionality**, and support
> **progressive evaluation**.
>
> **The cost is hidden dependencies**, and it must be mitigated: a saved view silently conceals what
> it filtered, so a user can misread a sparse timeline as "few links" when it is really "links
> hidden." **Always display what is currently hidden** — a persistent, non-dismissible summary such
> as *"2 lanes, 1 link type, extracted links hidden"* with one-click restore.
