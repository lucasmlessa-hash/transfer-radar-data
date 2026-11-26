import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { POINTS_FROG_AIRLINES as source } from '../src/sources/points-frog-airlines.mjs';
const input=readFileSync(new URL('../fixtures/valuations-points-frog-airlines.html',import.meta.url),'utf8');
test('the dated USD travel redemption ranking covers known airlines with one representative Avios row',()=>{
  const result=source.parse(input);
  assert.deepEqual(result.missingCodes,[]);
  for(const [code,value] of Object.entries({BR:1.4,BA:1.3,HU:.5,SK:1.1,VN:.5,AI:.6})) {
    assert.equal(result.values[code],value);
    assert.equal(result.dates[code],'2026-10-13');
  }
  assert.equal(result.values.ACCOR,undefined);
});
test('rejects invalid dates, ambiguous tables and a non-redemption unit',()=>{
  for(const html of [input.replaceAll('2026-10-13','2026-02-30'),input+input,input.replace('estimated redemption value per point','purchase price per point')]) {
    assert.throws(()=>source.parse(html));
  }
  assert.ok(source.parse(input.replaceAll('per mile','pence/mile')).missingCodes.includes('BR'));
});
