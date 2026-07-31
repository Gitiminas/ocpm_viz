import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadObjectGraph } from '../src/data/loadObjectGraph.js';
import { milestones } from '../src/stats/metrics.js';
import { formatInstant, formatDateMinute } from '../src/render/format.js';

const fileTransport = async (query) =>
  JSON.parse(await readFile(new URL(`./fixtures/${query.fixture}.json`, import.meta.url), 'utf8'));

describe('all times render in UTC, labelled (decision 9)', () => {
  test('an instant renders at its UTC clock time, not the machine’s', () => {
    // The vscode issue opens at 05:15:54Z. The screenshots/ baseline was captured on
    // a UTC+01:00 machine and shows 06:15:54 — the defect this fixes.
    const opened = new Date('2025-03-07T05:15:54Z');
    assert.match(formatInstant(opened), /05:15:54/);
    assert.doesNotMatch(formatInstant(opened), /06:15:54/);
  });

  test('every instant carries its zone, so a bare time cannot be misread as local', () => {
    assert.match(formatInstant(new Date('2025-03-07T05:15:54Z')), / UTC$/);
  });

  test('axis label formats are UTC too', () => {
    assert.match(formatDateMinute(new Date('2025-03-07T23:30:00Z')), /Mar 07\s+23:30/);
  });

  test('the rendering is independent of the machine timezone', async () => {
    // Every formatter must give the same answer whatever TZ the viewer has set;
    // that is the whole point — evaluation numbers must reproduce across machines.
    const graph = await loadObjectGraph({ fixture: 'F1' }, { transport: fileTransport });
    const rendered = milestones(graph).map((entry) => formatInstant(entry.time));
    assert.ok(rendered.length > 0);
    assert.ok(rendered.every((text) => text.endsWith(' UTC')));
    assert.match(rendered[0], /Mar 07, 2025 · 05:15:54 UTC/);
  });
});
