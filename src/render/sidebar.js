/**
 * The sidebar: every control that subtracts from the picture.
 *
 * The toggle architecture from the mockup is preserved and extended rather than
 * replaced — a master checkbox that goes indeterminate over mixed children, and
 * sub-toggles that disable themselves when the lane they depend on is hidden. That
 * dependency-awareness is what "independently toggleable" needs to stay honest.
 *
 * What Task 3 adds:
 *   - individual issues and PRs, so one of two concurrent PRs can be hidden
 *     without hiding its lane
 *   - commit *groups* rather than individual commits: a real sub-log has hundreds
 *     of commits and nobody wants that many checkboxes, but "the commits that went
 *     into this PR" is a unit people reason about
 *   - per-qualifier and per-detection-method link filters
 *
 * Every control here feeds `summarizeHidden`, so nothing can be switched off
 * without the app saying so.
 */

import { glyph, typeColor, TYPE } from './theme.js';
import { escapeHtml } from './format.js';

const CHECKBOX = 'accent-color:var(--color-accent);width:14px;height:14px;flex:0 0 auto;cursor:pointer';
const SUB_CHECKBOX = 'accent-color:var(--color-accent);width:13px;height:13px;cursor:pointer';
const ROW = 'display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:var(--radius-sm)';
const SUB_WRAP =
  'flex-direction:column;gap:2px;padding:4px 8px 6px 30px;border-left:1px solid var(--color-neutral-800);margin-left:14px';

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

/** A nested checkbox row: label, optional colour swatch, optional count badge. */
function subRow({ label, checked, swatch, count, onChange }) {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;padding:1px 0';
  row.innerHTML =
    `<input type="checkbox" style="${SUB_CHECKBOX}">` +
    (swatch
      ? `<span style="width:8px;height:8px;border-radius:2px;flex:0 0 auto;background:${swatch}"></span>`
      : '') +
    `<span class="mono" style="font-size:11px;color:var(--color-neutral-400);flex:1;` +
    `overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(label)}</span>` +
    (count == null
      ? ''
      : `<span class="mono" style="font-size:9.5px;color:var(--color-neutral-600)">${count}</span>`);

  const checkbox = row.querySelector('input');
  checkbox.checked = checked;
  checkbox.addEventListener('change', () => onChange(checkbox.checked));
  return { row, checkbox };
}

/** A section with a master checkbox, a chevron and a list of children. */
function masterSection({ label, open, children, onMasterChange, onToggleOpen }) {
  const wrapper = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'sideRow on';
  row.style.cssText = ROW;

  const chev = chevron(open);
  const labelEl = document.createElement('label');
  labelEl.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;min-width:0;cursor:pointer';
  labelEl.innerHTML =
    `<input type="checkbox" checked style="${CHECKBOX}">` +
    `<span class="mono" style="font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;` +
    `white-space:nowrap">${escapeHtml(label)}</span>`;

  const master = labelEl.querySelector('input');
  master.addEventListener('change', () => onMasterChange(master.checked));

  row.append(chev, labelEl);
  wrapper.appendChild(row);

  const sub = document.createElement('div');
  sub.style.cssText = `display:${open ? 'flex' : 'none'};${SUB_WRAP}`;
  for (const child of children) sub.appendChild(child);
  wrapper.appendChild(sub);

  chev.addEventListener('click', (event) => {
    event.stopPropagation();
    const nowOpen = sub.style.display === 'none';
    sub.style.display = nowOpen ? 'flex' : 'none';
    chev.style.transform = `rotate(${nowOpen ? 90 : 0}deg)`;
    onToggleOpen?.(nowOpen);
  });

  return { wrapper, row, master, labelEl, sub };
}

function sectionLabel(text) {
  const el = document.createElement('div');
  el.className = 'mono';
  el.style.cssText =
    'font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:var(--color-neutral-600);' +
    'padding:5px 0 2px';
  el.textContent = text;
  return el;
}

/**
 * Track rows: one per lane, expanding into its comment toggle, its individual
 * objects, and — for the commit lane — its commit groups.
 */
