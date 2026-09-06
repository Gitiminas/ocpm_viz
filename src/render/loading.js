/**
 * The loading overlay: what a page says while a sub-log is on its way.
 *
 * A sub-log arrives in one RPC call and that call is slow — 3.5 s to 3.9 s warm against
 * the live database on 2026-09-06, 7.4 s cold — during which nothing on screen changed at all. The
 * previous sub-log stayed up, fully interactive, so a reader could toggle a lane, drag a
 * mark or click the degree stepper again on a picture that was about to be replaced, and
 * had no way to tell a slow query from a dead tool. `main.js` already worried about
 * exactly this in prose ("conclude the tool had hung"); this is the affordance.
 *
 * Three things it does that a bare spinner does not:
 *
 * **It waits before appearing.** The fixture source answers in milliseconds, and a
 * spinner that flashes for one frame on every fixture load is worse than no spinner — it
 * reads as a glitch. `show()` only arms a timer; a `hide()` that arrives first cancels it
 * and nothing is ever drawn. So the overlay appears exactly when there is a wait to
 * report.
 *
 * **It blocks the stale picture.** The old sub-log is blurred and stops taking pointer
 * events, because it is no longer the answer to the question being asked. Blurring rather
 * than clearing keeps the context — you can still see roughly what you had — while making
 * it unmistakably not current. This is the same principle as the hidden-state banner: the
 * tool never shows something that could be read as current when it is not.
 *
 * **It says more if the wait runs long.** After `PATIENCE_MS` the card admits the query is
 * a slow one rather than leaving a spinner turning forever, which is the moment a reader
 * decides the tool is broken.
 *
 * DOM-free to reason about: it touches `innerHTML` and `style` on two elements and takes
 * its timers by injection, so the whole thing is checkable against stubs.
 */

/**
 * How long a load may take before the overlay appears.
 *
 * Below this, a load is perceived as instant and an overlay is just a flash. The fixture
 * source is always below it; the database source never is.
 */
export const SHOW_DELAY_MS = 200;

/** How long the overlay stays silent before admitting the query is a slow one. */
export const PATIENCE_MS = 6000;

const escapeHtml = (value) =>
  String(value).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/**
 * The card, as markup. Pure, so what it says is testable without a browser.
 *
 * `description` names the query rather than the seed id: a repository and a traversal
 * degree are what a reader can act on — the degree in particular is why a wait is long —
 * while `issue:829212149` is a database key that means nothing on screen.
 */
export function loadingHtml(description = '', { patient = false } = {}) {
  return (
    '<div class="loadingCard">' +
    '<div class="spinner"></div>' +
    '<div>' +
    '<div class="loadingTitle">Loading sub-log</div>' +
    (description
      ? `<div class="loadingQuery mono">${escapeHtml(description)}</div>`
      : '') +
    (patient
      ? '<div class="loadingPatience">Still working. A busy seed at a higher traversal ' +
        'degree reaches more objects, and the whole sub-log arrives in one query.</div>'
      : '') +
    '</div>' +
    '</div>'
  );
}

/**
 * @param {object} options
 * @param {{innerHTML: string, style: object}} options.overlayEl  where the card goes
 * @param {{style: object}} [options.contentEl]   what is blurred behind it
 * @param {Function} [options.schedule]           `setTimeout`, injectable for tests
 * @param {Function} [options.cancel]             `clearTimeout`, injectable for tests
 * @param {number} [options.delayMs]              wait before appearing
 * @param {number} [options.patienceMs]           wait before admitting it is slow
 */
export function createLoadingOverlay({
  overlayEl,
  contentEl = null,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
  delayMs = SHOW_DELAY_MS,
  patienceMs = PATIENCE_MS,
}) {
  if (!overlayEl) throw new Error('createLoadingOverlay: overlayEl is required');

  let showTimer = null;
  let patienceTimer = null;
  let showing = false;
  let description = '';

  const paint = (patient) => {
    overlayEl.innerHTML = loadingHtml(description, { patient });
  };

  function reveal() {
    showTimer = null;
    showing = true;
    paint(false);
    overlayEl.style.display = 'flex';
    if (contentEl) {
      contentEl.style.filter = 'blur(2px)';
      // Not merely cosmetic: a click that lands on the stale picture acts on a sub-log
      // that is being replaced, which is how a drag or a toggle gets applied to the
      // wrong thing.
      contentEl.style.pointerEvents = 'none';
    }
    patienceTimer = schedule(() => {
      patienceTimer = null;
      if (showing) paint(true);
    }, patienceMs);
  }

  return {
    /**
     * A load has started. Nothing is drawn yet — `delayMs` decides whether anything ever is.
     */
    show(text = '') {
      description = text;
      if (showing) {
        paint(false); // a second load began while the first was still up: retitle it
        return;
      }
      if (showTimer == null) showTimer = schedule(reveal, delayMs);
    },

    /**
     * The load ended, whether it succeeded or failed. Safe to call when nothing is showing,
     * which is what lets every caller put it in a `finally`.
     */
    hide() {
      if (showTimer != null) cancel(showTimer);
      if (patienceTimer != null) cancel(patienceTimer);
      showTimer = null;
      patienceTimer = null;
      showing = false;
      overlayEl.style.display = 'none';
      overlayEl.innerHTML = '';
      if (contentEl) {
        contentEl.style.filter = '';
        contentEl.style.pointerEvents = '';
      }
    },

    isShowing: () => showing,
    /** True once a load has been announced, whether or not the card is on screen yet. */
    isPending: () => showing || showTimer != null,
  };
}
