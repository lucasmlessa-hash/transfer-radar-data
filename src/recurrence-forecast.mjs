import {monthlyWindows} from './forecast-windows.mjs';
// Daily recurrent-event survival model. The outcome is a NEW campaign start,
// not a campaign overlapping a future month. All effects are fitted jointly;
// there is no annual quota and no manual probability discount after an event.
import {resolveBank,resolvePartner} from './aliases.mjs';
import {parseMDY,deriveHistory} from './history.mjs';

export const RECURRENCE_MODEL_VERSION='recurrence-hazard-v3';
// Fixed before temporal evaluation. Penalties are on standardized covariates;
// flags support registered ablations, not a per-route choice after outcomes.
export const RECURRENCE_DEFAULTS=Object.freeze({
  halfLifeDays:1095,featurePenalty:8,routePenalty:3,bankPenalty:6,partnerPenalty:6,
  maxIterations:480,tolerance:1e-5,useGap:true,useCounts:true,useSeasonality:true,useTrend:true,
});
const DAY=86400000;
const epoch=d=>Math.floor(d.getTime()/DAY);
const date=d=>new Date(d*DAY);
const iso=d=>date(d).toISOString().slice(0,10);
const median=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),m=Math.floor(b.length/2);return b.length%2?b[m]:(b[m-1]+b[m])/2;};
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const clip=(x,a,b)=>Math.max(a,Math.min(b,x));
const sigmoid=x=>x>=0?1/(1+Math.exp(-x)):Math.exp(x)/(1+Math.exp(x));
const softplus=x=>x>0?x+Math.log1p(Math.exp(-x)):Math.log1p(Math.exp(x));
const mdy=d=>`${d.getUTCMonth()+1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;

export function prepareCampaigns(raw,now=new Date()) {
  if(!Number.isFinite(now.getTime()))throw new Error('invalid issue date');
  const cut=epoch(now),groups=new Map();
  for(const entry of raw) {
    const bank=resolveBank(entry.bankName),code=resolvePartner(entry.partnerName);
    const start=parseMDY(entry.startDateRaw),end=parseMDY(entry.endDateRaw),pct=Number(entry.pct);
    const known=entry.knownAt==null?null:new Date(entry.knownAt);
    if(!bank||!code||!start||!end||end<start||!Number.isFinite(pct)||pct<=0||epoch(start)>cut
      ||(known&&(!Number.isFinite(known.getTime())||known>now)))continue;
    const id=`${bank.toLowerCase()}-${code.toLowerCase()}`;
    if(!groups.has(id))groups.set(id,[]);
    const knownAt=known?.toISOString()??null,knownDay=known?epoch(known):epoch(start);
    groups.get(id).push({id,bank,code,start,end,s:epoch(start),e:epoch(end),pct,knownAt,knownDay,
      versions:[{s:epoch(start),e:epoch(end),knownAt,knownDay}]});
  }
  const result=[];
  for(const id of [...groups.keys()].sort()) {
    const windows=groups.get(id).sort((a,b)=>a.s-b.s||a.e-b.e||a.knownDay-b.knownDay||a.pct-b.pct);
    for(const w of windows) {
      const last=result.at(-1);
      // Overlapping archive listings, tiers and extensions are one campaign.
      // Distinct adjacent non-overlapping offers remain distinct events.
      if(last?.id===id&&w.s<=last.e) {
        if(w.e>last.e){last.e=w.e;last.end=w.end;}
        last.pct=Math.max(last.pct,w.pct);
        if(w.knownDay<last.knownDay){last.knownDay=w.knownDay;last.knownAt=w.knownAt;}
        if(!last.versions.some(v=>v.s===w.s&&v.e===w.e&&v.knownAt===w.knownAt))last.versions.push(...w.versions);
      }else result.push({...w});
    }
  }
  return result;
}

function stateAt(route,day,knownThrough=day-1) {
  const versions=[];
  for(const w of route?.windows??[]) {
    if(w.s>=day||w.knownDay>knownThrough)continue;
    versions.push(...w.versions.filter(v=>v.s<day&&v.knownDay<=knownThrough));
  }
  // Rebuild connected campaigns using only versions known at this instant.
  // A later bridge/extension must not join formerly separate periods early.
  versions.sort((a,b)=>a.s-b.s||a.e-b.e||a.knownDay-b.knownDay);
  const ws=[];
  for(const v of versions) {
    const last=ws.at(-1);
    if(last&&v.s<=last.e) {
      last.e=Math.max(last.e,v.e);last.end=date(last.e);last.knownDay=Math.min(last.knownDay,v.knownDay);
    }else ws.push({...v,start:date(v.s),end:date(v.e)});
  }
  const year=date(day).getUTCFullYear(),yearStart=epoch(new Date(Date.UTC(year,0,1))),nextYear=epoch(new Date(Date.UTC(year+1,0,1)));
  const phase=(day-yearStart)/(nextYear-yearStart),last=ws.at(-1);
  const intervals=ws.slice(1).map((w,i)=>w.s-ws[i].s);
  const firstObservation=ws.length?Math.min(...ws.map(w=>Math.max(w.s,w.knownDay))):day;
  const firstYear=date(firstObservation).getUTCFullYear();
  const annual=[];
  for(let y=firstYear+1;y<year;y++)annual.push(ws.filter(w=>date(w.s).getUTCFullYear()===y).length);
  const annualMean=mean(annual);
  const annualVariance=annual.length?mean(annual.map(n=>(n-annualMean)**2)):null;
  const gap=last?day-last.s:null;
  const lastEnd=ws.length?Math.max(...ws.map(w=>w.e)):null;
  return {ws,year,phase,gap,lastEnd,
    nYear:ws.filter(w=>w.s>=yearStart).length,n365:ws.filter(w=>w.s>=day-365).length,
    intervals,annual,annualMean,annualVariance,
    medianGap:median(intervals),recentGap:mean(intervals.slice(-2)),
  };
}

const FEATURE_NAMES=[
  'gap_log','gap_relative','short_gap','long_gap',
  'season_sin','season_cos','season_sin2','season_cos2',
  'trailing_pressure','annual_pressure','next_ordinal','annual_regular_pressure',
  'annual_season_sin','annual_season_cos','historical_frequency','recent_pace',
];
function features(state,options) {
  // Prefix estimates are shrunk toward 2/y only to define covariate scale,
  // never to set a probability. Actual hazards and intercepts are fitted.
  const annual=(state.annualMean??(state.medianGap?365.25/state.medianGap:2));
  const typical=state.medianGap??365.25/(annual||1);
  const gap=state.gap??typical;
  const angle=2*Math.PI*state.phase,sin=Math.sin(angle),cos=Math.cos(angle);
  const seam=Math.sin(Math.PI*state.phase)**2;
  const pressure=(state.nYear-annual*state.phase)/(annual+1)*seam;
  // Revision fixed during development, before reserved temporal evaluation:
  // one complete year has zero empirical variance by construction, not proof
  // of a stable annual quota. Estimate this signal only after repeated years,
  // and shrink it toward no regularity effect until more years accumulate.
  const nYears=state.annual.length;
  const regularity=nYears<2?0:nYears/(nYears+2)/(1+state.annualVariance/(annual+.5));
  const x=[
    Math.log1p(Math.min(gap,1095)/90),clip(Math.log((gap+30)/(typical+30)),-2,2),Math.exp(-gap/30),Math.log1p(Math.max(0,gap-365)/365),
    sin,cos,Math.sin(2*angle),Math.cos(2*angle),
    clip((state.n365-annual)/(annual+1),-2,3),pressure,Math.max(0,state.nYear-1)/(annual+1)*seam,pressure*regularity,
    pressure*sin,pressure*cos,Math.log1p(annual),
    state.recentGap&&state.medianGap?clip(Math.log((state.recentGap+30)/(state.medianGap+30)),-2,2):0,
  ];
  if(!options.useGap)x.fill(0,0,4);
  if(!options.useSeasonality){x.fill(0,4,8);x.fill(0,12,14);}
  if(!options.useCounts)x.fill(0,8,15);
  if(!options.useTrend)x[15]=0;
  return x;
}

const dot=(a,b)=>{let v=0;for(let j=0;j<a.length;j++)v+=a[j]*b[j];return v;};
function fitLogistic(rows,dimension,penalties,initial,options) {
  const objective=beta=>{
    const gradient=new Float64Array(dimension);let value=0,compensation=0;
    const addObjective=term=>{const adjusted=term-compensation,next=value+adjusted;compensation=(next-value)-adjusted;value=next;};
    for(const r of rows) {
      let eta=beta[0];
      for(let j=0;j<r.x.length;j++)eta+=beta[j+1]*r.x[j];
      for(const j of r.groups)eta+=beta[j];
      // At convergence, a Newton-sized step changes a 100k-row objective by
      // less than ordinary accumulation error. Compensated sums keep the
      // Armijo test from rejecting a genuinely improving final step.
      addObjective(r.weight*(softplus(eta)-r.y*eta));
      const error=r.weight*(sigmoid(eta)-r.y);
      gradient[0]+=error;
      for(let j=0;j<r.x.length;j++)gradient[j+1]+=error*r.x[j];
      for(const j of r.groups)gradient[j]+=error;
    }
    for(let j=0;j<dimension;j++){addObjective(.5*penalties[j]*beta[j]*beta[j]);gradient[j]+=penalties[j]*beta[j];}
    return {value,gradient};
  };
  let beta=Float64Array.from(initial),current=objective(beta),iterations=0,converged=false;
  const memory=[];
  for(;iterations<options.maxIterations;iterations++) {
    const gradientNorm=Math.max(...current.gradient.map(Math.abs));
    if(gradientNorm<options.tolerance){converged=true;break;}
    const q=Float64Array.from(current.gradient),alphas=[];
    for(let k=memory.length-1;k>=0;k--) {
      const m=memory[k],a=m.rho*dot(m.s,q);alphas[k]=a;
      for(let j=0;j<dimension;j++)q[j]-=a*m.y[j];
    }
    const last=memory.at(-1),scale=last?dot(last.s,last.y)/dot(last.y,last.y):1;
    const direction=Float64Array.from(q,v=>v*scale);
    for(let k=0;k<memory.length;k++) {
      const m=memory[k],b=m.rho*dot(m.y,direction);
      for(let j=0;j<dimension;j++)direction[j]+=m.s[j]*(alphas[k]-b);
    }
    for(let j=0;j<dimension;j++)direction[j]*=-1;
    let slope=dot(current.gradient,direction);
    if(!(slope<0)){for(let j=0;j<dimension;j++)direction[j]=-current.gradient[j];slope=-dot(current.gradient,current.gradient);memory.length=0;}
    let step=1,next,nextBeta;
    for(let search=0;search<35;search++,step*=.5) {
      nextBeta=Float64Array.from(beta,(v,j)=>v+step*direction[j]);next=objective(nextBeta);
      if(Number.isFinite(next.value)&&next.value<=current.value+1e-4*step*slope)break;
    }
    if(!next||!Number.isFinite(next.value)||next.value>current.value)break;
    const s=Float64Array.from(beta,(v,j)=>nextBeta[j]-v),y=Float64Array.from(beta,(_,j)=>next.gradient[j]-current.gradient[j]);
    const sy=dot(s,y);
    if(sy>1e-12){memory.push({s,y,rho:1/sy});if(memory.length>12)memory.shift();}
    beta=nextBeta;current=next;
  }
  const gradientNorm=Math.max(...current.gradient.map(Math.abs));
  converged ||= gradientNorm<options.tolerance;
  return {coefficients:Array.from(beta),converged,iterations,gradientNorm,objective:current.value};
}

export function fitRecurrenceForecast(raw,now=new Date(),config={}) {
  if(!Number.isFinite(now.getTime()))throw new Error('invalid issue date');
  const options={...RECURRENCE_DEFAULTS,...config},cut=epoch(now),campaigns=prepareCampaigns(raw,now),routes=new Map();
  if(!(options.halfLifeDays>0)||!(options.featurePenalty>0)||!(options.routePenalty>0)||!(options.bankPenalty>0)||!(options.partnerPenalty>0)
    ||!Number.isInteger(options.maxIterations)||options.maxIterations<1||!(options.tolerance>0))throw new Error('invalid recurrence configuration');
  for(const w of campaigns){if(!routes.has(w.id))routes.set(w.id,{id:w.id,bank:w.bank,code:w.code,windows:[]});routes.get(w.id).windows.push(w);}
  const groupIndices=new Map(),penalties=[.001,...FEATURE_NAMES.map(()=>options.featurePenalty)];
  for(const route of routes.values())for(const [kind,value,penalty] of [['bank',route.bank,options.bankPenalty],['partner',route.code,options.partnerPenalty],['route',route.id,options.routePenalty]]) {
    const key=`${kind}:${value}`;if(!groupIndices.has(key)){groupIndices.set(key,penalties.length);penalties.push(penalty);}
  }
  const rows=[];let exposureDays=0,events=0;
  for(const route of routes.values()) {
    const ws=route.windows;
    const groups=[groupIndices.get(`bank:${route.bank}`),groupIndices.get(`partner:${route.code}`),groupIndices.get(`route:${route.id}`)];
    // Backfilling an earlier campaign later cannot erase the exposure that
    // was already observed through other campaign records.
    const start=Math.min(...ws.map(w=>Math.max(w.s,w.knownDay)))+1;
    for(let day=start;day<cut;day++) {
      // A start is an event, and the same campaign's remaining active days are
      // not extra opportunities for another start. The unfinished final wait
      // contributes all observed event-free days (right censoring). Risk-set
      // membership describes the retrospectively observed process, not an
      // input available before a start; predictors below still honor knownAt.
      if(ws.some(w=>w.s<day&&w.e>=day))continue;
      const y=Number(ws.some(w=>w.s===day));
      const state=stateAt(route,day);
      if(!state.ws.length)continue;
      const weight=2**(-(cut-day)/options.halfLifeDays);
      rows.push({x:features(state,options),groups,y,weight});exposureDays++;events+=y;
    }
  }
  const rawForLegacy=campaigns.map(w=>({bankName:w.bank,partnerName:w.code,pct:w.pct,startDateRaw:mdy(w.start),endDateRaw:mdy(w.end)}));
  // Canonical airline codes are not all source aliases. Preserve resolvable
  // names when adapting the already deduplicated campaigns for the old UI.
  for(const r of rawForLegacy){const source=raw.find(w=>resolveBank(w.bankName)===r.bankName&&resolvePartner(w.partnerName)===r.partnerName);r.partnerName=source.partnerName;}
  const model={issuedAt:now.toISOString(),cut,options,routes,campaigns,groupIndices,featureNames:FEATURE_NAMES,
    legacy:deriveHistory(now,rawForLegacy),diagnostics:{exposureDays,events,rows:rows.length,exposureBasis:'archive_span_proxy'}};
  if(!rows.length){model.diagnostics.converged=true;model.coefficients=null;return model;}
  const totalWeight=rows.reduce((s,r)=>s+r.weight,0),eventWeight=rows.reduce((s,r)=>s+r.weight*r.y,0);
  const means=FEATURE_NAMES.map((_,j)=>rows.reduce((s,r)=>s+r.weight*r.x[j],0)/totalWeight);
  const scales=FEATURE_NAMES.map((_,j)=>Math.max(.1,Math.sqrt(rows.reduce((s,r)=>s+r.weight*(r.x[j]-means[j])**2,0)/totalWeight)));
  for(const r of rows)r.x=r.x.map((v,j)=>(v-means[j])/scales[j]);
  const initial=Array(penalties.length).fill(0);initial[0]=Math.log((eventWeight+.5)/(totalWeight-eventWeight+.5));
  const solution=fitLogistic(rows,penalties.length,penalties,initial,options);
  model.coefficients=solution.coefficients;model.means=means;model.scales=scales;
  model.diagnostics={...model.diagnostics,...solution,coefficients:undefined};
  return model;
}

export function recurrenceContext(model,identity,at=new Date(model.issuedAt)) {
  const cut=epoch(at),route=model.routes.get(identity.id),state=stateAt(route,cut+.5,Math.min(cut,model.cut)),ws=state.ws;
  const year=date(cut).getUTCFullYear(),nYear=ws.filter(w=>w.start.getUTCFullYear()===year).length;
  const end=ws.length?Math.max(...ws.map(w=>w.e)):null;
  return {campaignsThisYear:nYear,campaignsLast365Days:ws.filter(w=>w.s>=cut-365).length,
    annualMedian:median(state.annual),completeYears:state.annual.length,
    daysSinceLastStart:ws.length?cut-ws.at(-1).s:null,daysSinceLastEnd:end!==null&&end<cut?cut-end:null,
    medianIntervalDays:median(state.intervals),recentIntervalsDays:state.intervals.slice(-2),nextCampaignOrdinal:nYear+1};
}

export function predictRecurrenceForecast(model,identity) { return predictWindows(model,identity,false); }
export function predictMonthlyRecurrenceForecast(model,identity) { return predictWindows(model,identity,true); }
function predictWindows(model,identity,monthly) {
  if(!model.coefficients)return null;
  if(!model.diagnostics.converged)throw new Error('recurrence solver did not converge; refusing an unstable forecast');
  const route=model.routes.get(identity.id),ws=route?.windows??[];
  const groups=[`bank:${identity.bank}`,`partner:${identity.code}`,`route:${identity.id}`].map(k=>model.groupIndices.get(k)).filter(j=>j!==undefined);
  const windows=monthly?monthlyWindows(model.issuedAt):[[1,30],[3,90],[6,180]].map(([months,days])=>({months,days,startDate:iso(model.cut+1),endDate:iso(model.cut+days)}));
  let logSurvival=0;const horizonProbabilities=new Map();
  for(let ahead=1;ahead<=windows.at(-1).days;ahead++) {
    const day=model.cut+ahead;
    const state=stateAt(route,day,model.cut);
    if(!ws.some(w=>w.s<=model.cut&&w.e>=day)) {
      const x=features(state,model.options);let eta=model.coefficients[0];
      for(let j=0;j<x.length;j++)eta+=model.coefficients[j+1]*(x[j]-model.means[j])/model.scales[j];
      for(const j of groups)eta+=model.coefficients[j];
      logSurvival-=softplus(eta);
    }
    if(windows.some(w=>w.days===ahead))horizonProbabilities.set(ahead,-Math.expm1(logSurvival));
  }
  const first=ws[0],last=ws.length?Math.max(...ws.map(w=>Math.min(w.e,model.cut))):null;
  const spanMonths=first?date(last).getUTCFullYear()*12+date(last).getUTCMonth()-first.start.getUTCFullYear()*12-first.start.getUTCMonth()+1:0;
  // Context is anchored on the issuance day, rather than tomorrow's covariate
  // state: on 31 December the label must still describe the outgoing year.
  return {modelVersion:monthly?'recurrence-hazard-v4':RECURRENCE_MODEL_VERSION,issuedAt:model.issuedAt,target:'campaign_start',horizonMode:monthly?'rolling_months':'rolling_days',
    evidence:{windowCount:ws.length,firstDate:first?iso(first.s):null,lastDate:last==null?null:iso(last),spanMonths,
      level:ws.length>=6&&spanMonths>=24?'established_history':'limited'},
    context:recurrenceContext(model,identity),
    horizons:windows.map(window=>({...window,
      probability:clip(Math.round(horizonProbabilities.get(window.days)*1000)/1000,.001,.999)}))};
}

export function deriveRecurrenceHistory(raw,now=new Date(),model=fitRecurrenceForecast(raw,now)) {
  return new Map([...model.legacy].map(([id,history])=>{
    const forecast=predictRecurrenceForecast(model,{id,bank:history.bank,code:history.code});
    return [id,forecast?{...history,forecast,wait:forecast.horizons.map(h=>h.probability)}:history];
  }));
}