export function renderTrackRows({
  container,
  state,
  laneTypes,
  index,
  objectColors,
  commitGroups,
  onChange,
  relSync,
}) {
  container.innerHTML = '';

  for (const laneType of laneTypes) {
    const spec = TYPE[laneType];
    const hasComments = laneType === 'issue' || laneType === 'pull_request';
    const objects = index.objectsOfType(laneType);
    const children = [];
    const childControls = [];

    if (hasComments) {
      const { row } = subRow({
        label: 'Comments',
        checked: state.showComments[laneType] !== false,
        onChange: (checked) => {
          state.showComments[laneType] = checked;
          onChange();
        },
      });
      children.push(row);
    }

    if (laneType === 'commit') {
      // Groups, not individual commits: a sub-log can hold hundreds of commits, and
      // "the commits of PR #x" is the unit that is actually meaningful.
      if (commitGroups.length) {
        children.push(sectionLabel('commit groups'));
        for (const group of commitGroups) {
          const { row, checkbox } = subRow({
            label: `${group.label} · ${group.commitIds.size}`,
            checked: !state.hiddenCommitGroups.has(group.key),
            swatch: group.prId ? objectColors.get(group.prId) : 'var(--color-neutral-600)',
            onChange: (checked) => {
              if (checked) state.hiddenCommitGroups.delete(group.key);
              else state.hiddenCommitGroups.add(group.key);
              onChange();
            },
          });
          children.push(row);
          childControls.push({ checkbox, isOn: () => !state.hiddenCommitGroups.has(group.key) });
        }
      }
    } else if (objects.length) {
      children.push(sectionLabel(`${objects.length} object${objects.length === 1 ? '' : 's'}`));
      for (const object of objects) {
        const { row, checkbox } = subRow({
          label: object.label || object.id,
          checked: !state.hiddenObjects.has(object.id),
          swatch: objectColors.get(object.id) || typeColor(laneType),
          onChange: (checked) => {
            if (checked) state.hiddenObjects.delete(object.id);
            else state.hiddenObjects.add(object.id);
            onChange();
          },
        });
        children.push(row);
        childControls.push({ checkbox, isOn: () => !state.hiddenObjects.has(object.id) });
      }
    }

    const section = masterSection({
      label: spec.label,
      open: state.trackOpen[laneType],
      children,
      onMasterChange: (checked) => {
        state.tracks[laneType] = checked;
        section.row.classList.toggle('on', checked);
        section.sub.style.opacity = checked ? '1' : '0.4';
        section.sub.style.pointerEvents = checked ? 'auto' : 'none';
        relSync();
        onChange();
      },
      onToggleOpen: (open) => {
        state.trackOpen[laneType] = open;
      },
    });

    // The glyph goes next to the master label, so a lane still reads as its type.
    section.labelEl.insertAdjacentHTML('afterbegin', glyph(spec.shape, spec.color));
    section.master.checked = state.tracks[laneType] !== false;
    section.row.classList.toggle('on', section.master.checked);
    section.sub.style.opacity = section.master.checked ? '1' : '0.4';
    section.sub.style.pointerEvents = section.master.checked ? 'auto' : 'none';
    if (!children.length) section.sub.remove();

    container.appendChild(section.wrapper);
  }
}

/**
 * Relationship rows: evidence groups, then qualifiers, then detection methods.
 *
 * Three independent filters over the same links. All are ANDed, so switching a
 * method off cannot be undone by leaving its qualifier on — which is what makes
 * "any single method can be excluded" true rather than approximately true.
 *
 * @returns {Function} a resync callback the lane toggles call, since a pair is
 *                     unavailable when either of its lanes is hidden.
 */
