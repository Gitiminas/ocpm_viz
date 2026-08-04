/**
 * The PostgREST transport, exercised without a PostgREST.
 *
 * `fetchImpl` is injectable precisely so this suite can run in `npm test` with no
 * database, no server and no network — the same property every other module here has.
 * What it checks is the transport's own contract: that it asks for the right thing,
 * and that a failure arrives as something a person can act on.
 *
 * What it deliberately does NOT check is whether the payload is correct — that needs a
 * real database, and it is `scripts/rpc-check.mjs`'s job.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createRpcTransport, DEFAULT_BASE_URL } from '../src/data/api.js';
import { loadObjectGraph } from '../src/data/loadObjectGraph.js';

/** A fetch stub that records the request and replays a canned response. */
function stubFetch(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: response.status < 400,
      status: response.status,
      json: async () => {
        if (response.throwOnJson) throw new Error('not json');
        return response.body;
      },
    };
  };
  return { fetchImpl, calls };
}

const MINIMAL_GRAPH = {
  meta: { repo: 'microsoft/vscode', seed: [{ id: 'pr:1', type: 'pull_request' }], traversal_degree: 2 },
  objects: [{ id: 'pr:1', type: 'pull_request', label: 'PR #1', intervals: [] }],
  events: [],
  links: [],
};

describe('the RPC transport asks for the right thing', () => {
  test('posts to /rpc/get_object_graph with SQL parameter names', async () => {
    const { fetchImpl, calls } = stubFetch({ status: 200, body: MINIMAL_GRAPH });
    const transport = createRpcTransport({ fetchImpl });

    await transport({ repo: 'microsoft/vscode', seed: 'pr:1', traversalDegree: 3 });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/rpc/get_object_graph`);
    assert.equal(calls[0].init.method, 'POST');
    // PostgREST resolves the overload by ARGUMENT NAME, so these must match the SQL
    // exactly. A typo here is a 404 "could not find the function", not a 400 — which
    // is a confusing enough failure to be worth pinning.
    assert.deepEqual(calls[0].body, {
      repo: 'microsoft/vscode',
      seed: 'pr:1',
      traversal_degree: 3,
    });
  });

  test('traversal degree defaults to 2 and is sent as a number', async () => {
    const { fetchImpl, calls } = stubFetch({ status: 200, body: MINIMAL_GRAPH });
    await createRpcTransport({ fetchImpl })({ repo: 'r', seed: 's' });
    assert.equal(calls[0].body.traversal_degree, 2);

    await createRpcTransport({ fetchImpl })({ repo: 'r', seed: 's', traversalDegree: '3' });
    assert.strictEqual(calls[1].body.traversal_degree, 3, 'a string degree must be coerced');
  });

  test('a missing repo or seed fails in the transport, naming the field', async () => {
    const { fetchImpl } = stubFetch({ status: 200, body: MINIMAL_GRAPH });
    const transport = createRpcTransport({ fetchImpl });

    await assert.rejects(() => transport({ seed: 'pr:1' }), /query\.repo is required/);
    await assert.rejects(() => transport({ repo: 'r' }), /query\.seed is required/);
  });

  test('the base url is injectable, so a deployment need not edit the module', async () => {
    const { fetchImpl, calls } = stubFetch({ status: 200, body: MINIMAL_GRAPH });
    await createRpcTransport({ fetchImpl, baseUrl: 'https://example.test/api' })({
      repo: 'r',
      seed: 's',
    });
    assert.equal(calls[0].url, 'https://example.test/api/rpc/get_object_graph');
  });
});

describe('failures arrive as something a person can act on', () => {
  test("the RPC's own hint survives into the error message", async () => {
    // This is the shape api.get_object_graph really returns for a display number
    // typed where a database id belongs — the single most likely user error.
    const { fetchImpl } = stubFetch({
      status: 400,
      body: {
        code: 'P0001',
        message: 'seed 242864 is not an issue, pull request or commit in microsoft/vscode',
        hint: 'Object ids are type-prefixed and carry the DATABASE id, not the display number',
        details: null,
      },
    });

    await assert.rejects(
      () => createRpcTransport({ fetchImpl })({ repo: 'microsoft/vscode', seed: '242864' }),
      (error) => {
        assert.match(error.message, /not an issue, pull request or commit/);
        assert.match(error.message, /Hint: Object ids are type-prefixed/);
        assert.equal(error.status, 400);
        assert.equal(error.code, 'P0001');
        return true;
      },
    );
  });

  test('a non-JSON error body still throws with the status, rather than hanging', async () => {
    // What a proxy in front of PostgREST, or nothing listening, actually looks like.
    const { fetchImpl } = stubFetch({ status: 502, throwOnJson: true });
    await assert.rejects(
      () => createRpcTransport({ fetchImpl })({ repo: 'r', seed: 's' }),
      /HTTP 502/,
    );
  });
});

describe('the transport is a drop-in for the fixture transport', () => {
  test('loadObjectGraph validates an RPC payload the same way it validates a fixture', async () => {
    const { fetchImpl } = stubFetch({ status: 200, body: MINIMAL_GRAPH });
    const graph = await loadObjectGraph(
      { repo: 'microsoft/vscode', seed: 'pr:1', traversalDegree: 2 },
      { transport: createRpcTransport({ fetchImpl }) },
    );

    // Normalized, and carrying the query that produced it — the same postconditions
    // the fixture path has. If this holds, nothing above the data layer can tell the
    // two apart, which is the property the whole seam exists for.
    assert.equal(graph.objects.length, 1);
    assert.deepEqual(graph.meta.query, {
      repo: 'microsoft/vscode',
      seed: 'pr:1',
      traversalDegree: 2,
    });
  });

  test('a malformed RPC payload is rejected by the validator, not passed through', async () => {
    const { fetchImpl } = stubFetch({
      status: 200,
      body: { ...MINIMAL_GRAPH, objects: [{ id: 'x:1', type: 'repo', intervals: [] }] },
    });

    await assert.rejects(
      () =>
        loadObjectGraph(
          { repo: 'r', seed: 's' },
          { transport: createRpcTransport({ fetchImpl }) },
        ),
      /closed set/,
      'a repo-typed object must be rejected however it arrived (decision 39)',
    );
  });
});
