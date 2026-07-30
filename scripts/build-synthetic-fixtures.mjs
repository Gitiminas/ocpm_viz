/**
 * Build the synthesized property fixtures F2–F9.
 *
 *   node scripts/build-synthetic-fixtures.mjs
 *   node scripts/build-synthetic-fixtures.mjs --check
 *
 * Unlike F1, these are **not** real data and must never be presented as such. Each
 * one exists to exhibit exactly one structural property that F1 cannot — F1 has one
 * issue, one PR, one burst and no reopen, so it cannot catch a regression in any of
 * them.
 *
 * Every fixture declares the property it is supposed to exhibit, and
 * `tests/layout.test.js` asserts the property holds. That check is the point: an
 * "overlapping PRs" fixture whose PRs do not actually overlap passes every test
 * while verifying nothing, and that failure mode is invisible.
 */

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'tests/fixtures');
const GENERATED_AT = '2026-07-30T00:00:00Z';

const t = (day, hour = 0) =>
  new Date(Date.UTC(2025, 0, day, hour)).toISOString().replace('.000', '');

const repo = 'synthetic/fixture';

function issue(n, { from, to, label = `#${n}` } = {}) {
  return {
    id: `issue:${n}`,
    type: 'issue',
    label,
    repo,
    time_semantics: 'created_at(opened)->closed',
    vmap: { issue_number: n, issue_id: 900000 + n, title: `Synthetic issue ${n}` },
    intervals: to ? [{ start: from, end: to }] : [{ start: from, end: null }],
  };
}

function pr(n, { from, to } = {}) {
  return {
    id: `pr:${n}`,
    type: 'pull_request',
    label: `PR #${n}`,
    repo,
    time_semantics: 'created_at(opened)->merged',
    vmap: { pr_number: n, pull_request_id: 800000 + n, title: `Synthetic PR ${n}` },
    intervals: [{ start: from, end: to }],
  };
}

function commit(sha, { at, pushId, message = 'synthetic commit' } = {}) {
  return {
    id: `commit:${sha}`,
    type: 'commit',
    label: sha.slice(0, 7),
    repo,
    time_semantics: 'first_seen(push)',
    vmap: {
      commit_sha: sha,
      push_id: pushId,
      commit_message: message,
      commit_author_name: 'Synthetic Author',
      ref: 'refs/heads/main',
    },
    intervals: [{ start: at, end: at }],
  };
}

function actor(login) {
  return {
    id: `actor:${login}`,
    type: 'actor',
    label: `@${login}`,
    repo,
    time_semantics: 'static',
    vmap: { login },
    intervals: [],
  };
}

let eventSeq = 0;
function event(activity, time, objectId, { actorId = 'actor:alice', comment = false } = {}) {
  eventSeq += 1;
  return {
    id: `e${eventSeq}`,
    activity,
    time,
    object_id: objectId,
    actor_id: actorId,
    repo,
    comment,
    attrs: {},
  };
}

function link(source, target, qualifier, method) {
  const validated = ['pr_body', 'head_sha', 'merge_commit_sha', 'event_actor_id'].includes(method);
  return {
    source,
    target,
    qualifier,
    evidence: validated ? 'validated' : 'extracted',
    method,
    link_methods: [method],
    n_methods: 1,
  };
}

function graph({ id, property, seed, objects, events, links }) {
  return {
    meta: {
      repo,
      repo_id: 1,
      seed,
      traversal_degree: 2,
      active_object_types: [...new Set(objects.map((o) => o.type))].sort(),
      active_link_methods: [...new Set(links.map((l) => l.method))].sort(),
      generated_at: GENERATED_AT,
      activity_scope: 'OCEL-strict + comments',
      data_honesty: {
        synthetic:
          'SYNTHESIZED FIXTURE — not real GitHub data. Exists to exhibit one ' +
          'structural property; never use it for any figure or claim about behaviour.',
        commit_time: 'first-seen in PushEvent, NOT real git commit time',
      },
      source: { fixture: id, built_by: 'scripts/build-synthetic-fixtures.mjs', property },
    },
    objects,
    events,
    links,
  };
}

// ---------------------------------------------------------------------------

const FIXTURES = {};

