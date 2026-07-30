/**
 * The minimap: an overview strip with a draggable viewport and drag-to-zoom handles.
 *
 * The handle drag is the most intricate interaction in the app. Dragging one edge
 * changes the zoom while keeping the *opposite* edge pinned to the same instant,
 * which means converting the anchor pixel back to a time before the zoom changes,
 * then recomputing scrollLeft from where that time lands afterwards. Hence
 * `scales.invert`.
 */

/* global d3 */

import { typeColor, COLORS } from './theme.js';

const HEIGHT = 40;
const HANDLE_HIT_WIDTH = 10;
const GRIP_WIDTH = 5;

export function createMinimap({ svgEl, scrollEl, chartEl, onZoom, onAfterZoom }) {
  let resizing = false;
  let dragging = false;

  function viewportMetrics(mapWidth) {
    const total = Math.max(chartEl.scrollWidth, 1);
    const visible = scrollEl.clientWidth;
    const fractionVisible = Math.min(1, visible / total);
    const fractionScrolled = total > visible ? scrollEl.scrollLeft / (total - visible) : 0;
    const width = Math.max(6, fractionVisible * mapWidth);
    return { total, visible, width, x: fractionScrolled * (mapWidth - width) };
  }

  /** Keep the viewport rectangle in step with the scroll position. */
  function syncViewport() {
    if (resizing) return;
    const mapWidth = svgEl.parentElement.clientWidth - 20;
    const { width, x } = viewportMetrics(mapWidth);

    d3.select(svgEl).select('rect.viewport').attr('x', x).attr('width', width);
    const handles = svgEl.querySelectorAll('.mmHandle');
    if (handles[0]) handles[0].setAttribute('x', x - HANDLE_HIT_WIDTH / 2);
    if (handles[1]) handles[1].setAttribute('x', x + width - HANDLE_HIT_WIDTH / 2);
    const grips = svgEl.querySelectorAll('rect.mmGrip');
    if (grips[0]) grips[0].setAttribute('x', x - GRIP_WIDTH / 2);
    if (grips[1]) grips[1].setAttribute('x', x + width - GRIP_WIDTH / 2);
  }

  function render({ nodes, plotWidth, marginLeft, marginRight, basePlotWidth, scales, zoomBounds }) {
    const map = d3.select(svgEl);
    map.selectAll('*').remove();

    const mapWidth = svgEl.parentElement.clientWidth - 20;
    map.attr('width', mapWidth).attr('height', HEIGHT);

    const span = plotWidth || 1;
    for (const node of nodes) {
      const x = Math.max(0, Math.min(mapWidth, ((node.x - marginLeft) / span) * mapWidth));
      map
        .append('circle')
        .attr('cx', x)
        .attr('cy', HEIGHT / 2)
        .attr('r', node.isBurst ? 4 : 2.2)
        .attr('fill', node.isBurst ? COLORS.commit : typeColor(node.lane))
        .attr('opacity', 0.85);
    }

    const { total, visible, width: viewportWidth, x: viewportX } = viewportMetrics(mapWidth);

    const viewport = map
      .append('rect')
      .attr('class', 'viewport')
      .attr('x', viewportX)
      .attr('y', 0)
      .attr('width', viewportWidth)
      .attr('height', HEIGHT)
      .attr('fill', 'var(--color-accent)')
      .attr('fill-opacity', 0.14)
      .attr('stroke', 'var(--color-accent)')
      .attr('stroke-width', 1.5)
      .style('cursor', 'grab');

    function scrollToClientX(clientX) {
      const bounds = svgEl.getBoundingClientRect();
      const fraction = Math.max(
        0,
        Math.min(1, (clientX - bounds.left - viewportWidth / 2) / (mapWidth - viewportWidth || 1)),
      );
      scrollEl.scrollLeft = fraction * (total - visible);
    }

    viewport.node().addEventListener('pointerdown', (event) => {
      dragging = true;
      viewport.node().setPointerCapture(event.pointerId);
    });
    viewport.node().addEventListener('pointermove', (event) => {
      if (dragging) scrollToClientX(event.clientX);
    });
    viewport.node().addEventListener('pointerup', () => {
      dragging = false;
    });
    map.on('click', (event) => {
      if (event.target === viewport.node()) return;
      scrollToClientX(event.clientX);
    });

    // ---- drag-to-zoom handles -------------------------------------------------
    const gripHeight = Math.min(22, HEIGHT - 6);
    const sides = { left: {}, right: {} };

    for (const [side, handleX] of [
      ['left', viewportX],
      ['right', viewportX + viewportWidth],
    ]) {
      const hit = map
        .append('rect')
        .attr('class', 'mmHandle')
        .attr('x', handleX - HANDLE_HIT_WIDTH / 2)
        .attr('y', 0)
        .attr('width', HANDLE_HIT_WIDTH)
        .attr('height', HEIGHT)
        .attr('fill', '#000')
        .attr('fill-opacity', 0)
        .style('cursor', 'ew-resize');

      const grip = map
        .append('rect')
        .attr('class', 'mmGrip')
        .attr('x', handleX - GRIP_WIDTH / 2)
        .attr('y', (HEIGHT - gripHeight) / 2)
        .attr('width', GRIP_WIDTH)
        .attr('height', gripHeight)
        .attr('rx', 2.5)
        .attr('fill', 'var(--color-accent)')
        .style('pointer-events', 'none');

      sides[side] = { hit, grip };
      hit.append('title').text('Drag to zoom');

      hit.node().addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        resizing = true;
        svgEl.setPointerCapture(event.pointerId);

        const bounds = svgEl.getBoundingClientRect();
        const startX = viewportX;
        const startWidth = viewportWidth;
        const startVisible = visible;

        // The instant under the *opposite* edge, which must not move.
        const anchorFraction = side === 'right' ? startX / mapWidth : (startX + startWidth) / mapWidth;
        const anchorTime = scales.invert(marginLeft + anchorFraction * plotWidth);

        let frame = null;
        let pending = null;

        function apply(pointerX) {
          let newX;
          let newWidth;
          if (side === 'right') {
            newWidth = Math.max(mapWidth * 0.03, Math.min(mapWidth - startX, pointerX - startX));
            newX = startX;
          } else {
            newX = Math.max(0, Math.min(startX + startWidth - mapWidth * 0.03, pointerX));
            newWidth = startX + startWidth - newX;
          }

          viewport.attr('x', newX).attr('width', newWidth);
          sides.left.grip.attr('x', newX - GRIP_WIDTH / 2);
          sides.left.hit.attr('x', newX - HANDLE_HIT_WIDTH / 2);
          sides.right.grip.attr('x', newX + newWidth - GRIP_WIDTH / 2);
          sides.right.hit.attr('x', newX + newWidth - HANDLE_HIT_WIDTH / 2);

          const newFractionVisible = newWidth / mapWidth;
          const zoom = Math.max(
            zoomBounds.min,
            Math.min(
              zoomBounds.max,
              (startVisible / newFractionVisible - marginLeft - marginRight) / basePlotWidth,
            ),
          );
          const newPlotWidth = onZoom(zoom);

          const newTotal = marginLeft + newPlotWidth + marginRight;
          const anchorPx = scales.xAtZoom(anchorTime, newPlotWidth);
          const scrollLeft = side === 'right' ? anchorPx : anchorPx - startVisible;
          scrollEl.scrollLeft = Math.max(0, Math.min(newTotal - startVisible, scrollLeft));
        }

        function move(moveEvent) {
          pending = Math.max(0, Math.min(mapWidth, moveEvent.clientX - bounds.left));
          if (frame) return;
          frame = requestAnimationFrame(() => {
            apply(pending);
            frame = null;
          });
        }

        function end() {
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', end);
          document.removeEventListener('pointercancel', end);
          if (frame) {
            cancelAnimationFrame(frame);
            frame = null;
            if (pending != null) apply(pending);
          }
          resizing = false;
          onAfterZoom();
        }

        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', end);
        document.addEventListener('pointercancel', end);
      });
    }
  }

  return { render, syncViewport, isResizing: () => resizing };
}
