/**
 * The OCEL 2.0 export (`src/model/ocel.js`): every fixture and live sample as a log in the
 * standard's JSON format, checked against the format's structural rules and against the
 * sub-log it came from — nothing added, nothing lost but what the docstring says is lost.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadSubLog } from '../src/data/loadSubLog.js';
import { toOcelJson, findOcelProblems } from '../src/model/ocel.js';
import { objectsOf, actorOf } from '../src/model/subLog.js';

const fileTransport = async (query) =>
  JSON.parse(await readFile(new URL(`./fixtures/${query.fixture}.json`, import.meta.url), 'utf8'));
const load = (fixture) => loadSubLog({ fixture }, { transport: fileTransport });

const ALL = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13', 'F14', 'F15', 'LIVE1', 'LIVE2'];

describe('every sub-log exports as a well-formed OCEL 2.0 log', () => {
  for (const fixture of ALL) {
    test(`${fixture}: the format's rules hold, and the log is the sub-log restated`, async () => {
      const graph = await load(fixture);
      const log = toOcelJson(graph);
      assert.deepEqual(findOcelProblems(log), []);

      // Exactly the four keys, in the sample's order.
      assert.deepEqual(Object.keys(log), ['objectTypes', 'eventTypes', 'objects', 'events']);

      // Every object and event, once, under its type; every activity a declared event type.
      assert.deepEqual(log.objects.map((o) => o.id), graph.objects.map((o) => o.id));
      assert.deepEqual(log.events.map((e) => e.id), graph.events.map((e) => e.id));
      assert.deepEqual(
        log.eventTypes.map((t) => t.name),
        [...new Set(graph.events.map((e) => e.activity))].sort(),
      );

      // E2O: the same rows, renamed — the actor included, under its role.
      for (const [i, event] of graph.events.entries()) {
        const exported = log.events[i];
        assert.deepEqual(
          exported.relationships.map((r) => r.objectId),
          event.relationships.map((r) => r.object_id),
        );
        const actor = actorOf(event);
        if (actor) assert.ok(exported.relationships.some((r) => r.objectId === actor));
        assert.equal(
          exported.relationships.filter((r) => ['subject', 'pushed_commit'].includes(r.qualifier)).length,
          objectsOf(event).length,
        );
        assert.equal(exported.time, event.time.toISOString());
      }

      // O2O: one row per link, on its source, with the plain qualifier; evidence does not
      // travel. Compared as sets: the format nests the rows under their source object.
      const rows = (list) => list.map((r) => r.join('→')).sort();
      const o2o = log.objects.flatMap((o) => (o.relationships ?? []).map((r) => [o.id, r.objectId, r.qualifier]));
      assert.deepEqual(rows(o2o), rows(graph.links.map((l) => [l.source, l.target, l.qualifier])));
      assert.ok(!JSON.stringify(log).includes('"evidence"'));

      // Object attributes: the vmap values at time zero, the label, and the lifecycle as `state`.
      for (const [i, object] of graph.objects.entries()) {
        const attrs = log.objects[i].attributes;
        for (const [name, value] of Object.entries(object.vmap ?? {})) {
          if (value == null) continue;
          assert.ok(attrs.some((a) => a.name === name && a.value === value && a.time === '1970-01-01T00:00:00Z'), `${object.id}.${name}`);
        }
        const states = attrs.filter((a) => a.name === 'state');
        const expected = object.intervals.flatMap((iv) => [iv.start && 'open', iv.end && 'closed'].filter(Boolean));
        assert.deepEqual(states.map((s) => s.value), expected, `${object.id} lifecycle`);
      }
    });
  }
});

describe('the format checker names what it rejects', () => {
  const clean = () => ({
    objectTypes: [{ name: 'issue', attributes: [{ name: 'label', type: 'string' }] }, { name: 'actor', attributes: [] }],
    eventTypes: [{ name: 'IssueClosed', attributes: [{ name: 'comment', type: 'boolean' }] }],
    objects: [
      { id: 'issue:1', type: 'issue', attributes: [{ name: 'label', time: '1970-01-01T00:00:00Z', value: '#1' }] },
      { id: 'actor:a', type: 'actor', attributes: [] },
    ],
    events: [
      { id: 'e1', type: 'IssueClosed', time: '2025-01-01T00:00:00Z', attributes: [{ name: 'comment', value: false }],
        relationships: [{ objectId: 'issue:1', qualifier: 'subject' }, { objectId: 'actor:a', qualifier: 'closer' }] },
    ],
  });

  test('a clean log passes', () => {
    assert.deepEqual(findOcelProblems(clean()), []);
  });

  test('an extra top-level key, a shared id, an undeclared attribute, a timed event attribute, an untimed object attribute', () => {
    const problems = (mutate) => {
      const log = clean();
      mutate(log);
      return findOcelProblems(log).join('\n');
    };
    assert.match(problems((l) => (l.meta = {})), /exactly objectTypes, eventTypes, objects, events/);
    assert.match(problems((l) => (l.events[0].id = 'issue:1')), /both an event and an object/);
    assert.match(problems((l) => l.events[0].attributes.push({ name: 'extra', value: 1 })), /extra not declared for IssueClosed/);
    assert.match(problems((l) => (l.events[0].attributes[0].time = 'x')), /comment carries a time/);
    assert.match(problems((l) => delete l.objects[0].attributes[0].time), /label carries no time/);
    assert.match(problems((l) => (l.events[0].relationships = [{ objectId: 'actor:a', qualifier: 'closer' }])), /about no object/);
    assert.match(problems((l) => l.events[0].relationships.push({ objectId: 'pr:9', qualifier: 'subject' })), /unknown pr:9/);
  });
});
