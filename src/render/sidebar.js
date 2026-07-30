/**
 * The sidebar: track toggles, relationship toggles, actor rows and the search combos.
 *
 * The toggle architecture is worth preserving — a master checkbox that goes
 * indeterminate over mixed children, and sub-toggles that disable themselves when the
 * lane they depend on is hidden. That dependency-awareness is the right foundation for
 * "everything toggleable" in Task 3, so it is extended rather than replaced.
 *
 * What changed: relationship rows are built from the pairs actually present in the
 * sub-log rather than from four hardcoded combinations, and the group formerly
 * labelled `inferred` is now `extracted` in both its key and its label.
 */

import { glyph, typeColor, TYPE } from './theme.js';
import { escapeHtml } from './format.js';

const CHECKBOX_STYLE =
  'accent-color:var(--color-accent);width:14px;height:14px;flex:0 0 auto;cursor:pointer';
const SUB_CHECKBOX_STYLE = 'accent-color:var(--color-accent);width:13px;height:13px;cursor:pointer';
const ROW_STYLE = 'display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:var(--radius-sm)';

function chevron(open) {
  const span = document.createElement('span');
  span.style.cssText =
    'display:inline-flex;flex:0 0 auto;cursor:pointer;color:var(--color-neutral-500);' +
    `transition:transform .15s ease;transform:rotate(${open ? 90 : 0}deg)`;
  span.innerHTML =
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"></path></svg>';
  return span;
}

/** Track rows: one per lane, with a nested Comments toggle where comments exist. */
export function renderTrackRows({ container, state, laneTypes, onChange, relSync }) {
  container.innerHTML = '';

  for (const laneType of laneTypes) {
    const spec = TYPE[laneType];
    const hasComments = laneType === 'issue' || laneType === 'pull_request';

    const wrapper = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'sideRow on';
    row.style.cssText = ROW_STYLE;

    const chev = chevron(state.trackOpen[laneType]);
    if (!hasComments) chev.style.visibility = 'hidden';

    const label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;min-width:0;cursor:pointer';
    label.innerHTML =
      `<input type="checkbox" checked style="${CHECKBOX_STYLE}">` +
      `${glyph(spec.shape, spec.color)}` +
      `<span class="mono" style="font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;` +
      `white-space:nowrap">${spec.label}</span>`;

    const checkbox = label.querySelector('input');
    checkbox.checked = state.tracks[laneType] !== false;
    row.append(chev, label);
    wrapper.appendChild(row);

    let commentCheckbox = null;
    let sub = null;

    if (hasComments) {
      sub = document.createElement('div');
      sub.style.cssText =
        `display:${state.trackOpen[laneType] ? 'flex' : 'none'};align-items:center;gap:8px;` +
        `padding:4px 8px 6px 30px;opacity:${checkbox.checked ? 1 : 0.4}`;
      sub.innerHTML =
        `<label style="display:flex;align-items:center;gap:8px;cursor:pointer">` +
        `<input type="checkbox" checked style="${SUB_CHECKBOX_STYLE}">` +
        `<span class="mono" style="font-size:11px;color:var(--color-neutral-400)">Comments</span></label>`;

      commentCheckbox = sub.querySelector('input');
      commentCheckbox.checked = state.showComments[laneType] !== false;
      commentCheckbox.disabled = !checkbox.checked;
      sub.style.pointerEvents = checkbox.checked ? 'auto' : 'none';

      commentCheckbox.addEventListener('change', () => {
        state.showComments[laneType] = commentCheckbox.checked;
        onChange();
      });

      chev.addEventListener('click', (event) => {
        event.stopPropagation();
        state.trackOpen[laneType] = !state.trackOpen[laneType];
        chev.style.transform = `rotate(${state.trackOpen[laneType] ? 90 : 0}deg)`;
        sub.style.display = state.trackOpen[laneType] ? 'flex' : 'none';
      });

      wrapper.appendChild(sub);
    }

    checkbox.addEventListener('change', () => {
      state.tracks[laneType] = checkbox.checked;
      row.classList.toggle('on', checkbox.checked);
      if (commentCheckbox) {
        commentCheckbox.disabled = !checkbox.checked;
        sub.style.opacity = checkbox.checked ? '1' : '0.4';
        sub.style.pointerEvents = checkbox.checked ? 'auto' : 'none';
      }
      relSync();
      onChange();
    });

    container.appendChild(wrapper);
  }
}

