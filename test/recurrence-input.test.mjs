import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as observed from '../src/observed.mjs';

const sighting = (startDate, status='observed') => ({id:'chase-ac',bank:'CHASE',code:'AC',
  active:{pct:20,startDate,endDate:'2026-09-30'},offerEvidence:{status}});

test('the observed archive preserves an explicit campaign start separately from discovery', () => {
  const rows=observed.updateLedger([], [sighting('2026-08-12')], '2026-08-20');
  assert.equal(rows[0].startDate,'2026-08-12');
  assert.equal(rows[0].firstSeen,'2026-08-20');
  assert.equal(rows[0].startKnownAt,'2026-08-20');
  const later=observed.updateLedger(rows,[sighting('2026-08-12')],'2026-08-21');
  assert.equal(later[0].startKnownAt,'2026-08-20');
});

test('recurrence training never turns discovery date or conflicting dates into campaign starts', () => {
  const unknown=observed.updateLedger([], [sighting(undefined)], '2026-08-20');
  const conflict=observed.updateLedger([], [sighting('2026-08-12','conflict')], '2026-08-20');
  assert.deepEqual(observed.toRecurrenceWindows(unknown),[]);
  assert.deepEqual(observed.toRecurrenceWindows(conflict),[]);
});

test('a verified start reaches recurrence training with its information date', () => {
  const rows=observed.updateLedger([], [sighting('2026-08-12')], '2026-08-20');
  assert.deepEqual(observed.toRecurrenceWindows(rows),[{
    bankName:'CHASE',partnerName:'AC',pct:20,startDateRaw:'8/12/2026',endDateRaw:'9/30/2026',knownAt:'2026-08-20T00:00:00.000Z',
  }]);
  const archived=[{bankName:'Chase',partnerName:'Aeroplan',pct:20,startDateRaw:'8/12/2026',endDateRaw:'9/30/2026'}];
  assert.deepEqual(observed.toRecurrenceWindows(rows,archived),[]);
});
