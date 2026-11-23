import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseFmTransferTimes } from '../src/sources/transfer-times.mjs';
import { refreshTransferTimes, runTransferTimes } from '../scripts/refresh-transfer-times.mjs';

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const sourceUrl = 'https://frequentmiler.com/transfer-partner-master-list/';
const now = new Date('2026-10-13T15:00:00Z');
const input = () => ({
  ...JSON.parse(readFileSync(new URL('../sample/partners.json', import.meta.url), 'utf8')),
  transferTimes: { AMEX: { AF: '2 DAYS', CX: '8 HOURS', VN: '7 DAYS' }, ROVE: { AF: '1 DAY', F9: '3 DAYS' }, LIV: { AD: '2 DAYS' } },
  transferTimeMeta: {
    AMEX: { VN: { source: sourceUrl, asOf: '2026-08-01', estimate: true } },
    ROVE: { F9: { source: sourceUrl, asOf: '2026-08-01', estimate: true } },
    LIV: { AD: { source: 'https://example.com/old-source', asOf: '2026-08-01', estimate: true } },
  },
});
const liveSnapshot = async () => new Response(fixture('transfer-times-fm.html'));

test('FM live snapshot maps per-bank estimates, preserves ranges and excludes unknown times', () => {
  const { times, unparsed } = parseFmTransferTimes(fixture('transfer-times-fm.html'));
  assert.equal(times.AMEX?.AF, 'INSTANT');
  assert.equal(times.AMEX.CX, '4–8 HOURS');
  assert.equal(times.C1.CX, '1–2 DAYS');
  assert.equal(times.C1.SQ, '12–24 HOURS');
  assert.equal(times.AMEX.IB, '~12–24 HOURS (SLOWER OVER WEEKEND)');
  assert.equal(times.CITI.MH, '1–2 DAYS');
  assert.equal(times.CITI.EY, '~1 HOUR');
  assert.equal(times.CITI.TG, '3–7 DAYS');
  assert.equal(times.BILT.WN, '~12 HOURS');
  assert.equal(times.ROVE.AF, 'INSTANT', 'inserted US Bank column must not shift Rove');
  assert.equal(times.USB?.AF, undefined, 'Unknown must not become instant');
  assert.equal(times.CITI.JL, undefined);
  assert.equal(times.LIV, undefined, 'no estimates may be extrapolated to Brazilian banks');
  assert.equal(times.AMEX.UA, undefined, 'a blank cell must not inherit another bank time');
  assert.ok(unparsed.some((r) => r.bank === 'CITI' && r.code === 'JL' && r.reason === 'unknown'));
});

test('FM parser rejects ambiguity, resolves aliases by headers and ignores indirect tables', () => {
  const { times, unparsed, conflicts } = parseFmTransferTimes(fixture('transfer-times-edge.html'));
  assert.equal(times.C1?.CX, '2–3 BUSINESS DAYS');
  assert.equal(times.AMEX.CX, '30–60 MINUTES');
  assert.equal(times.AMEX.AF, undefined, 'conflicting duplicate observations are not chosen arbitrarily');
  assert.equal(times.C1.AF, undefined, 'unrecognized qualifier must not be silently discarded');
  assert.equal(times.AMEX.AV, undefined, 'unbalanced parentheses are not evidence');
  assert.equal(times.AMEX.NH, undefined, 'ratio alone is not transfer time');
  assert.equal(times.AMEX.UA, undefined, 'indirect table must not fill direct estimates');
  assert.ok(unparsed.some((r) => r.bank === 'C1' && r.code === 'AF' && r.reason === 'unparseable'));
  assert.deepEqual(conflicts.map(({ bank, code }) => ({ bank, code })), [{ bank: 'AMEX', code: 'AF' }]);
});

