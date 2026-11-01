// Regularized empirical first-bonus distribution. The four categories are
// <=1 month, months 2–3, months 4–6, and no bonus in six months. Cumulative
// probabilities are monotone without assuming independent calendar months.
import {resolveBank,resolvePartner} from './aliases.mjs';
import {parseMDY,deriveHistory} from './history.mjs';
export const POOLED_MODEL_VERSION='pooled-recurrence-v2';
// Fixed before the reserved retrospective evaluation; these are modeling
// assumptions, not fitted confidence levels. See the model protocol report.
export const POOLED_DEFAULTS=Object.freeze({halfLifeMonths:36,routeStrength:5,peerStrength:8,seasonWeight:1,recencyWeight:1,blendLegacy:true});
const ami=d=>d.getUTCFullYear()*12+d.getUTCMonth();
const day=d=>d.toISOString().slice(0,10);
const monthDate=m=>new Date(Date.UTC(Math.floor(m/12),m%12,1));
const bucket=months=>months<=2?0:months<=6?1:months<=12?2:3;
const sum=xs=>xs.reduce((a,b)=>a+b,0);
const normalize=xs=>{const n=sum(xs);return xs.map(x=>x/n);};
function categoricalMass(rows,weights) {
  const mass=[0,0,0,0];for(let i=0;i<rows.length;i++) mass[rows[i].outcome]+=weights[i];return mass;
}
export function fitPooledForecast(raw,now=new Date(),config={}) {
  if (!Number.isFinite(now.getTime())) throw new Error('invalid issue date');
  const options={...POOLED_DEFAULTS,...config}, cut=ami(now), today=day(now), routes=new Map();
  const seen=new Set(), admissible=[];
  for(const entry of raw) {
    const bank=resolveBank(entry.bankName),code=resolvePartner(entry.partnerName);
    const start=parseMDY(entry.startDateRaw),end=parseMDY(entry.endDateRaw);
    if(!bank||!code||!start||!end||end<start||day(end)>=today||!(Number(entry.pct)>0)) continue;
    const id=`${bank.toLowerCase()}-${code.toLowerCase()}`, key=`${id}|${day(start)}|${day(end)}`;
    if(seen.has(key))continue;seen.add(key);admissible.push(entry);
    if(!routes.has(id))routes.set(id,{id,bank,code,windows:[]});
    routes.get(id).windows.push({start,end,s:ami(start),e:ami(end)});
  }
  const rows=[];
  for(const route of routes.values()) {
    route.windows.sort((a,b)=>a.start-b.start||a.end-b.end);
    // Observation begins after the first known campaign, rather than counting
    // its arrival as proof of a high underlying event rate (left truncation).
    const firstEnd=Math.min(...route.windows.map(w=>w.e));
    for(let origin=firstEnd+1;origin+6<cut;origin++) {
      const at=monthDate(origin);
      if(route.windows.some(w=>w.start<=at&&w.end>=at))continue;
      const past=route.windows.filter(w=>w.end<at);
      if(!past.length)continue;
      const lastEnd=Math.max(...past.map(w=>w.e));
      let outcome=3;
      for(let ahead=1;ahead<=6;ahead++) {
        const target=origin+ahead;
        if(route.windows.some(w=>w.s<=target&&w.e>=target)){outcome=ahead<=1?0:ahead<=3?1:2;break;}
      }
      rows.push({id:route.id,bank:route.bank,code:route.code,origin,season:(origin+1)%12,recency:bucket(origin-lastEnd),outcome,
        // Six overlapping starts do not count as six independent six-month
        // windows when deciding how hard to shrink toward peer information.
        weight:Math.pow(.5,(cut-(origin+6))/options.halfLifeMonths)/6});
    }
  }
  return {issuedAt:now.toISOString(),cut,routes,rows,options,legacy:deriveHistory(now,admissible)};
}
export function predictPooledForecast(model,identity) {
  if(!model.rows.length)return null;
  const {rows,options,cut}=model, own=model.routes.get(identity.id), windows=own?.windows??[];
  const lastEnd=windows.length?Math.max(...windows.map(w=>w.e)):null;
  const recency=lastEnd===null?null:bucket(cut-lastEnd), season=(cut+1)%12;
  const weights=rows.map(r=>r.weight*(r.season===season?1:options.seasonWeight)*(recency===null||r.recency===recency?1:options.recencyWeight));
  const peers=[],peerWeights=[],ownRows=[],ownWeights=[],general=[],generalWeights=[];
  for(let i=0;i<rows.length;i++) {
    const r=rows[i];
    if(r.id===identity.id){ownRows.push(r);ownWeights.push(weights[i]);continue;}
    general.push(r);generalWeights.push(weights[i]);
    // The union avoids double-counting a peer that matches both attributes.
    if(r.bank===identity.bank||r.code===identity.code){peers.push(r);peerWeights.push(weights[i]);}
  }
  const globalMass=categoricalMass(general.length?general:rows,general.length?generalWeights:weights);
  const globalRate=normalize(globalMass.map(x=>x+.5)); // Jeffreys smoothing.
  const peerMass=categoricalMass(peers,peerWeights);
  const peerRate=normalize(peerMass.map((x,i)=>x+options.peerStrength*globalRate[i]));
  const routeMass=categoricalMass(ownRows,ownWeights);
  const probability=normalize(routeMass.map((x,i)=>x+options.routeStrength*peerRate[i]));
  const first=windows.length?new Date(Math.min(...windows.map(w=>w.start))):null;
  const last=windows.length?new Date(Math.max(...windows.map(w=>w.end))):null;
  const spanMonths=first&&last?ami(last)-ami(first)+1:0;
  const old=model.legacy.get(identity.id)?.wait;
  const ownWeight=options.blendLegacy && old ? windows.length/(windows.length+5) : 0;
  const cumulative=[0,1,2].map(i=>ownWeight*(old?.[i]??0)+(1-ownWeight)*sum(probability.slice(0,i+1)));
  return {modelVersion:POOLED_MODEL_VERSION,issuedAt:model.issuedAt,
    evidence:{windowCount:windows.length,firstDate:first?day(first):null,lastDate:last?day(last):null,spanMonths,
      level:windows.length>=6&&spanMonths>=24?'established_history':'limited'},
    horizons:[1,3,6].map((months,i)=>({months,startDate:day(monthDate(cut+1)),endDate:day(new Date(Date.UTC(Math.floor(cut/12),cut%12+months+1,0))),
      probability:Math.max(.001,Math.min(.999,Math.round(Math.max(...cumulative.slice(0,i+1))*1000)/1000))}))};
}

// Keep the old seasonal engine available for reproducible comparisons. Only
// the published wait/forecast fields use the new estimator.
export function derivePooledHistory(raw,now=new Date(),model=fitPooledForecast(raw,now)) {
  return new Map([...model.legacy].map(([id,history])=>{
    const forecast=predictPooledForecast(model,{id,bank:history.bank,code:history.code});
    return [id,forecast?{...history,forecast,wait:forecast.horizons.map(h=>h.probability)}:history];
  }));
}
