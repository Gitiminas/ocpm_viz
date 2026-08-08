import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadObjectGraph, describeSubLog } from '../src/data/loadObjectGraph.js';
import { indexObjectGraph, findGraphProblems, collectInstants } from '../src/model/objectGraph.js';
import { deriveBursts, indexBurstsByCommit, DEFAULT_BURST_THRESHOLD } from '../src/model/bursts.js';
import { buildAdjacency, focusSet, MAX_FOCUS_DEGREE } from '../src/model/graph.js';
import { classifyMethod, classifyLink, LINK_METHOD, EVIDENCE } from '../src/model/evidence.js';
import {
  activityLabel,
  activityShortLabel,
  isKnownActivity,
  isLandmark,
  LANDMARK_ACTIVITIES,
  LANE_TYPES,
  OBJECT_TYPES,
} from '../src/model/activities.js';

/** Read fixtures from disk, standing in for the browser's fetch transport. */
const fileTransport = async (query) => {
  const url = new URL(`./fixtures/${query.fixture || 'F1'}.json`, import.meta.url);
  return JSON.parse(await readFile(url, 'utf8'));
};

const loadF1 = () => loadObjectGraph({ fixture: 'F1' }, { transport: fileTransport });

const commitsOf = (graph) => graph.objects.filter((o) => o.type === 'commit');

