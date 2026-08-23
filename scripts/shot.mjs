/**
 * Screenshot the running app headlessly, so a change can be *looked at* without a
 * human at a browser.
 *
 *   npm start                      # in another shell
 *   node scripts/shot.mjs LIVE1
 *   node scripts/shot.mjs F1 --height 2000
 *   node scripts/shot.mjs LIVE2 --page stats
 *   node scripts/shot.mjs F13 --mode relationships
 *
 * ⚠️ **This does not replace looking at it.** `npm test` covers the arithmetic and this
 * covers "did anything draw at all"; neither can tell you the picture is *right*. It
 * exists because the alternative was no visual check whatsoever from a shell, and one
 * PNG catches the whole class of faults where the payload validates and the render is
 * still wrong — a lane drawn empty, glyphs stacked into a column, links to nowhere.
 *
 * Output goes to `.shots/`, which is gitignored.
 *
 * **How it works, and why it is not Playwright.** Chromium's `--headless=new
 * --screenshot` needs no driver, so the only dependency is a browser binary. The first
 * of `$BROWSER`, a Windows-side Microsoft Edge reachable over WSL interop, or a local
 * chromium/chrome wins. A Windows binary needs a Windows output path, which is the only
 * awkward part below.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CANDIDATES = [
  process.env.BROWSER,
  '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean);

const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error(
    'No browser found. Set BROWSER=/path/to/chrome, or install chromium.\n' +
      `Looked in:\n  ${CANDIDATES.join('\n  ')}`,
  );
  process.exit(1);
}
const isWindows = browser.endsWith('.exe');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

/*
 * ⚠️ A flag's VALUE is not a positional argument. Filtering on `--` alone treated
 * `--repo kubernetes/kubernetes` as both the flag and a fixture name, so the shot was
 * written to `.shots/kubernetes/kubernetes-off.png` — a directory that does not exist.
 */
const flagValues = new Set(
  args.flatMap((arg, i) => (arg.startsWith('--') ? [args[i + 1]] : [])),
);
const positional = args.filter((arg) => !arg.startsWith('--') && !flagValues.has(arg));

const width = Number(flag('width', 1700));
const height = Number(flag('height', 1400));
const page = flag('page', null);
// The time mode. Worth a flag rather than only a preset, because the relationships mode changes
// what position means, so "F13" and "F13 with time released" are two different pictures.
const mode = flag('mode', null);
const port = flag('port', 8000);

// A live sub-log rather than a fixture. Needs PostgREST up; `?source=database` is implied,
// because a repo-and-seed query means nothing to the fixture catalogue.
const repo = flag('repo', null);
const seed = flag('seed', null);
const degree = flag('degree', null);
// Which arrangement the relationships mode uses: layered (rows) or cluster (clusters).
const layout = flag('layout', null);
// The brushed time range, as two fractions: --brush 0.6,1
const brush = flag('brush', null);
// Focus a single object: --focus pr:243221 [--focusDegree 2]
const focus = flag('focus', null);
const focusDegree = flag('focusDegree', null);
const fixture = positional[0] || 'LIVE1';

const target = repo
  ? `?source=database&repo=${encodeURIComponent(repo)}` +
    (seed ? `&seed=${encodeURIComponent(seed)}` : '') +
    (degree ? `&degree=${encodeURIComponent(degree)}` : '')
  : `?fixture=${encodeURIComponent(fixture)}`;

const url =
  `http://localhost:${port}/${target}` +
  (page ? `&page=${encodeURIComponent(page)}` : '') +
  (mode ? `&mode=${encodeURIComponent(mode)}` : '') +
  (layout ? `&layout=${encodeURIComponent(layout)}` : '') +
  (brush ? `&brush=${encodeURIComponent(brush)}` : '') +
  (focus ? `&focus=${encodeURIComponent(focus)}` : '') +
  (focusDegree ? `&focusDegree=${encodeURIComponent(focusDegree)}` : '');

// The browser writes where *it* can see. Under WSL that means a Windows path, so stage
// the file on the Windows side and copy it back into the repo's scratch directory.
const outDir = resolve(ROOT, '.shots');
mkdirSync(outDir, { recursive: true });
// Slashes and colons in a repo name or a seed id are not filename characters.
const label = repo
  ? [repo, seed, degree && `d${degree}`].filter(Boolean).join('-').replace(/[^\w.-]+/g, '-')
  : fixture;
const name = `${label}${page ? `-${page}` : ''}${mode ? `-${mode}` : ''}${layout ? `-${layout}` : ''}${brush ? '-brushed' : ''}${focus ? '-focused' : ''}.png`;
const finalPath = resolve(outDir, name);

let browserTarget;
let stagedPath;
if (isWindows) {
  const winDir = '/mnt/c/temp/ocpm';
  mkdirSync(winDir, { recursive: true });
  stagedPath = `${winDir}/${name}`;
  browserTarget = execFileSync('wslpath', ['-w', stagedPath], { encoding: 'utf8' }).trim();
} else {
  browserTarget = finalPath;
}

try {
  execFileSync(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      /*
       * ⚠️ Motion off, so two shots of one sub-log are comparable.
       *
       * The relationships mode drifts its marks a couple of pixels around where the layout put
       * them, which is fine to look at and useless to compare: two screenshots taken a
       * second apart would differ everywhere, and a screenshot is exactly the tool used
       * here to check whether a change moved anything. The app honours this the same way
       * it honours a reader who has asked for less movement — same picture, no journey.
       */
      '--force-prefers-reduced-motion',
      /*
       * ⚠️ The page lays out in a viewport SHORTER than this, and is then captured at
       * this size. Measured: `--window-size=1500,900` gives `window.innerHeight` 807 while
       * the app renders, and a 900px-tall image afterwards. A real browser fires `resize`
       * and the app re-renders; headless does not, so anything sized to the viewport —
       * the relationships mode fits its drawing to the surface — comes out ~10% smaller here than
       * on a screen of the same size. Compare fill between shots, not against the box.
       */
      `--window-size=${width},${height}`,
      // The app fetches its payload and lays out with d3 before anything is drawn, so a
      // naive screenshot catches a blank page. Virtual time lets the render finish
      // without a fixed sleep.
      '--virtual-time-budget=15000',
      `--screenshot=${browserTarget}`,
      url,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000 },
  );
} catch (error) {
  console.error(`Browser failed: ${error.message}`);
  console.error('Is the dev server running?  npm start');
  process.exit(1);
}

if (isWindows) copyFileSync(stagedPath, finalPath);
if (!existsSync(finalPath)) {
  console.error('No image was produced. Is the dev server running?  npm start');
  process.exit(1);
}
console.log(`${finalPath}\n  ${url}  (${width}x${height})`);
