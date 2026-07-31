/**
 * Fixture transport: load a raw `ObjectGraph` bundle from a local JSON file.
 *
 * This is the transport used until the RPC exists. Swapping to PostgREST means
 * adding a sibling transport in `api.js` and passing it to `loadObjectGraph` —
 * nothing above the data layer changes.
 */

/** Where fixture JSON is served from, relative to the page. */
const FIXTURE_BASE = './tests/fixtures/';

/**
 * The fixture registry, which doubles as the sidebar's source list.
 *
 * F1 is real data. Everything else is synthesized to exhibit one structural
 * property F1 cannot, and is labelled `synthetic: true` so the UI can say so —
 * a reader must never mistake a synthesized sub-log for observed behaviour.
 */
export const FIXTURES = {
  F1: {
    id: 'F1',
    label: 'vscode · issue #242864 → PR #243221',
    file: 'F1.json',
    synthetic: false,
  },
  F2: { id: 'F2', label: 'F2 · sequential PRs', file: 'F2.json', synthetic: true },
  F3: { id: 'F3', label: 'F3 · overlapping PRs', file: 'F3.json', synthetic: true },
  F4: { id: 'F4', label: 'F4 · two issues, one PR', file: 'F4.json', synthetic: true },
  F5: { id: 'F5', label: 'F5 · commit in two PRs', file: 'F5.json', synthetic: true },
  F6: { id: 'F6', label: 'F6 · no commits', file: 'F6.json', synthetic: true },
  F7: { id: 'F7', label: 'F7 · two bursts', file: 'F7.json', synthetic: true },
  F8: { id: 'F8', label: 'F8 · orphan PR', file: 'F8.json', synthetic: true },
  F9: { id: 'F9', label: 'F9 · reopened issue', file: 'F9.json', synthetic: true },
  F10: { id: 'F10', label: 'F10 · large (300 commits)', file: 'F10.json', synthetic: true },
  F11: { id: 'F11', label: 'F11 · all four detection methods', file: 'F11.json', synthetic: true },
  F12: { id: 'F12', label: 'F12 · mixed evidence, multi-method', file: 'F12.json', synthetic: true },
  F13: { id: 'F13', label: 'F13 · concurrent PRs, many commits', file: 'F13.json', synthetic: true },
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
