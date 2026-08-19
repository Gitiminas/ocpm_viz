/**
 * The statistics page: a per-object table, aggregable on demand (decision 8).
 *
 * The mockup showed nine scalar cards — "Issue open → close: 4d 16h" — computed
 * from `issueObj` and `prObj`. With two issues that presentation does not degrade,
 * it *lies*: it reports one arbitrary object's numbers under a heading that reads
 * like a property of the sub-log. A row per object cannot make that mistake, and
 * aggregates are derived from the rows rather than being the only thing on offer.
 *
 * Everything numeric comes from `src/stats/metrics.js` as pure functions, and it is
 * computed over the **visible** sub-log, so the numbers answer the question the
 * screen is currently asking (decision 12).
 */

import { formatDuration, formatInstant, escapeHtml } from './format.js';
import { typeColor, chevronMarkup } from './theme.js';
import { TYPE_LABELS } from '../state/labels.js';
import {
  perObjectMetrics,
  groupRowsByType,
  prOutcomeDistribution,
  largestGaps,
  leadTimes,
  commitStats,
  commentCounts,
  linkCounts,
  landmarks,
} from '../stats/metrics.js';

const dash = (ms) => (ms == null ? '—' : formatDuration(Math.abs(ms)));
const hours = (h) => (h == null ? '—' : h >= 48 ? `${Math.round(h / 24)}d` : `${Math.round(h)}h`);

/** Which type groups the user has collapsed to their aggregate row. */
const collapsedTypes = new Set();

export function renderStats({
  graph,
  index,
  gridEl,
  landmarksEl,
  hiddenSummary,
  onRerender,
  /*
   * The same per-object shades the timeline uses (`assignObjectColors`).
   *
   * Without them this page painted every issue the same purple and every pull request
   * the same orange, so a table of four pull requests said "pull request" four times
   * and nothing about which was which — while the timeline beside it had already spent
   * a colour channel answering exactly that. Two views of one sub-log disagreeing about
   * what a colour means is worse than either being uncoloured.
   */
  objectColors = new Map(),
}) {
  gridEl.innerHTML = '';
  gridEl.style.cssText = 'display:flex;flex-direction:column;gap:var(--space-4)';

  // The stats page has no sidebar toggles and no banner, so if the numbers are
  // filtered it has to say so here or they read as facts about the whole sub-log.
  if (hiddenSummary?.anyHidden) {
    const notice = document.createElement('div');
    notice.className = 'mono';
    notice.style.cssText =
      'font-size:11px;color:var(--color-accent-300);border:1px solid var(--color-accent-700);' +
      'background:color-mix(in srgb, var(--color-accent) 10%, transparent);border-radius:var(--radius-sm);' +
      'padding:7px 10px;line-height:1.5';
    notice.textContent =
      `These figures describe the filtered view, not the whole sub-log — ` +
      `${hiddenSummary.items.map((item) => item.label).join('; ')}.`;
    gridEl.appendChild(notice);
  }

  const rows = perObjectMetrics(graph);
  const groups = groupRowsByType(rows);

  gridEl.appendChild(buildTable(groups, onRerender, objectColors));
  gridEl.appendChild(buildSubLogSummary(graph, index));
  renderLandmarkList(graph, landmarksEl, objectColors);
}

// ---------------------------------------------------------------------------

