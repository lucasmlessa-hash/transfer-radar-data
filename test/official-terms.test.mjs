import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/normalize.mjs';
import { campaignWindow, windowExpired } from '../src/campaign-terms.mjs';

test('official offer terms never migrate to a different campaign', () => {
  const get = (pct, start, end) => campaignWindow('citi-tk', pct, start, end).terms;
  assert.equal(get(40,'2026-11-01','2026-11-30').bonusCap,50000);
  assert.equal(get(40,'2026-11-02','2026-11-30'),undefined);
  assert.equal(get(35,'2026-11-01','2026-11-30'),undefined);
  assert.equal(get(40,'2027-11-01','2027-11-30'),undefined);
});

test('normalization observes the official local window across UTC midnight', () => {
  const raw = [{bankName:'Rove',partnerName:'Accor',pct:55,endDateRaw:'11/30/2026',sourceUrl:'https://www.rove.com/blog/rove-black-friday'}];
  const at = iso => normalize(raw,new Date(iso),new Map()).routes[0];
  assert.equal(at('2026-11-26T04:59:00Z').upcoming.startDate,'2026-11-26');
  assert.equal(at('2026-12-01T04:59:59Z').active.terms.levels.length,3);
  assert.equal(at('2026-12-01T05:00:00Z').ended.pct,55);
  const tk = campaignWindow('citi-tk',40,'2026-11-01','2026-11-30');
  assert.equal(windowExpired(tk,new Date('2026-11-30T20:59:59Z')),false);
  assert.equal(windowExpired(tk,new Date('2026-11-30T21:00:00Z')),true);
});
