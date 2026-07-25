// Walk-forward backtest of the SHIPPED forecast against the FM archive.
//
//   node scripts/backtest.mjs [archive-cache.html]
//
// Scores what production actually publishes — `deriveHistory().p2`, the exact
// number the panel's WAIT/TOSS-UP/SEND NOW verdict reads — against the
// baseline it has to beat to justify existing: per-route climatology ("how
// often does this route run bonuses at all", no seasonality, no recency).
//
// Every number here carries its uncertainty. A 2026-07-25 audit found the
// previous version of this script reporting a headline skill whose confidence
// interval crossed zero, over a period where the skill was negative in the
// first year, driven by routes that were half too thin to model. None of that
// was visible in its output. It is all visible now, by construction:
//
//   - clustered bootstrap intervals (by cutoff AND by route)
//   - skill broken out per year
//   - skill split by how much history the route actually has
//   - effective event count vs row count
//   - archive data-quality checks
//
// The rule this encodes: a difference whose interval crosses zero is not a
// result. Report it as "not established", never as a win.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { source } from '../src/sources/frequentmiler.mjs';
import {
  loadWindows, buildRows, brier, logloss, skillPct,
  bootstrapDelta, calibration, effectiveEvents, findOverlaps,
} from '../src/evaluate.mjs';

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const pct = (x) => (x * 100).toFixed(0) + '%';

const cachePath = process.argv[2] ?? '';
let html;
if (cachePath && existsSync(cachePath)) {
  html = readFileSync(cachePath, 'utf8');
  console.log(`[backtest] cached archive: ${cachePath}`);
} else {
  console.log(`[backtest] fetching ${source.url}`);
  const res = await fetch(source.url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  html = await res.text();
  if (cachePath) { writeFileSync(cachePath, html); console.log(`[backtest] cached to ${cachePath}`); }
}

// --- archive quality --------------------------------------------------------
const { windows, byId } = loadWindows(html);
const overlaps = findOverlaps(byId);
const sizes = [...byId.values()].map((w) => w.length).sort((a, b) => a - b);
console.log(`\n── arquivo ──`);
console.log(`${windows.length} janelas resolvidas em ${byId.size} rotas · janelas/rota: min ${sizes[0]}, mediana ${sizes[Math.floor(sizes.length / 2)]}, max ${sizes[sizes.length - 1]}`);
if (overlaps.length) {
  console.log(`⚠ ${overlaps.length} par(es) de janelas SOBREPOSTAS na mesma rota (mesma campanha listada duas vezes?):`);
  for (const o of overlaps) console.log(`   ${o.id}: ${o.a.start.toISOString().slice(0, 10)}→${o.a.end.toISOString().slice(0, 10)} vs ${o.b.start.toISOString().slice(0, 10)}→${o.b.end.toISOString().slice(0, 10)}`);
}

// --- walk-forward -----------------------------------------------------------
const rows = buildRows(html);
const ev = effectiveEvents(rows, byId);
const baseRate = rows.reduce((s, r) => s + r.y, 0) / rows.length;
console.log(`\n── walk-forward 2024-01..2026-04 ──`);
console.log(`${rows.length} previsões rota×corte · taxa-base ${pct(baseRate)}`);
console.log(`${ev.positiveRows} linhas y=1 vêm de apenas ${ev.distinctWindows} janelas reais (${ev.rowsPerWindow.toFixed(2)} linhas por janela) — por isso os IC são clusterizados`);

console.log(`\npreditor   Brier    log-loss   skill vs clim`);
for (const key of ['ship', 'clim']) {
  const s = key === 'clim' ? '—' : skillPct(rows, key).toFixed(1) + '%';
  console.log(`${key.padEnd(10)} ${brier(rows, key).toFixed(4)}   ${logloss(rows, key).toFixed(4)}     ${s}`);
}

// --- uncertainty: the headline is meaningless without this ------------------
console.log(`\n── ΔBrier (clim − ship; >0 = modelo melhor) ──`);
let established = true;
for (const by of ['cut', 'id']) {
  const b = bootstrapDelta(rows, 'ship', { by });
  const label = by === 'cut' ? 'blocos=corte  ' : 'blocos=rota   ';
  console.log(`${label} Δ=${b.delta.toFixed(4)}  IC95%[${b.lo.toFixed(4)}, ${b.hi.toFixed(4)}]  P(Δ≤0)=${pct(b.pNeg)}  (${b.clusters} clusters)`);
  if (b.lo <= 0) established = false;
}
console.log(established
  ? '✓ vantagem sobre a baseline ESTABELECIDA nos dois esquemas de bloco'
  : '⚠ vantagem NÃO estabelecida: algum IC95% cruza zero — reporte como "não estabelecido", nunca como vitória');

// --- stability: an edge that swings by period is fragile --------------------
console.log(`\n── skill por ano de corte ──`);
for (const year of [...new Set(rows.map((r) => r.year))].sort()) {
  const sub = rows.filter((r) => r.year === year);
  console.log(`  ${year}  n=${String(sub.length).padStart(4)}  skill ${skillPct(sub, 'ship').toFixed(1)}%`);
}

// --- where the skill actually lives -----------------------------------------
console.log(`\n── skill por espessura do histórico ──`);
for (const [label, filter] of [['<4 janelas', (r) => r.nTrain < 4], ['≥4 janelas', (r) => r.nTrain >= 4]]) {
  const sub = rows.filter(filter);
  if (!sub.length) continue;
  console.log(`  ${label}  n=${String(sub.length).padStart(4)} (${pct(sub.length / rows.length)} das previsões)  skill ${skillPct(sub, 'ship').toFixed(1)}%`);
}

// --- calibration -------------------------------------------------------------
console.log(`\n── calibração (decil previsto → observado) ──`);
console.log('bin        n     média   observado');
for (const c of calibration(rows, 'ship')) {
  console.log(`${c.bin.padEnd(9)} ${String(c.n).padStart(4)}   ${pct(c.meanP).padStart(5)}   ${pct(c.observed).padStart(8)}`);
}

const misses = rows.filter((r) => Math.abs(r.ship - r.y) > 0.6).sort((a, b) => Math.abs(b.ship - b.y) - Math.abs(a.ship - a.y));
console.log(`\n${misses.length} previsões erradas por >60 pontos (piores 8):`);
for (const m of misses.slice(0, 8)) {
  console.log(`  ${String(Math.floor(m.cut / 12))}-${String((m.cut % 12) + 1).padStart(2, '0')} ${m.id.padEnd(12)} previu ${pct(m.ship).padStart(4)} · aconteceu ${m.y} · ${m.nTrain} janelas`);
}
