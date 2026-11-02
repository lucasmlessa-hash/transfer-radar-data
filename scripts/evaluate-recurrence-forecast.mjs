// Retrospective, date-respecting comparisons of the SAME campaign-start target.
// An archive span is a coverage proxy, never a proven history of source uptime.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {parseMDY} from '../src/history.mjs';
import {resolveBank,resolvePartner} from '../src/aliases.mjs';
import {loadWindows,bootstrapDelta} from '../src/evaluate.mjs';

const DAY=86400000;
const iso=t=>new Date(t).toISOString().slice(0,10);
const floor=t=>Date.parse(iso(t));
const KNOWN=r=>r.knownAt==null?-Infinity:Date.parse(r.knownAt);

function campaigns(raw) {
  const groups=new Map();
  for(const r of raw) {
    const bank=resolveBank(r.bankName),code=resolvePartner(r.partnerName);
    const s=parseMDY(r.startDateRaw)?.getTime(),e=parseMDY(r.endDateRaw)?.getTime();
    if(!bank||!code||!Number.isFinite(s)||!Number.isFinite(e)||e<s||!(r.pct>0))continue;
    const id=`${bank.toLowerCase()}-${code.toLowerCase()}`;
    if(!groups.has(id))groups.set(id,[]);
    groups.get(id).push({id,bank,code,s,e});
  }
  for(const [id,ws] of groups) {
    ws.sort((a,b)=>a.s-b.s||a.e-b.e);
    const merged=[];
    for(const w of ws){const last=merged.at(-1);if(last&&w.s<=last.e)last.e=Math.max(last.e,w.e);else merged.push({...w});}
    groups.set(id,merged);
  }
  return groups;
}

export function buildRecurrenceCases(raw,{cuts,asOf}) {
  const boundary=floor(asOf),truth=campaigns(raw.filter(r=>KNOWN(r)<=boundary));
  const rows=[];
  for(const value of cuts) {
    const at=new Date(value),cut=floor(at);
    const trainRaw=raw.filter(r=>{const s=parseMDY(r.startDateRaw);return s&&s.getTime()<=cut&&KNOWN(r)<=at.getTime();});
    const known=campaigns(trainRaw);
    for(const [id,past] of known) {
      if(past.some(w=>w.s<=cut&&w.e>=cut))continue;
      const first=past[0],last=past.at(-1),year=at.getUTCFullYear();
      const campaignsThisYear=past.filter(w=>new Date(w.s).getUTCFullYear()===year).length;
      for(const [i,days] of [30,90,180].entries()) {
        const end=cut+days*DAY;
        if(end>=boundary)continue;
        rows.push({id,bank:first.bank,code:first.code,cut:at.toISOString(),days,months:[1,3,6][i],
          startDate:iso(cut+DAY),endDate:iso(end),
          y:Number((truth.get(id)||[]).some(w=>w.s>cut&&w.s<=end)),
          campaignsThisYear,nextCampaignOrdinal:campaignsThisYear+1,
          daysSinceLastStart:(cut-last.s)/DAY,trainRaw});
      }
    }
  }
  return rows;
}

export function scoreRecurrence(rows,key) {
  if(!rows.length)return null;
  const mean=f=>rows.reduce((sum,r)=>sum+f(r),0)/rows.length;
  const calibration=[];
  for(let lo=0;lo<1;lo+=.1) {
    const sample=rows.filter(r=>r[key]>=lo-1e-12&&r[key]<lo+.1-1e-12);
    if(sample.length)calibration.push({bin:`${Math.round(lo*100)}-${Math.round((lo+.1)*100)}%`,n:sample.length,
      predicted:sample.reduce((s,r)=>s+r[key],0)/sample.length,observed:sample.reduce((s,r)=>s+r.y,0)/sample.length});
  }
  return {n:rows.length,brier:mean(r=>(r[key]-r.y)**2),logLoss:mean(r=>{
    const p=Math.max(1e-9,Math.min(1-1e-9,r[key]));return -(r.y*Math.log(p)+(1-r.y)*Math.log1p(-p));
  }),predicted:mean(r=>r[key]),observed:mean(r=>r.y),calibration};
}

export function recurrenceEvaluationSlices(rows) {
  const afterTwoAtIssue=rows.filter(r=>r.campaignsThisYear>=2);
  return {afterTwoAtIssue,sameYearAfterTwo:afterTwoAtIssue.filter(r=>r.endDate.slice(0,4)===r.cut.slice(0,4))};
}

function frequencyPredictor(raw,at) {
  const grouped=campaigns(raw),cut=floor(at);
  let events=0,exposure=0;
  for(const ws of grouped.values()){events+=Math.max(0,ws.length-1);exposure+=Math.max(0,(cut-ws[0].s)/DAY);}
  const globalRate=(events+.5)/(exposure+365);
  return (id,days)=>{const ws=grouped.get(id)||[];
    const rate=ws.length?(Math.max(0,ws.length-1)+365*globalRate)/(Math.max(0,(cut-ws[0].s)/DAY)+365):globalRate;
    return -Math.expm1(-days*rate);
  };
}

