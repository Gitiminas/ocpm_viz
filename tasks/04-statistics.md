# Task 4 — Rewrite the statistics view

`renderStats()` (L1227–1281) computes 9 metric cards and a 6-item milestone list, all assuming
exactly one issue and one PR. It will not survive.

Rebuild as a **per-object table, aggregable on demand** (decision 8). Metric list in
`DATA_REQUIREMENTS.md` §9.

Metrics are computed in **JS over the loaded sub-log** (decision 12), as pure functions in
`src/stats/metrics.js` taking an `ObjectGraph` and returning numbers. No DOM, no fetching, unit
tested against the fixtures.

This is deliberate: metrics must respond to toggles. Hiding comments must recompute gaps. A
server-side precomputation would silently answer "no".

**Use SQL only** for figures spanning data that is not loaded — per-repo link coverage for RQ2
(Task 6). Those are reported once for the thesis, not rendered live.
