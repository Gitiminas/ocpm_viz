/**
 * Time and duration formatting — the single place a timestamp becomes text.
 *
 * **All times are UTC** (decision 9), and labelled as such.
 *
 * The mockup parsed UTC but rendered with `d3.timeFormat`, which is *local* time, so
 * every displayed instant shifted with the viewer's machine — the `screenshots/`
 * baseline was captured at UTC+01:00 and shows an issue opening at 06:15:54 that the
 * data records as 05:15:54Z. Evaluation numbers have to reproduce across whoever
 * runs the study, so that had to go.
 *
 * ⚠️ It was **not** the one-line formatter swap an earlier version of this comment
 * promised. `d3.scaleTime()` also *chooses* ticks on local midnights, and the axis
 * decided whether a tick was a date boundary with `getHours()`; a UTC formatter over
 * locally-chosen ticks would have labelled "Mar 09 23:00" as a day boundary. Those
 * two live in `render/axis.js`, which now uses `d3.scaleUtc` and `getUTCHours`.
 *
 * These formatters are hand-written rather than `d3.utcFormat` for one reason that
 * earns the extra twenty lines: it makes the guarantee **structural and testable**.
 * Nothing here can reach a local-time API, so `grep -rn 'get[A-Z]' src/ | grep -v
 * getUTC` is a complete audit — and the module imports in Node without d3, so the
 * timezone behaviour is covered by tests that pass under any TZ rather than by a
 * promise in a comment.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (value) => String(value).padStart(2, '0');

const utcParts = (date) => ({
  month: MONTHS[date.getUTCMonth()],
  day: pad(date.getUTCDate()),
  year: date.getUTCFullYear(),
  hour: pad(date.getUTCHours()),
  minute: pad(date.getUTCMinutes()),
  second: pad(date.getUTCSeconds()),
});

/**
 * Tooltip and milestone timestamps, carrying their zone.
 *
 * The suffix is on every instant rather than in a legend somewhere, because a bare
 * "21:47:52" is precisely what a reader will unconsciously read as local time.
 */
export function formatInstant(date) {
  const { month, day, year, hour, minute, second } = utcParts(date);
  return `${month} ${day}, ${year} · ${hour}:${minute}:${second} UTC`;
}

/** Axis tick labels, coarsest first. The axis carries a single "UTC" of its own. */
export function formatDate(date) {
  const { month, day } = utcParts(date);
  return `${month} ${day}`;
}

export function formatTime(date) {
  const { hour, minute } = utcParts(date);
  return `${hour}:${minute}`;
}

export function formatDateMinute(date) {
  const { month, day, hour, minute } = utcParts(date);
  return `${month} ${day}  ${hour}:${minute}`;
}

export function formatDateSecond(date) {
  const { month, day, hour, minute, second } = utcParts(date);
  return `${month} ${day}  ${hour}:${minute}:${second}`;
}

/**
 * Exact duration, e.g. "4d 16h". Minutes appear only when the duration is under a
 * day, where they carry information; below a minute it reads "<1m".
 *
 * Durations are differences, so they were never affected by the timezone defect —
 * which is why the baseline's "4d 16h" was right even while its clock times were
 * wrong, and why fixing the zone does not move any duration in the stats table.
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
