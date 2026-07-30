/**
 * Time and duration formatting — the single place a timestamp becomes text.
 *
 * ⚠️ Timezone: the mockup parsed UTC but rendered with `d3.timeFormat`, which is
 * *local* time, so every displayed instant and every duration shifted with the
 * viewer's machine. Decision 9 requires UTC everywhere, labelled.
 *
 * The switch is deliberately not made yet: it belongs to Task 5, and making it here
 * would add a second visible difference to the Task 1 baseline comparison on top of
 * the evidence reclassification, muddying exactly the check that is meant to catch a
 * regression. Task 5 is then a one-line change — `d3.timeFormat` → `d3.utcFormat` in
 * `timeFormatter` below — plus a "UTC" label in the axis and tooltips.
 *
 * Formatters are built lazily rather than at module load, so this module imports
 * cleanly in Node without d3 present. That keeps the pure duration helpers, which
 * are the parts worth testing, testable.
 */

/* global d3 */

const formatterCache = new Map();

function timeFormatter(specifier) {
  let formatter = formatterCache.get(specifier);
  if (!formatter) {
    formatter = d3.timeFormat(specifier);
    formatterCache.set(specifier, formatter);
  }
  return formatter;
}

/** Tooltip and milestone timestamps. */
export const formatInstant = (date) => timeFormatter('%b %d, %Y · %H:%M:%S')(date);

/** Axis tick label variants, coarsest first. */
export const formatDate = (date) => timeFormatter('%b %d')(date);
export const formatTime = (date) => timeFormatter('%H:%M')(date);
export const formatDateMinute = (date) => timeFormatter('%b %d  %H:%M')(date);
export const formatDateSecond = (date) => timeFormatter('%b %d  %H:%M:%S')(date);

/**
 * Exact duration, e.g. "4d 16h". Minutes appear only when the duration is under a
 * day, where they carry information; below a minute it reads "<1m".
 */
export function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (!days && minutes) parts.push(`${minutes}m`);
  return parts.length ? parts.join(' ') : '<1m';
}

/** Approximate duration for gap bands, e.g. "≈ 7 days". */
export function formatApproxDuration(ms) {
  const minutes = ms / 60000;
  const hours = minutes / 60;
  const days = hours / 24;
  const months = days / 30.44;

  if (months >= 1) {
    const n = Math.round(months);
    return `≈ ${n} ${n === 1 ? 'month' : 'months'}`;
  }
  if (days >= 1) {
    const n = Math.round(days);
    return `≈ ${n} ${n === 1 ? 'day' : 'days'}`;
  }
  if (hours >= 1) {
    const n = Math.round(hours);
    return `≈ ${n} ${n === 1 ? 'hour' : 'hours'}`;
  }
  return `≈ ${Math.max(1, Math.round(minutes))} min`;
}

/** Escape text for interpolation into tooltip HTML. */
export function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
