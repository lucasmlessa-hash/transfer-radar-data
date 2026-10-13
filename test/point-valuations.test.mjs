import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parsePointValuations } from '../src/sources/point-valuations.mjs';
import { refreshPointValuations } from '../scripts/refresh-point-valuations.mjs';

const fixture = id => readFileSync(new URL(`../fixtures/valuations-${id}-2026-10.html`, import.meta.url), 'utf8');

test('original publisher tables return only the 24 designated cents-USD estimates', () => {
  assert.deepEqual(parsePointValuations(fixture('fm'), 'fm').values, {
    AC:1.4, AF:1.3, AA:1.4, AS:1.5, AV:1.3, BA:1.1, CX:1.1, DL:1.1,
    F9:1, B6:1.3, LH:1.3, QF:1.3, WN:1.3, UA:1.3, VS:1.5,
  });
  assert.deepEqual(parsePointValuations(fixture('tpg'), 'tpg').values, {
    AM:0.8, NH:1.4, QR:1.4, EI:1.4, IB:1.4, EK:1.2, EY:1.2, SQ:1.3, TK:1.1,
  });
});

test('a numeric change is collected while a lost table or unknown unit is not treated as fresh evidence', () => {
  const fm=fixture('fm').replace(/(Air France KLM Flying Blue<\/td>\s*<td[^>]*>)1\.3/, '$11.25');
  assert.equal(parsePointValuations(fm,'fm').values.AF,1.25);
  assert.throws(()=>parsePointValuations('<html>temporarily unavailable</html>','fm'),/table|tabela/i);
  assert.throws(()=>parsePointValuations(fixture('tpg').replaceAll('valuation (cents)','valuation (euros)'),'tpg'),/table|tabela/i);
  const unknown=fm.replace(/(Air France KLM Flying Blue<\/td>\s*<td[^>]*>)1\.25/, '$1—');
  const partial=parsePointValuations(unknown,'fm');
  assert.equal(partial.values.AF,undefined);
  assert.ok(partial.missingCodes.includes('AF'));
  assert.equal(partial.values.AC,1.4);
});

