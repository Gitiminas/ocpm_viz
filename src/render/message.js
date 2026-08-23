/**
 * A page's message surface: the element that speaks when there is nothing to draw.
 *
 * Every page that renders something needs somewhere to say why it did not. The timeline
 * grew one because writing the message into the drawing surface detached the renderer's
 * own `<svg>`; the statistics page never grew one at all, so an exception in
 * `renderStats` left an empty dashboard while the explanation went into an element
 * belonging to a page that was not on screen. Both are the same mistake — a message with
 * nowhere of its own to live — so both now use this.
 *
 * ⚠️ **The surface and the drawing surface are always siblings, never nested.** The
 * renderer owns everything inside `contentEl` and holds references into it; writing a
 * message there destroys what it is holding. This module exists so that rule has one
 * implementation instead of one per page.
 *
 * DOM-free to construct and to reason about: it touches only `innerHTML` and
 * `style.display`, which is what makes it testable against a stub.
 */

/**
 * @param {object} options
 * @param {{innerHTML: string, style: object}} options.messageEl  where the message goes
 * @param {{style: object}} [options.contentEl]  what the message stands in for
 */
export function createMessageSurface({ messageEl, contentEl = null }) {
  if (!messageEl) throw new Error('createMessageSurface: messageEl is required');

  return {
    show(html) {
      messageEl.innerHTML = html;
      messageEl.style.display = 'block';
      // Hidden, not emptied: its contents are the last thing successfully drawn, and
      // showing them beneath "could not render" would contradict the message.
      if (contentEl) contentEl.style.display = 'none';
    },

    hide() {
      messageEl.style.display = 'none';
      messageEl.innerHTML = '';
      if (contentEl) contentEl.style.display = '';
    },

    isShowing() {
      return messageEl.style.display !== 'none' && messageEl.style.display !== '';
    },
  };
}

/** A heading and a body, formatted the same way wherever a page has to explain itself. */
export function messageHtml(title, bodyHtml) {
  return (
    '<div style="padding:32px;max-width:760px">' +
    '<div style="font-size:15px;font-weight:600;color:var(--color-text);margin-bottom:8px">' +
    `${title}</div>` +
    `<div style="font-size:12.5px;color:var(--color-neutral-400);line-height:1.7">${bodyHtml}</div>` +
    '</div>'
  );
}

/**
 * A failure, rendered as its message.
 *
 * `<pre>` and escaped, because the text is an exception message: it may contain angle
 * brackets, and it is the one string on screen that must not be reinterpreted as markup.
 */
export function errorHtml(error, title = 'Could not render this sub-log') {
  const text = String(error?.message || error).replace(/[&<>]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c],
  );
  return messageHtml(
    title,
    `<pre class="mono" style="white-space:pre-wrap;font-size:12px;line-height:1.6;margin:0">${text}</pre>`,
  );
}
