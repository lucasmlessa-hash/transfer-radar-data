import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { refreshPointValuations } from '../scripts/refresh-point-valuations.mjs';

function setup(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'valuation-mean-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const partnersPath = path.join(dir, 'partners.json');
  const input = JSON.parse(readFileSync(new URL('../fixtures/partners-audit-2026-10.json', import.meta.url)));
  writeFileSync(partnersPath, JSON.stringify(input));
  return {read: () => JSON.parse(readFileSync(partnersPath)), run: (sources, day='2026-11-26') =>
    refreshPointValuations({partnersPath, sources, now: new Date(day+'T14:00Z'), sleepImpl:async()=>{}, log() {}})};
}
function publisher(id, value, date, maxAgeDays = 35) {
  return {id, name:id, url:'https://'+id+'.example/value', codes:['BA','IB'], maxAgeDays,
    async collect() {return {values:{BA:value,IB:value}, dates:{BA:date,IB:date}, missingCodes:[]};}};
}
test('averages each dated publisher once, applies equal Avios base, and excludes stale or future editions', async t => {
  const f=setup(t);
  const a=publisher('one',1.1,'2026-10-08',90), b=publisher('two',1.35,'2026-11-01');
  const repeat={...a, id:'one-duplicate', url:a.url+'/other'};
  await f.run([a,b,repeat,publisher('old',4,'2026-10-01'),publisher('future',5,'2026-11-27')]);
  const doc=f.read();
  assert.equal(doc.airlineValues.BA,1.225);
  assert.deepEqual(doc.airlineValueMeta.BA,doc.airlineValueMeta.IB);
  assert.equal(doc.airlineValueMeta.BA.sources.length,2);
  assert.equal(doc.airlineValueMeta.BA.sources[1].validUntil,'2026-12-06');
});
test('temporary outage retains dated observations only through expiry and repeated reads cannot renew an old edition',async t=>{
  const f=setup(t), a=publisher('one',1.25,'2026-11-01'), b=publisher('two',1.35,'2026-11-20');
  await f.run([a,b]);
  a.collect=async()=>{throw new Error('temporary outage');};
  await f.run([a,b],'2026-12-06');
  assert.equal(f.read().airlineValues.BA,1.3);
  await f.run([a,b],'2026-12-07');
  assert.equal(f.read().airlineValues.BA,1.35);
  assert.equal(f.read().airlineValueMeta.BA.sources.length,1);
  await f.run([a,b],'2027-01-06');
  assert.equal(f.read().airlineValues.BA,undefined);
});
