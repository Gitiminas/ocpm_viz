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

import {
  createRpcTransport,
  createDfgTransport,
  searchSeeds,
  DEFAULT_BASE_URL,
  TRAVERSAL_DEGREE,
} from '../src/data/api.js';
import { loadSubLog } from '../src/data/loadSubLog.js';
import { loadDfg } from '../src/data/loadDfg.js';
import { DFG_CONTRACT_VERSION } from '../src/model/dfg.js';
import { resolveQuery } from '../src/data/source.js';

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
  test('posts to /rpc/get_sublog with SQL parameter names', async () => {
    const { fetchImpl, calls } = stubFetch({ status: 200, body: MINIMAL_GRAPH });
    const transport = createRpcTransport({ fetchImpl });

    await transport({ repo: 'microsoft/vscode', seed: 'pr:1', traversalDegree: 2 });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/rpc/get_sublog`);
    assert.equal(calls[0].init.method, 'POST');
    // PostgREST resolves the overload by ARGUMENT NAME, so these must match the SQL
    // exactly. A typo here is a 404 "could not find the function", not a 400 — which
    // is a confusing enough failure to be worth pinning.
    assert.deepEqual(calls[0].body, {
      repo: 'microsoft/vscode',
      seed: 'pr:1',
      traversal_degree: 2,
    });
  });

  test('traversal degree defaults to 1 and is sent as a number', async () => {
    // The seed and what it directly touches is the question most loads ask.
    const { fetchImpl, calls } = stubFetch({ status: 200, body: MINIMAL_GRAPH });
    await createRpcTransport({ fetchImpl })({ repo: 'r', seed: 's' });
    assert.equal(calls[0].body.traversal_degree, 1);
    assert.equal(TRAVERSAL_DEGREE.default, 1);

    await createRpcTransport({ fetchImpl })({ repo: 'r', seed: 's', traversalDegree: '2' });
    assert.strictEqual(calls[1].body.traversal_degree, 2, 'a string degree must be coerced');
  });

  test('a degree outside 0..2 is refused before anything is sent', async () => {
    // The range caps at 2 — the third hop turns a 42-object sub-log into 291 on a busy
    // seed and nothing the tool asks needs it. The SQL guard enforces the same range;
    // refusing here says which field is wrong instead of surfacing a 400.
    const { fetchImpl, calls } = stubFetch({ status: 200, body: MINIMAL_GRAPH });
    const transport = createRpcTransport({ fetchImpl });
    for (const bad of [3, -1, 1.5, 'two']) {
      await assert.rejects(
        () => transport({ repo: 'r', seed: 's', traversalDegree: bad }),
        /traversalDegree must be an integer from 0 to 2/,
        `degree ${bad} should be refused`,
      );
    }
    assert.equal(calls.length, 0, 'nothing may reach the network');
    assert.equal(TRAVERSAL_DEGREE.max, 2);
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
    assert.equal(calls[0].url, 'https://example.test/api/rpc/get_sublog');
  });
});

describe('failures arrive as something a person can act on', () => {
  test("the RPC's own hint survives into the error message", async () => {
    // This is the shape api.get_sublog really returns for a display number
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
  test('loadSubLog validates an RPC payload the same way it validates a fixture', async () => {
    const { fetchImpl } = stubFetch({ status: 200, body: MINIMAL_GRAPH });
    const graph = await loadSubLog(
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
        loadSubLog(
          { repo: 'r', seed: 's' },
          { transport: createRpcTransport({ fetchImpl }) },
        ),
      /closed set/,
      'a repo-typed object must be rejected however it arrived',
    );
  });
});

describe('seed search bridges display numbers to database ids', () => {
  /** A stub search transport that records the params it was asked for. */
  function stubSearch(rows) {
    const calls = [];
    return {
      calls,
      transport: async (params) => {
        calls.push(params);
        return rows;
      },
    };
  }

  const ISSUE = { id: 'issue:655615214', type: 'issue', label: '#102358', title: 'SCM view empty' };
  const PR = { id: 'pr:448781946', type: 'pull_request', label: 'PR #102479', title: 'fixes #102358' };
  const COMMIT = { id: 'commit:48fd5cbf', type: 'commit', label: '48fd5cb', sha: '48fd5cbf', title: 'fixes' };

  test('a bare number is sent as a number query, not as free text', async () => {
    const { transport, calls } = stubSearch([ISSUE]);
    await searchSeeds('microsoft/vscode', '102358', { transport });

    assert.equal(calls[0].number_query, '102358');
    assert.equal(calls[0].text_query, null, 'a number must not also be searched as text');
    assert.equal(calls[0].repo, 'microsoft/vscode');
  });

  test('a stated type is passed through as a filter', async () => {
    const { transport, calls } = stubSearch([PR]);
    await searchSeeds('microsoft/vscode', 'pr 102479', { transport });
    assert.equal(calls[0].seed_type, 'pull_request');
    assert.equal(calls[0].number_query, '102479');
  });

  test('a hex string is sent as a SHA prefix', async () => {
    const { transport, calls } = stubSearch([COMMIT]);
    await searchSeeds('microsoft/vscode', '48fd5cb', { transport });
    assert.equal(calls[0].sha_prefix, '48fd5cb');
  });

  test('every parameter is present as null rather than omitted', async () => {
    // JSON.stringify drops undefined keys, and a dropped key makes PostgREST resolve a
    // different function signature -- a 404 that reads as "function missing" rather than
    // "argument absent". Pinned because the failure is so misleading.
    const { transport, calls } = stubSearch([]);
    await searchSeeds('r', 'mcp', { transport });
    for (const key of ['seed_type', 'number_query', 'sha_prefix', 'text_query']) {
      assert.ok(key in calls[0], `${key} must be sent`);
      assert.notEqual(calls[0][key], undefined, `${key} must be null, never undefined`);
    }
  });

  test('results are ranked here, not by the server: exact beats substring', async () => {
    // The server returns a permissive superset in a stable but meaningless order; the
    // ranking is scoreSeedRef, the same function the fixture catalogue search uses.
    const { transport } = stubSearch([
      { id: 'issue:1', type: 'issue', label: '#1102358' },
      { id: 'issue:2', type: 'issue', label: '#102358' },
      { id: 'issue:3', type: 'issue', label: '#1023580' },
    ]);
    const hits = await searchSeeds('r', '102358', { transport });
    assert.equal(hits[0].id, 'issue:2', 'the exact match must come first');
    assert.equal(hits[1].id, 'issue:3', 'then the prefix match');
  });

  test('non-matching rows the server returned are dropped, not shown', async () => {
    const { transport } = stubSearch([ISSUE, { id: 'issue:9', type: 'issue', label: '#999' }]);
    const hits = await searchSeeds('r', '102358', { transport });
    assert.deepEqual(hits.map((h) => h.id), ['issue:655615214']);
  });

  test('it asks for more than it returns, so ranking has something to rank', async () => {
    const { transport, calls } = stubSearch([]);
    await searchSeeds('r', '10', { transport, limit: 20 });
    assert.ok(calls[0].max_results > 20, 'trimming before ranking would discard better matches');
    assert.ok(calls[0].max_results <= 200, 'and must stay within the server cap');
  });
});

describe('a query is resolved before anything is fetched', () => {
  const dbSource = { defaultSeed: async () => null };
  const fixtureSource = { defaultSeed: async (repo) => (repo === 'has-seeds' ? 'issue:1' : null) };

  test('a ?fixture= address loads directly and is never asked for a seed', async () => {
    // The regression this suite exists for: `?fixture=` carries no seed by design, and
    // testing only for a seed made every fixture link show the "choose a seed" prompt.
    for (const source of [dbSource, fixtureSource]) {
      const resolved = await resolveQuery({ fixture: 'F1' }, source);
      assert.equal(resolved.action, 'load');
      assert.deepEqual(resolved.query, { fixture: 'F1' });
    }
  });

  test('repo plus seed is a complete query', async () => {
    const resolved = await resolveQuery({ repo: 'r', seed: 'pr:1' }, dbSource);
    assert.equal(resolved.action, 'load');
    assert.equal(resolved.query.seed, 'pr:1');
  });

  test('a repo with no seed prompts against the database, which cannot default', async () => {
    const resolved = await resolveQuery({ repo: 'microsoft/vscode' }, dbSource);
    assert.equal(resolved.action, 'prompt');
    assert.equal(resolved.repo, 'microsoft/vscode');
  });

  test('a repo with no seed loads the first servable one against fixtures', async () => {
    const resolved = await resolveQuery({ repo: 'has-seeds' }, fixtureSource);
    assert.equal(resolved.action, 'load');
    assert.equal(resolved.query.seed, 'issue:1');
  });

  test('a repo the fixture source cannot serve still prompts rather than failing', async () => {
    const resolved = await resolveQuery({ repo: 'no-seeds' }, fixtureSource);
    assert.equal(resolved.action, 'prompt');
  });

  test('a bare visit with no repo at all still loads something on fixtures', async () => {
    // `/` with no query is the normal way to open the app. The fixture transport always
    // resolved this internally; when the decision moved into resolveQuery, dropping the
    // no-repo case made a plain visit show the seed prompt with a repository already
    // selected — nonsense, and caught by opening it rather than by a test.
    const anyRepo = { defaultSeed: async (repo) => (repo ? null : 'issue:242864') };
    const resolved = await resolveQuery({}, anyRepo);
    assert.equal(resolved.action, 'load');
    assert.equal(resolved.query.seed, 'issue:242864');
  });
});

describe('an unreachable database says so, and says what to do', () => {
  test('a network failure names PostgREST and the way out, not "fetch failed"', async () => {
    // `fetch` surfaces an unreachable server as the bare string "fetch failed", which
    // names neither the server nor the fact that one is involved. Since the app
    // defaults to fixtures, that is exactly the moment someone concludes the tool is
    // broken and switches back, never learning a process was simply not running.
    const dead = async () => {
      throw new TypeError('fetch failed');
    };
    const transport = createRpcTransport({ fetchImpl: dead, baseUrl: 'http://localhost:9999' });

    await assert.rejects(
      () => transport({ repo: 'r', seed: 'pr:1' }),
      (error) => {
        assert.match(error.message, /Could not reach PostgREST at http:\/\/localhost:9999/);
        assert.match(error.message, /postgrest postgrest\.conf/, 'must say how to start it');
        assert.match(error.message, /Fixtures/, 'must offer the source that needs no database');
        assert.equal(error.unreachable, true);
        assert.equal(error.cause?.message, 'fetch failed', 'the original must survive');
        return true;
      },
    );
  });

  test('an HTTP error is left alone — it is not a reachability problem', async () => {
    // A 400 means PostgREST answered. Wrapping it in "could not reach" would send the
    // reader after the wrong thing and bury the RPC's own hint.
    const { fetchImpl } = stubFetch({
      status: 400,
      body: { code: 'P0001', message: 'seed x is not an issue', hint: 'ids are prefixed' },
    });
    await assert.rejects(
      () => createRpcTransport({ fetchImpl })({ repo: 'r', seed: 'x' }),
      (error) => {
        assert.match(error.message, /seed x is not an issue/);
        assert.notEqual(error.unreachable, true);
        return true;
      },
    );
  });
});

describe('the DFG transport asks for one repository and nothing else', () => {
  const MINIMAL_DFG = {
    meta: { repo: 'microsoft/vscode', dfg_contract_version: DFG_CONTRACT_VERSION, generated_at: '2026-09-01T00:00:00+00:00' },
    nodes: [],
    edges: [],
    cross_edges: [],
  };

  test('posts to /rpc/get_dfg with the SQL parameter name', async () => {
    const { fetchImpl, calls } = stubFetch({ status: 200, body: MINIMAL_DFG });
    await createDfgTransport({ fetchImpl })({ repo: 'microsoft/vscode' });
    assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/rpc/get_dfg`);
    assert.deepEqual(calls[0].body, { repo: 'microsoft/vscode' });
  });

  test('a missing repo fails before anything is fetched', async () => {
    const { fetchImpl, calls } = stubFetch({ status: 200, body: MINIMAL_DFG });
    await assert.rejects(() => createDfgTransport({ fetchImpl })({}), /query\.repo is required/);
    assert.equal(calls.length, 0);
  });

  test('an unreachable server is reworded the same way as the sub-log transport', async () => {
    const fetchImpl = async () => {
      throw new Error('fetch failed');
    };
    await assert.rejects(
      () => createDfgTransport({ fetchImpl, baseUrl: 'http://localhost:9999' })({ repo: 'r' }),
      (error) => {
        assert.match(error.message, /Could not reach PostgREST/);
        assert.equal(error.unreachable, true);
        return true;
      },
    );
  });

  test('loadDfg validates, normalizes and records the query', async () => {
    const dfg = await loadDfg({ repo: 'r' }, { transport: async () => MINIMAL_DFG });
    assert.ok(dfg.meta.generated_at instanceof Date);
    assert.deepEqual(dfg.meta.query, { repo: 'r' });
  });

  test('loadDfg refuses a malformed payload with the problems listed', async () => {
    const broken = { ...MINIMAL_DFG, meta: { ...MINIMAL_DFG.meta, dfg_contract_version: 9 } };
    await assert.rejects(
      () => loadDfg({ repo: 'r' }, { transport: async () => broken }),
      /Malformed DFG/,
    );
  });

  test('loadDfg demands a transport rather than defaulting to one', async () => {
    // Which DFG transport applies is the source's call; a silent default would let a
    // caller load the sample while believing it queried the database.
    await assert.rejects(() => loadDfg({ repo: 'r' }), /a transport is required/);
  });
});
