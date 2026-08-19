/**
 * The help texts: what each thing on screen is, in one or two plain sentences.
 *
 * This file is a table and nothing else. The left side is a stable key that a control,
 * a row or a mark carries as `data-tip="<key>"` (marks carry `data-legend`, which maps to
 * `legend.<key>` here); the right side is the sentence the help strip shows while the
 * pointer or the keyboard focus is on it (`render/helpStrip.js`). Changing a wording is
 * an edit to this file and to nothing else.
 *
 * A few entries take an argument — the lane rows differ only by type, a saved view by its
 * own description — and are functions of it. `tipFor(key, arg)` resolves either form.
 *
 * ⚠️ DOM-free, and tested in both directions (`tests/tips.test.js`): every key referenced
 * from the markup or a renderer must exist here, and every key here must be referenced —
 * the same rule decision 82 applies to the legend, for the same reason: a label with no
 * text, or a text nobody shows, is a silent drift. The texts are also checked for the
 * project's retired words (`case`, `milestone`, `inferred`).
 *
 * Writing rule: short, plain, human. Say what the thing is and what touching it does.
 */

import { TYPE_LABELS } from '../state/labels.js';

/** What the strip says when nothing is hovered. */
export const DEFAULT_TIP = 'Hover over something to see what it is.';

const TYPE_NAMES = {
  issue: 'issue',
  pull_request: 'pull request',
  commit: 'commit',
  actor: 'actor',
};
const typeName = (type) => TYPE_NAMES[type] ?? TYPE_LABELS[type]?.toLowerCase() ?? type;
const plural = (word, n) => (n === 1 ? word : `${word}s`);

