import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { deriveHistory, recordHistory } from '../src/history.mjs';
import { normalize } from '../src/normalize.mjs';
import { parseHistory, source as frequentmiler } from '../src/sources/frequentmiler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOW = new Date('2026-07-24T00:00:00Z');

// Minimal stand-in for the live page: the current-bonus table (which must NOT
// be read as history) followed by the "Expired Transfer Bonuses" archive,
// hidden sort-serial <p> and all.
const CURRENT_TABLE = `
<h3>Current and Upcoming Transfer Bonuses</h3>
<table id="tablepress-33-no-5" class="tablepress">
<thead><tr><th>Transfer From</th><th>Transfer Bonus Details</th><th>Start Date</th><th>End Date</th></tr></thead>
<tbody>
<tr><td>Amex Membership Rewards</td><td>30% transfer bonus from Amex Membership Rewards to Virgin Atlantic Flying Club</td><td><p style='display: none;'>46204</p>07/01/26</td><td><p style='display: none;'>46234</p>07/31/26</td></tr>
</tbody></table>`;

const ARCHIVE_TABLE = `
<h3>Expired Transfer Bonuses</h3>
<table id="tablepress-33-no-6" class="tablepress">
<thead><tr><th>Transfer From</th><th>Transfer Bonus Details</th><th>Start Date</th><th>End Date</th></tr></thead>
<tbody>
<tr><td>Citi ThankYou Rewards</td><td>50% transfer bonus from Citi ThankYou Rewards to Avianca LifeMiles</td><td><p style='display: none;'>46187</p>06/14/26</td><td><p style='display: none;'>46221</p>07/18/26</td></tr>
<tr><td>Citi ThankYou Rewards</td><td>25% transfer bonus from Citi ThankYou Rewards to Avianca LifeMiles</td><td><p style='display: none;'>45800</p>06/02/25</td><td><p style='display: none;'>45810</p>06/02/25</td></tr>
<tr><td>Marriott Bonvoy</td><td>35% transfer bonus from Marriott Bonvoy to Air Canada Aeroplan</td><td>07/17/17</td><td>08/21/17</td></tr>
<tr><td>Capital One Miles</td><td>5,000 bonus point transfer bonus from Capital One Miles to JetBlue TrueBlue</td><td>01/01/24</td><td>02/01/24</td></tr>
<tr><td>Amex Membership Rewards</td><td>40% transfer bonus from Amex Membership Rewards to Virgin Atlantic Flying Club [Targeted]</td><td>11/21/25</td><td>12/31/25</td></tr>
</tbody></table>`;

const PAGE = CURRENT_TABLE + ARCHIVE_TABLE;

test('parseHistory reads the archive table, not the current-bonus table', () => {
  const windows = parseHistory(PAGE);
  assert.equal(windows.length, 3, 'the non-percentage promo and [Targeted] rows are skipped');
  assert.deepEqual(windows[0], {
    bankName: 'Citi ThankYou Rewards',
    partnerName: 'Avianca LifeMiles',
    pct: 50,
    startDateRaw: '06/14/26', // hidden sort serial stripped
    endDateRaw: '07/18/26',
  });
  assert.ok(!windows.some((w) => w.partnerName.includes('Virgin')), 'current bonuses must never leak into history');
});

test('targeted-only offers are excluded from history', () => {
  const windows = parseHistory(PAGE);
  assert.ok(!windows.some((w) => w.startDateRaw === '11/21/25'), 'a [Targeted] window is not a public window');
});

test('parseHistory finds the archive by size when the heading is missing', () => {
  const noHeading = PAGE.replace('<h3>Expired Transfer Bonuses</h3>', '');
  assert.equal(parseHistory(noHeading).length, 3);
});

test('parseHistory returns nothing when the page has only the current table', () => {
  // the checked-in fixture is exactly this case - one table, no archive
  const fixture = readFileSync(path.join(__dirname, '..', 'fixtures', 'frequentmiler.html'), 'utf8');
  assert.deepEqual(parseHistory(fixture), []);
});

