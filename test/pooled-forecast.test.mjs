import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fitPooledForecast,predictPooledForecast,derivePooledHistory} from '../src/pooled-forecast.mjs';
import {normalize} from '../src/normalize.mjs';
const asOf=new Date('2026-11-01T10:00:00Z');
const row=(bankName,partnerName,y,m)=>({bankName,partnerName,pct:30,startDateRaw:`${m}/5/${y}`,endDateRaw:`${m}/20/${y}`});
const raw=[];for(let y=2018;y<=2026;y++) for(const m of [3,9]) raw.push(row('Chase','British Airways',y,m),row('Amex','Air France',y,m));
raw.push(row('Capital One','Japan Airlines',2026,9));
test('short history receives pooled numeric probabilities and nested horizons',()=>{
  const fitted=fitPooledForecast(raw,asOf);
  const f=predictPooledForecast(fitted,{id:'c1-jl',bank:'C1',code:'JL'});
  assert.equal(f.modelVersion,'pooled-recurrence-v2');assert.equal(f.horizons.length,3);
  const p=f.horizons.map(h=>h.probability);
  assert.ok(p.every(x=>Number.isFinite(x)&&x>0&&x<1));assert.ok(p[0]<=p[1]&&p[1]<=p[2]);
  assert.ok(p[0]<.8,'one recent campaign is not 95% monthly confidence');
  assert.equal(f.horizons[2].endDate,'2027-05-31');
  assert.equal(f.evidence.windowCount,1);
});
test('future and still-running campaigns cannot alter the fitted model',()=>{
  const identity={id:'chase-ba',bank:'CHASE',code:'BA'};
  const before=predictPooledForecast(fitPooledForecast(raw,asOf),identity);
  const future=[row('Chase','British Airways',2027,1),{...row('Chase','British Airways',2026,10),endDateRaw:'11/10/2026'}];
  assert.deepEqual(predictPooledForecast(fitPooledForecast([...raw,...future],asOf),identity),before);
});
test('duplicate archive entries do not increase estimates or evidence',()=>{
  const identity={id:'chase-ba',bank:'CHASE',code:'BA'};
  assert.deepEqual(predictPooledForecast(fitPooledForecast([...raw,...raw],asOf),identity),predictPooledForecast(fitPooledForecast(raw,asOf),identity));
});
test('a new supported pair can borrow peer history, but an empty archive is not fake evidence',()=>{
  assert.equal(predictPooledForecast(fitPooledForecast([],asOf),{id:'x',bank:'C1',code:'JL'}),null);
  const f=predictPooledForecast(fitPooledForecast(raw,asOf),{id:'c1-ba',bank:'C1',code:'BA'});
  assert.equal(f.evidence.windowCount,0);assert.ok(f.horizons.every(h=>h.probability>0));
});
test('a one-campaign route survives normalization with a numerical forecast',()=>{
  const history=derivePooledHistory(raw,asOf);
  const route=normalize([],asOf,history).routes.find(r=>r.id==='c1-jl');
  assert.ok(route,'short histories must appear in the forecast feed');
  assert.equal(route.forecast.modelVersion,'pooled-recurrence-v2');
  assert.deepEqual(route.wait,route.forecast.horizons.map(h=>h.probability));
  assert.equal(route.hist.length,1);
});