/**
 * Relationship rows: one group per evidence class, each expanding into the
 * object-type pairs actually present.
 *
 * @returns {Function} a resync callback the track toggles call when a lane's
 *                     visibility changes, since a pair is unavailable when either of
 *                     its lanes is hidden.
 */
export function renderRelationshipRows({ container, state, relGroups, onChange }) {
  container.innerHTML = '';
  const syncers = [];

  for (const group of relGroups) {
    const wrapper = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'sideRow on';
    row.style.cssText = ROW_STYLE;

    const chev = chevron(state.relOpen[group.key]);
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;min-width:0;cursor:pointer';
    label.innerHTML =
      `<input type="checkbox" checked style="${CHECKBOX_STYLE}">` +
      `<span class="mono" style="font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;` +
      `white-space:nowrap">${group.label}</span>`;

    const master = label.querySelector('input');
    row.append(chev, label);
    wrapper.appendChild(row);

    const sub = document.createElement('div');
    sub.style.cssText =
      `display:${state.relOpen[group.key] ? 'flex' : 'none'};flex-direction:column;gap:2px;` +
      'padding:4px 8px 6px 30px';

    const children = [];
    const available = (pair) => state.tracks[pair.types[0]] && state.tracks[pair.types[1]];

    function sync() {
      const availablePairs = group.pairs.filter(available);
      const values = group.pairs.map((pair) => state.relPairs[pair.key]);
      const allOn = values.every(Boolean);
      const allOff = values.every((v) => !v);

      master.indeterminate = !allOn && !allOff;
      master.checked = allOn;
      master.disabled = availablePairs.length === 0;
      label.style.opacity = availablePairs.length === 0 ? 0.45 : 1;
      row.classList.toggle('on', !allOff);

      for (const child of children) {
        const ok = available(child.pair);
        child.checkbox.disabled = !ok;
        child.row.style.opacity = ok ? 1 : 0.45;
        child.row.style.pointerEvents = ok ? 'auto' : 'none';
      }
    }

    master.addEventListener('change', () => {
      for (const pair of group.pairs) {
        if (available(pair)) state.relPairs[pair.key] = master.checked;
      }
      for (const child of children) {
        if (available(child.pair)) child.checkbox.checked = master.checked;
      }
      sync();
      onChange();
    });

    for (const pair of group.pairs) {
      const childRow = document.createElement('label');
      childRow.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer';
      childRow.innerHTML =
        `<input type="checkbox" checked style="${SUB_CHECKBOX_STYLE}">` +
        `<span class="mono" style="font-size:11px;color:var(--color-neutral-400)">${pair.label}</span>`;

      const checkbox = childRow.querySelector('input');
      checkbox.checked = state.relPairs[pair.key] !== false;
      checkbox.addEventListener('change', () => {
        state.relPairs[pair.key] = checkbox.checked;
        sync();
        onChange();
      });

      children.push({ pair, checkbox, row: childRow });
      sub.appendChild(childRow);
    }

    chev.addEventListener('click', (event) => {
      event.stopPropagation();
      state.relOpen[group.key] = !state.relOpen[group.key];
      chev.style.transform = `rotate(${state.relOpen[group.key] ? 90 : 0}deg)`;
      sub.style.display = state.relOpen[group.key] ? 'flex' : 'none';
    });

    wrapper.appendChild(sub);
    container.appendChild(wrapper);
    sync();
    syncers.push(sync);
  }

  return () => syncers.forEach((sync) => sync());
}