export async function evaluateRecurrence(raw,{cuts,asOf,config={},ablations=true,onProgress=()=>{}}) {
  const {fitRecurrenceForecast,predictRecurrenceForecast,RECURRENCE_DEFAULTS}=await import('../src/recurrence-forecast.mjs');
  const cases=buildRecurrenceCases(raw,{cuts,asOf}),byCut=new Map(),rows=[],fits=[];
  for(const row of cases){if(!byCut.has(row.cut))byCut.set(row.cut,[]);byCut.get(row.cut).push(row);}
  const configs={candidate:config,...(ablations?{
    withoutCounts:{...config,useCounts:false},renewal:{...config,useCounts:false,useSeasonality:false,useTrend:false},
  }: {})};
  for(const [cut,rs] of byCut) {
    const at=new Date(cut),models={},predictions=new Map();
    for(const [name,cfg] of Object.entries(configs)) {
      const started=Date.now();models[name]=fitRecurrenceForecast(rs[0].trainRaw,at,cfg);
      fits.push({cut,name,milliseconds:Date.now()-started,diagnostics:models[name].diagnostics??null});
    }
    const frequency=frequencyPredictor(rs[0].trainRaw,at);
    for(const input of rs) {
      const {trainRaw,...r}=input;
      let valid=true;
      for(const name of Object.keys(models)) {
        const key=`${name}|${r.id}`;
        if(!predictions.has(key))predictions.set(key,predictRecurrenceForecast(models[name],r));
        const f=predictions.get(key),h=f?.horizons.find(h=>h.days===r.days);
        if(!h){valid=false;break;}
        if(f.target!=='campaign_start'||h.startDate!==r.startDate||h.endDate!==r.endDate)
          throw new Error('Evaluation target/window differs from the forecast');
        r[name]=h.probability;
      }
      if(valid){r.frequency=frequency(r.id,r.days);rows.push(r);}
    }
    onProgress({cut,completed:fits.length/Object.keys(configs).length,rows:rows.length});
  }
  const methods=[...Object.keys(configs),'frequency'];
  const summarize=rs=>Object.fromEntries(methods.map(key=>[key,scoreRecurrence(rs,key)]));
  const horizons=[30,90,180].map(days=>{
    const rs=rows.filter(r=>r.days===days);
    return {days,scores:summarize(rs),...Object.fromEntries(Object.entries(recurrenceEvaluationSlices(rs)).map(([key,slice])=>[key,summarize(slice)])),
      byOrdinal:[1,2,3].map(n=>({ordinal:n===3?'3+':String(n),scores:summarize(rs.filter(r=>n===3?r.nextCampaignOrdinal>=3:r.nextCampaignOrdinal===n))})),
      byInterval:[[0,90],[90,180],[180,Infinity]].map(([lo,hi])=>({range:[lo,Number.isFinite(hi)?hi:null],scores:summarize(rs.filter(r=>r.daysSinceLastStart>=lo&&r.daysSinceLastStart<hi))})),
      ...(rs.length?{vsFrequencyByRoute:bootstrapDelta(rs,'candidate',{ref:'frequency',by:'id',reps:1000}),
        vsFrequencyByIssue:bootstrapDelta(rs,'candidate',{ref:'frequency',by:'cut',reps:1000})}:{}),
    };
  });
  return {target:'campaign_start',horizonMode:'rolling_days',asOf,config:{...RECURRENCE_DEFAULTS,...config},
    qualification:'Retrospective simulation with archive-span coverage proxy; this archive influenced previous model development. Not an untouched holdout or published performance.',horizons,fits,rows};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const arg=name=>process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
  const input=arg('input');if(!input)throw new Error('Pass --input=frozen-archive.html');
  const phase=arg('phase')??'development',validation=phase==='validation';
  const from=arg('from')??(validation?'2025-01-01':'2022-01-01');
  const asOf=arg('as-of')??(validation?'2026-11-02':'2025-01-01');
  const stride=Number(arg('stride')??1),cuts=[];
  for(let at=new Date(from);at<new Date(asOf);at=new Date(Date.UTC(at.getUTCFullYear(),at.getUTCMonth()+stride,1)))cuts.push(at.toISOString());
  const {raw}=loadWindows(fs.readFileSync(input,'utf8'));
  const config=arg('config')?JSON.parse(fs.readFileSync(arg('config'),'utf8')):{};
  const report=await evaluateRecurrence(raw,{cuts,asOf,config,ablations:!process.argv.includes('--no-ablations'),onProgress:p=>console.log(JSON.stringify(p))});
  report.phase=phase;
  if(arg('out'))fs.writeFileSync(arg('out'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({phase,horizons:report.horizons.map(h=>({days:h.days,scores:h.scores,afterTwoAtIssue:h.afterTwoAtIssue,sameYearAfterTwo:h.sameYearAfterTwo}))},null,2));
}