export function renderRelationshipRows({
  container,
  state,
  relGroups,
  qualifiers,
  methods,
  onChange,
}) {
  container.innerHTML = '';
  const syncers = [];

  for (const group of relGroups) {
    const available = (pair) => state.tracks[pair.types[0]] && state.tracks[pair.types[1]];
    const controls = [];
    const children = group.pairs.map((pair) => {
      const { row, checkbox } = subRow({
        label: pair.label,
        checked: state.relPairs[pair.key] !== false,
        onChange: (checked) => {
          state.relPairs[pair.key] = checked;
          sync();
          onChange();
        },
      });
      controls.push({ pair, checkbox, row });
      return row;
    });

    const section = masterSection({
      label: group.label,
      open: state.relOpen[group.key],
      children,
      onMasterChange: (checked) => {
        for (const pair of group.pairs) if (available(pair)) state.relPairs[pair.key] = checked;
        for (const control of controls) if (available(control.pair)) control.checkbox.checked = checked;
        sync();
        onChange();
      },
      onToggleOpen: (open) => {
        state.relOpen[group.key] = open;
      },
    });

    function sync() {
      const availablePairs = group.pairs.filter(available);
      const values = group.pairs.map((pair) => state.relPairs[pair.key]);
      const allOn = values.every(Boolean);
      const allOff = values.every((v) => !v);

      section.master.indeterminate = !allOn && !allOff;
      section.master.checked = allOn;
      section.master.disabled = availablePairs.length === 0;
      section.labelEl.style.opacity = availablePairs.length === 0 ? 0.45 : 1;
      section.row.classList.toggle('on', !allOff);

      for (const control of controls) {
        const ok = available(control.pair);
        control.checkbox.disabled = !ok;
        control.row.style.opacity = ok ? 1 : 0.45;
        control.row.style.pointerEvents = ok ? 'auto' : 'none';
      }
    }

    container.appendChild(section.wrapper);
    sync();
    syncers.push(sync);
  }

  // ---- qualifiers and detection methods ------------------------------------
  const simpleFilter = ({ label, key, entries, bag }) => {
    if (!entries.length) return;
    const controls = [];
    const children = entries.map((entry) => {
      const { row, checkbox } = subRow({
        label: entry.label,
        checked: bag[entry.key] !== false,
        count: entry.count,
        onChange: (checked) => {
          bag[entry.key] = checked;
          sync();
          onChange();
        },
      });
      controls.push({ entry, checkbox });
      return row;
    });

    const section = masterSection({
      label,
      open: state.relOpen[key],
      children,
      onMasterChange: (checked) => {
        for (const entry of entries) bag[entry.key] = checked;
        for (const control of controls) control.checkbox.checked = checked;
        sync();
        onChange();
      },
      onToggleOpen: (open) => {
        state.relOpen[key] = open;
      },
    });

    function sync() {
      const values = entries.map((entry) => bag[entry.key]);
      const allOn = values.every((v) => v !== false);
      const allOff = values.every((v) => v === false);
      section.master.indeterminate = !allOn && !allOff;
      section.master.checked = allOn;
      section.row.classList.toggle('on', !allOff);
      for (const control of controls) control.checkbox.checked = bag[control.entry.key] !== false;
    }

    container.appendChild(section.wrapper);
    sync();
    syncers.push(sync);
  };

  simpleFilter({ label: 'Qualifiers', key: 'qualifiers', entries: qualifiers, bag: state.qualifiers });
  simpleFilter({
    label: 'Detection methods',
    key: 'methods',
    entries: methods,
    bag: state.methods,
  });

  return () => syncers.forEach((sync) => sync());
}

/** The burst size threshold (decision 6) — a control, not a constant. */
export function renderBurstControls({ container, state, bursts, onChange }) {
  container.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:2px 8px';

  const label = document.createElement('div');
  label.className = 'mono';
  label.style.cssText = 'font-size:11px;color:var(--color-neutral-400);display:flex;justify-content:space-between';
  const value = () =>
    `Collapse pushes over <span style="color:var(--color-text)">${state.burstThreshold}</span>`;
  label.innerHTML = `<span>${value()}</span><span style="color:var(--color-neutral-600)">${bursts.length} burst${bursts.length === 1 ? '' : 's'}</span>`;

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '1';
  slider.max = '50';
  slider.value = String(state.burstThreshold);
  slider.style.cssText = 'width:100%;accent-color:var(--color-accent);cursor:pointer';
  slider.addEventListener('input', () => {
    state.burstThreshold = Number(slider.value);
    label.querySelector('span').innerHTML = value();
  });
  // Re-derive on release rather than on every pixel: changing the threshold
  // rebuilds every burst and the adjacency that depends on them.
  slider.addEventListener('change', () => onChange());

  wrap.append(label, slider);

  if (bursts.length) {
    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:2px;margin-top:4px';
    for (const burst of bursts) {
      const { row } = subRow({
        label: `${burst.size} commits · push ${burst.pushId}`,
        checked: !state.expandedBursts.has(burst.id),
        onChange: (checked) => {
          if (checked) state.expandedBursts.delete(burst.id);
          else state.expandedBursts.add(burst.id);
          onChange();
        },
      });
      list.appendChild(row);
    }
    wrap.append(sectionLabel('collapsed'), list);
  }

  container.appendChild(wrap);
}