test('refresh stamps only source-verified estimates and reports retained known times', async () => {
  const original = input(), before = structuredClone(original);
  const { doc, report } = await refreshTransferTimes(original, { fetchImpl: liveSnapshot, now });
  assert.deepEqual(original, before, 'refresh must not mutate the caller snapshot');
  assert.equal(doc.transferTimes.AMEX.AF, 'INSTANT');
  assert.equal(doc.transferTimes.AMEX.CX, '4–8 HOURS');
  assert.equal(doc.transferTimes.ROVE.AF, 'INSTANT');
  assert.deepEqual(doc.transferTimeMeta.AMEX.AF, { source: sourceUrl, asOf: '2026-10-13', estimate: true });
  assert.equal(doc.transferTimes.AMEX.VN, '7 DAYS');
  assert.equal(doc.transferTimes.ROVE.F9, '3 DAYS');
  assert.deepEqual(doc.transferTimeMeta.AMEX.VN, before.transferTimeMeta.AMEX.VN);
  assert.deepEqual(doc.transferTimeMeta.ROVE.F9, before.transferTimeMeta.ROVE.F9);
  assert.deepEqual(doc.transferTimeMeta.LIV, before.transferTimeMeta.LIV);
  assert.deepEqual(doc.transferTimes.LIV, { AD: '2 DAYS' });
  assert.equal(doc.transferTimes.ESF, undefined);
  assert.equal(report.coverage.knownBefore, 6);
  assert.equal(report.coverage.verifiedKnown, 3);
  assert.equal(report.coverage.retainedKnown, 3);
  assert.equal(report.changed, true);
  assert.equal(report.ok, false, 'previously known covered routes need review when unverifiable');
  assert.deepEqual(report.missingKnown.map(({ bank, code, reason }) => ({ bank, code, reason })), [
    { bank: 'AMEX', code: 'VN', reason: 'not-observed' },
    { bank: 'ROVE', code: 'F9', reason: 'unknown' },
    { bank: 'LIV', code: 'AD', reason: 'source-not-covered' },
  ]);
  assert.deepEqual(doc.directory, before.directory, 'time refresh must not rewrite ratios or membership');
});

test('failed source or redesigned empty table preserves every value and verification date', async () => {
  for (const fetchImpl of [async () => { throw new Error('offline'); }, async () => new Response('Unavailable', { status: 503 }), async () => new Response('<html>new page shell</html>')]) {
    const original = input();
    const { doc, report } = await refreshTransferTimes(original, { fetchImpl, now });
    assert.deepEqual(doc, original);
    assert.equal(report.changed, false);
    assert.equal(report.ok, false);
    assert.equal(report.sources[0].status, 'failed');
    assert.equal(report.coverage.verifiedKnown, 0);
    assert.equal(report.missingKnown.length, 6);
  }
});

test('a same-day repeat with identical evidence is idempotent', async () => {
  const original = input();
  original.transferTimes = { AMEX: { AF: 'INSTANT' } };
  delete original.transferTimeMeta;
  const first = await refreshTransferTimes(original, { fetchImpl: liveSnapshot, now });
  const second = await refreshTransferTimes(first.doc, { fetchImpl: liveSnapshot, now });
  assert.equal(first.report.ok, true);
  assert.equal(second.report.changed, false);
  assert.deepEqual(second.doc, first.doc);
});

test('CLI runner writes a report while dry-run preserves the input, then writes a verified update', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'transfer-times-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const partnersPath = path.join(dir, 'partners.json'), reportPath = path.join(dir, 'report.json');
  const original = JSON.stringify(input(), null, 2) + '\n';
  writeFileSync(partnersPath, original);
  const dry = await runTransferTimes({ partnersPath, reportPath, dryRun: true, fetchImpl: liveSnapshot, now });
  assert.equal(readFileSync(partnersPath, 'utf8'), original);
  assert.equal(dry.written, false);
  assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).dryRun, true);
  const saved = await runTransferTimes({ partnersPath, reportPath, fetchImpl: liveSnapshot, now });
  assert.equal(saved.written, true);
  assert.equal(JSON.parse(readFileSync(partnersPath, 'utf8')).transferTimeMeta.AMEX.AF.asOf, '2026-10-13');
  await assert.rejects(runTransferTimes({ partnersPath, reportPath: partnersPath, fetchImpl: liveSnapshot, now }), /must differ/);
});

function directTable(rows) {
  const cells = row => `<tr>${row.map(text => `<td>${text}</td>`).join('')}</tr>`;
  return `<table class="tablepress"><thead><tr><th>Rewards Program</th>
    <th>Amex Transfer Ratio (and transfer time)</th><th>Citi Transfer Ratio (and transfer time)</th>
    </tr></thead><tbody>${rows.map(cells).join('')}</tbody></table>`;
}

