/**
 * The actor profile card.
 *
 * ⚠️ Two mocks were deliberately **not** carried over from the mockup, which is
 * nominally Task 5's job but could not wait: porting them would have meant writing
 * `Math.random()` placeholder rows and a fake loading delay into new files, and
 * fabricated placeholder UI is forbidden outright.
 *
 * What was dropped:
 *   - four blurred `Math.random()`-width rows behind a "Look up user activity" prompt
 *   - a 650 ms artificial spinner before the *already-loaded* list was revealed
 *
 * Both were pure theatre — the data was in memory the whole time — and in a
 * task-based usability evaluation a fake spinner invites a participant to report a
 * performance problem that does not exist.
 */

import { formatInstant, escapeHtml } from './format.js';
import { glyph, TYPE, typeColor } from './theme.js';
import { activityLabel } from '../model/activities.js';

export function createActorCard({ element }) {
  document.addEventListener('click', (event) => {
    if (element.style.display !== 'none' && !element.contains(event.target)) {
      element.style.display = 'none';
    }
  });
  element.addEventListener('click', (event) => event.stopPropagation());

  /** Everything this actor did, across every object in the sub-log. */
  function activity(actor, graph, index) {
    const items = [];

    for (const event of graph.events) {
      if (event.actor_id !== actor.id) continue;
      const object = index.byId.get(event.object_id);
      if (!object || object.type === 'commit') continue;
      items.push({
        time: event.time,
        type: object.type,
        label: event.comment
          ? `Comment on ${object.label}`
          : `${object.label} · ${activityLabel(event.activity)}`,
      });
    }

    for (const commit of index.objectsOfType('commit')) {
      if (index.pusherByCommit.get(commit.id) !== actor.id) continue;
      items.push({
        time: commit.intervals?.[0]?.start,
        type: 'commit',
        label: `Pushed ${commit.label}`,
      });
    }

    return items.filter((item) => item.time).sort((a, b) => +a.time - +b.time);
  }

  function open(actor, anchorElement, { graph, index, color }) {
    const anchor = anchorElement.getBoundingClientRect();
    const items = activity(actor, graph, index);
    const login = actor.vmap?.login || actor.label;

    const rows = items
      .map(
        (item) =>
          '<div style="display:flex;align-items:center;gap:8px;padding:6px 2px;' +
          'border-bottom:1px dashed var(--color-neutral-800);font-size:11.5px">' +
          `${glyph(TYPE[item.type]?.shape || 'square', typeColor(item.type))}` +
          `<span style="flex:1;color:var(--color-text)">${escapeHtml(item.label)}</span>` +
          `<span class="mono" style="color:var(--color-neutral-500);font-size:10.5px">${formatInstant(item.time)}</span>` +
          '</div>',
      )
      .join('');

    element.innerHTML =
      '<div style="padding:14px;display:flex;align-items:center;gap:10px;' +
      'border-bottom:1px solid var(--color-neutral-800)">' +
      `<span style="width:34px;height:34px;border-radius:50%;background:${color};display:flex;` +
      'align-items:center;justify-content:center;flex:0 0 auto">' +
      '<svg fill="none" height="18" stroke="var(--color-bg)" stroke-linecap="round" ' +
      'stroke-linejoin="round" stroke-width="2" viewBox="0 0 24 24" width="18">' +
      '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>' +
      '<circle cx="12" cy="7" r="4"></circle></svg></span>' +
      '<div style="min-width:0">' +
      `<div class="mono" style="font-size:13px;font-weight:500;color:var(--color-text)">@${escapeHtml(login)}</div>` +
      `<a href="https://www.github.com/${encodeURIComponent(login)}" target="_blank" rel="noopener" ` +
      'class="mono" style="font-size:11px;color:var(--color-accent-300);text-decoration:none">' +
      `www.github.com/${escapeHtml(login)}</a></div></div>` +
      '<div style="max-height:220px;overflow-y:auto;padding:6px 14px 12px">' +
      (rows ||
        '<div style="font-size:11.5px;color:var(--color-neutral-500);padding:8px 0">' +
          'No recorded activity in this sub-log.</div>') +
      '</div>' +
      '<div style="padding:8px 14px;border-top:1px solid var(--color-neutral-800);' +
      'font-size:10.5px;color:var(--color-neutral-500);line-height:1.4">' +
      'Activity within the loaded sub-log only. Commit authorship is a separate git identity ' +
      'and is not joined to this account.</div>';

    element.style.display = 'block';
    element.style.left = `${anchor.right + 10}px`;
    element.style.top = `${Math.max(10, Math.min(anchor.top, window.innerHeight - 380))}px`;
  }

  return { open, close: () => (element.style.display = 'none') };
}
