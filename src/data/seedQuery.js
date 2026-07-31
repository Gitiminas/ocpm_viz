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
 *   242864            a number — an issue or a PR (see below)
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

/**
 * Does this catalogue entry satisfy the reference?
 *
 * Matching is deliberately generous on identity and strict on type: a stated type
 * is honoured exactly, while an unstated one lets a number match an issue or a PR.
 */
export function matchesSeedRef(ref, seed) {
  if (!ref) return true;
  if (ref.type && ref.type !== seed.type) return false;

  const label = String(seed.label ?? '').toLowerCase();
  const id = String(seed.id ?? '').toLowerCase();
  const title = String(seed.title ?? '').toLowerCase();

  if (ref.number != null) {
    // Numbers are matched on the label rather than by substring, so 242 does not
    // match #242864 — a near-miss that silently loads the wrong sub-log is worse
    // than no match at all.
    const labelNumber = label.match(/\d+/);
    if (labelNumber && Number(labelNumber[0]) === ref.number) return true;
  }

  if (ref.shaPrefix && seed.type === 'commit') {
    if (id.includes(`:${ref.shaPrefix}`) || label.startsWith(ref.shaPrefix)) return true;
  }

  if (ref.number == null && ref.shaPrefix == null) {
    // A type word alone has already passed the type check above, so everything of
    // that type matches.
    if (!ref.text) return true;
    // Free text falls back to the title, which is what makes "mcp" find the issue
    // about MCP servers.
    return title.includes(ref.text) || label.includes(ref.text) || id.includes(ref.text);
  }

  return false;
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