const mixedRows = [
  ['Finnair Plus', '1 to 1 via BA (Instant)', ''],
  ['Jet Airways InterMiles', '', '1 to 1 (1 day)'],
  ['British Airways Avios', '', '1 to 1 (Instant)'],
  ['Flying Blue', '1 to 1 (2 days)', '1 to 1 (Instant)'],
  ['Iberia Avios', '1 to 1 via BA (Instant)', ''],
  ['Iberia Avios', '1 to 1 (Unknown)', ''],
  ['Flying Blue', '1 to 1 via BA (1 day)', ''],
];

function directTimeInput() {
  const doc = input();
  const destination = 'Air France / KLM Flying Blue';
  doc.directory.CITI = { air: [[destination, '—']], hotel: [] };
  doc.ratioTiers = { CITI: { [destination]: [
    { cards: 'Strata Premier', ratio: '1000:1000' }, { cards: 'Outros cartões', ratio: '1000:700' },
  ] } };
  doc.transferTimes = { AMEX: { AY: '1 DAY', IB: '3 DAYS' }, CITI: { '9W': '2 DAYS', VN: '1 DAY' } };
  doc.transferTimeMeta = Object.fromEntries(Object.entries(doc.transferTimes).map(([bank, byCode]) => [
    bank, Object.fromEntries(Object.keys(byCode).map(code => [code, { source: sourceUrl, asOf: '2026-08-01', estimate: true }])),
  ]));
  return doc;
}

test('inline indirect cells are reported for removal only when the source never lists a direct cell', () => {
  for (const rows of [mixedRows, [...mixedRows].reverse()]) {
    const { times, indirect, unparsed, conflicts } = parseFmTransferTimes(directTable(rows));
    assert.equal(times.AMEX?.AY, undefined);
    assert.equal(times.AMEX?.AF, '2 DAYS');
    assert.equal(times.AMEX?.IB, undefined);
    assert.deepEqual(indirect, [{ bank: 'AMEX', code: 'AY' }]);
    assert.deepEqual(conflicts, []);
    assert.ok(unparsed.some(row => row.code === 'IB' && row.reason === 'unknown'));
  }
});

test('healthy refresh removes saved indirect and non-Citi partners with their metadata, even when unobserved', async () => {
  const { doc, report } = await refreshTransferTimes(directTimeInput(), {
    fetchImpl: async () => new Response(directTable(mixedRows)), now,
  });
  assert.deepEqual(doc.transferTimes, { AMEX: { AF: '2 DAYS', IB: '3 DAYS' }, CITI: { AF: 'INSTANT' } });
  assert.deepEqual(Object.keys(doc.transferTimeMeta.AMEX).sort(), ['AF', 'IB']);
  assert.deepEqual(Object.keys(doc.transferTimeMeta.CITI), ['AF']);
  assert.equal(doc.transferTimeMeta.AMEX.IB.asOf, '2026-08-01');
  assert.deepEqual(report.missingKnown.map(row => row.code), ['IB']);
  assert.deepEqual(report.verified.map(row => row.code), ['AF', 'AF']);
  assert.deepEqual(report.changes.filter(row => row.after === null).map(row => row.code).sort(), ['9W', 'AY', 'VN']);
  assert.equal(report.coverage.knownBefore, 4);
  assert.equal(report.coverage.verifiedKnown, 0);
  assert.equal(report.coverage.removedKnown, 3);
  assert.equal(report.coverage.byBank.CITI.verifiedKnown, 0);
  assert.equal(report.coverage.byBank.CITI.removedKnown, 2);
  const repeated = await refreshTransferTimes(doc, { fetchImpl: async () => new Response(directTable(mixedRows)), now });
  assert.deepEqual(repeated.doc, doc);
  assert.equal(repeated.report.changed, false);
});

test('an unusable source cannot delete saved estimates, including stale Citi and inline indirect rows', async () => {
  for (const response of [new Response('offline', { status: 503 }), new Response(directTable([mixedRows[0]]))]) {
    const original = directTimeInput();
    const { doc, report } = await refreshTransferTimes(original, { fetchImpl: async () => response, now });
    assert.deepEqual(doc, original);
    assert.deepEqual(report.changes, []);
    assert.equal(report.coverage.removedKnown, 0);
    assert.equal(report.coverage.retainedKnown, 4);
    assert.equal(report.sources[0].status, 'failed');
  }
});
