/**
 * The preset panel and the hidden-state banner.
 *
 * These two belong together because they are two halves of one bargain. Presets buy
 * a large reduction in repetition viscosity; the price is hidden dependencies — a
 * saved view conceals what it filtered, so a sparse timeline reads as "few links"
 * when the truth is "links switched off". The banner is what makes that price
 * payable, and it is deliberately **not dismissible** while anything is hidden.
 */

import { escapeHtml } from './format.js';
import {
  BUILT_IN_PRESETS,
  loadPresets,
  savePreset,
  deletePreset,
  renamePreset,
  serializeState,
  presetUrl,
} from '../state/presets.js';

/**
 * The persistent summary of everything currently filtered out.
 *
 * Renders nothing at all when nothing is hidden — a banner that is always present
 * stops being read. Each item carries its own restore, so a user can undo one
 * subtraction without losing the rest of their configuration.
 */
export function renderHiddenBanner({ container, summary, state, onRestore }) {
  container.innerHTML = '';
  if (!summary.anyHidden) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'flex';
  container.style.cssText =
    'display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:0 0 auto;' +
    'border:1px solid var(--color-accent-700);background:color-mix(in srgb, var(--color-accent) 10%, transparent);' +
    'border-radius:var(--radius-md);padding:7px 11px';

  const icon = document.createElement('span');
  icon.style.cssText = 'display:inline-flex;color:var(--color-accent-300);flex:0 0 auto';
  icon.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"></path>' +
    '<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"></path>' +
    '<line x1="1" y1="1" x2="23" y2="23"></line></svg>';
  container.appendChild(icon);

  const label = document.createElement('span');
  label.className = 'mono';
  label.style.cssText = 'font-size:11px;color:var(--color-neutral-300);flex:0 0 auto';
  label.textContent = 'Hidden:';
  container.appendChild(label);

  for (const item of summary.items) {
    const chip = document.createElement('button');
    chip.className = 'mono';
    chip.title = 'Click to restore';
    chip.style.cssText =
      'font-size:11px;color:var(--color-text);background:var(--color-neutral-900);cursor:pointer;' +
      'border:1px solid var(--color-neutral-700);border-radius:999px;padding:2px 9px;display:flex;' +
      'align-items:center;gap:6px';
    chip.innerHTML = `${escapeHtml(item.label)}<span style="color:var(--color-neutral-500)">×</span>`;
    chip.addEventListener('click', () => {
      item.restore(state);
      onRestore();
    });
    container.appendChild(chip);
  }

  const restoreAll = document.createElement('button');
  restoreAll.className = 'mono';
  restoreAll.style.cssText =
    'margin-left:auto;font-size:11px;color:var(--color-accent-300);background:none;cursor:pointer;' +
    'border:1px solid var(--color-accent);border-radius:var(--radius-sm);padding:3px 10px';
  restoreAll.textContent = 'Show everything';
  restoreAll.addEventListener('click', () => {
    for (const item of summary.items) item.restore(state);
    onRestore();
  });
  container.appendChild(restoreAll);
}

/**
 * The preset panel: built-ins, saved views, save / rename / delete, and a copyable
 * shareable link.
 */
/**
 * @param {object} options
 * @param {object} options.query   `{repo, seed, fixture, source, traversalDegree}` — what
 *   `presetUrl` needs to name the sub-log
 * @param {Function} [options.view] returns the live `{page, brush, focus, focusDegree,
 *   layout}` at the moment Copy link is pressed — a function, because focus and brush
 *   change after this panel was rendered and the link has to carry what is on screen NOW
 */
