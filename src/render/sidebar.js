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

import { glyph, typeColor, TYPE, chevron } from './theme.js';
import { escapeHtml } from './format.js';

const CHECKBOX = 'accent-color:var(--color-accent);width:14px;height:14px;flex:0 0 auto;cursor:pointer';
const SUB_CHECKBOX = 'accent-color:var(--color-accent);width:13px;height:13px;cursor:pointer';
const ROW = 'display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:var(--radius-sm)';
const SUB_WRAP =
  'flex-direction:column;gap:2px;padding:4px 8px 6px 30px;border-left:1px solid var(--color-neutral-800);margin-left:14px';

/** A nested checkbox row: label, optional colour swatch, optional count badge. */
/** Stamp a row with the help strip's label (`help/tips.js`): `tip = { key, arg }`. */
function stampTip(element, tip) {
  if (!tip) return;
  element.dataset.tip = tip.key;
  if (tip.arg != null) element.dataset.tipArg = String(tip.arg);
}

function subRow({ label, checked, swatch, count, onChange, tip = null }) {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;padding:1px 0';
  stampTip(row, tip);
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
function masterSection({ label, open, children, onMasterChange, onToggleOpen, tip = null }) {
  const wrapper = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'sideRow on';
  row.style.cssText = ROW;
  stampTip(row, tip);

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
export function renderLaneRows({
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
        tip: { key: 'lane.comments', arg: laneType },
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
            tip: { key: 'lane.group' },
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
          tip: { key: 'lane.object' },
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
      tip: { key: 'lane', arg: laneType },
      open: state.laneOpen[laneType],
      children,
      onMasterChange: (checked) => {
        state.lanes[laneType] = checked;
        section.row.classList.toggle('on', checked);
        section.sub.style.opacity = checked ? '1' : '0.4';
        section.sub.style.pointerEvents = checked ? 'auto' : 'none';
        relSync();
        onChange();
      },
      onToggleOpen: (open) => {
        state.laneOpen[laneType] = open;
      },
    });

    // The glyph goes next to the master label, so a lane still reads as its type.
    section.labelEl.insertAdjacentHTML('afterbegin', glyph(spec.shape, spec.color));
    section.master.checked = state.lanes[laneType] !== false;
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
    const available = (pair) => state.lanes[pair.types[0]] && state.lanes[pair.types[1]];
    const controls = [];
    const children = group.pairs.map((pair) => {
      const { row, checkbox } = subRow({
        label: pair.label,
        tip: { key: 'rel.pair', arg: pair.label },
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
      // The two evidence classes have their own texts (`rel.validated`, `rel.extracted`).
      tip: { key: group.key === 'validated' ? 'rel.validated' : 'rel.extracted' },
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
        tip: { key: key === 'qualifiers' ? 'rel.qualifier' : 'rel.method', arg: entry.label },
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
      tip: { key: key === 'qualifiers' ? 'rel.qualifiers' : 'rel.methods' },
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
export function renderBurstControls({ container, state, bursts, commentBursts = [], onChange }) {
  container.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:2px 8px';

  /*
   * Pushes fold by `push_id` and that is the whole rule (decision 94), so this states the
   * outcome rather than offering a control.
   *
   * There used to be a size slider and a checkbox per burst here. The slider never chose
   * what a burst *is* — `push_id` does, and it is a fact in the data — only how big one
   * had to be before the tool bothered, which is a preference dressed as a finding. The
   * checkboxes duplicated a click that already exists on the burst itself, and on a
   * sub-log with many pushes the list was longer than everything else in the sidebar.
   */
  const pushes = document.createElement('div');
  pushes.className = 'mono';
  pushes.dataset.tip = 'folding.pushes';
  pushes.style.cssText = 'font-size:11px;color:var(--color-neutral-400);line-height:1.5';
  pushes.innerHTML =
    `Pushes fold by <span style="color:var(--color-text)">push id</span>` +
    `<div style="color:var(--color-neutral-600);font-size:10px;margin-top:2px">` +
    `${bursts.length} folded · click one to expand, and the handle above it to fold back</div>`;
  wrap.appendChild(pushes);

  /*
   * The comment window, in days.
   *
   * A slider precisely because comments have no `push_id` — nothing in the data says
   * which of them belong together, so the reader decides what "close together" means and
   * watches the count change (decision 93). That is the difference between this control
   * and the one that used to sit above it.
   */
  const commentLabel = document.createElement('div');
  commentLabel.className = 'mono';
  commentLabel.dataset.tip = 'folding.commentWindow';
  commentLabel.style.cssText =
    'font-size:11px;color:var(--color-neutral-400);display:flex;justify-content:space-between;margin-top:12px';
  const commentValue = () =>
    `Fold comments within <span style="color:var(--color-text)">${state.commentWindowDays}</span> day${state.commentWindowDays === 1 ? '' : 's'}`;
  commentLabel.innerHTML =
    `<span>${commentValue()}</span><span style="color:var(--color-neutral-600)">` +
    `${commentBursts.length} folded</span>`;

  const commentSlider = document.createElement('input');
  commentSlider.type = 'range';
  commentSlider.min = '0';
  commentSlider.max = '30';
  commentSlider.dataset.tip = 'folding.commentWindow';
  commentSlider.value = String(state.commentWindowDays);
  commentSlider.style.cssText = 'width:100%;accent-color:var(--color-accent);cursor:pointer';
  commentSlider.addEventListener('input', () => {
    state.commentWindowDays = Number(commentSlider.value);
    commentLabel.querySelector('span').innerHTML = commentValue();
  });
  // 0 days means "only comments sharing an instant", which is the honest way to switch
  // the folding off without a second control that can disagree with the slider.
  commentSlider.addEventListener('change', () => onChange());

  wrap.append(commentLabel, commentSlider);
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
  onPreview = () => {},
}) {
  container.innerHTML = '';

  for (const actor of actors) {
    const row = document.createElement('div');
    row.className = 'sideRow';
    row.dataset.tip = 'actors.row';
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
      `cursor:pointer;padding:2px" data-tip="actors.profile">` +
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

    /*
     * Hovering previews the trail; clicking pins it. Same idea as the legend: see what a
     * control does before committing to it, which for an actor list matters because the
     * only way to answer "did this person touch the part I care about?" was to click,
     * look, and click back — and a wrong guess left the picture changed.
     *
     * `mouseleave` clears unconditionally rather than clearing only what it drew. If a
     * click lands between the two events the row is now pinned, `actorPreview` returns
     * null for it, and there is no preview left to clear — so clearing regardless is
     * both correct and the only version that cannot strand a stroke on screen.
     */
    row.addEventListener('mouseenter', () => onPreview(actor.id));
    row.addEventListener('mouseleave', () => onPreview(null));

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
 * Claim an input for a combo, discarding whatever was bound to it before.
 *
 * ⚠️ **Load-bearing.** Both combos are re-wired on every load — `wireSelectors` runs
 * from `load()`, from the seed prompt and from the failure path — but they are wired
 * onto the *same two elements* every time. Plain `addEventListener` therefore stacked
 * a fresh generation of listeners on each load, and never removed the old ones. Every
 * generation stayed live, each closing over the `activeRepo` of the load that created
 * it, and all of them fired on one keystroke and wrote into the same dropdown.
 *
 * The observed result: after visiting two repositories, typing an issue number fired
 * **five** searches across three repositories, results from whichever answered last
 * flashed over the others, and clicking a row rendered by a stale generation reloaded
 * the app into that generation's repository — the tool silently changing repository
 * under the user while the Repo box still said the one they had chosen.
 *
 * The generation guard inside `setupSearchCombo` cannot help: it makes a combo ignore
 * its *own* out-of-order responses, and these are rival combos it has no way to see.
 * The invariant has to be "one live binding per element", so it is enforced here where
 * the binding happens rather than asked of every caller.
 */
function claimCombo(input) {
  input.__comboAbort?.abort();
  const controller = new AbortController();
  input.__comboAbort = controller;
  return { signal: controller.signal };
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
  const bind = claimCombo(input);
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
      // The row truncates the title; the help strip does not. Hovering a result shows
      // "issue #47532 — the whole title" there, which is where a reader can actually
      // read it (decision 122's mechanism; `seed.result` takes the text as its argument).
      if (option.tipText) {
        row.dataset.tip = 'seed.result';
        row.dataset.tipArg = option.tipText;
      }
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
  }, bind);
  // Debounced, because each keystroke may be a network round trip. 150 ms is below
  // the ~200 ms at which typing starts to feel laggy and above a fast typist's
  // inter-key interval, so a word becomes one request.
  let debounce = null;
  input.addEventListener('input', () => {
    dropdown.style.display = 'block';
    clearTimeout(debounce);
    debounce = setTimeout(() => renderResults(input.value), 150);
  }, bind);
  input.addEventListener('blur', () => {
    setTimeout(() => {
      dropdown.style.display = 'none';
      // Restore the loaded seed's label: a half-typed search left in the box would
      // misstate what is on screen.
      input.value = initialLabel;
    }, 120);
  }, bind);
}

/**
 * A filterable combo box, for lists small enough to hold — the repository picker.
 *
 * The mockup built these but never passed an `onSelect`, so choosing an entry did
 * nothing at all.
 */
export function setupCombo({ input, dropdown, options, initialLabel, onSelect }) {
  const bind = claimCombo(input);
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
  }, bind);
  input.addEventListener('input', () => {
    renderList(input.value);
    dropdown.style.display = 'block';
  }, bind);
  input.addEventListener('blur', () => {
    setTimeout(() => {
      dropdown.style.display = 'none';
    }, 120);
  }, bind);
}
