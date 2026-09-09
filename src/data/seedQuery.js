/**
 * Parsing what someone types into the "Start from" box.
 *
 * The seed picker cannot enumerate its options. A repository like kubernetes holds
 * hundreds of thousands of issues and pull requests and millions of commits, so
 * there is no list to scroll and no summary to precompute — working out what a seed
 * *yields* would mean running the traversal for every candidate. The interaction is
 * therefore a **search**: type an identifier, resolve it, load the sub-log.
 *
 * Accepted forms, all case-insensitive:
 *
 *   242864            a number — an issue or a PR (see below); matches by substring
 *   #242864           the same, written the way GitHub writes it
 *   issue 242864      constrained to an issue
 *   pr #243221        constrained to a pull request
 *   commit dcc7479    a commit, by SHA prefix
 *   dcc7479           a bare hex string is taken as a SHA prefix
 *
 * ⚠️ A bare number is genuinely ambiguous in the *query* but not in the *data*:
 * GitHub draws issue and pull-request numbers from one sequence per repository, so
 * #242864 is one or the other and never both. The resolver therefore looks for
 * either and returns whichever exists, rather than making the user state which.
 */

/** A hex string this long or longer is worth treating as a SHA prefix. */
const MIN_SHA_PREFIX = 4;

const TYPE_WORDS = [
  [/^(issues?)\b/, 'issue'],
  [/^(prs?|pull[\s-]?requests?)\b/, 'pull_request'],
  [/^(commits?|shas?)\b/, 'commit'],
];

/**
 * Parse a search string into a seed reference.
 *
 * Returns `null` for input that names nothing. A reference may carry both `number`
 * and `shaPrefix` — "123" is a plausible issue number *and* a plausible SHA prefix,
 * and refusing to guess between them is better than picking one.
 */
export function parseSeedRef(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  let rest = raw.toLowerCase();
  let type = null;

  for (const [pattern, typeName] of TYPE_WORDS) {
    const match = rest.match(pattern);
    if (!match) continue;
    type = typeName;
    rest = rest.slice(match[0].length).trim();
    break;
  }

  rest = rest.replace(/^#/, '').trim();

  // A type word on its own is a filter, not nothing: typing "pr" should narrow to
  // pull requests rather than matching everything.
  if (!rest) return type ? { raw, type, number: null, shaPrefix: null, text: '' } : null;

  const number = /^\d+$/.test(rest) ? Number(rest) : null;
  const shaPrefix = /^[0-9a-f]+$/.test(rest) && rest.length >= MIN_SHA_PREFIX ? rest : null;

  return { raw, type, number, shaPrefix, text: rest };
}

/** Scores, highest first. Only the ordering matters, not the absolute values. */
const SCORE = { exact: 100, prefix: 60, substring: 30, title: 20, typeOnly: 10, none: -1 };

/**
 * How well a catalogue entry satisfies the reference. `-1` means it does not.
 *
 * Matching is generous on identity and strict on type: a stated type is honoured
 * exactly, while an unstated one lets a number match an issue or a PR.
 *
 * **Numbers match by substring**, so `242` finds `#242864` — that is how every
 * typeahead behaves and it is what people expect. An earlier version required the
 * whole number, on the reasoning that a near-miss might load the wrong sub-log;
 * that reasoning was wrong, because nothing auto-loads. Results appear in a list
 * and the user picks one, so a surplus candidate costs a glance while a missing one
 * costs the search. Ranking is what keeps it usable: an exact match outranks a
 * prefix, which outranks a substring, so typing `242864` still puts `#242864` first
 * even where `#1242864` also exists.
 *
 * SHAs stay **prefix**-matched, because abbreviating a SHA from the front is the git
 * convention and a mid-SHA substring hit would be noise rather than intent.
 */
export function scoreSeedRef(ref, seed) {
  if (!ref) return SCORE.typeOnly;
  if (ref.type && ref.type !== seed.type) return SCORE.none;

  const label = String(seed.label ?? '').toLowerCase();
  const id = String(seed.id ?? '').toLowerCase();
  const title = String(seed.title ?? '').toLowerCase();

  if (ref.number != null) {
    const digits = (label.match(/\d+/) || [''])[0];
    const needle = String(ref.number);
    if (digits === needle) return SCORE.exact;
    if (digits.startsWith(needle)) return SCORE.prefix;
    if (digits.includes(needle)) return SCORE.substring;
  }

  if (ref.shaPrefix && seed.type === 'commit') {
    const sha = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
    if (sha === ref.shaPrefix) return SCORE.exact;
    if (sha.startsWith(ref.shaPrefix) || label.startsWith(ref.shaPrefix)) return SCORE.prefix;
  }

  if (ref.number == null && ref.shaPrefix == null) {
    // A type word alone has already passed the type check above, so everything of
    // that type matches.
    if (!ref.text) return SCORE.typeOnly;
    // Free text falls back to the title, which is what makes "mcp" find the issue
    // about MCP servers.
    if (label.includes(ref.text) || id.includes(ref.text)) return SCORE.substring;
    if (title.includes(ref.text)) return SCORE.title;
  }

  return SCORE.none;
}

/** Whether the entry matches at all. */
export function matchesSeedRef(ref, seed) {
  return scoreSeedRef(ref, seed) >= 0;
}

/**
 * A seed as the seed box and the sub-log card name it: the type word, then the label
 * with any type word the label itself carries removed — `issue #47532`, `pull request
 * #102479`, `commit 05579e1`. Object labels name their type (`Issue #N`, `PR #N`) so a
 * card can stand alone; the seed box already says the type, so it must not say it twice.
 */
export function seedDisplayLabel(seed) {
  const type = String(seed.type || 'object').replace('_', ' ');
  const label = String(seed.label ?? seed.id ?? '').replace(/^(PR|Issue)\s+/, '');
  return `${type} ${label}`;
}

/** Human-readable description of a reference, for the "nothing found" message. */
export function describeSeedRef(ref) {
  if (!ref) return 'anything';
  const kind = ref.type ? ref.type.replace('_', ' ') : 'object';
  if (ref.number != null) return `${kind} #${ref.number}`;
  if (ref.shaPrefix) return `commit ${ref.shaPrefix}`;
  if (!ref.text) return `any ${kind}`;
  return `${kind} matching "${ref.text}"`;
}