test('deriveHistory builds hist most-recent-first with inclusive day lengths', () => {
  const derived = deriveHistory(NOW, parseHistory(PAGE));
  const citiAv = derived.get('citi-av');
  assert.ok(citiAv, 'Citi -> Avianca resolves through the alias maps');
  assert.deepEqual(citiAv.hist, [
    { w: 'JUN 2026', pct: 50, len: '35 days' },
    { w: 'JUN 2025', pct: 25, len: '1 day' },
  ]);
  assert.equal(citiAv.typical, '+25–50%');
});

test('deriveHistory drops untracked banks/partners instead of inventing codes', () => {
  const derived = deriveHistory(NOW, parseHistory(PAGE));
  assert.deepEqual([...derived.keys()], ['citi-av']);
});

test('mp is the empirical per-month frequency across the years covered', () => {
  // One route, two windows: Jun 14 2026 -> Jul 18 2026 and Jun 2 2025.
  // Span = 2025..2026 = 2 years. June seen in 2 of those years -> 1.0.
  // July seen in 1 (2026) -> 0.5. Every other month -> 0.
  const mp = deriveHistory(NOW, parseHistory(PAGE)).get('citi-av').mp;
  assert.equal(mp.length, 12);
  assert.equal(mp[5], 1); // June
  assert.equal(mp[6], 0.5); // July
  assert.deepEqual(
    mp.filter((_, i) => i !== 5 && i !== 6),
    Array(10).fill(0),
  );
  for (const v of mp) assert.ok(v >= 0 && v <= 1, `mp value ${v} outside 0..1`);
});

test('a single archived window yields history but never a forecast', () => {
  const one = [{ bankName: 'Amex', partnerName: 'Avianca LifeMiles', pct: 30, startDateRaw: '03/01/26', endDateRaw: '03/31/26' }];
  const entry = deriveHistory(NOW, one).get('amex-av');
  assert.equal(entry.hist.length, 1);
  assert.equal(entry.next, undefined, 'one window is an anecdote, not a pattern');
});

test('next picks the highest-probability month ahead and stays a valid probability', () => {
  const marchEveryYear = ['24', '25', '26'].map((yy) => ({
    bankName: 'Amex',
    partnerName: 'Avianca LifeMiles',
    pct: 40,
    startDateRaw: `03/01/${yy}`,
    endDateRaw: `03/31/${yy}`,
  }));
  const entry = deriveHistory(NOW, marchEveryYear).get('amex-av');
  assert.equal(entry.next.label, 'Mar 2027');
  // mp[Mar] = 3 years seen / 3 years spanned = 1.0; last window ended
  // 03/31/26, under 12 months before NOW -> recency 1.0; capped at 95.
  assert.equal(entry.next.prob, 95);
  assert.ok(Number.isInteger(entry.next.prob) && entry.next.prob >= 0 && entry.next.prob <= 100);
});

test('a route that stopped running bonuses years ago is damped, not dropped', () => {
  const stale = ['17', '18'].map((yy) => ({
    bankName: 'Amex',
    partnerName: 'Avianca LifeMiles',
    pct: 40,
    startDateRaw: `03/01/${yy}`,
    endDateRaw: `03/31/${yy}`,
  }));
  const entry = deriveHistory(NOW, stale).get('amex-av');
  // mp[Mar] = 2 years seen / (2017..2026 = 10 years spanned) = 0.2,
  // last window ended >24 months ago -> recency 0.5 -> 10%
  assert.equal(entry.next.prob, 10);
});

test('malformed archive rows are skipped, not guessed at', () => {
  const junk = [
    { bankName: 'Amex', partnerName: 'Avianca LifeMiles', pct: 30, startDateRaw: '02/30/26', endDateRaw: '03/31/26' },
    { bankName: 'Amex', partnerName: 'Avianca LifeMiles', pct: 30, startDateRaw: 'sometime', endDateRaw: '03/31/26' },
    { bankName: 'Amex', partnerName: 'Avianca LifeMiles', pct: 30, startDateRaw: '05/01/26', endDateRaw: '04/01/26' },
  ];
  assert.equal(deriveHistory(NOW, junk).size, 0);
});

