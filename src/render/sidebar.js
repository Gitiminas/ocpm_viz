/**
 * The sidebar: every control that subtracts from the picture.
 *
 * The toggle architecture from the mockup is preserved and extended rather than
 * replaced — a master checkbox that goes indeterminate over mixed children, and
 * sub-toggles that disable themselves while nothing they govern could be drawn: a pair
 * under a hidden lane, a qualifier whose every link sits on a switched-off pair, a
 * method no visible link carries (`relControlAvailability`; `dfgControlAvailability`
 * for the Process page). That dependency-awareness is what "independently toggleable"
 * needs to stay honest.
 *
 * What it adds over the mockup's:
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
import { DFG_TYPE_LABELS } from '../state/labels.js';
import { escapeHtml, formatDate, formatInstant } from './format.js';
import { activityLabel, activityShortLabel } from '../model/activities.js';
import { groupSequenceRows } from '../model/dfg.js';
import { dfgRangeScale, dfgControlAvailability } from '../model/dfg.js';
import { relControlAvailability } from '../state/state.js';

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
              relSync();
              onChange();
            },
          });
          children.push(row);
          childControls.push({ checkbox, isOn: () => !state.hiddenCommitGroups.has(group.key) });
        }
      }
    } else if (objects.length) {
      children.push(sectionLabel(`${objects.length} artifact${objects.length === 1 ? '' : 's'}`));
      for (const object of objects) {
        const { row, checkbox } = subRow({
          label: object.label || object.id,
          tip: { key: 'lane.object' },
          checked: !state.hiddenObjects.has(object.id),
          swatch: objectColors.get(object.id) || typeColor(laneType),
          onChange: (checked) => {
            if (checked) state.hiddenObjects.delete(object.id);
            else state.hiddenObjects.add(object.id);
            relSync();
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
  links = [],
  byId = new Map(),
  groupsByCommit = new Map(),
  onChange,
}) {
  container.innerHTML = '';
  const syncers = [];
  const syncAll = () => syncers.forEach((fn) => fn());

  // One rule for every row (`relControlAvailability`): a control is inert while nothing
  // it governs could be drawn. Recomputed on every sync, because any row can empty
  // another — a hidden lane empties its pairs, a switched-off pair its qualifiers.
  let availability = relControlAvailability(links, byId, state, groupsByCommit);
  const refresh = () => {
    availability = relControlAvailability(links, byId, state, groupsByCommit);
  };

  for (const group of relGroups) {
    const available = (pair) => availability.pairs.has(pair.key);
    const controls = [];
    const children = group.pairs.map((pair) => {
      const { row, checkbox } = subRow({
        label: pair.label,
        tip: { key: 'rel.pair', arg: pair.label },
        checked: state.relPairs[pair.key] !== false,
        onChange: (checked) => {
          state.relPairs[pair.key] = checked;
          syncAll();
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
        syncAll();
        onChange();
      },
      onToggleOpen: (open) => {
        state.relOpen[group.key] = open;
      },
    });

    function sync() {
      refresh();
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
    const available = (entry) => availability[key].has(entry.key);
    const controls = [];
    const children = entries.map((entry) => {
      const { row, checkbox } = subRow({
        label: entry.label,
        tip: { key: key === 'qualifiers' ? 'rel.qualifier' : 'rel.method', arg: entry.label },
        checked: bag[entry.key] !== false,
        count: entry.count,
        onChange: (checked) => {
          bag[entry.key] = checked;
          syncAll();
          onChange();
        },
      });
      controls.push({ entry, checkbox, row });
      return row;
    });

    const section = masterSection({
      label,
      tip: { key: key === 'qualifiers' ? 'rel.qualifiers' : 'rel.methods' },
      open: state.relOpen[key],
      children,
      onMasterChange: (checked) => {
        // An inert row keeps its state, as an unavailable pair does under its master.
        for (const entry of entries) if (available(entry)) bag[entry.key] = checked;
        for (const control of controls) if (available(control.entry)) control.checkbox.checked = checked;
        syncAll();
        onChange();
      },
      onToggleOpen: (open) => {
        state.relOpen[key] = open;
      },
    });

    function sync() {
      refresh();
      const availableEntries = entries.filter(available);
      const values = availableEntries.map((entry) => bag[entry.key]);
      const allOn = values.every((v) => v !== false);
      const allOff = values.every((v) => v === false);
      section.master.indeterminate = values.length > 0 && !allOn && !allOff;
      section.master.checked = values.length > 0 && allOn;
      section.master.disabled = availableEntries.length === 0;
      section.labelEl.style.opacity = availableEntries.length === 0 ? 0.45 : 1;
      section.row.classList.toggle('on', values.length > 0 && !allOff);
      for (const control of controls) {
        control.checkbox.checked = bag[control.entry.key] !== false;
        const ok = available(control.entry);
        control.checkbox.disabled = !ok;
        control.row.style.opacity = ok ? 1 : 0.45;
        control.row.style.pointerEvents = ok ? 'auto' : 'none';
      }
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

  return syncAll;
}

/**
 * "0 folded", "1 fold", "n folds": a fold is by definition two or more marks in one, so
 * "1 folded" read as one *thing* folded, which is not a fold at all.
 */