describe('F1 loads and validates', () => {
  test('the fixture passes validation and keeps its census', async () => {
    const graph = await loadF1();
    assert.equal(graph.objects.length, 38);
    assert.equal(graph.events.length, 42);
    // 34, not 76: decision 41 dropped the 42 event→actor attribution links, so
    // every link left is a traceability link between two objects and no consumer
    // has to subtract a class before counting.
    assert.equal(graph.links.length, 34);
  });

  /**
   * Attribution survives the deletion — the point of decision 41 is that it was
   * never carried by the links in the first place.
   *
   * Asserted on the *loaded* graph rather than on the build script, because the
   * script's own bijection check could be deleted with the script. If the 42 actor
   * ids stopped being reachable from the events, actor trails and the actor card
   * would empty out, and no other test in this file would notice.
   */
  test('every actor is still reachable, from the events alone', async () => {
    const graph = await loadF1();
    const index = indexObjectGraph(graph);
    const attributed = graph.events.filter((event) => event.actor_id);

    assert.equal(attributed.length, 42, 'all 42 events must still name their actor');
    assert.equal(index.eventCountByActor.size, 4);
    for (const event of attributed) {
      assert.ok(index.byId.has(event.actor_id), `${event.actor_id} resolves to an actor object`);
    }
  });

  test('no link carries actor attribution any more (decision 41)', async () => {
    const graph = await loadF1();
    const eventIds = new Set(graph.events.map((event) => event.id));

    assert.equal(graph.links.some((link) => link.qualifier === 'actor'), false);
    assert.equal(graph.links.some((link) => link.method === 'event_actor_id'), false);
    for (const link of graph.links) {
      for (const endpoint of [link.source, link.target]) {
        assert.equal(eventIds.has(endpoint), false, `${endpoint} is an event, not an object`);
      }
    }
  });

  test('timestamps parse to Date objects, in UTC', async () => {
    const graph = await loadF1();
    const issue = graph.objects.find((o) => o.id === 'issue:242864');
    assert.ok(issue.intervals[0].start instanceof Date);
    assert.equal(issue.intervals[0].start.toISOString(), '2025-03-07T05:15:54.000Z');
    assert.ok(graph.events[0].time instanceof Date);
  });

  test('loading does not mutate the bundle the transport returned', async () => {
    let captured = null;
    const spy = async (query) => {
      captured = await fileTransport(query);
      return captured;
    };
    await loadObjectGraph({ fixture: 'F1' }, { transport: spy });
    // If normalizeGraph mutated in place, this would already be a Date.
    assert.equal(typeof captured.events[0].time, 'string');
  });

  test('the sub-log is described by its query, with no case notion', async () => {
    const graph = await loadF1();
    const description = describeSubLog(graph);
    // The query is repo + seed + traversal degree — exactly what get_object_graph
    // is asked, and what a reader needs to reproduce the selection.
    assert.match(description, /microsoft\/vscode/);
    assert.match(description, /from issue #242864/);
    assert.match(description, /degree 2/);
    assert.doesNotMatch(description, /case/i);
  });
});

describe('validation fails loudly on a malformed bundle', () => {
  const valid = {
    meta: {},
    objects: [{ id: 'issue:1', type: 'issue', intervals: [] }],
    events: [],
    links: [],
  };

  test('a clean bundle reports no problems', () => {
    assert.deepEqual(findGraphProblems(valid), []);
  });

  test('an object type outside the closed set is rejected', () => {
    // `branch` is deliberately out of scope (CLAUDE.md), so it can never drift into
    // the closed set and quietly make this assertion vacuous.
    const bad = { ...valid, objects: [{ id: 'x:1', type: 'branch', intervals: [] }] };
    assert.match(findGraphProblems(bad).join('\n'), /closed set/);
  });

  test('a missing intervals array is rejected', () => {
    const bad = { ...valid, objects: [{ id: 'issue:1', type: 'issue' }] };
    assert.match(findGraphProblems(bad).join('\n'), /intervals/);
  });

  test('an event referencing an unknown object is rejected', () => {
    const bad = {
      ...valid,
      events: [{ id: 'e1', activity: 'IssueOpened', time: '2025-01-01T00:00:00Z', object_id: 'nope' }],
    };
    assert.match(findGraphProblems(bad).join('\n'), /unknown object/);
  });

  test('an unknown activity is rejected rather than rendered raw', () => {
    const bad = {
      ...valid,
      events: [
        { id: 'e1', activity: 'IssueLabelled', time: '2025-01-01T00:00:00Z', object_id: 'issue:1' },
      ],
    };
    assert.match(findGraphProblems(bad).join('\n'), /unknown activities/);
  });

  /**
   * Decision 49. The validator accepted an event id as a link endpoint while the
   * event→actor links existed; now that both endpoints must be objects, a link into
   * an event is a fault — and a silent one if unchecked, because it draws nothing
   * and reports nothing.
   */
  test('a link endpoint that names an event is rejected, and says so', () => {
    const bad = {
      ...valid,
      events: [
        { id: 'e1', activity: 'IssueOpened', time: '2025-01-01T00:00:00Z', object_id: 'issue:1' },
      ],
      objects: [
        { id: 'issue:1', type: 'issue', intervals: [] },
        { id: 'actor:ada', type: 'actor', intervals: [] },
      ],
      links: [
        { source: 'e1', target: 'actor:ada', qualifier: 'actor', evidence: 'validated' },
      ],
    };
    const problems = findGraphProblems(bad).join('\n');
    assert.match(problems, /has event "e1" as its source/);
    assert.match(problems, /both endpoints must be objects/);
  });

  test('an endpoint that is neither an object nor an event is still rejected', () => {
    const bad = {
      ...valid,
      links: [{ source: 'issue:1', target: 'ghost:9', qualifier: 'resolves', evidence: 'validated' }],
    };
    assert.match(findGraphProblems(bad).join('\n'), /unknown target "ghost:9"/);
  });

  test('retired evidence vocabulary is rejected', () => {
    const bad = {
      ...valid,
      objects: [
        { id: 'issue:1', type: 'issue', intervals: [] },
        { id: 'pr:1', type: 'pull_request', intervals: [] },
      ],
      links: [
        { source: 'pr:1', target: 'issue:1', qualifier: 'related_issue', evidence: 'inferred' },
      ],
    };
    assert.match(findGraphProblems(bad).join('\n'), /validated and extracted/);
  });
});

/**
 * The expected class of every method, written out by hand.
 *
 * Deliberately not derived from `VALIDATED_METHODS` — a test that reads the same set
 * the implementation reads asserts only that a Set works. This table is the second
 * opinion: changing an evidence class in `evidence.js` must fail here, because a
 * class silently flipping is a link changing from solid to dashed in every render
 * and a changed validated/extracted split in every figure the thesis reports.
 *
 * Decision 42 fixes `link.method` at sixteen values, and since decision 41 removed
 * `event_actor_id` the enum holds exactly those sixteen and nothing else.
 */
const EXPECTED_EVIDENCE = [
  ['pr_body', 'validated'],
  ['head_sha', 'validated'],
  ['merge_commit_sha', 'validated'],
  ['closed_via_commit', 'validated'],
  ['pr_title', 'extracted'],
  ['commit_message', 'extracted'],
  ['issue_comment', 'extracted'],
  ['branch_name', 'extracted'],
  ['proximity', 'extracted'],
  ['ref_match', 'extracted'],
  ['pr_title_gh', 'extracted'],
  ['pr_title_symfony', 'extracted'],
  ['pr_title_for', 'extracted'],
  ['pr_body_gh', 'extracted'],
  ['pr_body_fixed_tickets', 'extracted'],
  ['pr_body_refs', 'extracted'],
];

describe('evidence classification (decision 7)', () => {
  for (const [method, expected] of EXPECTED_EVIDENCE) {
    test(`${method} is ${expected}`, () => {
      assert.equal(classifyMethod(method), expected);
    });
  }

  // Retired by decision 41: actor attribution is `event.actor_id`, not a link. Like
  // `merge_commit_message` below it must reach the throw rather than merely be
  // absent, so a payload built against the old enum fails loudly instead of having
  // its attribution counted among the validated traceability links.
  test('the retired event_actor_id method is gone and throws', () => {
    assert.equal(Object.values(LINK_METHOD).includes('event_actor_id'), false);
    assert.equal(LINK_METHOD.EVENT_ACTOR_ID, undefined);
    assert.throws(() => classifyMethod('event_actor_id'), /Unknown link method/);
  });

  test('link.method is exactly the sixteen values of decision 42', () => {
    const linkMethods = Object.values(LINK_METHOD).sort();
    assert.equal(linkMethods.length, 16);
    assert.deepEqual(linkMethods, EXPECTED_EVIDENCE.map(([m]) => m).sort());
  });

  // Removed by decision 42: no upstream view emits it. It must not merely be absent
  // from the enum — it must reach the throw, so a stale payload fails loudly.
  test('the retired merge_commit_message method is gone and throws', () => {
    assert.equal(Object.values(LINK_METHOD).includes('merge_commit_message'), false);
    assert.throws(() => classifyMethod('merge_commit_message'), /Unknown link method/);
  });

  test('an unknown method throws instead of defaulting to solid', () => {
    assert.throws(() => classifyMethod('vibes'), /Unknown link method/);
  });

  test('one validating method is enough for a multi-method link', () => {
    assert.equal(
      classifyLink([LINK_METHOD.REF_MATCH, LINK_METHOD.PR_BODY]),
      EVIDENCE.VALIDATED,
    );
    assert.equal(
      classifyLink([LINK_METHOD.REF_MATCH, LINK_METHOD.PR_TITLE]),
      EVIDENCE.EXTRACTED,
    );
  });

  test('F1 splits 3 validated / 31 extracted', async () => {
    const graph = await loadF1();
    // Over `graph.links` directly: the split used to be quoted over a filtered
    // subset, because the 42 attribution links were all validated and would have
    // turned 3/31 into 45/31. Nothing to filter now — the number the thesis reports
    // and the number in the bundle are the same number.
    const links = graph.links;
    assert.equal(links.filter((l) => l.evidence === 'validated').length, 3);
    assert.equal(links.filter((l) => l.evidence === 'extracted').length, 31);
    assert.equal(JSON.stringify(graph.links).includes('inferred'), false);
  });
});

describe('burst derivation replaces the hardcoded burst', () => {
  test('F1 yields exactly one burst of its true size, 20 not 21', async () => {
    const graph = await loadF1();
    const bursts = deriveBursts(commitsOf(graph));
    assert.equal(bursts.length, 1);
    // meta.burst.n_commits claimed 21. The count is derived, so it cannot be wrong.
    assert.equal(bursts[0].size, 20);
    assert.equal(bursts[0].commits.length, bursts[0].size);
    assert.equal(bursts[0].id, 'burst:47398243521');
  });

  test('the burst position is derived, and reproduces the old literal exactly', async () => {
    const graph = await loadF1();
    const [burst] = deriveBursts(commitsOf(graph));
    // The mockup hardcoded BURST_T = 2025-03-10T18:32:11Z in source.
    assert.equal(burst.time.toISOString(), '2025-03-10T18:32:11.000Z');
  });

  test('the threshold decides how many bursts there are, including zero', async () => {
    const graph = await loadF1();
    const commits = commitsOf(graph);
    assert.equal(deriveBursts(commits, { threshold: 100 }).length, 0);
    // Every push in F1 has either 20 commits or 1, so dropping the threshold to 0
    // makes all 13 pushes bursts.
    assert.equal(deriveBursts(commits, { threshold: 0 }).length, 13);
    assert.equal(DEFAULT_BURST_THRESHOLD, 5);
  });

  test('commits without a push_id are never burst members', () => {
    const commits = [
      { id: 'c:1', vmap: {}, intervals: [{ start: new Date('2025-01-01T00:00:00Z') }] },
      { id: 'c:2', vmap: {}, intervals: [{ start: new Date('2025-01-02T00:00:00Z') }] },
    ];
    assert.equal(deriveBursts(commits, { threshold: 0 }).length, 0);
  });

  test('membership is derived, not read from the stale vmap.in_burst field', async () => {
    const graph = await loadF1();
    const commits = commitsOf(graph);
    const bursts = deriveBursts(commits);
    const byCommit = indexBurstsByCommit(bursts);
    const derived = commits.filter((c) => byCommit.has(c.id)).length;
    const claimed = commits.filter((c) => c.vmap.in_burst === true).length;
    assert.equal(derived, 20);
    // They agree here — but the point is that nothing reads the claim.
    assert.equal(claimed, 20);
  });
});

describe('activity vocabulary is closed', () => {
  test('known activities resolve to labels', () => {
    assert.equal(activityLabel('IssueClosed'), 'Close');
    assert.equal(activityShortLabel('PullRequestMerged'), 'merge');
    assert.equal(activityLabel('PullRequestClosed'), 'Close');
  });

  test('an unmapped activity throws instead of rendering the raw enum', () => {
    assert.throws(() => activityLabel('IssueLabelled'), /vocabulary is closed/);
  });

  // Decision 48 removed it: a ±15-minute timing heuristic drawn with the weight of a
  // real merge. Removed from the vocabulary means it hits the closed-vocabulary throw
  // like any other unmapped string — if a transport ever emits one again, it fails
  // loudly here rather than being rendered.
  test('the retired off-platform activity is no longer in the vocabulary', () => {
    assert.equal(isKnownActivity('PullRequestMergedOffPlatform'), false);
    assert.throws(() => activityLabel('PullRequestMergedOffPlatform'), /vocabulary is closed/);
  });

  test('landmarks are exactly the two emphasised outcomes', () => {
    assert.deepEqual(LANDMARK_ACTIVITIES.sort(), ['IssueClosed', 'PullRequestMerged']);
    assert.equal(isLandmark('IssueOpened'), false);
  });

  test('object types are closed at four, of which three get lanes', () => {
    assert.deepEqual(OBJECT_TYPES, ['issue', 'pull_request', 'commit', 'actor']);
    assert.deepEqual(LANE_TYPES, ['issue', 'pull_request', 'commit']);
    // `actor` is the one object type without a lane. That gap between the two lists
    // is decision 15's whole content, and it must not close: an actor has no
    // lifecycle interval, so a lane would draw a bar encoding nothing.
    assert.deepEqual(
      OBJECT_TYPES.filter((type) => !LANE_TYPES.includes(type)),
      ['actor'],
    );
  });

  /**
   * Decision 39 in the only place it is observable.
   *
   * No fixture ever contained a repo object — the type had a permanently empty
   * branch, which is the argument the decision makes. So the entire behavioural
   * change is here: a payload carrying one must now fail loudly rather than be
   * indexed into a group nothing reads. Without this test the decision would be
   * implemented and unexercised.
   */
  test('a repo-typed object is now rejected, and the message names the closed set', () => {
    const problems = findGraphProblems({
      meta: {},
      objects: [{ id: 'repo:microsoft/vscode', type: 'repo', intervals: [] }],
      events: [],
      links: [],
    });
    const text = problems.join('\n');
    assert.match(text, /has type "repo"/);
    assert.match(text, /issue, pull_request, commit, actor/);
    assert.doesNotMatch(text, /repo,/, 'repo must not still be listed as legal');
  });

  test('every activity in F1 is in the vocabulary', async () => {
    const graph = await loadF1();
    for (const event of graph.events) {
      assert.doesNotThrow(() => activityLabel(event.activity), `activity ${event.activity}`);
    }
  });
});

describe('indexing exposes collections, never a privileged first object', () => {
  test('objects are grouped by type', async () => {
    const graph = await loadF1();
    const index = indexObjectGraph(graph);
    assert.equal(index.objectsOfType('issue').length, 1);
    assert.equal(index.objectsOfType('pull_request').length, 1);
    assert.equal(index.objectsOfType('commit').length, 32);
    assert.equal(index.objectsOfType('actor').length, 4);
    // Every type in the closed set gets a group, even an empty one, so a caller
    // never has to distinguish "no objects of this type" from "unknown type".
    assert.equal(index.objectsByType.size, OBJECT_TYPES.length);
    // And a type outside the set answers with an empty list rather than throwing —
    // `repo` was a member until decision 39, so stale callers must degrade quietly
    // here even though a repo *object* would be rejected at validation.
    assert.deepEqual(index.objectsOfType('repo'), []);
  });

  test('events are grouped per object and sorted in time', async () => {
    const graph = await loadF1();
    const index = indexObjectGraph(graph);
    const events = index.eventsOf('issue:242864');
    assert.ok(events.length > 1);
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].time >= events[i - 1].time, 'events out of order');
    }
    assert.deepEqual(index.eventsOf('nonexistent'), []);
  });

  test('objects with no lifecycle carry an empty interval list', async () => {
    const graph = await loadF1();
    const actors = graph.objects.filter((o) => o.type === 'actor');
    assert.equal(actors.length, 4);
    for (const actor of actors) assert.deepEqual(actor.intervals, []);
  });

  test('instants include lifecycle bounds, not only event times', async () => {
    const graph = await loadF1();
    const instants = collectInstants(graph);
    for (let i = 1; i < instants.length; i++) {
      assert.ok(instants[i] > instants[i - 1], 'instants must be sorted and distinct');
    }
    const issueEnd = +graph.objects.find((o) => o.id === 'issue:242864').intervals[0].end;
    assert.ok(instants.includes(issueEnd));
  });
});