/** Actor rows, with a colour swatch, an event count and a profile button. */
export function renderActorRows({ container, searchInput, actors, actorColors, state, onChange, onProfile }) {
  container.innerHTML = '';

  for (const actor of actors) {
    const row = document.createElement('div');
    row.className = 'sideRow';
    row.dataset.login = String(actor.vmap?.login || actor.label || '').toLowerCase();
    row.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--radius-sm)';
    row.classList.toggle('on', state.actors.has(actor.id));

    row.innerHTML =
      `<span style="width:9px;height:9px;border-radius:50%;flex:0 0 auto;background:${actorColors.get(actor.id)}"></span>` +
      `<span class="mono" style="font-size:12px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;` +
      `white-space:nowrap">@${escapeHtml(actor.vmap?.login || actor.label)}</span>` +
      `<span class="mono" style="font-size:10px;color:var(--color-neutral-500);background:var(--color-neutral-900);` +
      `padding:2px 6px;border-radius:999px">${actor.eventCount}</span>` +
      `<span class="actorProfileBtn" style="display:inline-flex;flex:0 0 auto;color:var(--color-neutral-500);` +
      `cursor:pointer;padding:2px" title="View profile">` +
      `<svg fill="none" height="14" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" ` +
      `stroke-width="2" viewbox="0 0 24 24" width="14"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2">` +
      `</path><circle cx="12" cy="7" r="4"></circle></svg></span>`;

    row.addEventListener('click', () => {
      if (state.actors.has(actor.id)) {
        state.actors.delete(actor.id);
        row.classList.remove('on');
      } else {
        state.actors.add(actor.id);
        row.classList.add('on');
      }
      onChange();
    });

    const profileButton = row.querySelector('.actorProfileBtn');
    profileButton.addEventListener('click', (event) => {
      event.stopPropagation();
      onProfile(actor, profileButton);
    });

    container.appendChild(row);
  }

  searchInput.oninput = () => {
    const query = searchInput.value.toLowerCase();
    for (const row of container.children) {
      row.style.display = row.dataset.login.includes(query) ? 'flex' : 'none';
    }
  };
}

/**
 * A filterable combo box.
 *
 * The mockup built these but never passed an `onSelect`, so choosing an entry did
 * nothing at all. They are now wired to reload the sub-log.
 */
export function setupCombo({ input, dropdown, options, initialLabel, onSelect }) {
  input.value = initialLabel;
  input.setAttribute('value', initialLabel);

  function renderList(query) {
    const needle = (query || '').toLowerCase();
    const matches = options.filter((option) => option.label.toLowerCase().includes(needle));
    dropdown.innerHTML = '';

    if (!matches.length) {
      dropdown.innerHTML =
        '<div style="padding:10px 12px;font-size:12px;color:var(--color-neutral-500)">No matches</div>';
      return;
    }

    for (const option of matches) {
      const row = document.createElement('div');
      const disabled = !!option.disabled;
      row.className = 'mono';
      row.style.cssText =
        'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;' +
        `font-size:12.5px;cursor:${disabled ? 'not-allowed' : 'pointer'};` +
        `color:${disabled ? 'var(--color-neutral-600)' : 'var(--color-text)'};` +
        `opacity:${disabled ? 0.55 : 1}`;
      row.innerHTML =
        `<span>${escapeHtml(option.label)}</span>` +
        (disabled
          ? '<span style="font-size:9px;border:1px solid var(--color-neutral-700);padding:1px 5px;' +
            'border-radius:999px;color:var(--color-neutral-500)">no data</span>'
          : option.active
            ? '<span style="color:var(--color-accent);font-size:11px">✓</span>'
            : '');

      if (!disabled) {
        row.addEventListener('mouseenter', () => {
          row.style.background = 'color-mix(in srgb, var(--color-text) 6%, transparent)';
        });
        row.addEventListener('mouseleave', () => {
          row.style.background = '';
        });
        row.addEventListener('mousedown', (event) => {
          event.preventDefault();
          input.value = option.label;
          input.setAttribute('value', option.label);
          dropdown.style.display = 'none';
          onSelect?.(option);
        });
      }
      dropdown.appendChild(row);
    }
  }

  input.addEventListener('focus', () => {
    renderList(input.value === initialLabel ? '' : input.value);
    dropdown.style.display = 'block';
  });
  input.addEventListener('input', () => {
    renderList(input.value);
    dropdown.style.display = 'block';
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      dropdown.style.display = 'none';
    }, 120);
  });
}