const foldCount = (n) => (n === 0 ? '0 folded' : n === 1 ? '1 fold' : `${n} folds`);

/** Folding controls: the push rule as a readout, and the comment window slider. */
export function renderBurstControls({ container, state, bursts, commentBursts = [], onChange }) {
  container.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:2px 0';

  /*
   * Two foldings, two boxes. In one flow the push readout and the comment slider read as
   * one setting with a slider under it, so each gets its own captioned box — the sub-log
   * card's treatment — and says only what is its own.
   */
  const box = (caption, tip) => {
    const el = document.createElement('div');
    el.dataset.tip = tip;
    el.style.cssText =
      'display:flex;flex-direction:column;gap:5px;padding:7px 9px 8px;' +
      'border:1px solid var(--color-neutral-800);border-radius:var(--radius-md);' +
      'background:var(--color-neutral-900)';
    const head = document.createElement('div');
    head.style.cssText =
      'font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-500)';
    head.textContent = caption;
    el.appendChild(head);
    return el;
  };

  /*
   * Pushes fold by `push_id` and that is the whole rule, so this states the outcome
   * rather than offering a control.
   *
   * There used to be a size slider and a checkbox per burst here. The slider never chose
   * what a burst *is* — `push_id` does, and it is a fact in the data — only how big one
   * had to be before the tool bothered, which is a preference dressed as a finding. The
   * checkboxes duplicated a click that already exists on the burst itself, and on a
   * sub-log with many pushes the list was longer than everything else in the sidebar.
   * How to unfold a mark is the mark's help text, not a line here.
   */
  const pushBox = box('Commits', 'folding.pushes');
  const pushes = document.createElement('div');
  pushes.className = 'mono';
  pushes.style.cssText =
    'font-size:11px;color:var(--color-neutral-400);line-height:1.5;display:flex;justify-content:space-between';
  pushes.innerHTML =
    `<span>Fold by <span style="color:var(--color-text)">push id</span></span>` +
    `<span style="color:var(--color-neutral-600)">${foldCount(bursts.length)}</span>`;
  pushBox.appendChild(pushes);

  /*
   * The comment window, in days.
   *
   * A slider precisely because comments have no `push_id` — nothing in the data says
   * which of them belong together, so the reader decides what "close together" means and
   * watches the count change. That is the difference between this control and the one
   * that used to sit above it.
   */
  const commentBox = box('Comments', 'folding.commentWindow');
  const commentLabel = document.createElement('div');
  commentLabel.className = 'mono';
  commentLabel.style.cssText =
    'font-size:11px;color:var(--color-neutral-400);display:flex;justify-content:space-between';
  const commentValue = () =>
    `Fold within <span style="color:var(--color-text)">${state.commentWindowDays}</span> day${state.commentWindowDays === 1 ? '' : 's'}`;
  commentLabel.innerHTML =
    `<span>${commentValue()}</span><span style="color:var(--color-neutral-600)">` +
    `${foldCount(commentBursts.length)}</span>`;

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
  commentBox.append(commentLabel, commentSlider);

  wrap.append(pushBox, commentBox);
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
/** How many result rows appear per reveal; the rest wait for the scroll. */
const SEARCH_PAGE_SIZE = 15;

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

    /*
     * The list reveals itself in pages as the reader scrolls (15 at a time), but the
     * DATA arrived whole: one ranked query, because ranking is client-side and paging the
     * server would page an unranked superset. So there is no spinner — a spinner over
     * results already in memory would be theatre — the next page simply fades in the
     * moment the bottom comes into view. When even the 200-row superset was full, the
     * tail says so and how to get the rest, rather than pretending the list ended.
     */
    let shown = 0;
    const revealNext = () => {
      const page = results.slice(shown, shown + SEARCH_PAGE_SIZE);
      shown += page.length;
      for (const option of page) appendRow(option);
      if (shown >= results.length) {
        sentinel.remove();
        if (results.length >= 200) {
          const cap = document.createElement('div');
          cap.style.cssText =
            'padding:8px 12px;font-size:10.5px;color:var(--color-neutral-500);font-style:italic';
          cap.textContent = '200 shown — narrow the search to see the rest.';
          dropdown.appendChild(cap);
        }
      } else {
        dropdown.appendChild(sentinel); // keep it below the freshly revealed rows
      }
    };

    // The sentinel row: reaching it reveals the next page. Kept visually quiet — three
    // dots, not a spinner, since nothing is loading.
    const sentinel = document.createElement('div');
    sentinel.style.cssText =
      'padding:6px 12px;font-size:11px;color:var(--color-neutral-600);text-align:center';
    sentinel.textContent = '···';

    const appendRow = (option) => {
      const row = document.createElement('div');
      row.className = 'mono';
      // The row truncates the title; the help strip does not. Hovering a result shows
      // "issue #47532 — the whole title" there, which is where a reader can actually
      // read it (`seed.result` takes the text as its argument).
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
      row.classList.add('searchRowIn'); // a brief fade, so a revealed page blends in
      dropdown.appendChild(row);
    };

    revealNext();

    // Reaching the bottom reveals the next page. The dropdown is the scroll container;
    // rebound on every render because the listener closes over THIS render's state, and
    // a stale one would append rows from a superseded search.
    dropdown.onscroll = () => {
      if (shown >= results.length) return;
      if (dropdown.scrollTop + dropdown.clientHeight >= dropdown.scrollHeight - 24) {
        revealNext();
      }
    };
  }

  /*
   * Focus searches what the box HOLDS, not the empty string.
   *
   * ⚠️ It used to search `''`, so clicking the box while "issue #100138" was displayed
   * opened a dropdown of whatever an unfiltered search returns — on the database source,
   * commits ordered by SHA — a list that names nothing the box says and nothing on screen.
   * The two have to agree: the dropdown is the box's results, so it answers the box's text.
   * `seedLabel`'s output is written to be parsed back by `parseSeedRef`, so the loaded
   * seed's own label finds the loaded seed, which the row then marks with a ✓.
   *
   * The text is selected on the way in, because searching for something else is the usual
   * reason to click here and the box is never empty once a seed is loaded — without this
   * every new search starts by deleting a label by hand. Typing replaces it; the caret
   * keys still put the cursor in it for anyone who meant to edit rather than replace.
   */
  input.addEventListener('focus', () => {
    input.select?.();
    renderResults(input.value);
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

// ---------------------------------------------------------------------------
// the Process page's controls
// ---------------------------------------------------------------------------

/**
 * The process map's drill-downs, in the sub-log sidebar's own vocabulary: two
 * master/child sections (lanes and cross pairs, with counts), a dual-handle count
 * range on the brush-track control, and per-activity rows grouped by lane.
 *
 * `vocabulary` comes from `deriveDfgToggles(dfg)` — derived from the loaded artifact,
 * never a fixed list — and `view` is the page's own state object, mutated in place the
 * way the sub-log rows mutate `st`. A cross pair is available only while both of its
 * lanes are on, with the same disable-and-dim treatment the relationship pairs get.
 * `onChange` re-renders the map; the range label updates live but the picture waits
 * for the release, the comment-window slider's split.
 */
export function renderDfgControls({
  lanesContainer,
  relationshipsContainer,
  rangeContainer,
  dfg,
  vocabulary,
  view,
  onChange,
}) {
  for (const el of [lanesContainer, relationshipsContainer, rangeContainer]) {
    el.innerHTML = '';
  }

  /*
   * LANES: what the map draws per lane — its activities. One foldable master row per
   * lane, as the Trace page's lane rows fold their sub-rows; the master shows or hides
   * every activity of the lane, a child row one activity. Hiding an activity removes its
   * node and every succession touching it (`filterDfg`).
   */
  const laneActivityMasters = [];
  for (const lane of vocabulary.lanes) {
    const keysOf = () =>
      vocabulary.activities
        .filter((a) => a.type === lane.type)
        .map((entry) => `${entry.type}/${entry.activity}`);
    const children = vocabulary.activities
      .filter((a) => a.type === lane.type)
      .map((entry) => {
        const key = `${entry.type}/${entry.activity}`;
        const control = subRow({
          label: activityShortLabel(entry.activity),
          checked: !view.hiddenActivities.has(key),
          swatch: typeColor(entry.type),
          count: entry.events,
          tip: { key: 'dfg.activity', arg: activityLabel(entry.activity) },
          onChange: (checked) => {
            if (checked) view.hiddenActivities.delete(key);
            else view.hiddenActivities.add(key);
            sync();
            onChange();
          },
        });
        return { key, ...control };
      });
    const section = masterSection({
      label: DFG_TYPE_LABELS[lane.type],
      open: false,
      children: children.map((c) => c.row),
      tip: { key: 'dfg.laneActivities', arg: DFG_TYPE_LABELS[lane.type] },
      onMasterChange: (checked) => {
        for (const key of keysOf()) {
          if (checked) view.hiddenActivities.delete(key);
          else view.hiddenActivities.add(key);
        }
        for (const child of children) child.checkbox.checked = checked;
        sync();
        onChange();
      },
    });
    laneActivityMasters.push({ lane, section, keysOf });
    lanesContainer.appendChild(section.wrapper);
  }

  const laneControls = [];
  const pairControls = [];

  const laneChildren = vocabulary.lanes.map((lane) => {
    const control = subRow({
      label: DFG_TYPE_LABELS[lane.type],
      checked: view.lanes[lane.type] !== false,
      swatch: typeColor(lane.type),
      count: lane.edges,
      tip: { key: 'dfg.lane', arg: TYPE[lane.type].label },
      onChange: (checked) => {
        view.lanes[lane.type] = checked;
        sync();
        onChange();
      },
    });
    laneControls.push({ lane, ...control });
    return control.row;
  });

  const laneSection = masterSection({
    label: 'Within a type',
    open: true,
    children: laneChildren,
    tip: { key: 'dfg.showPerType' },
    onMasterChange: (checked) => {
      for (const { lane, checkbox } of laneControls) {
        if (checkbox.disabled) continue; // an unavailable lane keeps its state
        view.lanes[lane.type] = checked;
        checkbox.checked = checked;
      }
      sync();
      onChange();
    },
  });

  const pairLabel = (pair) => pair.types.map((type) => DFG_TYPE_LABELS[type]).join(' ↔ ');
  const pairChildren = vocabulary.pairs.map((pair) => {
    const control = subRow({
      label: pairLabel(pair),
      checked: view.pairs[pair.key] !== false,
      count: pair.successions,
      tip: { key: 'dfg.pair', arg: pairLabel(pair) },
      onChange: (checked) => {
        view.pairs[pair.key] = checked;
        sync();
        onChange();
      },
    });
    pairControls.push({ pair, ...control });
    return control.row;
  });

  /*
   * The link vocabulary, the Trace Relationships section's own groups: each row filters
   * which links' successions count, and the aggregate arrows thin rather than multiply.
   * They live inside the Across-links sub because per-type successions ride no links.
   */
  const classControls = [];
  for (const [heading, rows, bagKey, tipKey] of [
    ['link evidence', vocabulary.linkEvidence, 'linkEvidence', 'dfg.evidence'],
    ['qualifiers', vocabulary.linkQualifiers, 'linkQualifiers', 'dfg.qualifier'],
    ['detection methods', vocabulary.linkMethods, 'linkMethods', 'dfg.method'],
  ]) {
    const bag = view[bagKey];
    if (!rows.length) continue;
    pairChildren.push(sectionLabel(heading));
    for (const entry of rows) {
      const control = subRow({
        label: entry.key,
        checked: bag[entry.key] !== false,
        count: entry.successions.toLocaleString('en-US'),
        tip: { key: tipKey, arg: entry.key },
        onChange: (checked) => {
          bag[entry.key] = checked;
          sync();
          onChange();
        },
      });
      classControls.push({ ...control, entry, bag: bagKey });
      pairChildren.push(control.row);
    }
  }

  const pairSection = masterSection({
    label: 'Across links',
    open: true,
    children: pairChildren,
    tip: { key: 'dfg.showCross' },
    onMasterChange: (checked) => {
      for (const { pair, checkbox } of pairControls) {
        if (checkbox.disabled) continue; // an unavailable pair keeps its state
        view.pairs[pair.key] = checked;
        checkbox.checked = checked;
      }
      sync();
      onChange();
    },
  });

  /** Master states and pair availability, the relationship rows' contract. */
  function sync() {
    for (const { section, keysOf } of laneActivityMasters) {
      const shown = keysOf().map((key) => !view.hiddenActivities.has(key));
      section.master.checked = shown.every(Boolean);
      section.master.indeterminate = !shown.every(Boolean) && shown.some(Boolean);
      section.row.classList.toggle('on', shown.some(Boolean));
    }
    // One rule for every row (`dfgControlAvailability`), the Trace sidebar's: a row is
    // inert while no succession it governs could be drawn.
    const availability = dfgControlAvailability(dfg, view);
    const laneValues = laneControls
      .filter(({ lane }) => availability.lanes.has(lane.type))
      .map(({ lane }) => view.lanes[lane.type] !== false);
    laneSection.master.indeterminate =
      laneValues.length > 0 && !laneValues.every(Boolean) && laneValues.some(Boolean);
    laneSection.master.checked = laneValues.length > 0 && laneValues.every(Boolean);
    laneSection.master.disabled = laneValues.length === 0;
    laneSection.labelEl.style.opacity = laneValues.length === 0 ? 0.45 : 1;
    laneSection.row.classList.toggle('on', laneValues.some(Boolean));

    const available = (pair) => availability.pairs.has(pair.key);
    for (const control of laneControls) {
      const ok = availability.lanes.has(control.lane.type);
      control.checkbox.disabled = !ok;
      control.row.style.opacity = ok ? 1 : 0.45;
      control.row.style.pointerEvents = ok ? 'auto' : 'none';
    }
    const availablePairs = pairControls.filter(({ pair }) => available(pair));
    const pairValues = availablePairs.map(({ pair }) => view.pairs[pair.key] !== false);
    pairSection.master.indeterminate =
      pairValues.length > 0 && !pairValues.every(Boolean) && pairValues.some(Boolean);
    pairSection.master.checked = pairValues.length > 0 && pairValues.every(Boolean);
    pairSection.master.disabled = availablePairs.length === 0;
    pairSection.labelEl.style.opacity = availablePairs.length === 0 ? 0.45 : 1;
    pairSection.row.classList.toggle('on', pairValues.some(Boolean));

    for (const control of pairControls) {
      const ok = available(control.pair);
      control.checkbox.disabled = !ok;
      control.row.style.opacity = ok ? 1 : 0.45;
      control.row.style.pointerEvents = ok ? 'auto' : 'none';
    }

    // A class row filters cross successions; it is inert once the pairs, the activity
    // hides or the other two classes leave it nothing to filter.
    for (const control of classControls) {
      const ok = availability[control.bag].has(control.entry.key);
      control.checkbox.disabled = !ok;
      control.row.style.opacity = ok ? 1 : 0.45;
      control.row.style.pointerEvents = ok ? 'auto' : 'none';
    }
  }

  // RELATIONSHIPS: the successions — within a type and across links — under the Trace
  // page's own header, since both are toggles on what joins the marks, not on the marks.
  relationshipsContainer.append(laneSection.wrapper, pairSection.wrapper);

  // ---- the count range: two handles on one track, log-scaled -----------------------
  const scale = dfgRangeScale(vocabulary.maxSuccessions);
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;padding:8px 8px 2px';

  const rangeLabel = document.createElement('div');
  rangeLabel.className = 'mono';
  rangeLabel.dataset.tip = 'dfg.range';
  rangeLabel.style.cssText =
    'font-size:11px;color:var(--color-neutral-400);display:flex;justify-content:space-between';

  const track = document.createElement('div');
  track.className = 'brushTrack';
  track.dataset.tip = 'dfg.range';
  track.innerHTML =
    '<div class="brushRail"></div><div class="brushFill"></div>' +
    '<input type="range" min="0" max="1000" aria-label="Lowest succession count shown">' +
    '<input type="range" min="0" max="1000" aria-label="Highest succession count shown">';
  const fill = track.querySelector('.brushFill');
  const [fromInput, toInput] = track.querySelectorAll('input');
  fromInput.value = String(Math.round(scale.fractionOf(view.range[0]) * 1000));
  toInput.value = String(Math.round(scale.fractionOf(view.range[1]) * 1000));

  const rangeOfHandles = () => [
    scale.countAt(Number(fromInput.value) / 1000),
    scale.countAt(Number(toInput.value) / 1000),
  ];
  const paint = () => {
    const [low, high] = rangeOfHandles();
    rangeLabel.innerHTML =
      `<span>Count range <span style="color:var(--color-text)">${low.toLocaleString('en-US')}` +
      `</span> to <span style="color:var(--color-text)">${high.toLocaleString('en-US')}</span></span>`;
    fill.style.left = `${(Number(fromInput.value) / 1000) * 100}%`;
    fill.style.width = `${((Number(toInput.value) - Number(fromInput.value)) / 1000) * 100}%`;
  };
  // Stopped from crossing rather than allowed to swap, the time brush's rule: swapped,
  // the handle under the pointer would no longer be the one that was grabbed.
  const onDrag = (which) => () => {
    if (which === 'from' && Number(fromInput.value) > Number(toInput.value)) {
      fromInput.value = toInput.value;
    }
    if (which === 'to' && Number(toInput.value) < Number(fromInput.value)) {
      toInput.value = fromInput.value;
    }
    paint(); // the label follows the drag; the picture waits for the release
  };
  fromInput.addEventListener('input', onDrag('from'));
  toInput.addEventListener('input', onDrag('to'));
  for (const input of [fromInput, toInput]) {
    input.addEventListener('change', () => {
      view.range = rangeOfHandles();
      onChange();
    });
  }
  paint();

  wrap.append(rangeLabel, track);
  rangeContainer.appendChild(wrap);

  // ---- per-activity rows, grouped by lane ------------------------------------------
  sync();
  return sync;
}

// ---------------------------------------------------------------------------
// the Process page's Artifacts section
// ---------------------------------------------------------------------------

/**
 * The list a node card's "starts with" / "ends with" tile fills: the most recent objects
 * whose own sequence begins or ends with that activity, each a seed the sub-log page can
 * load with one click. A permanent section — it is on the page before anything is in it,
 * and says what fills it — so a reader never has to guess where the tile's answer went.
 *
 * `listing` is null (nothing asked yet) or `{ request: {objectType, activity, edge, total},
 * status: 'loading'|'ready'|'error', rows, error, fetchedAt }`. The rows are a SAMPLE of
 * `total`, most recent first, and the header says so: "100 of 79,018" is the rule that
 * nothing hidden goes undeclared, applied to a list that cannot hold everything.
 * The database is historical, so a fetched list is kept until Refresh is clicked or the
 * repository changes — there is nothing to poll for.
 */
export function renderDfgArtifacts({ container, countEl = null, listing, onSelect, onRefresh }) {
  container.innerHTML = '';
  if (countEl) countEl.textContent = '';

  const note = (html) => {
    const el = document.createElement('div');
    el.className = 'mono';
    el.style.cssText = 'font-size:11px;line-height:1.5;color:var(--color-neutral-500);padding:4px 8px';
    el.innerHTML = html;
    return el;
  };

  if (!listing) {
    container.appendChild(
      note(
        'Nothing listed yet. Pin an activity card on the map (right-click), then click its ' +
          '<span style="color:var(--color-neutral-300)">starts with</span> or ' +
          '<span style="color:var(--color-neutral-300)">ends with</span> tile to list the ' +
          'artifacts whose sequence begins or ends there. Comments are not listed yet.',
      ),
    );
    return;
  }

  const { request, status, rows = [], error } = listing;
  const typeSpec = TYPE[request.objectType];
  const edgeWord = request.edge === 'start' ? 'starts with' : 'ends with';
  const shown = status === 'ready' ? rows.length : null;

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 8px';
  head.innerHTML =
    `<span style="display:inline-flex;flex:0 0 auto">${glyph(typeSpec.shape, typeSpec.color)}</span>` +
    `<span class="mono" style="font-size:11px;flex:1;min-width:0;color:var(--color-neutral-300)">` +
    `${escapeHtml(typeSpec.label)} · ${edgeWord} ` +
    `<span style="color:var(--color-text)">${escapeHtml(activityShortLabel(request.activity))}</span>` +
    `</span>` +
    `<button type="button" class="artifactsRefresh" data-tip="artifacts.refresh" style="flex:0 0 auto;` +
    `font-family:inherit;font-size:10px;letter-spacing:.05em;text-transform:uppercase;` +
    `color:var(--color-neutral-400);background:var(--color-neutral-900);border:1px solid var(--color-neutral-700);` +
    `border-radius:4px;padding:2px 7px;cursor:pointer">Refresh</button>`;
  head.querySelector('.artifactsRefresh').addEventListener('click', () => onRefresh(request));
  container.appendChild(head);

  const summary = document.createElement('div');
  summary.className = 'mono';
  summary.dataset.tip = 'artifacts.summary';
  summary.style.cssText = 'font-size:10.5px;color:var(--color-neutral-500);padding:0 8px 4px';
  if (status === 'loading') summary.textContent = `Loading… of ${request.total.toLocaleString('en-US')}`;
  else if (status === 'error') summary.textContent = `Could not load the list.`;
  else {
    summary.textContent =
      `${shown.toLocaleString('en-US')} of ${request.total.toLocaleString('en-US')}` +
      (shown < request.total ? ', most recent first' : '');
  }
  container.appendChild(summary);
  if (countEl && status === 'ready') {
    countEl.textContent = `${shown.toLocaleString('en-US')} / ${request.total.toLocaleString('en-US')}`;
  }

  if (status === 'error') {
    container.appendChild(note(escapeHtml(String(error?.message || error || 'unknown error'))));
    return;
  }
  if (status !== 'ready') return;
  if (!rows.length) {
    container.appendChild(note('No artifact\u2019s sequence ' + edgeWord + ' this activity.'));
    return;
  }

  // Commits arrive grouped by the push their sequence edge belongs to; a group header
  // names the push and how many commits it carried, so a partial group says so.
  for (const group of groupSequenceRows(rows)) {
    if (group.label) {
      const header = sectionLabel(
        `${group.label} · ${group.rows.length}${group.count != null && group.count !== group.rows.length ? ` of ${group.count}` : ''} commit${group.count === 1 ? '' : 's'}`,
      );
      header.dataset.tip = 'artifacts.push';
      container.appendChild(header);
    }
    for (const row of group.rows) container.appendChild(artifactRow(row));
  }

  function artifactRow(row) {
    const el = document.createElement('div');
    el.className = 'sideRow';
    el.dataset.tip = 'artifacts.row';
    el.dataset.tipArg = `${row.label}${row.title ? ` — ${row.title}` : ''} · ${formatInstant(new Date(row.at))}`;
    el.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:var(--radius-sm)';
    el.innerHTML =
      `<span style="width:8px;height:8px;border-radius:2px;flex:0 0 auto;background:${typeSpec.color}"></span>` +
      `<span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:1px">` +
      `<span class="mono" style="font-size:11.5px;color:var(--color-text)">${escapeHtml(row.label)}</span>` +
      (row.title
        ? `<span style="font-size:10.5px;color:var(--color-neutral-500);overflow:hidden;text-overflow:ellipsis;` +
          `white-space:nowrap">${escapeHtml(row.title)}</span>`
        : '') +
      `</span>` +
      // The date only: the row's width is the title's, and the help strip carries the
      // full instant while the row is hovered.
      `<span class="mono" style="font-size:9.5px;color:var(--color-neutral-600);flex:0 0 auto">` +
      `${escapeHtml(formatDate(new Date(row.at)))}</span>`;
    el.addEventListener('click', () => onSelect(row));
    return el;
  }
}
