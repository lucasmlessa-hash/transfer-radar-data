import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFmDirectory, mergeDirectory } from '../src/sources/partner-directory.mjs';
import { parseFmTransferTimes } from '../src/sources/transfer-times.mjs';
import { monitorRatios } from '../scripts/monitor-ratios.mjs';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const table = rows => '<table class="tablepress"><thead><tr><th>Rewards Program</th>' +
  ['Amex','Capital One','Bilt','Chase','Citi'].map(b => '<th>'+b+' Transfer Ratio (and transfer time)</th>').join('') +
  '</tr></thead><tbody>' + rows.map(row => '<tr>'+row.map(cell=>'<td>'+cell+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
const html = table([
  ['Finnair Plus+', '1 to 1 via BA (Instant)', '1 to 1 (Instant)', '', '', ''],
  ['Copa Airlines ConnectMiles', '', '1 to 750 (Unknown)', '', '', '1 to 1 (Instant)'],
  ['Leading Hotels of the World', '1K to 250 (Unknown)', '', '', '', '1K to 200 (Instant)'],
  ['Marriott Bonvoy', '', '', '20K to 25K (Instant)', '', ''],
  ['Hyatt', '', '', '', '4 to 3 or 1 to 1 (varies by card) (Instant)', ''],
  ['Jet Airways InterMiles', '', '', '', '', '1 to 1 (Instant)'],
]);
const tiers = [{ cards: 'Sapphire Reserve', ratio: '1:1' }, { cards: 'Sapphire Preferred', ratio: '4:3' }];

test('the direct directory excludes Avios bridges and reads the reviewed Capital One and Leaders Club rates', () => {
  const byBank=parseFmDirectory(html);
  assert.equal(byBank.AMEX.air.has('Finnair Plus'), false);
  assert.equal(byBank.C1.air.get('Finnair Plus'), '1:1');
  assert.equal(byBank.C1.air.get('Copa ConnectMiles'), '1000:750');
  assert.equal(byBank.AMEX.hotel.get('Leading Hotels Leaders Club'), '1000:250');
  assert.equal(byBank.CITI.hotel.get('Leading Hotels Leaders Club'), '1000:200');
  assert.equal(byBank.BILT.hotel.get('Marriott Bonvoy'), '—', 'a block bonus is not the base');
  assert.equal(parseFmTransferTimes(html).times.AMEX?.AY, undefined);
});

test('daily and intraday publications keep conditional rates and confirmed route removals', async t => {
  const doc = {directory: {
    AMEX:{air:[['Finnair Plus','1:1']],hotel:[]},
    CHASE:{air:[],hotel:[['World of Hyatt','—']]},
    CITI:{air:[['Jet Airways InterMiles','1:1'],['Copa ConnectMiles','—']],hotel:[]}
  },ratioTiers:{CHASE:{'World of Hyatt':tiers},CITI:{'Copa ConnectMiles':[
    {cards:'Strata Premier',ratio:'1000:1000'},{cards:'Double Cash',ratio:'1000:700'}
  ]}}};
  const dir=mkdtempSync(path.join(tmpdir(),'reviewed-dir-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const partnersPath=path.join(dir,'partners.json');writeFileSync(partnersPath,JSON.stringify(doc));
  const result=await monitorRatios({partnersPath,fetchImpl:async()=>new Response(html),log:()=>{}});
  assert.equal(result.ok,true,JSON.stringify(result.failures));
  const daily=JSON.parse(readFileSync(partnersPath));
  const published=mergeDirectory(doc.directory,parseFmDirectory(html),doc.ratioTiers);
  for (const d of [daily.directory,published]) {
    assert.equal(d.AMEX.air.some(([n])=>n==='Finnair Plus'), false);
    assert.equal(d.CITI.air.some(([n])=>n==='Jet Airways InterMiles'), false);
    assert.deepEqual(d.CHASE.hotel,[['World of Hyatt','—']]);
    assert.deepEqual(d.CITI.air,[['Copa ConnectMiles','—']]);
  }
});
