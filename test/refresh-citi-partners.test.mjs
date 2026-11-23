import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refreshCitiPartners } from '../scripts/refresh-citi-partners.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/citi-public-tiers.json', import.meta.url)));
const high = ['CTHNKYUPMC', 'CTHNKYUPSC', 'TYSTRATAEL'];
const low = ['ANONYMOUS', 'CTHNKYUPCD', 'CUSTCASH', 'DBLCASH', 'REWARDPLUS'];
function payloads() {
  const roster = [], quotes = [];
  for (const [partnerCode, programName, programCatName, higher, lower] of fixture.routes) {
    roster.push({ partnerCode, programName, programCatName, pxGrpInteger: '1,000', pxTgtInteger: lower, isFutureInd: 'N' });
    const premier = [...high], basic = [...low];
    if (partnerCode !== 'PTXF_AAL') {
      premier.push('ATTAMORE');
      basic.push('ATTPTPLUS', 'ATTUNIVER', 'CTHNKYUATT');
      if (partnerCode !== 'PTXF_JBLUE') basic.push('THKSEARSNF');
    }
    const tierList = [...premier, ...basic].map(tierCode => {
      const targetDisplayPnts = premier.includes(tierCode) ? higher : lower;
      return { tierCode, sourceDisplayPnts: '1,000', targetDisplayPnts, conversionRate: Number(targetDisplayPnts.replace(',', '')) / 1000 };
    });
    quotes.push({ partnerCode, partnerName: programName, tierList });
  }
  return {
    roster: { hasPrograms: true, getMemberEligiblePointExchangeProgramData: { memberProgramDetails: roster, promoMemberProgramDetails: [] } },
    quotes: { partnerDetails: quotes, errorCode: null, errorMessage: null },
    labels: { ...fixture.cardLabels },
  };
}
function api(sources) {
  return async url => {
    if (url.endsWith('/partnerProgramsListing-ajax.json')) return sources.roster;
    if (url.endsWith('/getPartnerConversionRate-ajax.json')) return sources.quotes;
    if (url.endsWith('/ENG/ANONYMOUS.json')) return sources.labels;
    throw new Error('Unexpected public resource ' + url);
  };
}
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'radar-citi-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'partners.json');
  const original = readFileSync(new URL('../sample/partners.json', import.meta.url), 'utf8');
  writeFileSync(path, original);
  return { path, original };
}
test('refreshes only Citi from both issuer rates, preserving the full published card groups', async t => {
  const { path, original } = setup(t);
  const sources = payloads();
  // A later issuer quote changes without a new script or evidence fixture.
  const leaders = sources.quotes.partnerDetails.find(row => row.partnerCode === 'PTXF_LHW');
  for (const tier of leaders.tierList.filter(tier => tier.targetDisplayPnts === '200')) {
    tier.targetDisplayPnts = '210'; tier.conversionRate = 0.21;
  }
  await refreshCitiPartners({ partnersPath: path, getJson: api(sources), now: new Date('2026-11-23T12:00Z') });
  const result = JSON.parse(readFileSync(path));
  const before = JSON.parse(original);
  assert.equal(result.directory.CITI.air.length, 16);
  assert.equal(result.directory.CITI.hotel.length, 5);
  assert.ok([...result.directory.CITI.air, ...result.directory.CITI.hotel].every(([, ratio]) => ratio === '—'));
  assert.deepEqual(result.ratioTiers.CITI['Leading Hotels Leaders Club'].map(x => x.ratio), ['1000:210', '1000:140']);
  assert.match(result.ratioTiers.CITI['Leading Hotels Leaders Club'][0].cards, /AT&T Access More/);
  assert.doesNotMatch(result.ratioTiers.CITI['American Airlines AAdvantage'][0].cards, /AT&T/);
  assert.equal(result.ratioProvenance.CITI.asOf, '2026-11-23');
  for (const key of ['directory', 'ratioTiers', 'ratioProvenance']) {
    delete result[key].CITI;
    if (before[key]) delete before[key].CITI;
    else delete result[key];
  }
  assert.deepEqual(result, before);
});
test('preserves the original file on incomplete, ambiguous or promotional evidence', async t => {
  const { path, original } = setup(t);
  for (const change of [
    ({ roster }) => roster.getMemberEligiblePointExchangeProgramData.memberProgramDetails.pop(),
    ({ roster, quotes }) => { roster.getMemberEligiblePointExchangeProgramData.memberProgramDetails.pop(); quotes.partnerDetails.pop(); },
    ({ quotes }) => quotes.partnerDetails[0].tierList.pop(),
    ({ quotes }) => quotes.partnerDetails[0].tierList.push(quotes.partnerDetails[0].tierList[0]),
    ({ quotes }) => { quotes.partnerDetails[0].tierList[0].oldDisplayPnts = '900'; },
    ({ quotes }) => { quotes.partnerDetails[0].tierList[0].conversionRate = 1.2; },
    ({ roster }) => { roster.getMemberEligiblePointExchangeProgramData.memberProgramDetails[0].pxTgtInteger = '880'; },
    ({ quotes }) => { quotes.partnerDetails[0].tierList[0].targetDisplayPnts = '1,2'; },
    ({ roster }) => { roster.getMemberEligiblePointExchangeProgramData.memberProgramDetails[0].partnerCode = 'PTXF_NEW'; },
    ({ labels }) => { delete labels['pt.landing.page.conversionRate.group-1.header.PTXF_AAL']; },
  ]) {
    const sources = payloads();
    change(sources);
    await assert.rejects(refreshCitiPartners({ partnersPath: path, getJson: api(sources) }));
    assert.equal(readFileSync(path, 'utf8'), original);
  }
});
