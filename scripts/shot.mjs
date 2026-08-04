/**
 * Screenshot the running app headlessly, so a change can be *looked at* without a
 * human at a browser.
 *
 *   npm start                      # in another shell
 *   node scripts/shot.mjs LIVE1
 *   node scripts/shot.mjs F1 --height 2000
 *   node scripts/shot.mjs LIVE2 --page stats
 *
 * ⚠️ **This does not replace looking at it.** `npm test` covers the arithmetic and this
 * covers "did anything draw at all"; neither can tell you the picture is *right*. It
 * exists because the alternative was no visual check whatsoever from a shell, and one
 * PNG catches the whole class of faults where the payload validates and the render is
 * still wrong — a lane drawn empty, glyphs stacked into a column, links to nowhere.
 *
 * ⚠️ **Never writes to `screenshots/`.** That directory is the pre-change visual
 * regression baseline and is read-only by project rule (`CLAUDE.md`). Output goes to a
 * scratch directory instead, and is not committed.
 *
 * **How it works, and why it is not Playwright.** There is no browser installed under
 * Linux here and no Playwright. There *is* Microsoft Edge on the Windows side, reachable
 * through WSL interop, and Chromium's `--headless=new --screenshot` needs no driver. The
 * cost is that the output path must be a Windows path, which is the only awkward part
 * below. On a machine with a Linux Chrome/Chromium, set `BROWSER` and it works unchanged.
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
const positional = args.filter((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const fixture = positional[0] || 'LIVE1';
const width = Number(flag('width', 1700));
const height = Number(flag('height', 1400));
const page = flag('page', null);
const port = flag('port', 8000);

const url =
  `http://localhost:${port}/?fixture=${encodeURIComponent(fixture)}` +
  (page ? `&page=${encodeURIComponent(page)}` : '');

// The browser writes where *it* can see. Under WSL that means a Windows path, so stage
// the file on the Windows side and copy it back into the repo's scratch directory.
const outDir = resolve(ROOT, '.shots');
mkdirSync(outDir, { recursive: true });
const name = `${fixture}${page ? `-${page}` : ''}.png`;
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
