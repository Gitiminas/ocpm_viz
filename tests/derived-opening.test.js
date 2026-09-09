import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeGraph, indexSubLog } from '../src/model/subLog.js';
import { isDerivedEvent, isLandmark } from '../src/model/activities.js';
import { buildNodes } from '../src/layout/nodes.js';
import { buildStructuralNodes } from '../src/layout/structural.js';
import { perObjectGaps } from '../src/stats/metrics.js';
import { LEGEND_KEYS } from '../src/render/legend.js';

/**
 * An opening the archive never recorded as an event, read from a later event's payload
 * (`sql/fe_layer.sql` §4, branches 4 and 5). Two shapes reach the client: a PR opening with
 * the payload's author as actor, and an issue opening with NO actor, because an issue known
 * only from comments has no creator in the comment payload. Both carry
 * `attrs.source === 'payload'` and `attrs.derived_from`.
 */
function derivedOpeningGraph() {
  const repo = 'facebook/react';
  return normalizeGraph({
    meta: { repo, seed: [{ id: 'issue:1', type: 'issue' }], traversal_degree: 1 },
    objects: [
      { id: 'actor:1', type: 'actor', label: '@one', repo, vmap: { login: 'one' }, intervals: [] },
      { id: 'actor:2', type: 'actor', label: '@two', repo, vmap: { login: 'two' }, intervals: [] },
      {
        id: 'issue:1', type: 'issue', label: '#1', repo, time_semantics: 'created_at(payload)',
        vmap: { issue_number: 1 },
        intervals: [{ start: '2024-01-01T00:00:00Z', end: '2024-01-03T00:00:00Z' }],
      },
      {
        id: 'pr:2', type: 'pull_request', label: 'PR #2', repo, time_semantics: 'created_at(payload)',
        vmap: { pr_number: 2 },
        intervals: [{ start: '2024-01-02T00:00:00Z', end: '2024-01-04T00:00:00Z' }],
      },
    ],
    events: [
      // the derived issue opening: no actor, provenance in attrs
      { id: 'issue_open_payload:1', activity: 'IssueOpened', time: '2024-01-01T00:00:00Z',
        object_id: 'issue:1', actor_id: null, repo, comment: false,
        attrs: { source: 'payload', derived_from: 900 } },
      { id: 'issue_act:901', activity: 'IssueCommented', time: '2024-01-02T00:00:00Z',
        object_id: 'issue:1', actor_id: 'actor:1', repo, comment: true, attrs: {} },
      { id: 'issue_act:902', activity: 'IssueClosed', time: '2024-01-03T00:00:00Z',
        object_id: 'issue:1', actor_id: 'actor:2', repo, comment: false, attrs: {} },
      // the derived PR opening: the payload names the author
      { id: 'pr_open_payload:2', activity: 'PullRequestOpened', time: '2024-01-02T00:00:00Z',
        object_id: 'pr:2', actor_id: 'actor:1', repo, comment: false,
        attrs: { source: 'payload', derived_from: 903 } },
      { id: 'pr_act:903', activity: 'PullRequestMerged', time: '2024-01-04T00:00:00Z',
        object_id: 'pr:2', actor_id: 'actor:2', repo, comment: false, attrs: {} },
    ],
    links: [{ source: 'pr:2', target: 'issue:1', qualifier: 'resolves', evidence: 'extracted',
              method: 'pr_body', n_methods: 1, link_methods: ['pr_body'] }],
  });
}

describe('an opening derived from a later event\'s payload', () => {
  test('is recognised by attrs.source alone, and by nothing else', () => {
    assert.equal(isDerivedEvent({ attrs: { source: 'payload' } }), true);
    assert.equal(isDerivedEvent({ attrs: { source: 'event' } }), false);
    assert.equal(isDerivedEvent({ attrs: {} }), false);
    assert.equal(isDerivedEvent({}), false);
    assert.equal(isDerivedEvent(null), false);
  });

  test('the bundle loads with an actor-less event, and the index tolerates it', () => {
    const graph = derivedOpeningGraph();
    const index = indexSubLog(graph);
    const opening = graph.events.find((e) => e.id === 'issue_open_payload:1');
    assert.equal(opening.actor_id, null);
    assert.ok(index.objectsOfType('issue').some((o) => o.id === 'issue:1'));
  });

  test('the flag rides on the timeline node, on exactly the derived openings', () => {
    const graph = derivedOpeningGraph();
    const nodes = buildNodes({ graph, index: indexSubLog(graph), bursts: [] });
    const flagged = nodes.filter((n) => n.derivedOpening).map((n) => n.event.id).sort();
    assert.deepEqual(flagged, ['issue_open_payload:1', 'pr_open_payload:2']);
    for (const node of nodes.filter((n) => n.derivedOpening)) {
      assert.equal(node.landmark, false, 'an opening is never a landmark');
      assert.equal(node.heuristicLandmark, false);
    }
    const noActor = nodes.find((n) => n.event?.id === 'issue_open_payload:1');
    assert.equal(noActor.actorId, null);
  });

  test('the structural view carries the flag in the lifecycle it folds', () => {
    const graph = derivedOpeningGraph();
    const nodes = buildStructuralNodes({ graph, index: indexSubLog(graph), bursts: [] });
    const issue = nodes.find((n) => n.objectId === 'issue:1');
    assert.ok(issue, 'the issue is a structural node');
    const lifecycle = issue.lifecycle ?? issue.events ?? [];
    assert.ok(
      lifecycle.some((entry) => entry.derivedOpening === true),
      'the derived opening is marked in the folded lifecycle',
    );
  });

  test('a missing actor is a gap in the record, not a handoff', () => {
    const graph = derivedOpeningGraph();
    const gaps = perObjectGaps(graph.events, 'issue:1');
    assert.deepEqual(gaps.map((g) => g.actorChanged), [false, true]);
  });

  test('the mark has a legend row, so its help text is enforced by the tips test', () => {
    assert.ok(LEGEND_KEYS.includes('opening-derived'));
  });
});
