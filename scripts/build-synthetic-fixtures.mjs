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

// Deliberately a literal list rather than an import from `src/model/evidence.js`:
// the fixtures are the second opinion the evidence rule is checked against, and a
// generator that read the same set as the implementation could only agree with it.
// `event_actor_id` was a fourth member until decision 41 deleted the method; no
// synthetic fixture ever used it, so no fixture changes.
const VALIDATED_METHODS = ['pr_body', 'head_sha', 'merge_commit_sha'];

/**
 * A link detected by one or more methods.
 *
 * Multi-method links follow the real rule: one validating method is enough, since
 * a platform-asserted match cannot be weakened by further convention-based ones.
 */
function link(source, target, qualifier, methods) {
  const list = Array.isArray(methods) ? methods : [methods];
  return {
    source,
    target,
    qualifier,
    evidence: list.some((method) => VALIDATED_METHODS.includes(method)) ? 'validated' : 'extracted',
    method: list[0],
    link_methods: list,
    n_methods: list.length,
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
      link('pr:10', 'issue:1', 'resolves', 'pr_body'),
      link('pr:11', 'issue:1', 'resolves', 'pr_body'),
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
      link('pr:20', 'issue:2', 'resolves', 'pr_body'),
      link('pr:21', 'issue:2', 'resolves', 'branch_name'),
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
      link('pr:30', 'issue:3', 'resolves', 'pr_body'),
      link('pr:30', 'issue:4', 'resolves', 'pr_body'),
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
      link('pr:40', 'commit:aaaa111bbbb222ccc', 'contains_commit', 'head_sha'),
      link('pr:41', 'commit:aaaa111bbbb222ccc', 'contains_commit', 'ref_match'),
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
    links: [link('pr:50', 'issue:5', 'resolves', 'pr_body')],
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

/**
 * F13 — two concurrent PRs, each with its own run of commits, plus one commit
 * shared by both. The dense case: many links converging into one lane at once.
 */
FIXTURES.F13 = () => {
  eventSeq = 0;
  const objects = [
    issue(13, { from: t(1), to: t(20) }),
    pr(80, { from: t(2), to: t(12) }),
    pr(81, { from: t(4), to: t(16) }),
    actor('alice'),
    actor('bob'),
  ];
  const events = [
    event('IssueOpened', t(1), 'issue:13'),
    event('PullRequestOpened', t(2), 'pr:80'),
    event('PullRequestOpened', t(4), 'pr:81', { actorId: 'actor:bob' }),
  ];
  const links = [
    link('pr:80', 'issue:13', 'resolves', 'pr_body'),
    link('pr:81', 'issue:13', 'resolves', 'branch_name'),
  ];

  // Four commits per PR, interleaved in time so their links cross.
  for (const [prIndex, prId] of ['pr:80', 'pr:81'].entries()) {
    for (let i = 0; i < 4; i++) {
      const sha = `pr${prIndex}c${i}`.padEnd(17, '0');
      const day = 5 + i * 2 + prIndex;
      objects.push(commit(sha, { at: t(day), pushId: 8100 + prIndex * 10 + i }));
      events.push(
        event('CommitObserved', t(day), `commit:${sha}`, {
          actorId: prIndex ? 'actor:bob' : 'actor:alice',
        }),
      );
      links.push(link(prId, `commit:${sha}`, 'contains_commit', 'head_sha'));
    }
  }

  // One commit inside both PRs' spans, linked to both — the case where two links
  // would otherwise be drawn exactly on top of each other.
  const shared = 'sharedcommit00000';
  objects.push(commit(shared, { at: t(9), pushId: 8199 }));
  events.push(event('CommitObserved', t(9), `commit:${shared}`));
  links.push(link('pr:80', `commit:${shared}`, 'contains_commit', 'head_sha'));
  links.push(link('pr:81', `commit:${shared}`, 'contains_commit', 'ref_match'));

  events.push(event('PullRequestMerged', t(12), 'pr:80'));
  events.push(event('PullRequestMerged', t(16), 'pr:81', { actorId: 'actor:bob' }));
  events.push(event('IssueClosed', t(20), 'issue:13'));

  return graph({
    id: 'F13',
    property:
      'Two concurrent PRs with several commits each, plus a commit shared by both — ' +
      'links into one lane must stay individually readable.',
    seed: [{ id: 'issue:13', type: 'issue' }],
    objects,
    events,
    links,
  });
};

/**
 * F10 — a deliberately large sub-log: 3 PRs and 300 commits across many pushes.
 *
 * Not a performance benchmark. It exists so that "sub-logs are small, do not
 * pre-optimise" is a claim someone has actually checked, and so the density
 * behaviours — burst folding, label thinning, run grouping — are exercised at a
 * scale F1 cannot reach.
 */
FIXTURES.F10 = () => {
  eventSeq = 0;
  const objects = [
    issue(100, { from: t(1), to: t(120) }),
    pr(1001, { from: t(5), to: t(45) }),
    pr(1002, { from: t(40), to: t(80) }),
    pr(1003, { from: t(75), to: t(115) }),
    actor('alice'),
    actor('bob'),
  ];
  const events = [event('IssueOpened', t(1), 'issue:100')];
  const links = [
    link('pr:1001', 'issue:100', 'resolves', 'pr_body'),
    link('pr:1002', 'issue:100', 'resolves', 'branch_name'),
    link('pr:1003', 'issue:100', 'resolves', 'pr_title'),
  ];

  const prIds = ['pr:1001', 'pr:1002', 'pr:1003'];
  for (const [prIndex, prId] of prIds.entries()) {
    events.push(event('PullRequestOpened', t(5 + prIndex * 35), prId));

    // 100 commits per PR, in pushes of varying size so some fold and some do not.
    let commitNumber = 0;
    let pushIndex = 0;
    while (commitNumber < 100) {
      const pushSize = [1, 3, 12, 1, 40, 2, 8, 33][pushIndex % 8];
      const pushId = 10000 + prIndex * 100 + pushIndex;
      const day = 6 + prIndex * 35 + Math.floor((commitNumber / 100) * 30);

      for (let i = 0; i < pushSize && commitNumber < 100; i++, commitNumber++) {
        const sha = `p${prIndex}c${String(commitNumber).padStart(3, '0')}`.padEnd(17, '0');
        objects.push(commit(sha, { at: t(day, (commitNumber % 20) + 1), pushId }));
        events.push(
          event('CommitObserved', t(day, (commitNumber % 20) + 1), `commit:${sha}`, {
            actorId: commitNumber % 3 ? 'actor:alice' : 'actor:bob',
          }),
        );
        links.push(link(prId, `commit:${sha}`, 'contains_commit', 'head_sha'));
      }
      pushIndex += 1;
    }
    events.push(event('PullRequestMerged', t(45 + prIndex * 35), prId));
  }
  events.push(event('IssueClosed', t(120), 'issue:100'));

  return graph({
    id: 'F10',
    property: 'One issue, three PRs and 300 commits — density behaviour at a scale F1 cannot reach.',
    seed: [{ id: 'issue:100', type: 'issue' }],
    objects,
    events,
    links,
  });
};

/**
 * F11 — all four issue↔PR detection methods at once.
 *
 * F1 exercises only `pr_body`, so without this the per-method toggles could not be
 * switched independently and observed to do anything.
 */
FIXTURES.F11 = () => {
  eventSeq = 0;
  const objects = [
    issue(110, { from: t(1), to: t(30) }),
    pr(1101, { from: t(2), to: t(8) }),
    pr(1102, { from: t(10), to: t(16) }),
    pr(1103, { from: t(18), to: t(24) }),
    pr(1104, { from: t(25), to: t(29) }),
    actor('alice'),
  ];
  const events = [event('IssueOpened', t(1), 'issue:110')];
  const methods = ['pr_body', 'branch_name', 'pr_title', 'issue_comment'];
  const links = [];

  methods.forEach((method, i) => {
    const prId = `pr:110${i + 1}`;
    events.push(event('PullRequestOpened', t(2 + i * 8), prId));
    events.push(event('PullRequestMerged', t(8 + i * 8), prId));
    links.push(link(prId, 'issue:110', 'resolves', method));
  });
  events.push(event('IssueClosed', t(30), 'issue:110'));

  return graph({
    id: 'F11',
    property:
      'All four issue↔PR detection methods present, one per PR — each per-method toggle can be ' +
      'switched independently and its effect observed.',
    seed: [{ id: 'issue:110', type: 'issue' }],
    objects,
    events,
    links,
  });
};

/**
 * F12 — multi-method agreement, and mixed evidence on one object pair.
 *
 * Every link in F1 has `n_methods: 1`, so the confidence signal the tooltip carries
 * is otherwise unexercised. The commit↔PR pair here carries both a validated and an
 * extracted link at once, which is the case where evidence styling has to
 * distinguish two edges between the same two objects.
 */
FIXTURES.F12 = () => {
  eventSeq = 0;
  const sha = 'mixedevidence0000';
  // The merge commit is a second commit on purpose: `merge_commit` is the only qualifier
  // the corpus would otherwise never exercise, and it is the only one that arrives by
  // identity (`merge_commit_sha`) rather than by convention. Keeping it off the
  // `pr:1201`↔`sha` pair leaves this fixture's mixed-evidence property untouched.
  const mergeSha = 'mergecommit000000';
  const objects = [
    issue(120, { from: t(1), to: t(12) }),
    pr(1201, { from: t(2), to: t(10) }),
    commit(sha, { at: t(5), pushId: 12001 }),
    commit(mergeSha, { at: t(10), pushId: 12002, message: 'Merge pull request #1201' }),
    actor('alice'),
  ];
  const events = [
    event('IssueOpened', t(1), 'issue:120'),
    event('PullRequestOpened', t(2), 'pr:1201'),
    event('CommitObserved', t(5), `commit:${sha}`),
    event('CommitObserved', t(10), `commit:${mergeSha}`),
    event('PullRequestMerged', t(10), 'pr:1201'),
    event('IssueClosed', t(12), 'issue:120'),
  ];
  const links = [
    // Three methods agree on this one — the strongest signal the model can express.
    link('pr:1201', 'issue:120', 'resolves', ['pr_body', 'branch_name', 'pr_title']),
    // The same commit↔PR pair, asserted once by identity and once by convention.
    link('pr:1201', `commit:${sha}`, 'contains_commit', 'head_sha'),
    link('pr:1201', `commit:${sha}`, 'contains_commit', 'ref_match'),
    // The fourth qualifier, and the only validated-by-identity one.
    link('pr:1201', `commit:${mergeSha}`, 'merge_commit', 'merge_commit_sha'),
  ];

  return graph({
    id: 'F12',
    property:
      'Multi-method agreement (n_methods > 1) and both evidence classes on the same object pair.',
    seed: [{ id: 'issue:120', type: 'issue' }],
    objects,
    events,
    links,
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