const COVERED=['AC','AF','AA','AS','AV','BA','CX','DL','F9','B6','LH','QF','WN','UA','VS','AM','NH','QR','EI','IB','EK','EY','SQ','TK'];
function files(t) {
  const dir=mkdtempSync(path.join(tmpdir(),'radar-valuations-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const partnersPath=path.join(dir,'partners.json'),reportPath=path.join(dir,'report.json');
  const before=JSON.parse(readFileSync(new URL('../fixtures/partners-audit-2026-10.json',import.meta.url),'utf8'));
  writeFileSync(partnersPath,JSON.stringify(before,null,2)+'\n');
  return {partnersPath,reportPath,before,sleepImpl:async()=>{}};
}
const now=new Date('2026-10-13T16:00:00Z');
const fetchFixture=async url=>({ok:true,text:async()=>fixture(url.includes('frequentmiler')?'fm':'tpg')});

test('refresh verifies only the 24 covered estimates, including unchanged values, and persists a source report',async t=>{
  const f=files(t);const result=await refreshPointValuations({...f,fetchImpl:fetchFixture,now,log:()=>{}});
  assert.equal(result.ok,true);assert.equal(result.verified,24);
  const doc=JSON.parse(readFileSync(f.partnersPath,'utf8'));
  for(const code of COVERED) {
    assert.equal(doc.airlineValueMeta[code].asOf,'2026-10-13',code);
    assert.equal(doc.airlineValueMeta[code].currency,'USD',code);
    assert.equal(doc.airlineValueMeta[code].estimate,true,code);
    assert.equal(doc.airlineValueMeta[code].source,f.before.airlineValueMeta[code].source,code);
  }
  for(const code of Object.keys(f.before.airlineValues).filter(code=>!COVERED.includes(code))) {
    assert.deepEqual(doc.airlineValueMeta[code],f.before.airlineValueMeta[code]);
    assert.equal(doc.airlineValues[code],f.before.airlineValues[code]);
  }
  assert.deepEqual(doc.directory,f.before.directory);
  const report=JSON.parse(readFileSync(f.reportPath,'utf8'));
  assert.equal(report.sources.fm.verifiedCodes.length,15);
  assert.equal(report.sources.tpg.verifiedCodes.length,9);
});

test('a failed publisher preserves its previous values and age while the independent source still refreshes',async t=>{
  const f=files(t);
  // Deliberately differs from the captured publisher table and from today's
  // mutable sample, so the test proves preservation rather than a lucky match.
  f.before.airlineValues.AF=2.25;
  f.before.airlineValueMeta.AF.asOf='2026-07-24';
  writeFileSync(f.partnersPath,JSON.stringify(f.before,null,2)+'\n');
  const result=await refreshPointValuations({...f,now,log:()=>{},fetchImpl:async url=>{
    if(url.includes('frequentmiler'))throw Error('offline');return fetchFixture(url);
  }});
  assert.equal(result.ok,false);assert.equal(result.verified,9);
  const doc=JSON.parse(readFileSync(f.partnersPath,'utf8'));
  assert.deepEqual(doc.airlineValueMeta.AF,f.before.airlineValueMeta.AF);
  assert.equal(doc.airlineValues.AF,f.before.airlineValues.AF);
  assert.equal(doc.airlineValueMeta.NH.asOf,'2026-10-13');
  assert.equal(result.sources.fm.status,'failed');
  assert.equal(result.sources.tpg.status,'ok');
});

test('an unreadable individual value keeps its old review date without discarding successful rows',async t=>{
  const f=files(t);const result=await refreshPointValuations({...f,now,log:()=>{},fetchImpl:async url=>({ok:true,text:async()=>url.includes('frequentmiler')
    ? fixture('fm').replace(/(Air France KLM Flying Blue<\/td>\s*<td[^>]*>)1\.3/,'$1unknown') : fixture('tpg')})});
  assert.equal(result.ok,false);assert.equal(result.verified,23);
  const doc=JSON.parse(readFileSync(f.partnersPath,'utf8'));
  assert.deepEqual(doc.airlineValueMeta.AF,f.before.airlineValueMeta.AF);
  assert.equal(doc.airlineValueMeta.AC.asOf,'2026-10-13');
  assert.equal(result.sources.fm.status,'degraded');
  assert.deepEqual(result.sources.fm.missingCodes,['AF']);
});

test('dry run, total failure, and invalid candidate cannot rewrite partner data',async t=>{
  const f=files(t);const before=readFileSync(f.partnersPath,'utf8');
  const dry=await refreshPointValuations({...f,now,dryRun:true,fetchImpl:fetchFixture,log:()=>{}});
  assert.equal(dry.verified,24);assert.equal(dry.written,false);
  assert.equal(readFileSync(f.partnersPath,'utf8'),before);
  const failed=await refreshPointValuations({...f,now,fetchImpl:async()=>({ok:false,status:503}),log:()=>{}});
  assert.equal(failed.verified,0);assert.equal(failed.changed,false);
  assert.equal(readFileSync(f.partnersPath,'utf8'),before);
  const invalid={...f.before,version:99};writeFileSync(f.partnersPath,JSON.stringify(invalid));
  await assert.rejects(refreshPointValuations({...f,now,fetchImpl:fetchFixture,log:()=>{}}),/version/);
  assert.deepEqual(JSON.parse(readFileSync(f.partnersPath,'utf8')),invalid);
});

test('an incomplete public table reports its actual cells without accepting the missing estimates',()=>{
  const html=readFileSync(new URL('../fixtures/valuations-tpg-incomplete.html',import.meta.url),'utf8');
  const parsed=parsePointValuations(html,'tpg');
  assert.deepEqual(Object.keys(parsed.values),['AM','NH','QR','EI','IB']);
  assert.deepEqual(parsed.missingCodes,['EK','EY','SQ','TK']);
  assert.equal(parsed.diagnostics.matchingTableCount,1);
  assert.deepEqual(parsed.diagnostics.tables[0].header,['Program','October 2026 valuation (cents)']);
  assert.equal(parsed.diagnostics.tables[0].rowCount,9);
  assert.deepEqual(parsed.diagnostics.tables[0].rows[0],{program:'Aeromexico Rewards',valuation:'0.8'});
  assert.equal(parsed.diagnostics.tables[0].rows.at(-1).program,'Delta SkyMiles');
  assert.doesNotMatch(JSON.stringify(parsed.diagnostics),/Chase Air Canada|major refresh|<|href/);
  assert.equal(parsePointValuations(fixture('tpg'),'tpg').diagnostics,undefined);
});

test('wrong units remain rejected but expose bounded public table diagnostics',()=>{
  const html=fixture('tpg').replaceAll('valuation (cents)','valuation (euros)');
  assert.throws(()=>parsePointValuations(html,'tpg'),error=>{
    assert.match(error.message,/table|tabela/i);
    assert.equal(error.diagnostics.matchingTableCount,0);
    assert.ok(error.diagnostics.tables.some(table=>table.header[1]==='October 2026 valuation (euros)'));
    for(const table of error.diagnostics.tables) {
      assert.ok(table.rows.length<=60);
      assert.ok(table.rows.every(row=>row.program.length<=120 && row.valuation.length<=120));
    }
    return true;
  });
});

test('a partial remote valuation result persists the observed cells and preserves all missing values and dates',async t=>{
  const f=files(t);
  const incomplete=readFileSync(new URL('../fixtures/valuations-tpg-incomplete.html',import.meta.url),'utf8');
  const logs=[];
  const result=await refreshPointValuations({...f,now,log:line=>logs.push(line),fetchImpl:async url=>({ok:true,text:async()=>url.includes('frequentmiler')?fixture('fm'):incomplete})});
  assert.equal(result.ok,false);assert.equal(result.verified,20);
  const report=JSON.parse(readFileSync(f.reportPath,'utf8'));
  assert.equal(report.sources.tpg.status,'degraded');
  assert.equal(report.sources.tpg.diagnostics.tables[0].rowCount,9);
  assert.equal(report.sources.fm.diagnostics,undefined);
  assert.ok(logs.some(line=>line.startsWith('[valuations] tpg diagnostics: ') && line.includes('Aeromexico Rewards')));
  assert.ok(logs.every(line=>!line.startsWith('[valuations] fm diagnostics: ')));
  const doc=JSON.parse(readFileSync(f.partnersPath,'utf8'));
  for(const code of ['EK','EY','SQ','TK']) {
    assert.equal(doc.airlineValues[code],f.before.airlineValues[code]);
    assert.deepEqual(doc.airlineValueMeta[code],f.before.airlineValueMeta[code]);
  }
});

test('optional capture saves only failed public-source HTML, outside partner data, with a two MiB cap',async t=>{
  const f=files(t),diagnosticsDir=path.join(path.dirname(f.partnersPath),'captures');
  const html='<html><body>missing valuation table</body></html>'+' '.repeat(2*1024*1024);
  const result=await refreshPointValuations({...f,diagnosticsDir,now,log:()=>{},fetchImpl:async url=>({ok:true,text:async()=>url.includes('frequentmiler')?fixture('fm'):html})});
  assert.equal(result.sources.tpg.status,'failed');
  assert.deepEqual(readdirSync(diagnosticsDir),['tpg-attempt1.html','tpg-attempt2.html','tpg-attempt3.html']);
  assert.equal(statSync(path.join(diagnosticsDir,'tpg-attempt1.html')).size,2*1024*1024);
  assert.equal(readFileSync(path.join(diagnosticsDir,'tpg-attempt1.html'),'utf8'),html.slice(0,2*1024*1024));
  assert.deepEqual(result.sources.tpg.attempts[0].htmlCapture,{file:'tpg-attempt1.html',bytes:2*1024*1024,truncated:true});
  assert.equal(result.sources.fm.htmlCapture,undefined);
  const noCapture=path.join(path.dirname(f.partnersPath),'successful-captures');
  await refreshPointValuations({...f,diagnosticsDir:noCapture,now,log:()=>{},fetchImpl:fetchFixture});
  assert.equal(existsSync(noCapture),false);
});

test('partial capture is exact and the CLI accepts --diagnostics-dir without changing parsing rules',async t=>{
  const f=files(t),diagnosticsDir=path.join(path.dirname(f.partnersPath),'captures');
  const html=readFileSync(new URL('../fixtures/valuations-tpg-incomplete.html',import.meta.url),'utf8');
  const result=await refreshPointValuations({...f,diagnosticsDir,now,dryRun:true,log:()=>{},fetchImpl:async url=>({ok:true,text:async()=>url.includes('frequentmiler')?fixture('fm'):html})});
  assert.equal(result.verified,20);assert.equal(result.ok,false);
  assert.equal(readFileSync(path.join(diagnosticsDir,'tpg-attempt1.html'),'utf8'),html);
  assert.equal(result.sources.tpg.attempts[0].htmlCapture.truncated,false);
  writeFileSync(f.partnersPath,JSON.stringify({...f.before,version:99}));
  const cli=spawnSync(process.execPath,[new URL('../scripts/refresh-point-valuations.mjs',import.meta.url).pathname,'--diagnostics-dir',diagnosticsDir,'--partners',f.partnersPath],{encoding:'utf8'});
  assert.equal(cli.status,1);
  assert.match(cli.stderr,/version/);
  assert.doesNotMatch(cli.stderr,/Unknown argument/);
});

test('a 5/9 response is captured before retry and replaced by one fully verified 9/9 response',async t=>{
  const f=files(t),diagnosticsDir=path.join(path.dirname(f.partnersPath),'captures');
  const partial=readFileSync(new URL('../fixtures/valuations-tpg-incomplete.html',import.meta.url),'utf8');
  let tpgCalls=0,fmCalls=0;const sleeps=[];
  const result=await refreshPointValuations({...f,diagnosticsDir,now,log:()=>{},sleepImpl:async ms=>{
    sleeps.push(ms);assert.equal(readFileSync(path.join(diagnosticsDir,'tpg-attempt1.html'),'utf8'),partial);
  },fetchImpl:async url=>{
    if(url.includes('frequentmiler')){fmCalls++;return {ok:true,text:async()=>fixture('fm')};}
    tpgCalls++;return {ok:true,text:async()=>tpgCalls===1?partial:fixture('tpg')};
  }});
  assert.equal(result.ok,true);assert.equal(result.verified,24);
  assert.equal(tpgCalls,2);assert.equal(fmCalls,1);assert.deepEqual(sleeps,[1000]);
  assert.deepEqual(result.sources.tpg.attempts.map(a=>a.status),['degraded','ok']);
  assert.equal(result.sources.tpg.selectedAttempt,2);assert.deepEqual(result.failures,[]);
  assert.deepEqual(readdirSync(diagnosticsDir),['tpg-attempt1.html']);
});

test('three partial responses select the last response without combining values or renewing absent estimates',async t=>{
  const f=files(t);let calls=0;
  const partial=readFileSync(new URL('../fixtures/valuations-tpg-incomplete.html',import.meta.url),'utf8');
  const earlier=partial.replace('</tbody>','<tr><td>Emirates Skywards</td><td>9.99</td></tr></tbody>');
  const result=await refreshPointValuations({...f,now,log:()=>{},fetchImpl:async url=>{
    if(url.includes('frequentmiler'))return fetchFixture(url);
    calls++;return {ok:true,text:async()=>calls===1?earlier:partial};
  }});
  assert.equal(calls,3);assert.equal(result.ok,false);assert.equal(result.verified,20);
  assert.equal(result.sources.tpg.attempts.length,3);assert.equal(result.sources.tpg.selectedAttempt,3);
  const doc=JSON.parse(readFileSync(f.partnersPath,'utf8'));
  for(const code of ['EK','EY','SQ','TK']) {
    assert.equal(doc.airlineValues[code],f.before.airlineValues[code]);
    assert.deepEqual(doc.airlineValueMeta[code],f.before.airlineValueMeta[code]);
  }
});

test('repeated network failures do not block the independent source or erase a previously parsed partial response',async t=>{
  const f=files(t);const calls={fm:0,tpg:0};
  const partial=readFileSync(new URL('../fixtures/valuations-tpg-incomplete.html',import.meta.url),'utf8');
  const result=await refreshPointValuations({...f,now,log:()=>{},fetchImpl:async url=>{
    const source=url.includes('frequentmiler')?'fm':'tpg';calls[source]++;
    if(source==='tpg' && calls[source]===1)return {ok:true,text:async()=>partial};
    throw Error('network unavailable');
  }});
  assert.deepEqual(calls,{fm:3,tpg:3});assert.equal(result.verified,5);
  assert.equal(result.sources.fm.status,'failed');assert.equal(result.sources.tpg.status,'degraded');
  assert.equal(result.sources.tpg.selectedAttempt,1);
  assert.deepEqual(result.sources.tpg.attempts.map(a=>a.status),['degraded','failed','failed']);
  const doc=JSON.parse(readFileSync(f.partnersPath,'utf8'));
  assert.deepEqual(doc.airlineValueMeta.AF,f.before.airlineValueMeta.AF);
});

test('diagnostics retain up to thirty headerless table fragments without accepting their unscoped values',()=>{
  const partial=readFileSync(new URL('../fixtures/valuations-tpg-incomplete.html',import.meta.url),'utf8');
  const fragments=Array.from({length:35},(_,i)=>`<table><tr><td>fragment ${i}</td><td>1.2</td><td>excluded third cell</td></tr></table>`).join('');
  const parsed=parsePointValuations(partial+fragments,'tpg');
  assert.equal(parsed.diagnostics.tableCount,36);assert.equal(parsed.diagnostics.tables.length,30);
  assert.deepEqual(parsed.diagnostics.tables[1].header,['fragment 0','1.2']);
  assert.equal(parsed.diagnostics.tables[1].rows[0].program,'fragment 0');
  assert.doesNotMatch(JSON.stringify(parsed.diagnostics),/excluded third cell/);
  assert.deepEqual(parsed.missingCodes,['EK','EY','SQ','TK']);
});
