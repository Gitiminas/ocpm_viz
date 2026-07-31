# Project instructions

Master's thesis prototype: **"Visualizing Issue-to-Merge Processes using Object-Centric Event
Logs."** Design Science Research.

- **RQ1** How can OCPM data from GitHub issue-to-merge workflows be visualized to improve
  traceability of related issues, pull requests, and commits?
- **RQ2** What workflow patterns and differences appear across selected repositories?

Evaluated by Cognitive Dimensions of Notations + a task-based evaluation against PM4Py / OC-PM,
using the WP1 task catalogue (Q1–Q10) and shortcomings (S1–S11).

What exists: a working D3 timeline rendering **one hardcoded sub-log** (vscode issue #242864 →
PR #243221 → its commits). It looks right but is structurally overfit. The job is to generalize it.

**Design philosophy:** a general, configurable tool, not one tuned to a fixed question list. Every
lane, object type, link type and relationship class independently toggleable; configurations
nameable and saveable. Q1–Q10 are a check on whether it works, not a spec.

**Software engineering quality is graded, and the tool will be maintained by others after this
thesis.** Modularity, clear seams, tests and readable structure are deliverables, not polish. The
file format is free — `.dc.html`, plain HTML, ES modules, whatever serves this best. The **stack is
fixed**: PostgreSQL → PostgREST → D3.js.

**I am not experienced with D3.js or API development.** Explain non-obvious choices briefly. I will
not catch a subtle rendering bug by reading a diff — verification matters more than usual.

**Timebox:** ~5–6 working days inside a 12-day window. Smallest correct, defensible change.

## Documents

| Doc | What it is | Authority |
|---|---|---|
| `docs/DECISIONS.md` | Settled decisions + open questions | **Binding.** Read first. |
| `docs/DATA_CONTRACT.md` | What exists upstream: 4 base tables + 17 MVs | **Authoritative.** If a view is not in it, it does not exist. |
| `docs/DATA_REQUIREMENTS.md` | Every field the visualization needs, by entity | Requirements side |
| `docs/ADAPTER_AND_API.md` | The layer I build; `ObjectGraph` contract; evidence mapping | Binding |
| `docs/ARCHITECTURE.md` | Layers, seams, OCPM implications for the renderer | Intent |
| `docs/MOCKUP_OVERVIEW.md` | The **superseded** mockup, described | **Historical.** Not maintained; describes deleted code |
| `docs/VERIFICATION.md` | What was checked, how, and what was not | Task 6 output |
| `README.md` | Human entry point: run, test, extend | Keep current |
| `tasks/*.md` | One file per work package, in order | Per task |

## Repository map

| Path | What | Rules |
|---|---|---|
| `index.html` | The app shell: markup, CSS, and the one `<script type="module">` entry | **Work here** for anything structural in the page |
| `src/` | The application, as ES modules. Structure and rationale in `ARCHITECTURE.md` | **Work here.** Keep `model/`, `layout/` and `stats/` DOM-free |
| `scripts/build-f1.mjs` | Builds `tests/fixtures/F1.json` from `ocel-data.json` | Re-runnable. `--check` fails if the committed fixture is stale |
| `scripts/serve.mjs` | Zero-dependency static server (`npm start`) | Needed because ES modules and `fetch` are blocked on `file://` |
| `tests/` | `node --test` suites plus `tests/fixtures/` | Run with `npm test`. See `tests/fixtures/README.md` |
| `_ds/nocturne-*/` | Design system CSS tokens | Consume via `var(--token)`. Don't restyle |
| `ocel-data.json` | The untouched original data blob (hyphen — confirmed in Task 0) | **Never edit.** F1 is built from it by script |
| `screenshots/` | Pre-change reference renders of the original app | **Visual regression baseline. Read-only — never regenerate or overwrite.** Inventory in `screenshots/README.md` |
| `OCEL Timeline.dc.html` | The superseded mockup, frozen | **Do not edit, do not run as a second version.** Kept only as an A/B reference until Task 6 signs off, then deleted |
| `support.js` | Generated `dc-runtime` bundle, needed only by `.dc.html` | **Never edit.** Deleted together with the `.dc.html` after Task 6 |
| `.thumbnail` | Claude Design artifact | Ignore |

**Running it:** `npm start`, then open `http://localhost:8000`. Opening `index.html` from disk
does not work — browsers block both ES modules and `fetch` on `file://` origins.

## Hard rules

- **There is no "case".** OCPM removes the case notion; an event relates to several objects and none
  is privileged. Never use `case` in variable names, function names, comments, SQL or UI labels.
  The vocabulary is `objectGraph` / `subLog`. The RPC is `get_object_graph`, never `get_case`.
  The existing data blob and UI still say "case" — that is a defect to fix, not a precedent.
- **`docs/DATA_CONTRACT.md` is the complete list of what exists.** Do not invent views. Do not
  assume a view exists because it would be convenient. Anything else, I build in my own schema.
- **Never modify the shared upstream.** Base tables and the 17 MVs are owned by other researchers
  (a PhD student is building real OCEL tables; another MSc student is building bot classification).
  Read-only. No `UPDATE`/`DELETE`/`DROP`/`TRUNCATE`, no refreshes, no altering their definitions.
- **Do not build other people's theses.** Bot/human classification, OCEL 2.0 tables, labels, forks,
  reviews, review comments, branch/ref lifecycle — all out of scope.
- **Never fabricate data.** No placeholder rows, no `Math.random()`, no mock UI. Fixtures live in
  `tests/fixtures/` and are labelled. If data is missing, say so and stop.
- **Never change event-log semantics without asking** — object types, activity vocabulary,
  qualifiers, evidence classification. These are research decisions, not implementation details.
- **The word is `extracted`, not `inferred`.** Two evidence classes only: `validated` and
  `extracted`. `inferred` is retired vocabulary — replace it in data, constants, comments and UI.
- **All times UTC**, parsed and rendered, labelled as such.
- **Object types are closed at five:** `issue`, `pull_request`, `commit`, `actor`, `repo`.

## Conventions

- Analysis and metrics in **SQL**, not JS. The frontend fetches and renders.
- My derived views live in **my own schema**, never in the shared namespace. Plain `VIEW` by default;
  `MATERIALIZED VIEW` only where a measured query justifies it (see `docs/ADAPTER_AND_API.md`).
- Identity by numeric id, never by `login` or repo `name` — both are renameable.
- **Modularity is a hard requirement.** Data access, layout, rendering and stats stay separable.
  `loadObjectGraph(query) -> ObjectGraph` is the only data entry point.
- No bundler, framework or TypeScript. A test runner is required; native ES modules need no build
  step, so neither is a bundler.
- **Tests run with `npm test`** (`node --test`, Node's built-in runner — no dependencies, no config,
  native ES modules). `npm run test:watch` for a watch loop. Test files are `tests/*.test.js`;
  discovery is automatic, so do not pass a path. Node is installed user-local at `~/.local/node`
  and is on `PATH` via `~/.bashrc` and `~/.profile`; `package.json` sets `"type": "module"`.
- Every module must be importable and testable in isolation. If a function can only be exercised by
  rendering the whole app, the seam is in the wrong place.
- Extend the existing `st` state object and `REL_GROUPS` structure rather than inventing parallel
  mechanisms.
- Two distinct notions of degree — keep them named apart: **traversal degree** (server-side, what is
  *in* the sub-log) vs **focus degree** (client-side BFS, what is *highlighted*).

## Working style

- Tasks in order, starting with `tasks/00-*`. **Stop and check in after Task 1.**
- If a fixture reveals an ambiguity the settled decisions don't cover, **ask instead of guessing.**
  A wrong guess baked into layout is expensive to unwind and hard for me to detect.
- **Flag every place you guessed** rather than silently choosing.
- Extract modules deliberately — structure is graded and future students inherit this code. But
  correctness first: a clean architecture that still assumes one issue is a failure.
- Record any new design choice in `docs/DECISIONS.md` — it is thesis material, not bookkeeping.
