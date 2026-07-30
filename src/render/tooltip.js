/**
 * The tooltip: hover cards, right-click to pin, click a row to copy.
 *
 * Pinning is a genuinely useful affordance — it turns a transient hover card into
 * something you can read from and copy a SHA out of — so it survives the rewrite
 * unchanged in behaviour.
 *
 * The mockup guarded its document-level listeners with `window.__ocelTipWired`
 * because the dc-runtime could call `componentDidMount` more than once. Off that
 * runtime the module is instantiated exactly once by `main.js`, so the guards are
 * gone rather than being carried forward as cargo (decision 13).
 */

import { escapeHtml } from './format.js';
import { glyph } from './theme.js';

/**
 * @param {{tipEl: HTMLElement, wrapEl: HTMLElement}} elements
 */
export function createTooltip({ tipEl, wrapEl }) {
  let hideTimer = null;
  let pinned = false;

  function position(event) {
    const bounds = wrapEl.getBoundingClientRect();
    let left = event.clientX - bounds.left + 15;
    let top = event.clientY - bounds.top + 15;
    const width = tipEl.offsetWidth;
    const height = tipEl.offsetHeight;

    if (left + width > bounds.width) left = event.clientX - bounds.left - width - 15;
    if (left < 0) left = 4;
    if (top + height > bounds.height) top = event.clientY - bounds.top - height - 15;
    if (top < 0) top = 4;

    tipEl.style.left = `${left}px`;
    tipEl.style.top = `${top}px`;
  }

  function copyToClipboard(text, element) {
    const toast = () => {
      const el = document.createElement('div');
      el.textContent = 'Copied';
      el.style.cssText =
        'position:absolute;background:var(--color-accent);color:var(--color-bg);font-size:10px;' +
        'font-weight:700;padding:3px 7px;border-radius:4px;pointer-events:none;z-index:200;' +
        'opacity:1;transition:opacity .3s ease;font-family:"JetBrains Mono",monospace';
      const anchor = element.getBoundingClientRect();
      const wrap = wrapEl.getBoundingClientRect();
      el.style.left = `${anchor.right - wrap.left + 6}px`;
      el.style.top = `${anchor.top - wrap.top - 2}px`;
      wrapEl.appendChild(el);
      setTimeout(() => {
        el.style.opacity = '0';
      }, 650);
      setTimeout(() => el.remove(), 950);
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(toast).catch(toast);
    } else {
      toast();
    }
  }

  function attachCopyHandlers() {
    const closeButton = tipEl.querySelector('.tip-close');
    if (closeButton) {
      closeButton.addEventListener('click', (event) => {
        event.stopPropagation();
        unpin();
      });
    }

    const title = tipEl.querySelector('.tip-title');
    if (title) {
      title.addEventListener('click', (event) => {
        if (!pinned) return;
        event.stopPropagation();
        copyToClipboard(title.textContent.trim(), title);
      });
    }

    for (const row of tipEl.querySelectorAll('.tip-row')) {
      row.addEventListener('click', (event) => {
        if (!pinned) return;
        event.stopPropagation();
        const value = row.querySelector('.v');
        const text = value ? value.textContent.trim() : '';
        if (text) copyToClipboard(text, value);
      });
    }
  }

  /**
   * Render a card.
   *
   * @param {object} spec
   * @param {string} spec.accent  colour of the top rule and kicker glyph
   * @param {string} spec.shape   glyph shape
   * @param {string} spec.kicker  small uppercase label
   * @param {string} spec.title   already-escaped title HTML
   * @param {Array}  spec.rows    [label, valueHtml, className?]
   * @param {string} [spec.note]  footer note
   */
  function show(event, spec) {
    clearTimeout(hideTimer);

    const rows = spec.rows
      .filter(Boolean)
      .map(
        ([label, value, className]) =>
          `<div class="tip-row"><div class="k">${label}</div>` +
          `<div class="v${className ? ` ${className}` : ''}">${value}</div></div>`,
      )
      .join('');

    tipEl.innerHTML =
      '<button class="tip-close" aria-label="Close">&times;</button>' +
      `<div class="tip-accent" style="background:${spec.accent}"></div>` +
      `<div class="tip-header"><div class="tip-kicker">${glyph(spec.shape, spec.accent)}` +
      `<span>${spec.kicker}</span></div>` +
      `<div class="tip-title">${spec.title}</div></div>` +
      `<div class="tip-body">${rows}</div>` +
      (spec.note
        ? `<div class="tip-footer"><div class="tip-note"><span>&#9671;</span><span>${spec.note}</span></div></div>`
        : '') +
      '<div class="pin-hint">Click a row to copy · Esc to close</div>';

    tipEl.style.display = 'block';
    void tipEl.offsetWidth; // force a reflow so the fade-in transition runs
    tipEl.classList.add('show');
    attachCopyHandlers();
    position(event);
  }

  function hide() {
    if (pinned) return;
    tipEl.classList.remove('show');
    hideTimer = setTimeout(() => {
      tipEl.style.display = 'none';
    }, 150);
  }

  function unpin() {
    pinned = false;
    tipEl.classList.remove('pinned');
    tipEl.style.pointerEvents = 'none';
    tipEl.classList.remove('show');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      tipEl.style.display = 'none';
    }, 150);
  }

  /** Right-click handler: render the card and keep it open. */
  function pin(event, render) {
    event.preventDefault();
    event.stopPropagation();
    pinned = true;
    render();
    tipEl.classList.add('pinned');
    tipEl.style.pointerEvents = 'auto';
  }

  document.addEventListener('click', (event) => {
    if (pinned && !tipEl.contains(event.target)) unpin();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && pinned) unpin();
  });

  return {
    show,
    hide,
    pin,
    unpin,
    isPinned: () => pinned,
    /** Follow the cursor, unless the card is pinned in place. */
    positionIfFree: (event) => {
      if (!pinned) position(event);
    },
    /**
     * Attach the standard hover / pin / move / leave set to a selection.
     * Every interactive mark uses the same four handlers, so they live here.
     */
    bind(selection, buildSpec) {
      return selection
        .on('mouseenter', (event) => {
          if (pinned) return;
          show(event, buildSpec());
        })
        .on('contextmenu', (event) => pin(event, () => show(event, buildSpec())))
        .on('mousemove', (event) => {
          if (!pinned) position(event);
        })
        .on('mouseleave', hide);
    },
    escapeHtml,
  };
}
