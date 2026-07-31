/**
 * Named saved views.
 *
 * A preset is the whole toggle state under a name. In Green's terms this is an
 * *abstraction manager* — and his rule applies: "if the user is allowed to modify
 * abstractions, the system always requires a redefinition sub-device", which is why
 * save / rename / delete all exist rather than just save.
 *
 * Presets cut repetition viscosity, raise provisionality and support progressive
 * evaluation. Their cost is **hidden dependencies**: a saved view silently conceals
 * what it filtered, so a sparse timeline reads as "few links" when it is really
 * "links hidden". That cost is mitigated by `summarizeHidden` in `state.js`, whose
 * output the UI must always display. Presets without that summary would be a net
 * loss in comprehensibility.
 *
 * Encoding a preset into a URL is the reproducibility mechanism for the task-based
 * evaluation: "load this link" is the cheapest possible guarantee that two people on
 * two machines are looking at the same configuration.
 */

const STORAGE_KEY = 'ocpm_viz.presets.v1';
/** Bump when the snapshot shape changes incompatibly. */
const SNAPSHOT_VERSION = 1;

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
    tracks: { ...state.tracks },
    showComments: { ...state.showComments },
    hiddenObjects: [...state.hiddenObjects],
    hiddenCommitGroups: [...state.hiddenCommitGroups],
    relPairs: { ...state.relPairs },
    qualifiers: { ...state.qualifiers },
    methods: { ...state.methods },
    burstThreshold: state.burstThreshold,
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
  if (snapshot.burstThreshold != null) state.burstThreshold = snapshot.burstThreshold;

  for (const field of ['tracks', 'showComments', 'relPairs', 'qualifiers', 'methods']) {
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
 * The shareable URL for a configuration.
 *
 * Carries the *query* — repository and seed — alongside the toggles, so the link
 * reproduces both what was selected and how it was filtered. Those are the two
 * halves of what someone else needs to see the same screen.
 */
export function presetUrl(baseUrl, query, snapshot) {
  const url = new URL(baseUrl);
  url.search = '';
  if (query?.repo) url.searchParams.set('repo', query.repo);
  if (query?.seed) url.searchParams.set('seed', query.seed);
  if (query?.fixture && !query.repo) url.searchParams.set('fixture', query.fixture);
  url.searchParams.set('preset', encodePreset(snapshot));
  return url.toString();
}

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
 * They double as zero-interaction defaults and as evaluation material: each is a
 * question someone might actually arrive with, already configured.
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
      tracks: { issue: true, pull_request: true, commit: true },
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
      tracks: { issue: true, pull_request: true, commit: true },
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
      tracks: { issue: true, pull_request: true, commit: false },
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
      tracks: { issue: false, pull_request: true, commit: true },
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