test('normalize no longer copies mp/hist out of the simulated sample feed', async () => {
  const sample = JSON.parse(readFileSync(path.join(__dirname, '..', 'sample', 'feed.json'), 'utf8'));
  const sampleAmexVs = sample.routes.find((r) => r.id === 'amex-vs');
  assert.ok(sampleAmexVs && sampleAmexVs.hist.length > 0, 'the sample really does carry simulated history');

  const { routes } = normalize(
    [{ bankName: 'Amex', partnerName: 'Virgin Atlantic', pct: 30, endDateRaw: 'July 31, 2026', sourceUrl: 'https://example.com/' }],
    NOW,
    new Map(), // no archive available this run
  );
  const amexVs = routes.find((r) => r.id === 'amex-vs');
  assert.deepEqual(amexVs.hist, [], 'no archive -> no history, never the sample');
  assert.notDeepEqual(amexVs.hist, sampleAmexVs.hist);
  assert.deepEqual(amexVs.mp, Array(12).fill(0), 'no evidence reads as zero, not a guess');
  assert.equal('next' in amexVs, false);
  assert.equal(amexVs.typical, '—');
});

test('normalize emits forecast routes for archived routes with no live bonus', () => {
  const history = deriveHistory(
    NOW,
    ['24', '25', '26'].flatMap((yy) => [
      { bankName: 'Amex', partnerName: 'Avianca LifeMiles', pct: 40, startDateRaw: `03/01/${yy}`, endDateRaw: `03/31/${yy}` },
      { bankName: 'Citi', partnerName: 'Air France', pct: 25, startDateRaw: `04/01/${yy}`, endDateRaw: `04/20/${yy}` },
    ]),
  );
  const { routes } = normalize(
    [{ bankName: 'Amex', partnerName: 'Avianca LifeMiles', pct: 30, endDateRaw: 'July 31, 2026', sourceUrl: 'https://example.com/' }],
    NOW,
    history,
  );

  const live = routes.find((r) => r.id === 'amex-av');
  assert.ok(live.active, 'the live route stays live');
  assert.equal('next' in live, false, 'a live route carries `active` alone, per the contract');
  assert.ok(live.hist.length === 3, 'but it does carry its real history');

  const forecast = routes.find((r) => r.id === 'citi-af');
  assert.ok(forecast, 'an archived route with no live bonus still reaches the Forecast tab');
  assert.equal('active' in forecast, false);
  assert.equal(forecast.next.label, 'Apr 2027');
  assert.equal(forecast.airline, 'Air France / KLM Flying Blue');
  assert.equal(forecast.typical, '+25%');
});

test('forecast routes are capped at 25, dropping the least likely', () => {
  // 30 synthetic routes, each with a distinct probability via a distinct
  // number of observed years.
  const banks = ['Amex', 'Citi', 'Chase', 'Capital One', 'Bilt'];
  const partners = ['Avianca LifeMiles', 'Air France', 'Virgin Atlantic', 'British Airways', 'Cathay Pacific', 'Qatar Airways Avios'];
  const raw = [];
  let i = 0;
  for (const bank of banks) {
    for (const partner of partners) {
      const years = 2 + (i % 5); // 2..6 windows -> different mp -> different prob
      for (let y = 0; y < years; y += 1) {
        raw.push({ bankName: bank, partnerName: partner, pct: 30, startDateRaw: `03/01/${20 + y}`, endDateRaw: `03/28/${20 + y}` });
      }
      i += 1;
    }
  }
  const history = deriveHistory(NOW, raw);
  assert.equal(history.size, 30);

  const logged = [];
  const originalLog = console.log;
  console.log = (m) => logged.push(m);
  let routes;
  try {
    ({ routes } = normalize([], NOW, history));
  } finally {
    console.log = originalLog;
  }

  assert.equal(routes.length, 25);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /dropped 5 lower-probability route/);
  const probs = routes.map((r) => r.next.prob);
  assert.deepEqual(probs, [...probs].sort((a, b) => b - a), 'kept routes are the highest-probability ones, sorted');
});

test('source.parse feeds the archive to the history store without a second fetch', async () => {
  const entries = await frequentmiler.parse(PAGE);
  assert.equal(entries.length, 1, 'current-bonus parsing is unchanged');

  // parse() recorded the archive; normalize() picks it up with no extra
  // plumbing in publish.mjs.
  const derived = deriveHistory(NOW);
  assert.ok(derived.has('citi-av'), 'history recorded by the source is visible to normalize');

  // and recording is replace-by-source, so a second parse doesn't double-count
  await frequentmiler.parse(PAGE);
  assert.equal(deriveHistory(NOW).get('citi-av').hist.length, 2);
});