export const TIPS = Object.freeze({
  // ---- pages ----------------------------------------------------------------------
  'page.trace': 'The trace page: the sub-log drawn over time, or as a graph of relationships.',
  'page.stats': 'The statistics page: durations, counts and gaps for each object, computed from what is currently shown.',

  // ---- the query ------------------------------------------------------------------
  'source.fixtures': 'Pre-built test sub-logs that ship with the tool. Synthetic data for trying things out. No database needed.',
  'source.database': 'Live data from the database through PostgREST. Any issue, pull request or commit can be the starting point.',
  'query.repo': 'The repository the sub-log is taken from. Type to search.',
  'query.seed': 'The object to start from: an issue or PR number, a commit SHA, or some words from a title. The sub-log is everything reached from it.',
  'query.degree': 'How many hops to follow from the starting object. 0 is the object alone, 1 adds what it touches directly, 2 adds what those touch.',
  'query.degree.fixed': 'Pre-built sub-logs were built at a fixed number of hops. Use the database source to change it.',

  // ---- the sub-log card -----------------------------------------------------------
  card: 'What is currently shown, counted. When something is hidden by a toggle, the total follows after a slash.',
  'card.type': (type) => `How many ${plural(typeName(type), 2)} are shown, against how many the sub-log holds.`,
  'card.links': 'Links between objects that are shown. A link joins two objects, such as a PR and the issue it closes.',
  'card.events': 'Events that are shown. An event is one thing that happened to one object, such as an issue being opened.',
  'card.span': 'From the first shown event to the last, in UTC.',

  // ---- sidebar sections ----------------------------------------------------------
  'section.views': 'Saved combinations of toggles. Apply one, save the current one, or copy a link that reproduces this screen.',
  'section.lanes': 'Show or hide whole object types, their comments, and single objects.',
  'section.relationships': 'Show or hide links by how trustworthy they are, what they mean, and how they were found.',
  'section.folding': 'How marks that belong together are folded into one: pushes by push id, comments by time.',
  'section.actors': 'Everyone who did something in this sub-log. Hover to preview their trail, click to pin it.',
  'section.legend': 'What each shape, ring and line means. Dimmed rows are not in the current picture.',

  // ---- views --------------------------------------------------------------------
  'views.preset': (description) => description || 'A saved combination of toggles. Click to apply it.',
  'views.save': 'Save the current toggles, mode and arrangement as a named view, in this browser.',
  'views.copyLink': 'Copy a link that reopens this exact screen: the source, the sub-log, the toggles, the mode and the zoom.',
  'views.rename': 'Rename this saved view.',
  'views.delete': 'Delete this saved view.',

  // ---- lanes --------------------------------------------------------------------
  lane: (type) => `Show or hide every ${typeName(type)}. Open the row to toggle comments or single objects.`,
  'lane.comments': (type) => `Show or hide the comments on ${plural(typeName(type), 2)}. Hiding them changes the gap figures on the statistics page.`,
  'lane.object': 'Show or hide this one object.',
  'lane.group': 'Commits grouped by the pull request they reached. Hide a group to hide its commits.',

  // ---- relationships ------------------------------------------------------------
  'rel.validated': 'Links the platform itself asserts, such as a closing keyword GitHub acted on or an exact SHA match. Drawn solid.',
  'rel.extracted': 'Links we parsed from a convention nobody enforces, such as a number mentioned in a commit message. Drawn dashed, with a question mark.',
  'rel.pair': (label) => `Show or hide ${label || 'this kind of link'}.`,
  'rel.qualifiers': 'What a link means: resolves, references, contains a commit, and so on.',
  'rel.qualifier': (label) => `Show or hide links that mean "${label}".`,
  'rel.methods': 'How a link was found: the PR body, a commit message, a branch name, a SHA match.',
  'rel.method': (label) => `Show or hide links found by ${label}.`,

  // ---- folding ------------------------------------------------------------------
  'folding.pushes': 'Commits pushed together are drawn as one mark with a count. Click the mark to unfold it, and the minus above it to fold it back.',
  'folding.commentWindow': 'Comments closer together than this are drawn as one mark. Slide to change how close counts as together.',

  // ---- actors -------------------------------------------------------------------
  'actors.search': 'Filter the list of actors by login.',
  'actors.row': 'One actor. Hover to preview everything they touched, click to keep it shown.',
  'actors.profile': 'Open a card with everything this actor did in the sub-log.',

  // ---- mode and view controls ---------------------------------------------------
  'mode.time': 'Position means time. Each object has a lane, and marks sit where their events happened.',
  'mode.relationships': 'Position means relationships. Objects that are linked sit near each other, and the time axis is released.',
  'mode.absolute': 'The time axis is linear. A long quiet stretch takes as much room as a busy one.',
  'mode.discrete': 'Events are spaced evenly in order. Long gaps are marked on the axis instead of taking room.',
  'layout.rows': 'Issues in the top row, pull requests below, commits at the bottom, arranged to keep links short.',
  'layout.clusters': 'Each pull request is a hub with its commits around it. Drag a mark to move it and its neighbours follow.',
  'zoom.in': 'Zoom in. In relationships mode the wheel zooms too, around the pointer.',
  'zoom.out': 'Zoom out.',
  'zoom.reset': 'Put the view back: the zoom, any marks you dragged, and the time range.',
  'focus.info': 'Which object is focused. Click a mark to focus it, click the background to clear it.',
  'focus.degree': 'How far the focus reaches: the object alone, what it touches, or one hop further.',
  brush: 'The time range that is lit. Drag a handle to dim everything outside it.',
  minimap: 'The whole time span in one strip. Drag the window to move, drag its edge to zoom.',
  'hidden.banner': 'Everything currently hidden by a toggle, so a sparse picture is never mistaken for sparse data.',
  'hidden.chip': 'Something that is hidden. Click to show it again.',
  'hidden.restoreAll': 'Show everything again.',
  'stats.dashboard': (name) => `Show or hide the ${name || 'dashboard'} below.`,
  'stats.group': 'One object type, summarised. Click the row to show or hide its individual objects.',
  'fold.handle': 'Fold these commits back into one push mark.',

  // ---- marks and legend rows (legend.<key>, shared by the rows and the marks) -----
  'legend.issue': 'An issue. A circle, in the issue colour.',
  'legend.pull_request': 'A pull request. A diamond, in the PR colour.',
  'legend.commit': 'A commit, or a push of several commits shown as one square with a count.',
  'legend.comments': 'A comment on an issue or pull request. Small, and hidden with the comments toggle.',
  'legend.comment-burst': 'Several comments close together in time, drawn as one hollow mark with a count.',
  'legend.landmark': 'A solid ring marks the end of a lifecycle: a pull request merged or an issue closed.',
  'legend.closed-unmerged': 'A dashed ring marks a pull request that was closed without being merged.',
  'legend.repeat-observation': 'The same commit seen in another push. A hollow square, joined to the first sighting by a hairline.',
  'legend.burst': 'A push of several commits folded into one mark. The number is how many. Click to unfold.',
  'legend.link-validated': 'A link the platform itself asserts. Solid line.',
  'legend.link-extracted': 'A link parsed from a convention, such as a number in a commit message. Dashed line with a question mark.',
  'legend.link-crowded': 'More links meet here than can be drawn apart. The number says how many.',
  'legend.precedence-arrow': 'The arrowhead points at the end that came later in time.',
  'legend.sequence': 'The line that joins one object’s own events in order.',
  'legend.actor-trail': 'The path of the selected actor through everything they touched.',
});

/**
 * The text for a key, or null when there is none. Function entries receive `arg`.
 */
export function tipFor(key, arg = undefined) {
  const entry = TIPS[key];
  if (entry == null) return null;
  return typeof entry === 'function' ? entry(arg) : entry;
}
