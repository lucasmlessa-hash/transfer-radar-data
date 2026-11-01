import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,cpSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runPipeline} from '../src/publish.mjs';
test('only proof of a publicly served feed recovers publication, never a previous local build',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'radar-publication-pipeline-'));
 try {
  const outDir=path.join(dir,'out'),forecastLedgerPath=path.join(dir,'records.json');
  const fixturesDir=path.join(dir,'fixtures');cpSync(new URL('../fixtures/',import.meta.url),fixturesDir,{recursive:true});
  appendFileSync(path.join(fixturesDir,'frequentmiler.html'),`<h3>Expired Transfer Bonuses</h3><table><thead><tr><th>Transfer From</th><th>Transfer Bonus Details</th><th>Start Date</th><th>End Date</th></tr></thead><tbody>${[2020,2025].map(y=>`<tr><td>Chase</td><td>30% transfer bonus from Chase to British Airways</td><td>03/01/${y}</td><td>03/31/${y}</td></tr>`).join('')}</tbody></table>`);
  const first=await runPipeline({fixtures:true,fixturesDir,outDir,forecastLedgerPath,now:new Date('2026-07-24T09:00:00Z')});
  assert.equal(first.ok,true);
  const original=JSON.parse(readFileSync(path.join(outDir,'feed.json'),'utf8'));
  await runPipeline({fixtures:true,fixturesDir,outDir,forecastLedgerPath,now:new Date('2026-07-24T10:00:00Z')});
  let ledger=JSON.parse(readFileSync(forecastLedgerPath,'utf8'));
  assert.ok(ledger.records.every(r=>r.publicationStatus==='unconfirmed'));
  await runPipeline({fixtures:true,fixturesDir,outDir,forecastLedgerPath,now:new Date('2026-07-24T13:00:00Z'),
    publicationProof:{feed:original,observedAt:'2026-07-24T12:59:00Z'}});
  ledger=JSON.parse(readFileSync(forecastLedgerPath,'utf8'));
  const report=JSON.parse(readFileSync(path.join(outDir,'forecast-history.json'),'utf8'));
  const firstIssue=ledger.records.filter(r=>r.issuedAt===original.generatedAt&&r.probability!==null);
  assert.ok(firstIssue.length>0);assert.ok(firstIssue.every(r=>r.publicationStatus==='confirmed'));
  assert.ok(ledger.records.filter(r=>r.issuedAt==='2026-07-24T10:00:00.000Z').every(r=>r.publicationStatus==='unconfirmed'));
  assert.equal(report.status,'ok');assert.ok(report.records.some(r=>r.publicationStatus==='confirmed'));
 } finally {rmSync(dir,{recursive:true,force:true});}
});
