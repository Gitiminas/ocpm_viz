/**
 * Dragging the canvas to pan it, in the relationships mode.
 *
 * Zooming in scales the drawing past the surface, and the surface scrolls vertically only
 * (`#scroll` is `overflow-x: hidden`; the timeline navigates sideways with the minimap,
 * which relationships mode hides because it is a *time* overview). So a zoomed-in
 * relationships picture could be seen only one vertical strip at a time — reported as
 * "we cannot move the canvas once we zoom in". Every graph tool pans by dragging the
 * background with the primary button, so that is what this provides: a press on empty
 * canvas, a move, and the surface scrolls by the same distance in both axes.
 *
 * ⚠️ **Scrolling `scrollLeft` works with `overflow-x: hidden`.** The style hides the bar
 * and stops wheel/keyboard scrolling sideways; programmatic scrolling is unaffected, so
 * the surface keeps its timeline-era rule and nothing moves for the other modes.
 *
 * Three things this must not break, and how it avoids each:
 *   - a drag on a MARK (`render/structural.js` `enableDrag`) — those marks stop pointer
 *     events from bubbling (`stopPropagation` on pointerdown), so a press that reaches
 *     the svg is a press on the background;
 *   - the background CLICK, which clears the focus — a pan that travelled further than a
 *     few pixels swallows the click that follows it (`consumedClick`), the same rule the
 *     mark drag uses;
 *   - the timeline modes — `isActive()` gates it, so the baseline behaviour there is
 *     untouched.
 *
 * Pointer capture keeps the gesture alive when the pointer leaves the svg mid-drag.
 */

/** How far the pointer may travel before a press counts as a pan rather than a click. */
const PAN_SLOP_PX = 3;

/**
 * @param {object} options
 * @param {SVGElement} options.svgEl      the drawing surface
 * @param {HTMLElement} options.scrollEl  the element that scrolls (`#scroll`)
 * @param {() => boolean} options.isActive whether panning applies right now
 * @returns {{ consumedClick: () => boolean, dispose: () => void }}
 */
export function enableCanvasPan({ svgEl, scrollEl, isActive = () => true }) {
  let from = null;
  let travelled = 0;
  let wasPan = false;

  const onDown = (event) => {
    if (event.button !== 0 || !isActive()) return;
    from = { x: event.clientX, y: event.clientY, left: scrollEl.scrollLeft, top: scrollEl.scrollTop };
    travelled = 0;
    wasPan = false;
    svgEl.setPointerCapture?.(event.pointerId);
    svgEl.style.cursor = 'grabbing';
  };
  const onMove = (event) => {
    if (!from) return;
    const dx = event.clientX - from.x;
    const dy = event.clientY - from.y;
    travelled = Math.max(travelled, Math.hypot(dx, dy));
    if (travelled <= PAN_SLOP_PX) return;
    wasPan = true;
    // The picture follows the hand: dragging right shows what was off to the left.
    scrollEl.scrollLeft = from.left - dx;
    scrollEl.scrollTop = from.top - dy;
    event.preventDefault();
  };
  const onUp = (event) => {
    if (!from) return;
    svgEl.releasePointerCapture?.(event.pointerId);
    svgEl.style.cursor = isActive() ? 'grab' : '';
    from = null;
  };

  svgEl.addEventListener('pointerdown', onDown);
  svgEl.addEventListener('pointermove', onMove);
  svgEl.addEventListener('pointerup', onUp);
  svgEl.addEventListener('pointercancel', onUp);

  return {
    /** Whether the click that follows belongs to a pan and must be ignored. Resets. */
    consumedClick() {
      const it = wasPan;
      wasPan = false;
      return it;
    },
    /** Set the resting cursor for the current mode; call after a mode change. */
    syncCursor() {
      svgEl.style.cursor = isActive() ? 'grab' : '';
    },
    dispose() {
      svgEl.removeEventListener('pointerdown', onDown);
      svgEl.removeEventListener('pointermove', onMove);
      svgEl.removeEventListener('pointerup', onUp);
      svgEl.removeEventListener('pointercancel', onUp);
    },
  };
}
