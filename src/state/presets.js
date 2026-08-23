/**
 * Named saved views.
 *
 * A preset is the whole toggle state under a name. Anything the user can define, the
 * user must also be able to redefine, which is why save / rename / delete all exist
 * rather than just save.
 *
 * Presets save re-doing the same toggles by hand: a view is cheap to try, its effect
 * shows at once, and it is cheap to throw away. Their cost is state the user cannot
 * see on screen: a saved view silently conceals what it filtered, so a sparse timeline
 * reads as "few links" when it is really "links hidden". That cost is mitigated by
 * `summarizeHidden` in `state.js`, whose output the UI must always display. Presets
 * without that summary would be a net loss in comprehensibility.
 *
 * Encoding a preset into a URL is how a configuration is reproduced: "load this link"
 * is the cheapest possible guarantee that two people on two machines are looking at the
 * same configuration.
 */

const STORAGE_KEY = 'ocpm_viz.presets.v1';
/** Bump when the snapshot shape changes incompatibly. */
const SNAPSHOT_VERSION = 2;

// ---------------------------------------------------------------------------
// serialization
// ---------------------------------------------------------------------------

/**
 * Capture the toggle state as a plain, JSON-safe object.
 *
 * Deliberately excludes zoom, scroll, focus and burst expansion. A preset answers
 * "what is shown", not "where was I looking" — restoring someone else's scroll
 * position is noise, and focus is a transient probe rather than a configuration.
 */
export function serializeState(state) {
  return {
    v: SNAPSHOT_VERSION,
    mode: state.mode,
    // Which arrangement the relationships mode uses — part of the view, like the mode:
    // rows and clusters are two different pictures of one configuration.
    structuralLayout: state.structuralLayout,
    lanes: { ...state.lanes },
    showComments: { ...state.showComments },
    hiddenObjects: [...state.hiddenObjects],
    hiddenCommitGroups: [...state.hiddenCommitGroups],
    relPairs: { ...state.relPairs },
    qualifiers: { ...state.qualifiers },
    methods: { ...state.methods },
  };
}

/**
 * Apply a snapshot over the current state.
 *
 * Merges rather than replaces, so a snapshot taken against a different sub-log —
 * an old preset, or a shared URL — still applies what it can instead of blanking
 * toggles it has never heard of.
 */
export function applyState(state, snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return state;

  if (snapshot.mode) state.mode = snapshot.mode;
  if (snapshot.structuralLayout) state.structuralLayout = snapshot.structuralLayout;
  // `burstThreshold` is gone — pushes fold by push_id, always. An
  // older snapshot may still carry it; ignoring it is right, and saying so here is what
  // stops the next reader hunting for the field it sets.

  /*
   * ⚠️ **`tracks` is read as well as `lanes`, and must stay readable.**
   *
   * Snapshot v1 wrote `tracks`; v2 writes `lanes` (the rename that made one word for one
   * concept). Presets live in local storage and in shared `?preset=` URLs — they are how
   * a configuration is reproduced — so a v1 snapshot
   * that quietly lost its lane settings would restore a *different picture* under the
   * same link, with nothing saying so. Dropping the alias is only safe once no v1
   * snapshot can exist anywhere, which is not a thing this code can know.
   */
  if (snapshot.tracks && !snapshot.lanes) snapshot = { ...snapshot, lanes: snapshot.tracks };

  for (const field of ['lanes', 'showComments', 'relPairs', 'qualifiers', 'methods']) {
    if (!snapshot[field]) continue;
    for (const [key, value] of Object.entries(snapshot[field])) {
      if (key in state[field]) state[field][key] = value;
      else state[field][key] = value;
    }
  }
  if (Array.isArray(snapshot.hiddenObjects)) state.hiddenObjects = new Set(snapshot.hiddenObjects);
  if (Array.isArray(snapshot.hiddenCommitGroups)) {
    state.hiddenCommitGroups = new Set(snapshot.hiddenCommitGroups);
  }
  return state;
}

// ---------------------------------------------------------------------------
// URL encoding
// ---------------------------------------------------------------------------

/** base64url, so a preset survives being pasted into a chat or an email. */
export function encodePreset(snapshot) {
  const json = JSON.stringify(snapshot);
  const base64 = typeof btoa === 'function' ? btoa(json) : Buffer.from(json).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodePreset(encoded) {
  if (!encoded) return null;
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const json = typeof atob === 'function' ? atob(base64) : Buffer.from(base64, 'base64').toString();
    return JSON.parse(json);
  } catch {
    // A malformed preset in a URL must not take the app down with it; the caller
    // falls back to defaults and says so.
    return null;
  }
}

/**
 * The shareable URL for a configuration — a URL that reproduces the current screen.
 *
 * Carries the *query* — source, repository, seed, traversal degree — alongside the
 * toggles, so the link reproduces both what was selected and how it was filtered; and the
 * *view* — page, brushed range, focused object — that lives in the URL rather than in a
 * preset because it belongs to this sub-log and this moment rather than to a reusable
 * configuration.
 *
 * ⚠️ **This is the write side of `queryFromUrl()` in `main.js`, and the two must name the
 * same parameters.** It used to write `repo`, `seed` and `preset` only. Against the
 * database that produced a link with no `?source=`, which opened on the *fixtures* source
 * and could not find the seed — reported as "copy link doesn't work anymore" — and it also
 * dropped the traversal degree, the arrangement, the brush and the focus, so even on
 * fixtures the link opened a different picture from the one copied. Every parameter the
 * reader parses is written here; `tests/toggles.test.js` pins the round trip.
 *
 * @param {string} baseUrl                     the page's own URL; its query is replaced
 * @param {object} query                        `{repo, seed, fixture, source, traversalDegree}`
 * @param {object} snapshot                     `serializeState(state)`
 * @param {object} [view]                       `{page, brush, focus, focusDegree, layout}`
 */
