import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,copyFileSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runPipeline} from '../src/publish.mjs';
import legacyClient from './fixtures/data-client-v1.1.0.cjs';
import releasedClient from './fixtures/data-client-v1.2.0.cjs';
import {loadForecastRecords} from '../src/forecast-records.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
test('pipeline publishes recurrence context without treating discovery as a campaign start',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'radar-recurrence-publish-'));
  const fixturesDir=path.join(dir,'fixtures'),outDir=path.join(dir,'out'),ledgerPath=path.join(dir,'observed.json');
  try {
    cpSync(path.join(root,'fixtures'),fixturesDir,{recursive:true});
    copyFileSync(path.join(root,'fixtures/frequentmiler-recurrence-2026-11.html'),path.join(fixturesDir,'frequentmiler.html'));
    writeFileSync(ledgerPath,JSON.stringify({version:1,windows:[{
      id:'liv-ac',bank:'LIV',code:'AC',pct:20,firstSeen:'2026-06-10',lastSeen:'2026-06-30',endDate:'2026-06-30',
    }]}));
    const result=await runPipeline({fixtures:true,fixturesDir,outDir,ledgerPath,forecastLedgerPath:path.join(dir,'forecasts.json'),now:new Date('2026-11-02T13:00:00Z')});
    assert.equal(result.ok,true,result.reason);
    const feed=JSON.parse(readFileSync(path.join(outDir,'feed.json'),'utf8'));
    const chase=feed.routes.find(r=>r.id==='chase-ac');
    assert.equal(chase.nextCampaignForecast?.target,'campaign_start');
    assert.deepEqual(chase.nextCampaignForecast.horizons.map(h=>h.days),[30,90,180]);
    assert.equal(chase.nextCampaignForecast.context.campaignsThisYear,2);
    assert.equal(chase.nextCampaignForecast.context.nextCampaignOrdinal,3);
    assert.equal(chase.forecast.modelVersion,'pooled-recurrence-v2');
    assert.deepEqual(chase.monthlyCampaignForecast.horizons.map(w=>w.months),[1,2,3]);
    assert.equal(loadForecastRecords(path.join(dir,'forecasts.json')).ok,true);
    const oldReport=JSON.parse(readFileSync(path.join(outDir,'forecast-history.json'))),newReport=JSON.parse(readFileSync(path.join(outDir,'forecast-history-monthly.json')));
    assert.ok(!oldReport.records.some(r=>r.horizonMode==='rolling_months'));
    assert.ok(newReport.records.some(r=>r.months===2&&r.horizonMode==='rolling_months'));
    releasedClient.validateHistory(oldReport);
    const partners=JSON.parse(readFileSync(path.join(outDir,'partners.json'),'utf8'));
    assert.doesNotThrow(()=>releasedClient.validatePair(feed,partners));
    assert.doesNotThrow(()=>legacyClient.validatePair(feed,partners),'installed version 1.1.0 must keep receiving current offers');
    const inferred=feed.routes.find(r=>r.id==='liv-ac');
    assert.ok(inferred,'existing observed-only route remains represented');
    assert.equal(inferred.nextCampaignForecast.context.campaignsThisYear,0,'discovery cannot manufacture an event');
    assert.equal(inferred.nextCampaignForecast.evidence.windowCount,0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
