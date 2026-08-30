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
//     data em `ratioProvenance`, e um teste falha quando essa data envelhece
//     mais de 35 dias. É esse teste que força a revisão periódica.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFmDirectory, DIRECTORY_SOURCES } from '../src/sources/partner-directory.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARTNERS = path.join(ROOT, 'sample', 'partners.json');
const DRY = process.argv.includes('--dry');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const src = DIRECTORY_SOURCES.find((s) => s.id === 'fm-directory');
let scraped;
try {
  const res = await fetch(src.url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  scraped = parseFmDirectory(await res.text());
} catch (e) {
  // Fail-safe igual ao resto do pipeline: sem página, nada muda e nada se perde.
  console.log(`[ratios] fonte inacessível (${e.message}) — nada alterado`);
  process.exit(0);
}

const doc = JSON.parse(readFileSync(PARTNERS, 'utf8'));
const mudancas = [];
for (const [bank, buckets] of Object.entries(scraped)) {
  const atual = doc.directory[bank];
  if (!atual) continue;
  for (const bucket of ['air', 'hotel']) {
    const novo = buckets[bucket];
    if (!novo || !novo.size) continue;           // scrape vazio nunca apaga nada
    const antigo = new Map(atual[bucket] ?? []);
    for (const [nome, razao] of novo) {
      const antes = antigo.get(nome);
      // só reporta mudança de razão CONHECIDA para outra conhecida: aparecer
      // uma parceira nova, ou uma razão sair do em-dash, é rotina e não notícia.
      if (antes && antes !== '—' && razao !== '—' && antes !== razao) {
        mudancas.push({ bank, bucket, nome, antes, depois: razao });
      }
      antigo.set(nome, razao);
    }
    atual[bucket] = [...antigo].sort((a, b) => a[0].localeCompare(b[0]));
  }
}

if (mudancas.length) {
  console.log('RATIO_CHANGES_FOUND');
  for (const m of mudancas) {
    console.log(`  ${m.bank} -> ${m.nome} (${m.bucket}): ${m.antes} virou ${m.depois}`);
  }
} else {
  console.log('[ratios] nenhuma razão mudou');
}

if (!DRY && mudancas.length) writeFileSync(PARTNERS, JSON.stringify(doc, null, 2) + '\n');