describe('focus BFS', () => {
  test('degree 1 reaches direct neighbours only, degree 2 one hop further', async () => {
    const graph = await loadF1();
    const bursts = deriveBursts(commitsOf(graph));
    const adjacency = buildAdjacency(graph.links, bursts);

    const d1 = focusSet(adjacency, 'issue:242864', 1);
    const d2 = focusSet(adjacency, 'issue:242864', 2);

    assert.ok(d1.has('issue:242864'));
    assert.equal(d1.get('issue:242864'), 0);
    assert.ok(d1.has('pr:243221'), 'the PR is one hop from the issue');
    assert.ok(d2.size > d1.size, 'degree 2 must reach further than degree 1');
  });

  test('no focus is null, distinct from an empty set', async () => {
    const graph = await loadF1();
    const adjacency = buildAdjacency(graph.links, []);
    assert.equal(focusSet(adjacency, null), null);
  });

  test('degree is capped so focus cannot swallow the graph', async () => {
    const graph = await loadF1();
    const adjacency = buildAdjacency(graph.links, []);
    const capped = focusSet(adjacency, 'issue:242864', 99);
    const atMax = focusSet(adjacency, 'issue:242864', MAX_FOCUS_DEGREE);
    assert.equal(capped.size, atMax.size);
  });

  /**
   * The invariant is unchanged; what guarantees it moved. `buildAdjacency` used to
   * skip actor links explicitly, because an actor adjacent to every event it touched
   * would make every object reachable from every other object that shares a
   * contributor — one focus click lighting up the whole sub-log. Decision 41 removed
   * the links instead, so this now checks the property of the data that makes the
   * guard unnecessary. It must stay: if actor edges ever return, focus breaks
   * quietly, and it looks like over-eager highlighting rather than a data change.
   */
  test('no actor enters the object adjacency, so focus cannot leak through one', async () => {
    const graph = await loadF1();
    const adjacency = buildAdjacency(graph.links, []);
    const actors = graph.objects.filter((object) => object.type === 'actor');

    assert.equal(actors.length, 4);
    for (const actor of actors) {
      assert.equal(adjacency.has(actor.id), false, `${actor.id} must not be an adjacency node`);
    }
  });

  test('a collapsed burst inherits its members’ connections', async () => {
    const graph = await loadF1();
    const bursts = deriveBursts(commitsOf(graph));
    const adjacency = buildAdjacency(graph.links, bursts);
    const burst = bursts[0];
    assert.ok(adjacency.has(burst.id), 'the burst must be reachable');
    // Focusing the PR must light up the folded push that delivered its commits.
    const fromPr = focusSet(adjacency, 'pr:243221', 1);
    assert.ok(fromPr.has(burst.id));
  });
});
