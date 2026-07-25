import { test } from 'node:test';
import assert from 'node:assert/strict';
import { source, parseHistory } from '../src/sources/frequentmiler.mjs';
import { resolveBank, resolvePartner } from '../src/aliases.mjs';

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Spec floor: 241 windows measured on 2026-07-24, ~9% slack so FM can publish
// new windows for programmes we do not track without breaking the suite. A
// nomenclature regression costs 20+ windows and falls straight through this.
const FLOOR = 220;

test('FM archive resolution stays above the coverage floor', async (t) => {
  let html;
  try {
    const res = await fetch(source.url, {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    html = await res.text();
  } catch (e) {
    // Connectivity is not a code defect: skip, never fail, when offline.
    t.skip('FM unreachable (' + e.message + ')');
    return;
  }
  const windows = parseHistory(html);
  assert.ok(windows.length >= 300, 'archive shrank suspiciously: ' + windows.length + ' rows');
  const resolved = windows.filter((w) => resolveBank(w.bankName) && resolvePartner(w.partnerName)).length;
  assert.ok(resolved >= FLOOR, 'resolved ' + resolved + ' < floor ' + FLOOR + ' - alias drift?');
});
