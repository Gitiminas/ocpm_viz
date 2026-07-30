/**
 * The statistics page.
 *
 * A thin presentation layer over `src/stats/metrics.js` — everything numeric is
 * computed there, as pure functions, so the numbers are testable without a DOM.
 *
 * ⚠️ Task 4 replaces these cards with a per-object table that aggregates on demand
 * (decision 8). This is the minimum needed for Task 1: the mockup's nine cards read
 * `issueObj` and `prObj` directly and would report one arbitrary object's numbers as
 * if they were the sub-log's. They now aggregate across N.
 */

import { formatDuration, formatInstant, escapeHtml } from './format.js';
import { typeColor } from './theme.js';
import {
  aggregateDuration,
  commitStats,
  commentCounts,
  linkCounts,
  leadTimeToFirstCommit,
  milestones,
} from '../stats/metrics.js';

const dash = (ms) => (ms == null ? '—' : formatDuration(Math.abs(ms)));

export function renderStats({ graph, index, gridEl, milestonesEl, breadcrumbEl, description }) {
  breadcrumbEl.textContent = description;

  const issues = aggregateDuration(graph, 'issue');
  const prs = aggregateDuration(graph, 'pull_request');
  const commits = commitStats(graph);
  const comments = commentCounts(graph);
  const links = linkCounts(graph);
  const actors = index.objectsOfType('actor').length;

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const cards = [
    [
      'Issue open → close',
      dash(issues.median),
      issues.n === 1 ? 'one issue' : `median of ${plural(issues.n, 'issue')}`,
    ],
    [
      'PR open → close',
      dash(prs.median),
      prs.n === 1 ? 'one pull request' : `median of ${plural(prs.n, 'pull request')}`,
    ],
    ['Issue → first commit', dash(leadTimeToFirstCommit(graph)), 'lead time'],
    ['Commits', String(commits.count), plural(commits.authors, 'git author')],
    [
      'Comments',
      String(comments.total),
      [...comments.byType.entries()].map(([type, n]) => `${n} ${type.replace('_', ' ')}`).join(', ') || '—',
    ],
    ['Actors involved', String(actors), 'across all events'],
    ['Links', `${links.validated} validated`, `${links.extracted} extracted`],
  ];

  gridEl.innerHTML = '';
  for (const [label, value, note] of cards) {
    const cell = document.createElement('div');
    cell.style.cssText =
      'background:var(--color-neutral-900);border-radius:var(--radius-md);padding:14px 16px;' +
      'display:flex;flex-direction:column;gap:6px;min-width:0';
    cell.innerHTML =
      `<div style="font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;` +
      `color:var(--color-neutral-500);line-height:1.4">${escapeHtml(label)}</div>` +
      `<div class="mono" style="font-size:19px;font-weight:500;color:var(--color-text);` +
      `line-height:1.2">${escapeHtml(value)}</div>` +
      `<div style="font-size:11px;color:var(--color-neutral-500);line-height:1.3">${escapeHtml(note)}</div>`;
    gridEl.appendChild(cell);
  }

  const entries = milestones(graph);
  milestonesEl.innerHTML = '';
  entries.forEach((entry, i) => {
    const row = document.createElement('div');
    row.style.cssText =
      'position:relative;display:flex;align-items:center;gap:14px;font-size:12.5px;' +
      'color:var(--color-neutral-300);padding:13px 4px';
    const isLast = i === entries.length - 1;
    row.innerHTML =
      '<div style="position:relative;flex:0 0 auto;width:10px;height:10px;z-index:1">' +
      (isLast
        ? ''
        : '<div style="position:absolute;left:50%;top:10px;width:1px;height:44px;' +
          'transform:translateX(-50%);background:var(--color-neutral-700)"></div>') +
      `<div style="width:10px;height:10px;border-radius:50%;background:${typeColor(entry.type)};` +
      'box-shadow:0 0 0 3px var(--color-neutral-900)"></div></div>' +
      `<span style="flex:1;font-weight:500;color:var(--color-text)">${escapeHtml(entry.label)}</span>` +
      `<span class="mono" style="color:var(--color-neutral-500);font-size:11.5px">${formatInstant(entry.time)}</span>`;
    milestonesEl.appendChild(row);
  });
}
