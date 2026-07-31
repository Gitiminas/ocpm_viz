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
  isMilestone,
  MILESTONE_ACTIVITIES,
  LANE_TYPES,
  OBJECT_TYPES,
} from '../src/model/activities.js';

/** Read fixtures from disk, standing in for the browser's fetch transport. */
const fileTransport = async (query) => {
  const url = new URL(`./fixtures/${query.fixture || 'F1'}.json`, import.meta.url);
  return JSON.parse(await readFile(url, 'utf8'));
};

const loadF1 = () => loadObjectGraph({ fixture: 'F1' }, { transport: fileTransport });

const objectLinks = (graph) => graph.links.filter((l) => l.qualifier !== 'actor');
const commitsOf = (graph) => graph.objects.filter((o) => o.type === 'commit');

describe('F1 loads and validates', () => {
  test('the fixture passes validation and keeps its census', async () => {
    const graph = await loadF1();
    assert.equal(graph.objects.length, 38);
    assert.equal(graph.events.length, 42);
    assert.equal(graph.links.length, 76);
    assert.equal(objectLinks(graph).length, 34);
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
    const bad = { ...valid, objects: [{ id: 'x:1', type: 'milestone', intervals: [] }] };
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

describe('evidence classification (decision 7)', () => {
  test('the platform-asserts-it rule decides the class', () => {
    assert.equal(classifyMethod(LINK_METHOD.PR_BODY), EVIDENCE.VALIDATED);
    assert.equal(classifyMethod(LINK_METHOD.HEAD_SHA), EVIDENCE.VALIDATED);
    assert.equal(classifyMethod(LINK_METHOD.MERGE_COMMIT_SHA), EVIDENCE.VALIDATED);
    // The reclassification that moves most of F1 from solid to dashed.
    assert.equal(classifyMethod(LINK_METHOD.BRANCH_NAME), EVIDENCE.EXTRACTED);
    assert.equal(classifyMethod(LINK_METHOD.REF_MATCH), EVIDENCE.EXTRACTED);
    assert.equal(classifyMethod(LINK_METHOD.PR_TITLE), EVIDENCE.EXTRACTED);
    assert.equal(classifyMethod(LINK_METHOD.ISSUE_COMMENT), EVIDENCE.EXTRACTED);
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
    const links = objectLinks(graph);
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
    assert.equal(activityLabel('IssueClosed'), 'Issue closed');
    assert.equal(activityShortLabel('PullRequestMerged'), 'merged');
    assert.equal(activityLabel('PullRequestMergedOffPlatform'), 'PR merged off-platform');
  });

  test('an unmapped activity throws instead of rendering the raw enum', () => {
    assert.throws(() => activityLabel('IssueLabelled'), /vocabulary is closed/);
  });

  test('milestones are exactly the three emphasised outcomes', () => {
    assert.deepEqual(MILESTONE_ACTIVITIES.sort(), [
      'IssueClosed',
      'PullRequestMerged',
      'PullRequestMergedOffPlatform',
    ]);
    assert.equal(isMilestone('IssueOpened'), false);
  });

  test('object types are closed at five, of which three get lanes', () => {
    assert.deepEqual(OBJECT_TYPES, ['issue', 'pull_request', 'commit', 'actor', 'repo']);
    assert.deepEqual(LANE_TYPES, ['issue', 'pull_request', 'commit']);
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
    // The fifth type is legal and simply empty in F1 — see tests/fixtures/README.md.
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

  test('actor links are excluded, or every object would share an actor', async () => {
    const graph = await loadF1();
    const adjacency = buildAdjacency(graph.links, []);
    assert.equal(adjacency.has('actor:connor4312'), false);
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