function buildTable(groups, onRerender, objectColors = new Map()) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'overflow-x:auto';

  const table = document.createElement('table');
  table.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px';

  const columns = [
    { key: 'label', label: 'Object', align: 'left' },
    { key: 'lifetime', label: 'Open for', align: 'right' },
    { key: 'events', label: 'Events', align: 'right' },
    { key: 'comments', label: 'Comments', align: 'right' },
    { key: 'actors', label: 'Actors', align: 'right' },
    { key: 'links', label: 'Links', align: 'right' },
    { key: 'maxGapHours', label: 'Longest gap', align: 'right' },
    { key: 'handoffs', label: 'Handoffs', align: 'right' },
    { key: 'outcome', label: 'Outcome', align: 'left' },
  ];

  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const column of columns) {
    const th = document.createElement('th');
    th.textContent = column.label;
    th.style.cssText =
      `text-align:${column.align};padding:6px 7px;font-size:9.5px;letter-spacing:.04em;` +
      'text-transform:uppercase;color:var(--color-neutral-500);font-weight:500;' +
      'border-bottom:1px solid var(--color-neutral-700);white-space:nowrap';
    headRow.appendChild(th);
  }
  head.appendChild(headRow);
  table.appendChild(head);

  const body = document.createElement('tbody');

  for (const group of groups) {
    const collapsed = collapsedTypes.has(group.type);
    const color = typeColor(group.type);

    // The aggregate row. Clicking it collapses the individuals away — that is the
    // "aggregable on demand" of decision 8, rather than a fixed level of detail.
    const groupRow = document.createElement('tr');
    groupRow.style.cssText = 'cursor:pointer;background:var(--color-neutral-900)';
    groupRow.title = collapsed ? 'Show individual objects' : 'Collapse to the aggregate';
    groupRow.addEventListener('click', () => {
      if (collapsed) collapsedTypes.delete(group.type);
      else collapsedTypes.add(group.type);
      onRerender?.();
    });

    const plural = `${group.aggregate.n} ${TYPE_LABELS[group.type] || group.type}${group.aggregate.n === 1 ? '' : 's'}`;
    const spread =
      group.aggregate.withDuration > 1
        ? ` · ${dash(group.aggregate.min)}–${dash(group.aggregate.max)}`
        : '';

    groupRow.innerHTML =
      `<td style="padding:8px 7px;border-bottom:1px solid var(--color-neutral-800);white-space:nowrap">` +
      `<span style="display:inline-flex;align-items:center;gap:8px">` +
      // Same chevron as the sidebar's collapsibles, pointing down when the group is open.
      chevronMarkup(!collapsed) +
      `<span style="width:8px;height:8px;border-radius:2px;background:${color}"></span>` +
      `<span style="font-weight:500;color:var(--color-text)">${plural}</span></span></td>` +
      cell(
        group.aggregate.median == null
          ? '—'
          : `median ${dash(group.aggregate.median)}${spread}`,
        'right',
        true,
      ) +
      cell(group.aggregate.events, 'right', true) +
      cell(group.aggregate.comments, 'right', true) +
      cell('—', 'right', true) +
      cell(group.aggregate.links, 'right', true) +
      cell('—', 'right', true) +
      cell(group.aggregate.handoffs, 'right', true) +
      cell('', 'left', true);
    body.appendChild(groupRow);

    if (collapsed) continue;

    for (const row of group.rows) {
      const tr = document.createElement('tr');
      const rowColor = objectColors.get(row.id) || color;
      tr.innerHTML =
        `<td style="padding:6px 7px 6px 26px;border-bottom:1px solid var(--color-neutral-900);` +
        `white-space:nowrap">` +
        `<span style="display:inline-block;width:7px;height:7px;border-radius:2px;` +
        `background:${rowColor};margin-right:8px;vertical-align:middle"></span>` +
        `<span class="mono" style="color:var(--color-neutral-300)">` +
        `${escapeHtml(row.label)}</span>` +
        (row.intervals > 1
          ? `<span class="mono" style="font-size:9.5px;color:var(--color-neutral-500);` +
            `margin-left:7px">${row.intervals} intervals</span>`
          : '') +
        '</td>' +
        cell(row.complete ? dash(row.lifetime) : `${dash(row.lifetime)}…`, 'right') +
        cell(row.events, 'right') +
        cell(row.comments, 'right') +
        cell(row.actors, 'right') +
        cell(row.links, 'right') +
        cell(hours(row.maxGapHours), 'right') +
        cell(row.handoffs, 'right') +
        cell(row.outcome || '', 'left');
      body.appendChild(tr);
    }
  }

  table.appendChild(body);
  wrap.appendChild(table);
  return wrap;
}

