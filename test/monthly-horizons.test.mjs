import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fitRecurrenceForecast,predictRecurrenceForecast,predictMonthlyRecurrenceForecast} from '../src/recurrence-forecast.mjs';
import {monthlyWindows} from '../src/forecast-windows.mjs';
const rows=[];for(let y=2017;y<=2026;y++)for(const m of [3,9])rows.push({bankName:'Chase',partnerName:'Aeroplan',pct:20,startDateRaw:`${m}/1/${y}`,endDateRaw:`${m}/20/${y}`});
test('monthly horizons use calendar anniversaries, clamping short months and leap years',()=>{
 for(const [issued,ends] of [['2026-11-02',['2026-12-02','2027-01-02','2027-02-02']],['2027-01-31',['2027-02-28','2027-03-31','2027-04-30']],['2024-01-31',['2024-02-29','2024-03-31','2024-04-30']]]) {
  const ws=monthlyWindows(issued+'T12:00:00Z');assert.deepEqual(ws.map(w=>w.months),[1,2,3]);assert.deepEqual(ws.map(w=>w.endDate),ends);
  for(const w of ws)assert.equal(w.days,(Date.parse(w.endDate)-Date.parse(issued))/86400000);
 }
});
test('monthly forecasts integrate the same daily hazards at the new dates without changing the legacy forecast',()=>{
 const m=fitRecurrenceForecast(rows,new Date('2026-11-02T13:00:00Z')),id={id:'chase-ac',bank:'CHASE',code:'AC'};
 const old=predictRecurrenceForecast(m,id), f=predictMonthlyRecurrenceForecast(m,id);
 assert.equal(f.modelVersion,'recurrence-hazard-v4');assert.equal(f.horizonMode,'rolling_months');
 assert.deepEqual(f.horizons.map(w=>w.days),[30,61,92]);assert.deepEqual(f.horizons.map(w=>w.months),[1,2,3]);
 assert.equal(f.horizons[0].probability,old.horizons[0].probability);
 assert.ok(f.horizons[1].probability>=f.horizons[0].probability&&f.horizons[1].probability<=old.horizons[1].probability);
 assert.ok(f.horizons[2].probability>=old.horizons[1].probability);
 assert.deepEqual(predictRecurrenceForecast(m,id),old);
});

import {updateForecastRecords,confirmForecastPublication} from '../src/forecast-records.mjs';
test('monthly issuance preserves old records and confirms the two-month artifact exactly',()=>{
 const at='2026-11-02T13:00:00Z',id={id:'chase-ac',bank:'CHASE',code:'AC'};
 const model=fitRecurrenceForecast(rows,new Date(at)),old=predictRecurrenceForecast(model,id);
 const feed={generatedAt:at,routes:[{...id,airline:'Aeroplan',forecast:old}],health:{sources:{frequentmiler:{status:'ok'},awardwallet:{status:'ok'}}}};
 const prior=confirmForecastPublication(updateForecastRecords(null,feed),feed,'2026-11-02T13:01:00Z');
 feed.routes[0].monthlyCampaignForecast=predictMonthlyRecurrenceForecast(model,id);
 const updated=updateForecastRecords(prior,feed);
 for(const r of prior.records)assert.deepEqual(updated.records.find(x=>x.key===r.key),r);
 const changed=structuredClone(feed);changed.routes[0].monthlyCampaignForecast.horizons[1].endDate='2027-01-03';
 const partial=confirmForecastPublication(updated,changed,'2026-11-02T13:02:00Z');
 assert.equal(partial.records.find(r=>r.months===2).publicationStatus,'unconfirmed');
 const confirmed=confirmForecastPublication(updated,feed,'2026-11-02T13:02:00Z');
 assert.equal(confirmed.records.find(r=>r.months===2).publicationStatus,'confirmed');
});
