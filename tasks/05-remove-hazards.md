# Task 5 — Remove evaluation hazards

- **Delete the fake heatmap** (L1301–1305) — 130 divs filled with `Math.random()` behind a blur with
  an "In progress" badge. Placeholder UI invites attack in a usability evaluation. Remove it and the
  "Soon" dashboard rows.
- **Remove the fake actor-card spinner.** `openActorCard()` shows blurred fake rows and a 650 ms
  artificial delay before rendering the real list. Same hazard: it is mock UI in a study artifact.
- **Fix the timezone bug.** Times are parsed UTC but rendered in *local* time, so every duration
  shifts with the viewer's machine. Pin to UTC and label it (decision 9) — evaluation numbers must
  be reproducible across whoever runs the study.