function cell(value, align, strong = false) {
  return (
    `<td class="mono" style="text-align:${align};padding:${strong ? '8px' : '6px'} 7px;` +
    `border-bottom:1px solid var(--color-neutral-${strong ? '800' : '900'});white-space:nowrap;` +
    `color:var(--color-neutral-${strong ? '300' : '400'})">${escapeHtml(String(value))}</td>`
  );
}

/** Facts about the sub-log as a whole rather than about any one object. */
function buildSubLogSummary(graph, index) {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;padding-top:4px';

  const commits = commitStats(graph);
  const comments = commentCounts(graph);
  const links = linkCounts(graph);
  const outcomes = prOutcomeDistribution(graph);
  const gaps = largestGaps(graph, 3);

  const card = (title, body, note) => {
    const el = document.createElement('div');
    el.style.cssText =
      'background:var(--color-neutral-900);border-radius:var(--radius-md);padding:12px 14px;' +
      'display:flex;flex-direction:column;gap:6px;min-width:0';
    el.innerHTML =
      `<div style="font-size:10px;letter-spacing:.04em;text-transform:uppercase;` +
      `color:var(--color-neutral-500)">${escapeHtml(title)}</div>` +
      `<div class="mono" style="font-size:12.5px;color:var(--color-text);line-height:1.6">${body}</div>` +
      (note
        ? `<div style="font-size:10.5px;color:var(--color-neutral-500);line-height:1.4">${escapeHtml(note)}</div>`
        : '');
    return el;
  };

  wrap.appendChild(
    card(
      'Link evidence',
      `${links.validated} validated · ${links.extracted} extracted`,
      'Validated means the platform asserts it; extracted means we parsed a convention nobody enforces.',
    ),
  );

  wrap.appendChild(
    card(
      'PR outcomes',
      outcomes.length
        ? outcomes.map((o) => `${o.count} ${escapeHtml(o.outcome)}`).join('<br>')
        : '—',
      'A closed-unmerged PR is a conformance deviation.',
    ),
  );

  wrap.appendChild(
    card(
      'Commits',
      `${commits.count} · ${commits.authors} git author${commits.authors === 1 ? '' : 's'}`,
      'Git authorship is a separate identity space from the GitHub actors.',
    ),
  );

  wrap.appendChild(
    card(
      'Actors and comments',
      `${index.objectsOfType('actor').length} actors · ${comments.total} comments`,
      [...comments.byType.entries()].map(([type, n]) => `${n} on ${type.replace('_', ' ')}`).join(', '),
    ),
  );

  const lead = leadTimes(graph);
  if (lead.length) {
    wrap.appendChild(
      card(
        'Lead times',
        lead.map((entry) => `${escapeHtml(entry.label)} · ${dash(entry.value)}`).join('<br>'),
        'Earliest to earliest. With several issues or PRs there is no single such interval, ' +
          'so these describe the sub-log’s overall shape; the table is the per-object truth.',
      ),
    );
  }

  if (gaps.length) {
    wrap.appendChild(
      card(
        'Longest idle gaps',
        gaps
          .map(
            (gap) =>
              `${escapeHtml(gap.label)} · ${hours(gap.hours)}${gap.actorChanged ? ' ⇄' : ''}`,
          )
          .join('<br>'),
        '⇄ marks a gap spanning a handoff between actors.',
      ),
    );
  }

  return wrap;
}

function renderLandmarkList(graph, landmarksEl, objectColors = new Map()) {
  const entries = landmarks(graph);
  landmarksEl.innerHTML = '';

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
      `<div style="width:10px;height:10px;border-radius:50%;` +
      `background:${objectColors.get(entry.objectId) || typeColor(entry.type)};` +
      'box-shadow:0 0 0 3px var(--color-neutral-900)"></div></div>' +
      `<span style="flex:1;font-weight:500;color:var(--color-text)">${escapeHtml(entry.label)}</span>` +
      `<span class="mono" style="color:var(--color-neutral-500);font-size:11.5px">${formatInstant(entry.time)}</span>`;
    landmarksEl.appendChild(row);
  });
}
