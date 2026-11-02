import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fitRecurrenceForecast,predictRecurrenceForecast,deriveRecurrenceHistory,prepareCampaigns,recurrenceContext} from '../src/recurrence-forecast.mjs';

const at=new Date('2026-11-02T13:00:00Z');
const identity={id:'chase-ac',bank:'CHASE',code:'AC'};
const mdy=d=>`${d.getUTCMonth()+1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
const row=(start,end=start,bankName='Chase',partnerName='Aeroplan')=>({bankName,partnerName,pct:20,startDateRaw:start,endDateRaw:end});
const regular=[];
for(let year=2017;year<=2026;year++)for(const month of [3,9])regular.push(row(`${month}/1/${year}`,`${month}/20/${year}`));

test('recurrence predicts new starts in nested rolling-day windows with recorded context',()=>{
  const model=fitRecurrenceForecast(regular,at);
  const f=predictRecurrenceForecast(model,identity);
  assert.equal(f.target,'campaign_start');assert.equal(f.horizonMode,'rolling_days');
  assert.deepEqual(f.horizons.map(h=>[h.months,h.days,h.startDate,h.endDate]),[
    [1,30,'2026-11-03','2026-12-02'],[3,90,'2026-11-03','2027-01-31'],[6,180,'2026-11-03','2027-05-01'],
  ]);
  const ps=f.horizons.map(h=>h.probability);
  assert.ok(ps.every(p=>Number.isFinite(p)&&p>0&&p<1));assert.ok(ps[0]<=ps[1]&&ps[1]<=ps[2]);
  assert.equal(f.context.campaignsThisYear,2);assert.equal(f.context.campaignsLast365Days,2);
  assert.equal(f.context.annualMedian,2);assert.equal(f.context.completeYears,8);
  assert.equal(f.context.daysSinceLastStart,62);assert.equal(f.context.daysSinceLastEnd,43);
  assert.equal(f.context.nextCampaignOrdinal,3);
  assert.equal(model.diagnostics.converged,true);
});

test('future campaigns and facts only learned after issuance cannot change the forecast',()=>{
  const f=predictRecurrenceForecast(fitRecurrenceForecast(regular,at),identity);
  const extra=[row('12/1/2026','12/20/2026'),{...row('10/1/2026','10/20/2026'),knownAt:'2026-11-03T00:00:00Z'}];
  assert.deepEqual(predictRecurrenceForecast(fitRecurrenceForecast([...regular,...extra],at),identity),f);
});

test('duplicates and overlapping extensions are a single campaign',()=>{
  const duplicate=predictRecurrenceForecast(fitRecurrenceForecast([...regular,...regular],at),identity);
  assert.deepEqual(duplicate,predictRecurrenceForecast(fitRecurrenceForecast(regular,at),identity));
  const campaigns=prepareCampaigns([row('8/1/2026','8/31/2026'),row('8/15/2026','9/10/2026'),row('8/1/2026','8/20/2026')],at);
  assert.equal(campaigns.length,1);assert.equal(campaigns[0].start.toISOString().slice(0,10),'2026-08-01');
  assert.equal(campaigns[0].end.toISOString().slice(0,10),'2026-09-10');
});

test('a known ongoing campaign counts now and remains a single event across new year',()=>{
  const f=predictRecurrenceForecast(fitRecurrenceForecast([...regular,row('10/30/2026','1/5/2027')],at),identity);
  assert.equal(f.context.campaignsThisYear,3);assert.equal(f.context.daysSinceLastStart,3);
  assert.equal(f.context.daysSinceLastEnd,null);assert.equal(f.context.nextCampaignOrdinal,4);
  assert.ok(f.horizons[0].probability<.01,'ongoing campaign cannot be counted as a new campaign');
});

test('open waiting time supplies censored exposure, empty archive cannot fabricate estimates',()=>{
  assert.equal(predictRecurrenceForecast(fitRecurrenceForecast([],at),identity),null);
  const first=fitRecurrenceForecast(regular,new Date('2026-10-02T00:00:00Z'));
  const later=fitRecurrenceForecast(regular,at);
  assert.ok(later.diagnostics.exposureDays>first.diagnostics.exposureDays);
  assert.equal(later.diagnostics.events,first.diagnostics.events);
  const unknown=predictRecurrenceForecast(later,{id:'c1-jl',bank:'C1',code:'JL'});
  assert.equal(unknown.evidence.windowCount,0);assert.ok(unknown.horizons.every(h=>h.probability>0&&h.probability<1));
});

test('legacy route history remains available while probabilities have the new target',()=>{
  const route=deriveRecurrenceHistory(regular,at).get(identity.id);
  assert.equal(route.hist.length,20);assert.equal(route.forecast.target,'campaign_start');
  assert.deepEqual(route.wait,route.forecast.horizons.map(h=>h.probability));
});

test('a late first observation does not manufacture complete years of exposure',()=>{
  const raw=[{...row('1/1/2014','1/5/2014'),knownAt:'2026-10-01T00:00:00Z'}];
  const model=fitRecurrenceForecast(raw,at),f=predictRecurrenceForecast(model,identity);
  assert.equal(model.diagnostics.exposureDays,31);
  assert.equal(f.context.completeYears,0);assert.equal(f.context.annualMedian,null);
});

test('an unconverged optimization cannot silently produce a public probability',()=>{
  const model=fitRecurrenceForecast(regular,at,{maxIterations:1});
  assert.equal(model.diagnostics.converged,false);
  assert.throws(()=>predictRecurrenceForecast(model,identity),/converg/i);
});

test('learned regularity distinguishes a third campaign pattern from a two-campaign pattern',()=>{
  const twice=[],three=[];
  for(let year=2014;year<=2026;year++) {
    for(const month of[3,9])twice.push(row(`${month}/1/${year}`,`${month}/5/${year}`));
    for(const month of[3,9,12])three.push(row(`${month}/1/${year}`,`${month}/5/${year}`));
  }
  const a=predictRecurrenceForecast(fitRecurrenceForecast(twice,at),identity);
  const b=predictRecurrenceForecast(fitRecurrenceForecast(three,at),identity);
  assert.equal(a.context.campaignsThisYear,2);assert.equal(b.context.campaignsThisYear,2);
  assert.ok(a.horizons[1].probability<.25,'regular twice-yearly process is quiet after its second event');
  assert.ok(b.horizons[1].probability>.75,'history with a third campaign must not inherit a hard quota of two');
});

test('passing January 1 does not refill an annual quota',()=>{
  const december=predictRecurrenceForecast(fitRecurrenceForecast(regular,new Date('2026-12-31T12:00:00Z')),identity);
  const january=predictRecurrenceForecast(fitRecurrenceForecast(regular,new Date('2027-01-01T12:00:00Z')),identity);
  assert.equal(december.context.campaignsThisYear,2);assert.equal(january.context.campaignsThisYear,0);
  assert.equal(january.context.campaignsLast365Days,2);
  assert.ok(Math.abs(december.horizons[0].probability-january.horizons[0].probability)<.025);
});

test('an overlapping correction cannot backdate what was known about campaign start',()=>{
  const raw=[...regular,row('10/10/2026','10/31/2026'),{
    ...row('10/1/2026','10/31/2026'),knownAt:'2026-10-20T12:00:00Z',
  }];
  const model=fitRecurrenceForecast(raw,at);
  const before=recurrenceContext(model,identity,new Date('2026-10-15T12:00:00Z'));
  const after=recurrenceContext(model,identity,new Date('2026-10-25T12:00:00Z'));
  assert.equal(before.daysSinceLastStart,5,'October 1 only became known on October 20');
  assert.equal(after.daysSinceLastStart,24);
  assert.equal(before.campaignsThisYear,3);assert.equal(after.campaignsThisYear,3);
});

test('independent event data do not acquire a quota after two or more campaigns',()=>{
  let seed=414;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const raw=[];
  for(const[bank,partner]of[['Chase','Aeroplan'],['Amex','Air France'],['Citi','Avianca'],['Capital One','British Airways']]) {
    for(let day=Date.UTC(2000,0,1);day<Date.UTC(2026,10,2);day+=86400000) {
      if(random()>=2/365)continue;
      const d=mdy(new Date(day));raw.push(row(d,d,bank,partner));
    }
  }
  const model=fitRecurrenceForecast(raw,at);
  const chase=predictRecurrenceForecast(model,identity);
  const amex=predictRecurrenceForecast(model,{id:'amex-af',bank:'AMEX',code:'AF'});
  assert.equal(chase.context.campaignsThisYear,2);assert.equal(amex.context.campaignsThisYear,5);
  // The generating daily hazard is constant, with ~39% probability in 90d.
  // A broad tolerance allows finite history without licensing a quota effect.
  assert.ok(chase.horizons[1].probability>.2&&chase.horizons[1].probability<.7);
  assert.ok(amex.horizons[1].probability>.2&&amex.horizons[1].probability<.7);
});

test('late backfill of an older campaign does not erase already observed exposure',()=>{
  const original=fitRecurrenceForecast(regular,at);
  const backfill=fitRecurrenceForecast([...regular,{...row('1/1/2014','1/5/2014'),knownAt:'2026-10-01T00:00:00Z'}],at);
  assert.equal(backfill.diagnostics.exposureDays,original.diagnostics.exposureDays);
  assert.equal(backfill.diagnostics.events,original.diagnostics.events);
  assert.equal(predictRecurrenceForecast(backfill,identity).context.completeYears,8);
});

test('a later extension cannot merge historically separate campaigns before it was known',()=>{
  const raw=[{...row('3/1/2026','3/10/2026'),knownAt:'2026-03-01T00:00:00Z'},
    {...row('5/1/2026','5/10/2026'),knownAt:'2026-05-01T00:00:00Z'},
    {...row('3/5/2026','5/5/2026'),knownAt:'2026-06-01T00:00:00Z'}];
  const model=fitRecurrenceForecast(raw,at);
  const before=recurrenceContext(model,identity,new Date('2026-05-15T12:00:00Z'));
  const after=recurrenceContext(model,identity,new Date('2026-06-15T12:00:00Z'));
  assert.equal(before.campaignsThisYear,2);assert.equal(before.daysSinceLastStart,14);
  assert.equal(after.campaignsThisYear,1);assert.equal(after.daysSinceLastStart,106);
});

test('one complete year cannot teach an annual regularity effect',()=>{
  const raw=[];
  for(let year=2024;year<=2026;year++)for(const month of[3,9])raw.push(row(`${month}/1/${year}`,`${month}/5/${year}`));
  const model=fitRecurrenceForecast(raw,at);
  const feature=model.featureNames.indexOf('annual_regular_pressure');
  assert.equal(recurrenceContext(model,identity).completeYears,1);
  assert.equal(model.means[feature],0,'one annual count cannot estimate between-year variation');
  assert.equal(model.coefficients[feature+1],0,'unidentified regularity must contribute no fitted effect');
});

test('repeated complete years enable a regularity signal without treating it as certainty',()=>{
  const raw=[];
  for(let year=2022;year<=2026;year++)for(const month of[3,9])raw.push(row(`${month}/1/${year}`,`${month}/5/${year}`));
  const model=fitRecurrenceForecast(raw,at);
  const pressure=model.featureNames.indexOf('annual_pressure'),regularity=model.featureNames.indexOf('annual_regular_pressure');
  assert.ok(model.means[regularity]>0,'repeated stable years should supply a regularity signal');
  assert.ok(model.means[regularity]<model.means[pressure]/2,'short repeated history still shrinks the signal substantially');
});