export function presetUrl(baseUrl, query, snapshot, view = {}) {
  const url = new URL(baseUrl);
  url.search = '';
  const set = (key, value) => {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  };
  // The source first: it decides how every other parameter is interpreted. Fixtures is
  // the default and is left implicit, as `?source=` parsing treats it.
  if (query?.source && query.source !== 'fixtures') set('source', query.source);
  set('repo', query?.repo);
  set('seed', query?.seed);
  if (query?.fixture && !query.repo) set('fixture', query.fixture);
  set('degree', query?.traversalDegree);
  set('preset', encodePreset(snapshot));
  // The view. `mode` and `layout` also travel inside the snapshot; they are written
  // here as well so a hand-edited link can change one knob without decoding a preset,
  // exactly as `queryFromUrl` reads them.
  set('mode', snapshot?.mode);
  set('layout', view.layout ?? snapshot?.structuralLayout);
  if (view.page && view.page !== 'timeline') set('page', view.page);
  if (Array.isArray(view.brush) && (view.brush[0] > 0 || view.brush[1] < 1)) {
    set('brush', `${round3(view.brush[0])},${round3(view.brush[1])}`);
  }
  if (view.focus) {
    set('focus', view.focus);
    set('focusDegree', view.focusDegree);
  }
  return url.toString();
}

const round3 = (n) => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

function storage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // storage can throw in a sandboxed or private-mode context
  }
}

export function loadPresets() {
  const store = storage();
  if (!store) return {};
  try {
    return JSON.parse(store.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writePresets(presets) {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(presets));
    return true;
  } catch {
    return false;
  }
}

export function savePreset(name, snapshot) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return false;
  const presets = loadPresets();
  presets[trimmed] = snapshot;
  return writePresets(presets);
}

export function deletePreset(name) {
  const presets = loadPresets();
  if (!(name in presets)) return false;
  delete presets[name];
  return writePresets(presets);
}

export function renamePreset(from, to) {
  const trimmed = String(to || '').trim();
  const presets = loadPresets();
  if (!trimmed || !(from in presets) || trimmed === from) return false;
  presets[trimmed] = presets[from];
  delete presets[from];
  return writePresets(presets);
}

// ---------------------------------------------------------------------------
// built-in presets
// ---------------------------------------------------------------------------

/**
 * Shipped views.
 *
 * They double as zero-interaction defaults and as worked examples: each is a question
 * someone might actually arrive with, already configured.
 *
 * Each is a function of the derived toggle vocabulary rather than a fixed snapshot,
 * because the keys depend on what the loaded sub-log contains — a fixed snapshot
 * would silently do nothing on a sub-log with different link classes.
 */
export const BUILT_IN_PRESETS = [
  {
    name: 'Everything',
    description: 'Every lane, link class and detection method visible.',
    build: ({ relGroups, qualifiers, methods }) => ({
      v: SNAPSHOT_VERSION,
      lanes: { issue: true, pull_request: true, commit: true },
      showComments: { issue: true, pull_request: true },
      hiddenObjects: [],
      hiddenCommitGroups: [],
      relPairs: allOn(relGroups.flatMap((g) => g.pairs.map((p) => p.key))),
      qualifiers: allOn(qualifiers.map((q) => q.key)),
      methods: allOn(methods.map((m) => m.key)),
    }),
  },
  {
    name: 'Validated links only',
    description:
      'Hides everything the platform does not itself assert, so what remains is only what GitHub acted on.',
    build: ({ relGroups, qualifiers, methods }) => ({
      v: SNAPSHOT_VERSION,
      lanes: { issue: true, pull_request: true, commit: true },
      showComments: { issue: true, pull_request: true },
      hiddenObjects: [],
      hiddenCommitGroups: [],
      relPairs: Object.fromEntries(
        relGroups.flatMap((group) => group.pairs.map((p) => [p.key, group.key === 'validated'])),
      ),
      qualifiers: allOn(qualifiers.map((q) => q.key)),
      // Method toggles are left on: evidence already excludes the extracted links,
      // and switching both off would make it impossible to tell which control is
      // responsible for an empty view.
      methods: allOn(methods.map((m) => m.key)),
    }),
  },
  {
    name: 'Lifecycle without commits',
    description: 'Issue and PR lifecycles only — the shape of the process, without the delivery detail.',
    build: ({ relGroups, qualifiers, methods }) => ({
      v: SNAPSHOT_VERSION,
      lanes: { issue: true, pull_request: true, commit: false },
      showComments: { issue: true, pull_request: true },
      hiddenObjects: [],
      hiddenCommitGroups: [],
      relPairs: allOn(relGroups.flatMap((g) => g.pairs.map((p) => p.key))),
      qualifiers: allOn(qualifiers.map((q) => q.key)),
      methods: allOn(methods.map((m) => m.key)),
    }),
  },
  {
    name: 'Commit integration focus',
    description: 'PRs and commits with the conversation stripped out — how code reached the branch.',
    build: ({ relGroups, qualifiers, methods }) => ({
      v: SNAPSHOT_VERSION,
      lanes: { issue: false, pull_request: true, commit: true },
      showComments: { issue: false, pull_request: false },
      hiddenObjects: [],
      hiddenCommitGroups: [],
      relPairs: allOn(relGroups.flatMap((g) => g.pairs.map((p) => p.key))),
      qualifiers: allOn(qualifiers.map((q) => q.key)),
      methods: allOn(methods.map((m) => m.key)),
    }),
  },
];

function allOn(keys) {
  return Object.fromEntries(keys.map((key) => [key, true]));
}
