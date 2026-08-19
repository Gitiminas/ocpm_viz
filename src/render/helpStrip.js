/**
 * The help strip: one or two plain sentences about whatever the pointer is on.
 *
 * A muted text area on the left of the header row. While the pointer (or the keyboard
 * focus) rests on anything that carries a `data-tip="<key>"` attribute, the strip shows
 * that key's sentence from `help/tips.js`; chart marks carry `data-legend` already, and
 * that maps to `legend.<key>`, so the marks need no second label. Leaving everything
 * reverts to a quiet hint. It explains what a thing IS; the hovercards keep the
 * specifics of which issue, which commit, when.
 *
 * One delegated listener on the page root does all of it — `mouseover` bubbles from
 * whatever is under the pointer, and `closest('[data-tip]')` walks up to the labelled
 * ancestor — so a new control needs only an attribute, never a listener. `focusin` does
 * the same for the keyboard, which makes the strip an accessibility aid as well.
 *
 * Not sticky on purpose (the reader asked): it follows the pointer, the convention for
 * status-style help, and a click on a control keeps meaning what it meant.
 *
 * ⚠️ The strip has a fixed minimum height of two lines, so the header row never changes
 * height as the text changes — a header that jumped would move the chart under the
 * reader's eye on every hover, which is the object-constancy failure decision 100 guards
 * against in the chart itself.
 */

import { tipFor as defaultTipFor, DEFAULT_TIP } from '../help/tips.js';

/**
 * The sentence for an element, walking up to the nearest labelled ancestor.
 *
 * `data-tip` wins over `data-legend`, so a legend row — which carries both (the row is a
 * control that highlights marks) — can say what the row does if it wants to, and falls
 * back to saying what the mark is. Exported for the tests, which drive it with stubs.
 *
 * @param {Element|null} target
 * @param {(key:string, arg?:string) => string|null} [tipFor]
 * @returns {string|null}
 */
export function resolveTip(target, tipFor = defaultTipFor) {
  if (!target || typeof target.closest !== 'function') return null;
  const labelled = target.closest('[data-tip]');
  if (labelled) {
    const text = tipFor(labelled.dataset.tip, labelled.dataset.tipArg);
    if (text) return text;
  }
  const mark = target.closest('[data-legend]');
  if (mark) return tipFor(`legend.${mark.dataset.legend}`);
  return null;
}

/**
 * Bind the strip to the page.
 *
 * @param {object} options
 * @param {EventTarget} options.root      where the listeners go — the document body
 * @param {HTMLElement} options.stripEl   the element whose text is written
 * @param {Function} [options.tipFor]
 * @param {string} [options.defaultText]
 * @returns {{ show: (text: string|null) => void, dispose: () => void }}
 */
export function bindHelpStrip({ root, stripEl, tipFor = defaultTipFor, defaultText = DEFAULT_TIP }) {
  let shown = null;

  // The box's kicker ("About") is drawn by CSS; the sentence goes into its own element so
  // it can be clamped to two lines on its own. Created once; the binding owns it.
  const textEl = stripEl.ownerDocument ? stripEl.ownerDocument.createElement('div') : null;
  if (textEl) {
    textEl.className = 'helpText';
    stripEl.appendChild(textEl);
  }

  function show(text) {
    const next = text ?? defaultText;
    if (next === shown) return;
    shown = next;
    (textEl ?? stripEl).textContent = next;
    stripEl.classList.toggle('isDefault', text == null);
  }

  const onOver = (event) => show(resolveTip(event.target, tipFor));
  // Leaving the window: `relatedTarget` is null, and nothing is under the pointer.
  const onOut = (event) => {
    if (!event.relatedTarget) show(null);
  };
  const onFocus = (event) => show(resolveTip(event.target, tipFor));
  const onBlur = () => show(null);

  root.addEventListener('mouseover', onOver);
  root.addEventListener('mouseout', onOut);
  root.addEventListener('focusin', onFocus);
  root.addEventListener('focusout', onBlur);
  show(null);

  return {
    show,
    dispose() {
      root.removeEventListener('mouseover', onOver);
      root.removeEventListener('mouseout', onOut);
      root.removeEventListener('focusin', onFocus);
      root.removeEventListener('focusout', onBlur);
    },
  };
}
