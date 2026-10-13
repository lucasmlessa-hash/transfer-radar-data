#!/usr/bin/env node
// Vigia das razões de transferência.
//
//   node scripts/monitor-ratios.mjs [--dry]
//
// Por que existe: razão de transferência NÃO é fixa. Desvalorização é rotina no
// setor (a Etihad mudou de 3,3 para 4,2 na Esfera em 2026), e uma razão errada
// não quebra nada — ela só passa a mentir. Corrompe o ¢/pt de cada rota daquele
// banco e a ordenação BEST VALUE, em silêncio, para sempre.
//
// O que ele faz, e o que deliberadamente NÃO faz: compara as razões que o
// scrape traz hoje contra as commitadas em sample/partners.json e ESCREVE a
// diferença na saída padrão, num formato que o workflow transforma em issue.
// Ele atualiza o arquivo (a fonte manda), mas o valor está em avisar — uma
// mudança silenciosa aplicada sem ninguém ver é o que estamos evitando.
//
// Cobertura por origem:
//   - bancos US  -> lista mestre do Frequent Miler, raspada aqui e a cada build
//   - Livelo/Esfera -> scripts/refresh-br-ratios.mjs, no mesmo job semanal
//   - Marriott/Wyndham/Choice -> sem tabela raspável; conferidas à mão, com
//     data em `ratioProvenance`; check-curated-ratios.mjs alerta quando a
//     revisão envelhece mais de 35 dias sem bloquear o refresh independente.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { parseFmDirectory, DIRECTORY_SOURCES } from '../src/sources/partner-directory.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARTNERS = path.join(ROOT, 'sample', 'partners.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function biltMarriottBaseRatio(fetchImpl) {
  // FM's "20K to25K" includes a threshold bonus. The official support article
  // explicitly lists the base rate; its public JSON endpoint avoids the HTML
  // challenge without requiring authentication or any account access.
  const res = await fetchImpl('https://support.biltrewards.com/api/v2/help_center/en-us/articles/19086448638989.json', {
    headers: { 'user-agent': UA }, signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`Bilt official article HTTP ${res.status}`);
  const { article } = await res.json();
  if (article?.id !== 19086448638989 || typeof article.body !== 'string') throw new Error('Bilt official article missing');
  const $ = cheerio.load(article.body);
  const row = $('li').map((_, el) => $(el).text().trim()).get()
    .find((text) => /^Marriott\s+Bonvoy[™®]?\s*[-–—]\s*[\d.]+\s*:\s*[\d.]+$/.test(text));
  const match = row?.match(/([\d.]+)\s*:\s*([\d.]+)$/);
  if (!match || !Number.isFinite(Number(match[1])) || !Number.isFinite(Number(match[2]))
    || Number(match[1]) <= 0 || Number(match[2]) <= 0) throw new Error('Bilt Marriott base rate not explicitly published');
  return `${Number(match[1])}:${Number(match[2])}`;
}

export async function monitorRatios({ partnersPath = PARTNERS, dry = false, fetchImpl = fetch, log = console.log } = {}) {
  const src = DIRECTORY_SOURCES.find((s) => s.id === 'fm-directory');
  let scraped;
  try {
    const res = await fetchImpl(src.url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(25000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    scraped = parseFmDirectory(await res.text());
    if (!Object.values(scraped).some((b) => [...b.air.values(), ...b.hotel.values()].some((r) => r !== '—'))) {
      throw new Error('nenhuma razão verificável encontrada');
    }
  } catch (e) {
    // Fail-safe igual ao resto do pipeline: sem página, nada muda e nada se perde.
    log(`[ratios] verificação indisponível (${e.message}) — nada alterado`);
    return { ok: false, changes: [], updated: false, failures: [e.message] };
  }

  const doc = JSON.parse(readFileSync(partnersPath, 'utf8'));
  const mudancas = [];
  const failures = [];
  let updated = false;
  for (const [bank, buckets] of Object.entries(scraped)) {
    const atual = doc.directory[bank];
    if (!atual) continue;
    if (![...buckets.air.values(), ...buckets.hotel.values()].some((r) => r !== '—')) {
      failures.push(`${bank}: nenhuma razão verificável encontrada`);
      continue;
    }
    for (const bucket of ['air', 'hotel']) {
      const novo = buckets[bucket];
      if (!novo || !novo.size) continue;           // scrape vazio nunca apaga nada
      const antigo = new Map(atual[bucket] ?? []);
      for (const [nome, scrapedRatio] of novo) {
        let razao = scrapedRatio;
        const antes = antigo.get(nome);
        if (bank === 'BILT' && bucket === 'hotel' && nome === 'Marriott Bonvoy' && razao === '—') {
          try {
            razao = await biltMarriottBaseRatio(fetchImpl);
            log(`[ratios] BILT/Marriott Bonvoy: base ${razao} verificada na fonte oficial; bônus por bloco separado`);
          } catch (e) {
            failures.push(e.message);
            continue;
          }
        }
        if (razao === '—' && antes && antes !== '—') {
          failures.push(`${bank}/${nome}: razão não verificável; preservada ${antes}`);
          continue;
        }
        // só reporta mudança de razão CONHECIDA para outra conhecida: aparecer
        // uma parceira nova, ou uma razão sair do em-dash, é rotina e não notícia.
        if (antes && antes !== '—' && razao !== '—' && antes !== razao) {
          mudancas.push({ bank, bucket, nome, antes, depois: razao });
        }
        if (antes !== razao) updated = true;
        antigo.set(nome, razao);
      }
      atual[bucket] = [...antigo].sort((a, b) => a[0].localeCompare(b[0]));
    }
  }

  if (mudancas.length) {
    log('RATIO_CHANGES_FOUND');
    for (const m of mudancas) {
      log(`  ${m.bank} -> ${m.nome} (${m.bucket}): ${m.antes} virou ${m.depois}`);
    }
  } else {
    log('[ratios] nenhuma razão mudou');
  }

  if (!dry && updated) writeFileSync(partnersPath, JSON.stringify(doc, null, 2) + '\n');
  for (const failure of failures) log(`[ratios] ${failure}`);
  return { ok: failures.length === 0, changes: mudancas, updated, failures };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await monitorRatios({ dry: process.argv.includes('--dry') });
  if (!result.ok) process.exitCode = 1;
}