/** F2 — one issue, two PRs that never overlap. Expect: one band, more nodes. */
FIXTURES.F2 = () => {
  eventSeq = 0;
  const objects = [
    issue(1, { from: t(1), to: t(20) }),
    pr(10, { from: t(2), to: t(5) }),
    pr(11, { from: t(8), to: t(12) }),
    actor('alice'),
  ];
  const events = [
    event('IssueOpened', t(1), 'issue:1'),
    event('PullRequestOpened', t(2), 'pr:10'),
    event('PullRequestMerged', t(5), 'pr:10'),
    event('PullRequestOpened', t(8), 'pr:11'),
    event('PullRequestMerged', t(12), 'pr:11'),
    event('IssueClosed', t(20), 'issue:1'),
  ];
  return graph({
    id: 'F2',
    property: 'One issue, two sequential PRs — they must share a single sub-lane.',
    seed: [{ id: 'issue:1', type: 'issue' }],
    objects,
    events,
    links: [
      link('pr:10', 'issue:1', 'related_issue', 'pr_body'),
      link('pr:11', 'issue:1', 'related_issue', 'pr_body'),
    ],
  });
};

/** F3 — one issue, two PRs open at the same time. Expect: two bands. */
FIXTURES.F3 = () => {
  eventSeq = 0;
  const objects = [
    issue(2, { from: t(1), to: t(20) }),
    pr(20, { from: t(2), to: t(10) }),
    pr(21, { from: t(5), to: t(14) }),
    actor('alice'),
  ];
  const events = [
    event('IssueOpened', t(1), 'issue:2'),
    event('PullRequestOpened', t(2), 'pr:20'),
    event('PullRequestOpened', t(5), 'pr:21'),
    event('PullRequestMerged', t(10), 'pr:20'),
    event('PullRequestMerged', t(14), 'pr:21'),
    event('IssueClosed', t(20), 'issue:2'),
  ];
  return graph({
    id: 'F3',
    property: 'One issue, two temporally overlapping PRs — each must get its own sub-lane.',
    seed: [{ id: 'issue:2', type: 'issue' }],
    objects,
    events,
    links: [
      link('pr:20', 'issue:2', 'related_issue', 'pr_body'),
      link('pr:21', 'issue:2', 'related_issue', 'branch_name'),
    ],
  });
};

/** F4 — two overlapping issues resolved by one PR. Expect: two issue bands. */
FIXTURES.F4 = () => {
  eventSeq = 0;
  const objects = [
    issue(3, { from: t(1), to: t(12) }),
    issue(4, { from: t(4), to: t(12) }),
    pr(30, { from: t(6), to: t(12) }),
    actor('alice'),
  ];
  const events = [
    event('IssueOpened', t(1), 'issue:3'),
    event('IssueOpened', t(4), 'issue:4'),
    event('PullRequestOpened', t(6), 'pr:30'),
    event('PullRequestMerged', t(12), 'pr:30'),
    event('IssueClosed', t(12), 'issue:3'),
    event('IssueClosed', t(12), 'issue:4'),
  ];
  return graph({
    id: 'F4',
    property: 'Two overlapping issues closed by one PR — the issue lane must split into two sub-lanes.',
    seed: [{ id: 'pr:30', type: 'pull_request' }],
    objects,
    events,
    links: [
      link('pr:30', 'issue:3', 'related_issue', 'pr_body'),
      link('pr:30', 'issue:4', 'related_issue', 'pr_body'),
    ],
  });
};

/** F5 — one commit referenced by two PRs. Expect: extra edges, no extra layout. */
FIXTURES.F5 = () => {
  eventSeq = 0;
  const objects = [
    pr(40, { from: t(1), to: t(6) }),
    pr(41, { from: t(2), to: t(7) }),
    commit('aaaa111bbbb222ccc', { at: t(3), pushId: 5001 }),
    actor('alice'),
  ];
  const events = [
    event('PullRequestOpened', t(1), 'pr:40'),
    event('PullRequestOpened', t(2), 'pr:41'),
    event('CommitObserved', t(3), 'commit:aaaa111bbbb222ccc'),
    event('PullRequestMerged', t(6), 'pr:40'),
    event('PullRequestMerged', t(7), 'pr:41'),
  ];
  return graph({
    id: 'F5',
    property: 'One commit referenced by two PRs — one commit node, two edges, no layout change.',
    seed: [{ id: 'commit:aaaa111bbbb222ccc', type: 'commit' }],
    objects,
    events,
    links: [
      link('commit:aaaa111bbbb222ccc', 'pr:40', 'referenced_pull_request', 'head_sha'),
      link('commit:aaaa111bbbb222ccc', 'pr:41', 'referenced_pull_request', 'ref_match'),
    ],
  });
};