export function renderPresetPanel({
  container,
  state,
  context,
  query,
  view = () => ({}),
  onApply,
  onToast,
}) {
  container.innerHTML = '';
  // ⚠️ The container's `display` is NOT set here. It is the sidebar section the collapse
  // header opens and closes (`main.js`), and this used to overwrite its whole `cssText`
  // with `display:flex` on every render — so the Views section sprang open again on
  // every load, alone among the sections. Layout comes from the markup in `index.html`.

  const button = (text, { primary = false } = {}) => {
    const el = document.createElement('button');
    el.className = 'mono';
    el.textContent = text;
    el.style.cssText =
      `font-size:11px;cursor:pointer;border-radius:var(--radius-sm);padding:4px 8px;` +
      (primary
        ? 'color:var(--color-accent-300);border:1px solid var(--color-accent);background:none'
        : 'color:var(--color-neutral-400);border:1px solid var(--color-neutral-700);background:none');
    return el;
  };

  const presetRow = (name, { description, onLoad, actions = [] }) => {
    const row = document.createElement('div');
    row.className = 'sideRow';
    row.style.cssText =
      'display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:var(--radius-sm)';
    if (description) row.title = description;

    const label = document.createElement('span');
    label.className = 'mono';
    label.style.cssText =
      'font-size:11.5px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
      'cursor:pointer;color:var(--color-text)';
    label.textContent = name;
    label.addEventListener('click', onLoad);
    row.appendChild(label);

    for (const action of actions) {
      const el = document.createElement('span');
      el.className = 'mono';
      el.title = action.title;
      el.textContent = action.glyph;
      el.style.cssText =
        'font-size:11px;color:var(--color-neutral-500);cursor:pointer;padding:0 3px;flex:0 0 auto';
      el.addEventListener('click', (event) => {
        event.stopPropagation();
        action.run();
      });
      row.appendChild(el);
    }
    return row;
  };

  // ---- built-in views -------------------------------------------------------
  const builtInLabel = document.createElement('div');
  builtInLabel.className = 'mono';
  builtInLabel.style.cssText =
    'font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:var(--color-neutral-600);padding:2px 0';
  builtInLabel.textContent = 'Built-in';
  container.appendChild(builtInLabel);

  for (const preset of BUILT_IN_PRESETS) {
    container.appendChild(
      presetRow(preset.name, {
        description: preset.description,
        onLoad: () => onApply(preset.build(context)),
      }),
    );
  }

  // ---- saved views ----------------------------------------------------------
  const saved = loadPresets();
  const savedNames = Object.keys(saved).sort();

  const savedLabel = document.createElement('div');
  savedLabel.className = 'mono';
  savedLabel.style.cssText =
    'font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:var(--color-neutral-600);padding:8px 0 2px';
  savedLabel.textContent = savedNames.length ? 'Saved' : 'Saved (none yet)';
  container.appendChild(savedLabel);

  for (const name of savedNames) {
    container.appendChild(
      presetRow(name, {
        onLoad: () => onApply(saved[name]),
        actions: [
          {
            glyph: '✎',
            title: 'Rename',
            run: () => {
              const next = window.prompt('Rename view', name);
              if (next && renamePreset(name, next)) onToast('Renamed');
              rerender();
            },
          },
          {
            glyph: '×',
            title: 'Delete',
            run: () => {
              if (window.confirm(`Delete the saved view "${name}"?`)) {
                deletePreset(name);
                onToast('Deleted');
                rerender();
              }
            },
          },
        ],
      }),
    );
  }

  // ---- save / share ---------------------------------------------------------
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:6px;padding-top:8px;flex-wrap:wrap';

  const saveButton = button('Save current view', { primary: true });
  saveButton.addEventListener('click', () => {
    const name = window.prompt('Name this view');
    if (!name) return;
    if (savePreset(name, serializeState(state))) onToast(`Saved "${name}"`);
    else onToast('Could not save — storage unavailable');
    rerender();
  });

  const shareButton = button('Copy link');
  shareButton.title =
    'A URL carrying both the query and the filters — the reproducibility mechanism for the evaluation';
  shareButton.addEventListener('click', async () => {
    const url = presetUrl(window.location.href, query, serializeState(state), view());
    try {
      await navigator.clipboard.writeText(url);
      onToast('Link copied');
    } catch {
      window.prompt('Copy this link', url);
    }
  });

  actions.append(saveButton, shareButton);
  container.appendChild(actions);

  function rerender() {
    renderPresetPanel({ container, state, context, query, view, onApply, onToast });
  }
}
