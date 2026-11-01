import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/normalize.mjs';
import { validateFeed } from '../scripts/validate-feed.mjs';
import { source as livelo } from '../src/sources/livelo.mjs';
import { runPipeline } from '../src/publish.mjs';
import { mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const now = new Date('2026-11-01T10:00:00Z');
const base = { bankName: 'Chase', partnerName: 'British Airways', pct: 20, startDateRaw: '11/1/2026', endDateRaw: '11/30/2026', sourceId: 'frequentmiler', sourceUrl: 'https://example.com/one' };
const make = entries => normalize(entries, now, new Map()).routes[0];

test('disagreeing sources remain visible as a conflict, not corroboration of the larger bonus', () => {
  const r = make([base, { ...base, pct: 30, sourceId: 'awardwallet', sourceUrl: 'https://example.com/two' }]);
  assert.equal(r.offerEvidence?.status, 'conflict');
  assert.deepEqual(r.offerEvidence.observations.map(o => [o.pct, o.url]), [[20, 'https://example.com/one'], [30, 'https://example.com/two']]);
  assert.equal(r.offerEvidence.checkedAt, '2026-11-01T10:00:00.000Z');
});

test('an expired listing does not create conflict with the current campaign', () => {
  const r = make([base, { ...base, pct: 50, endDateRaw: '10/31/2026' }]);
  assert.equal(r.offerEvidence?.status, 'observed');
  assert.equal(r.offerEvidence.observations.length, 1);
});

test('maximum bonus and public conditions survive normalization', () => {
  const r = make([{ ...base, bonusKind: 'up_to', conditionsText: 'Up to 20% for selected members' }]);
  assert.equal(r.offerEvidence?.observations[0].bonusKind, 'up_to');
  assert.match(r.offerEvidence.observations[0].conditionsText, /selected/);
  assert.doesNotThrow(() => validateFeed({ version: 1, generatedAt: now.toISOString(), routes: [r] }));
  r.offerEvidence.observations[0].url = 'javascript:alert(1)';
  assert.throws(() => validateFeed({ version: 1, generatedAt: now.toISOString(), routes: [r] }), /offerEvidence.*url/i);
});

const page = variations => `<script id="__NEXT_DATA__">${JSON.stringify({ props: { cards: variations.map(v => ({ status: { forceClose: false, variations: [{ status: 'Vigente', statusCard: 'active', ...v }] } })) } })}</script>`;
const shopping = { title: 'Compre e ganhe pontos', description: 'Pontos nas compras', button: { redirectLink: '/juntar-pontos/parceiros/loja' } };

test('money-transfer advertising does not turn an empty Livelo points-bonus listing into a failure', () => {
  const html = page([shopping, { title: 'Lançamento ARQ', description: 'Transfira 100 US$/EURO e ganhe 5.500 pontos Livelo', button: { redirectLink: 'https://www.livelo.com.br/instituicoes-financeiras/arq' } }]);
  assert.equal(livelo.isValidEmpty(html), true);
});

test('an unrecognized points-transfer card still prevents declaring a healthy empty listing', () => {
  assert.equal(livelo.isValidEmpty(page([shopping, { title: 'Transfira pontos e ganhe!', button: { redirectLink: '/livelo-para-parceiros/azul/AZLTransfer' } }])), false);
  assert.equal(livelo.isValidEmpty('<html>maintenance</html>'), false);
});

test('carrying a prior offer never advances its verification timestamp', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'radar-offer-evidence-'));
  try {
    const fixturesDir = path.join(dir, 'fixtures');
    cpSync(new URL('../fixtures/', import.meta.url), fixturesDir, { recursive: true });
    writeFileSync(path.join(fixturesDir, 'frequentmiler.html'), '<html>unavailable</html>');
    const prior = make([{ ...base, bankName: 'Amex', partnerName: 'ANA' }]);
    writeFileSync(path.join(dir, 'feed.json'), JSON.stringify({ version: 1, generatedAt: now.toISOString(), routes: [prior] }));
    const result = await runPipeline({ fixtures: true, fixturesDir, outDir: dir, now: new Date('2026-11-02T10:00:00Z') });
    assert.equal(result.ok, true);
    const carried = result.routes.find(r => r.id === 'amex-nh');
    assert.equal(carried.offerEvidence.status, 'carried');
    assert.equal(carried.offerEvidence.checkedAt, '2026-11-01T10:00:00.000Z');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('partially parsed current-offer tables never count as healthy negative coverage', async () => {
  const {readFileSync}=await import('node:fs');
  const dir=mkdtempSync(path.join(tmpdir(),'radar-incomplete-offer-'));
  try {
    const fixturesDir=path.join(dir,'fixtures'); cpSync(new URL('../fixtures/',import.meta.url),fixturesDir,{recursive:true});
    const fm=path.join(fixturesDir,'frequentmiler.html'), aw=path.join(fixturesDir,'awardwallet.html');
    // Preserve plenty of valid entries while adding one truncated offer.
    writeFileSync(fm,readFileSync(fm,'utf8').replace('</tbody>','<tr><td>Rove</td><td>20% transfer bonus from Rove to Frontier</td><td>11/1/2026</td><td></td></tr></tbody>'));
    writeFileSync(aw,readFileSync(aw,'utf8').replace('class="transfer-times"','class="transfer-times"').replace('<div class="transfer-times">','<div class="transfer-times"><div class="tt-row"><div class="tt-body tt-from">Rove</div><div class="tt-body tt-to">Frontier</div><div class="tt-body tt-ratio"><div class="tt-bonus">20% transfer bonus</div></div></div>'));
    const result=await runPipeline({fixtures:true,fixturesDir,outDir:path.join(dir,'out'),now});
    assert.equal(result.ok,true);
    assert.equal(result.health.sources.frequentmiler.status,'degraded');
    assert.equal(result.health.sources.awardwallet.status,'degraded');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('Brazilian sources also mark partial transfer cards while ignoring financial advertising', async () => {
  const {source:esfera}=await import('../src/sources/esfera.mjs');
  const good={title:'Transfira para a Azul',description:'Até 100% de bônus até 30/11',button:{redirectLink:'/livelo-para-parceiros/azul/AZLTransfer'}};
  const unknown={title:'Transfira pontos e ganhe!',button:{redirectLink:'/livelo-para-parceiros/smiles/GOLTransfer'}};
  const arq={title:'Transfira dinheiro',description:'Transfira 100 US$/EURO e ganhe pontos Livelo',button:{redirectLink:'/instituicoes-financeiras/arq'}};
  assert.equal((await livelo.parse(page([good,unknown]))).coverageComplete,false);
  assert.notEqual((await livelo.parse(page([good,arq]))).coverageComplete,false);
  const html='<div class="carousel-item"><img alt="Só até 30/11: Ganhe até 100% de bônus, a marca da Azul e o botão Transferir"><img alt="Transfira pontos para Smiles e ganhe bônus"></div>';
  assert.equal((await esfera.parse(html)).coverageComplete,false);
});
