/**
 * Fixture transport: load a raw `ObjectGraph` bundle from a local JSON file.
 *
 * This is the transport used until the RPC exists. Swapping to PostgREST means
 * adding a sibling transport in `api.js` and passing it to `loadObjectGraph` —
 * nothing above the data layer changes.
 */

/** Where fixture JSON is served from, relative to the page. */
const FIXTURE_BASE = './tests/fixtures/';

export const FIXTURES = {
  F1: {
    id: 'F1',
    label: 'vscode · issue #242864 → PR #243221',
    file: 'F1.json',
  },
};

export async function fixtureTransport(query) {
  const id = query?.fixture || 'F1';
  const fixture = FIXTURES[id];
  if (!fixture) {
    throw new Error(`Unknown fixture "${id}". Known fixtures: ${Object.keys(FIXTURES).join(', ')}`);
  }

  const url = FIXTURE_BASE + fixture.file;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Could not load fixture ${id} from ${url} (HTTP ${response.status}). ` +
        `The app must be served over http — ES modules and fetch are both blocked on file:// . ` +
        `Run: npm start`,
    );
  }
  return response.json();
}