/** F6 — a sub-log with no commits at all. Expect: no commit lane content. */
FIXTURES.F6 = () => {
  eventSeq = 0;
  const objects = [issue(5, { from: t(1), to: t(4) }), pr(50, { from: t(2), to: t(4) }), actor('alice')];
  const events = [
    event('IssueOpened', t(1), 'issue:5'),
    event('PullRequestOpened', t(2), 'pr:50'),
    event('PullRequestMerged', t(4), 'pr:50'),
    event('IssueClosed', t(4), 'issue:5'),
  ];
  return graph({
    id: 'F6',
    property: 'Zero commits — the renderer must not assume the commit lane has content.',
    seed: [{ id: 'issue:5', type: 'issue' }],
    objects,
    events,
    links: [link('pr:50', 'issue:5', 'related_issue', 'pr_body')],
  });
};

/** F7 — two distinct bursts plus loose commits. Expect: two burst nodes. */
FIXTURES.F7 = () => {
  eventSeq = 0;
  const objects = [pr(60, { from: t(1), to: t(20) }), actor('alice')];
  const events = [event('PullRequestOpened', t(1), 'pr:60')];

  // Two pushes of 8 commits each, well above the default threshold of 5, plus two
  // single-commit pushes that must stay loose.
  for (const [pushIndex, pushId] of [7001, 7002].entries()) {
    for (let i = 0; i < 8; i++) {
      const sha = `burst${pushIndex}commit${i}`.padEnd(17, '0');
      objects.push(commit(sha, { at: t(5 + pushIndex * 5), pushId }));
      events.push(event('CommitObserved', t(5 + pushIndex * 5), `commit:${sha}`));
    }
  }
  for (const [i, day] of [3, 18].entries()) {
    const sha = `loose${i}`.padEnd(17, '0');
    objects.push(commit(sha, { at: t(day), pushId: 7100 + i }));
    events.push(event('CommitObserved', t(day), `commit:${sha}`));
  }
  events.push(event('PullRequestMerged', t(20), 'pr:60'));

  return graph({
    id: 'F7',
    property: 'Two separate bursts plus loose commits — burst handling must work for N, not 1.',
    seed: [{ id: 'pr:60', type: 'pull_request' }],
    objects,
    events,
    links: [],
  });
};

/** F8 — a PR with no linked issue. Expect: it still renders. */
FIXTURES.F8 = () => {
  eventSeq = 0;
  const objects = [pr(70, { from: t(1), to: t(3) }), actor('alice')];
  const events = [
    event('PullRequestOpened', t(1), 'pr:70'),
    event('PullRequestClosed', t(3), 'pr:70'),
  ];
  return graph({
    id: 'F8',
    property: 'An orphan PR seed with no issue — nothing may assume an issue exists.',
    seed: [{ id: 'pr:70', type: 'pull_request' }],
    objects,
    events,
    links: [],
  });
};

/** F9 — an issue opened, closed, reopened, closed. Expect: two interval bars. */
FIXTURES.F9 = () => {
  eventSeq = 0;
  const reopened = {
    ...issue(9, { from: t(1), to: t(4) }),
    intervals: [
      { start: t(1), end: t(4) },
      { start: t(9), end: t(14) },
    ],
  };
  const objects = [reopened, actor('alice')];
  const events = [
    event('IssueOpened', t(1), 'issue:9'),
    event('IssueClosed', t(4), 'issue:9'),
    event('IssueReopened', t(9), 'issue:9'),
    event('IssueClosed', t(14), 'issue:9'),
  ];
  return graph({
    id: 'F9',
    property: 'A reopened issue — must render as two bars on one row, not one span.',
    seed: [{ id: 'issue:9', type: 'issue' }],
    objects,
    events,
    links: [],
  });
};

// ---------------------------------------------------------------------------

const checkOnly = process.argv.includes('--check');
mkdirSync(OUT_DIR, { recursive: true });

let stale = [];
for (const [id, build] of Object.entries(FIXTURES)) {
  const json = `${JSON.stringify(build(), null, 2)}\n`;
  const path = resolve(OUT_DIR, `${id}.json`);
  if (checkOnly) {
    let current = null;
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      /* missing counts as stale */
    }
    if (current !== json) stale.push(id);
  } else {
    writeFileSync(path, json);
  }
}

if (checkOnly) {
  if (stale.length) {
    console.error(`Stale or missing fixtures: ${stale.join(', ')}. Run: npm run build:fixtures`);
    process.exit(1);
  }
  console.log('Synthetic fixtures are up to date.');
} else {
  console.log(`Wrote ${Object.keys(FIXTURES).length} synthetic fixtures to tests/fixtures/.`);
}
