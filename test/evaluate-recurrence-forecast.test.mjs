import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildRecurrenceCases, scoreRecurrence, recurrenceEvaluationSlices} from '../scripts/evaluate-recurrence-forecast.mjs';

const event=(start,end=start)=>({bankName:'Chase',partnerName:'Aeroplan',pct:20,startDateRaw:start,endDateRaw:end});

test('rolling outcomes count starts, retain nested day horizons and only score mature windows',()=>{
  const raw=[event('1/1/2023'),event('3/1/2024','4/30/2024')];
  const rows=buildRecurrenceCases(raw,{cuts:['2024-01-31'],asOf:'2024-07-31'});
  assert.deepEqual(rows.map(r=>[r.days,r.startDate,r.endDate,r.y]),[
    [30,'2024-02-01','2024-03-01',1],[90,'2024-02-01','2024-04-30',1],[180,'2024-02-01','2024-07-29',1],
  ]);
  assert.deepEqual(buildRecurrenceCases(raw,{cuts:['2024-01-31'],asOf:'2024-03-01'}),[]);
  assert.equal(buildRecurrenceCases(raw,{cuts:['2024-01-31'],asOf:'2024-03-02'}).length,1);
});

test('a campaign already in progress is excluded from evaluation at issue',()=>{
  const raw=[event('1/1/2023'),event('1/15/2024','2/15/2024')];
  assert.deepEqual(buildRecurrenceCases(raw,{cuts:['2024-01-31'],asOf:'2024-08-01'}),[]);
});

test('future starts affect outcomes but cannot affect context or the training archive',()=>{
  const raw=[event('1/1/2023'),event('6/1/2023'),event('1/20/2024'),event('3/1/2024')];
  const [r]=buildRecurrenceCases(raw,{cuts:['2024-01-31'],asOf:'2024-08-01'});
  assert.equal(r.campaignsThisYear,1);
  assert.equal(r.nextCampaignOrdinal,2);
  assert.equal(r.daysSinceLastStart,11);
  assert.equal(r.trainRaw.length,3);
  const withFuture=buildRecurrenceCases([...raw,event('1/1/2027')],{cuts:['2024-01-31'],asOf:'2024-08-01'});
  assert.deepEqual(withFuture[0],r);
});

test('an extension is one event and cannot manufacture annual frequency',()=>{
  const raw=[event('1/1/2023'),event('1/10/2024','1/15/2024'),event('1/10/2024','1/20/2024')];
  const [r]=buildRecurrenceCases(raw,{cuts:['2024-01-31'],asOf:'2024-08-01'});
  assert.equal(r.campaignsThisYear,1);
  assert.equal(r.y,0);
});

test('probability scores use squared error and distinguish calibration from accuracy',()=>{
  const rows=[{p:.2,y:0},{p:.8,y:1}];
  const s=scoreRecurrence(rows,'p');
  assert.ok(Math.abs(s.brier-.04)<1e-12);
  assert.ok(Math.abs(s.logLoss+Math.log(.8))<1e-12);
  assert.equal(s.predicted,.5);
  assert.equal(s.observed,.5);
  assert.equal(s.n,2);
});

test('an issue after two campaigns is not evidence of a third campaign in the same year when the horizon crosses January',()=>{
  const raw=[event('1/1/2023'),event('3/1/2024'),event('8/1/2024'),event('1/15/2025')];
  const rows=buildRecurrenceCases(raw,{cuts:['2024-12-01'],asOf:'2025-07-01'});
  const slices=recurrenceEvaluationSlices(rows);
  assert.equal(slices.afterTwoAtIssue.length,3);
  assert.equal(slices.sameYearAfterTwo.length,1);
  assert.equal(slices.sameYearAfterTwo[0].y,0);
  assert.equal(slices.afterTwoAtIssue.filter(r=>r.y).length,2);
});