/** Actor rows, with a colour swatch, an event count and a profile button. */
export function renderActorRows({
  container,
  searchInput,
  actors,
  actorColors,
  state,
  onChange,
  onProfile,
}) {
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

    row.querySelector('.actorProfileBtn').addEventListener('click', (event) => {
      event.stopPropagation();
      onProfile(actor, event.currentTarget);
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
 * A search box whose options come from a query, not from a list.
 *
 * The difference from `setupCombo` is the whole point rather than a detail. A combo
 * filters options it already holds; this one *asks* on every keystroke, because the
 * thing being searched cannot be held. A repository has hundreds of thousands of
 * issues and pull requests and millions of commits — there is no list to filter and
 * nothing useful to precompute about the results, since knowing what a seed yields
 * means running the traversal.
 *
 * `search` is therefore the seam that becomes a database query, and `emptyMessage`
 * matters as much as the results: "no match" must say *what* was looked for and
 * why it might not be available.
 */
export function setupSearchCombo({ input, dropdown, initialLabel, search, emptyMessage, onSelect }) {
  input.value = initialLabel;
  input.setAttribute('value', initialLabel);

  /*
   * Search may be synchronous (the fixture catalogue, filtered in memory) or
   * asynchronous (the database, over HTTP). Both are supported, and the async case
   * needs two things the sync case never did.
   *
   * **A race guard.** Keystrokes fire overlapping requests and they do not come back
   * in order: type "10", then "102", and the slower "10" response can land last and
   * overwrite the results for "102" — leaving the dropdown showing matches for text
   * the box no longer contains. `generation` makes a stale response a no-op. This is
   * not hypothetical; it is the normal behaviour of an unguarded typeahead.
   *
   * **A debounce**, below, so a five-character query is one request rather than five.
   */
  let generation = 0;

  async function renderResults(text) {
    const mine = ++generation;
    let results;
    try {
      results = await search(text);
    } catch (error) {
      // A failed search must say so. Rendering "no matches" would claim the repository
      // holds nothing like it, which is a different and wrong statement.
      if (mine !== generation) return;
      dropdown.innerHTML =
        `<div style="padding:10px 12px;font-size:11.5px;color:var(--color-danger,#e5534b);` +
        `line-height:1.5">${escapeHtml(error.message.split('\n')[0])}</div>`;
      return;
    }
    if (mine !== generation) return;

    dropdown.innerHTML = '';

    if (!results.length) {
      dropdown.innerHTML =
        `<div style="padding:10px 12px;font-size:11.5px;color:var(--color-neutral-500);` +
        `line-height:1.5">${escapeHtml(emptyMessage(text))}</div>`;
      return;
    }

    for (const option of results) {
      const row = document.createElement('div');
      row.className = 'mono';
      row.style.cssText =
        'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;' +
        'font-size:12.5px;cursor:pointer;color:var(--color-text)';
      row.innerHTML =
        `<span style="flex:0 0 auto">${escapeHtml(option.label)}</span>` +
        (option.note
          ? `<span style="font-size:10.5px;color:var(--color-neutral-500);min-width:0;` +
            `overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(option.note)}</span>`
          : option.active
            ? '<span style="color:var(--color-accent);font-size:11px">✓</span>'
            : '');

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
      dropdown.appendChild(row);
    }
  }

  input.addEventListener('focus', () => {
    renderResults('');
    dropdown.style.display = 'block';
  });
  // Debounced, because each keystroke may be a network round trip. 150 ms is below
  // the ~200 ms at which typing starts to feel laggy and above a fast typist's
  // inter-key interval, so a word becomes one request.
  let debounce = null;
  input.addEventListener('input', () => {
    dropdown.style.display = 'block';
    clearTimeout(debounce);
    debounce = setTimeout(() => renderResults(input.value), 150);
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      dropdown.style.display = 'none';
      // Restore the loaded seed's label: a half-typed search left in the box would
      // misstate what is on screen.
      input.value = initialLabel;
    }, 120);
  });
}

/**
 * A filterable combo box, for lists small enough to hold — the repository picker.
 *
 * The mockup built these but never passed an `onSelect`, so choosing an entry did
 * nothing at all.
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
      if (option.title) row.title = option.title;
      // A note carries what the option *yields* or why it is unavailable — the
      // information that makes the choice meaningful rather than a bare id.
      row.innerHTML =
        `<span style="min-width:0;overflow:hidden;text-overflow:ellipsis">${escapeHtml(option.label)}</span>` +
        (option.note
          ? `<span style="font-size:9px;border:1px solid var(--color-neutral-700);padding:1px 5px;` +
            `border-radius:999px;color:var(--color-neutral-500);flex:0 0 auto;white-space:nowrap">` +
            `${escapeHtml(option.note)}</span>`
          : option.active
            ? '<span style="color:var(--color-accent);font-size:11px;flex:0 0 auto">✓</span>'
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
