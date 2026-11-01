// Offline, date-respecting evaluation; never mutates production ledgers.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {deriveHistory,parseMDY} from '../src/history.mjs';
import {fitPooledForecast,predictPooledForecast,POOLED_DEFAULTS} from '../src/pooled-forecast.mjs';
import {loadWindows,amiToDate,brier,calibration,bootstrapDelta} from '../src/evaluate.mjs';
export function evaluatePooled(html,{phase='development',config={}}={}) {
 const {raw,byId}=loadWindows(html), rows=[];
 const from=phase==='development'?2022*12:2025*12;
 const boundary=phase==='development'?2025*12:2026*12+10;
 for(let cut=from;cut<boundary;cut++) {
  const at=amiToDate(cut), pastRaw=raw.filter(w=>{const end=parseMDY(w.endDateRaw);return end&&end<at;});
  const old=deriveHistory(at,pastRaw), fitted=fitPooledForecast(pastRaw,at,config);
  for(const [id,history] of old) {
   const windows=byId.get(id)||[];
   if(windows.some(w=>w.start<=at&&w.end>=at))continue;
   const fresh=predictPooledForecast(fitted,{id,bank:history.bank,code:history.code}); if(!fresh)continue;
   for(const [i,h] of [1,3,6].entries()) {
    if(cut+h>=boundary)continue;
    const future=windows.some(w=>w.s<=cut+h&&w.e>=cut+1);
    const past=windows.filter(w=>w.end<at);let hits=0,n=0;
    for(let start=Math.min(...past.map(w=>w.s))+1;start+h<cut;start++){n++;if(past.some(w=>w.s<=start+h-1&&w.e>=start))hits++;}
    rows.push({id,cut,months:h,y:Number(future),candidate:fresh.horizons[i].probability,
     legacy:history.next&&history.wait?history.wait[i]:null,clim:n?hits/n:null,windows:history.forecast.evidence.windowCount});
   }
  }
 }
 const score=rs=>rs.length?{n:rs.length,brier:brier(rs,'candidate'),legacyBrier:brier(rs,'legacy'),baselineBrier:brier(rs,'clim'),
  predicted:rs.reduce((s,r)=>s+r.candidate,0)/rs.length,observed:rs.reduce((s,r)=>s+r.y,0)/rs.length,
  relativeImprovement:1-brier(rs,'candidate')/brier(rs,'legacy'),calibration:calibration(rs,'candidate')}:null;
 const horizons=[1,3,6].map(months=>{
  const all=rows.filter(r=>r.months===months),common=all.filter(r=>r.legacy!==null&&r.clim!==null);
  return {months,newCoverage:all.length,comparison:score(common),shortHistory:score(common.filter(r=>r.windows<6)),
   ...(phase==='validation'&&common.length?{byRoute:bootstrapDelta(common,'candidate',{ref:'legacy',by:'id'}),byIssue:bootstrapDelta(common,'candidate',{ref:'legacy',by:'cut'})}:{})};
 });
 return {phase,config:{...POOLED_DEFAULTS,...config},scope:'Retrospective simulation, not published forecasts. Public archive coverage is incomplete.',horizons,rows};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const phase=process.argv.includes('--validation')?'validation':'development';
 const input=process.argv.find(a=>a.endsWith('.html'));
 if(!input)throw new Error('Pass a frozen archive .html path');
 const config=process.argv.includes('--context')?{seasonWeight:.25,recencyWeight:.35,blendLegacy:false}:process.argv.includes('--no-context')?{seasonWeight:1,recencyWeight:1,blendLegacy:false}:{};
 const result=evaluatePooled(fs.readFileSync(input,'utf8'),{phase,config});
 const out=process.argv.find(a=>a.startsWith('--out='))?.slice(6);
 if(out)fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({...result,rows:undefined},null,2));
}
