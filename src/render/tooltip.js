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
 * gone rather than being carried forward as cargo.
 */

import { escapeHtml } from './format.js';
import { glyph } from './theme.js';

/**
 * A comment's text in the card: the opening lines, expanding under the pointer.
 *
 * The row arrives as `{excerptText, truncated}` — RAW text, escaped HERE, because
 * comment bodies are arbitrary user-written GitHub content and this is the one place
 * they become markup (the XSS test pins it). Collapsed, the block clamps
 * to a few lines with a fade to the card's surface at the bottom and a "hover to read
 * more" hint — the fade is what says there is more, the hint says how to get it. Hovering
 * the block (the card must be pinned to be hoverable at all) raises the clamp; the
 * payload's excerpt is capped at 500 characters server-side, and when even that was cut
 * the expanded block ends by saying so rather than trailing off silently.
 */
export function excerptHtml({ excerptText, truncated = false, heading = 'Comment text' }) {
  const text = escapeHtml(String(excerptText));
  // Visible only once expanded (CSS): while the block is clamped the fade already says
  // "there is more here", and two more-indicators at once said less than one.
  const cutNote = truncated
    ? '<div class="tip-excerpt-cut">shortened (full text on GitHub)</div>'
    : '';
  // Clamp only when there is something to hide: short comments show whole, no fade.
  const clamp = truncated || String(excerptText).length > 200 ? ' clamp' : '';
  // A boxed section like the commit card's observation list, headed by the field's own
  // name: prose cannot sit right-aligned against a label the way the k/v rows do, so it
  // gets the group treatment — label on the box's head, text as the body. The hint sits
  // BELOW the clamped text on its own solid line, never inside the fade, where it was
  // barely readable over half-faded words.
  return (
    `<div class="tip-group tip-excerpt${clamp}">` +
    `<div class="tip-group-head"><div class="k">${escapeHtml(heading)}</div></div>` +
    `<div class="tip-excerpt-body"><div class="tip-excerpt-text">${text}</div>` +
    `${cutNote}<div class="tip-excerpt-more">hover text to read more</div></div></div>`
  );
}

/**
 * @param {{tipEl: HTMLElement, wrapEl: HTMLElement}} elements
 */
export function createTooltip({ tipEl, wrapEl }) {
  /*
   * A pinned card that GROWS — the comment excerpt expanding under the pointer — can run
   * past the bottom of the surface, since it was positioned when it was smaller. Watch
   * its size and slide it up just enough to stay inside; guarded because ResizeObserver
   * does not exist in the Node test runner, where nothing renders anyway.
   */
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      if (tipEl.style.display === 'none') return;
      const bounds = wrapEl.getBoundingClientRect();
      const rect = tipEl.getBoundingClientRect();
      const overflow = rect.bottom - bounds.bottom;
      if (overflow > 0) {
        const top = Math.max(4, rect.top - bounds.top - overflow - 4);
        tipEl.style.top = `${top}px`;
      }
    }).observe(tipEl);
  }
  let hideTimer = null;
  let pinned = false;
  // Right-click-to-pin is not guessable, so every unpinned card says so, in the accent
  // colour. Pinning hides the hint (the card now shows its close button instead); closing
  // brings it back on the next hover, since the next card is a fresh question.

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

    /*
     * The comment text is copyable once EXPANDED — while clamped, a click would copy
     * words the reader has not seen, and the expanded state is the one where "I want
     * this text" happens. Expansion is the CSS hover state, so being inside the handler
     * at all means the pointer is on the text and the block is open (or short enough to
     * need no expanding). Copies the raw excerpt, not the shortened-note or the hint.
     */
    for (const block of tipEl.querySelectorAll('.tip-excerpt')) {
      block.addEventListener('click', (event) => {
        if (!pinned) return;
        event.stopPropagation();
        const textEl = block.querySelector('.tip-excerpt-text');
        if (textEl?.textContent) copyToClipboard(textEl.textContent.trim(), textEl);
      });
    }

    // Grouped entries are copyable too, or the pin-to-copy affordance would work on
    // every row of the card except the ones carrying the detail worth copying.
    for (const item of tipEl.querySelectorAll('.tip-item')) {
      item.addEventListener('click', (event) => {
        if (!pinned) return;
        event.stopPropagation();
        const main = item.querySelector('.tip-item-main');
        const text = main ? main.textContent.trim() : '';
        if (text) copyToClipboard(text, main);
      });
    }
  }

  
/**
   * A boxed group of related entries.
   *
   * A repeated list — a commit's push observations, say — rendered as plain rows reads
   * as several unrelated facts that happen to share the card, because every row in the
   * body looks alike. Boxing it under one header says "these belong together, and this
   * is what they are". Each entry stacks its own two lines rather than sitting in the
   * key/value columns, because the columns are 300px wide and a timestamp beside a
   * branch name wraps into unreadable ribbons.
   *
   * @param {{label: string, value: string, items: Array<{primary: string, secondary?: string}>}} group
   */
  function groupHtml({ label, value, items = [] }) {
    const body = items
      .map(
        (item) =>
          '<div class="tip-item">' +
          `<div class="tip-item-main">${item.primary}</div>` +
          (item.secondary ? `<div class="tip-item-sub">${item.secondary}</div>` : '') +
          '</div>',
      )
      .join('');
    return (
      '<div class="tip-group">' +
      `<div class="tip-group-head"><div class="k">${label}</div><div class="v">${value}</div></div>` +
      body +
      '</div>'
    );
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
      .map((row) => {
        if (!Array.isArray(row) && row.excerptText != null) return excerptHtml(row);
        if (!Array.isArray(row)) return groupHtml(row);
        const [label, value, className] = row;
        return (
          `<div class="tip-row"><div class="k">${label}</div>` +
          `<div class="v${className ? ` ${className}` : ''}">${value}</div></div>`
        );
      })
      .join('');

    tipEl.innerHTML =
      '<button class="tip-close" aria-label="Close">&times;</button>' +
      (pinned ? '' : '<div class="tip-pin-hint">right-click to pin</div>') +
      `<div class="tip-accent" style="background:${spec.accent}"></div>` +
      `<div class="tip-header"><div class="tip-kicker">${glyph(spec.shape, spec.accent)}` +
      `<span>${spec.kicker}</span></div>` +
      `<div class="tip-title">${spec.title}</div></div>` +
      `<div class="tip-body">${rows}</div>` +
      (spec.note
        ? `<div class="tip-footer"><div class="tip-note"><span>&#9671;</span><span>${spec.note}</span></div></div>`
        : '') +
      '<div class="pin-hint">Click a row to copy · Esc to close</div>';

    // Flex, so the body can scroll under the fixed header when the viewport cap bites.
    tipEl.style.display = 'flex';
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
