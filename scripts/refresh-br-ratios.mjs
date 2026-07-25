// Refreshes the Brazilian programmes' partner lists AND conversion rates in
// sample/partners.json.
//
//   node scripts/refresh-br-ratios.mjs [--dry]
//
// Why this is its own weekly job and not part of the 30-minute build: it walks
// ~34 partner pages. At 48 builds a day that would be thousands of requests for
// data that changes maybe twice a year.
//
// Why it exists at all: the listing pages name partners but never state the
// rate, and Esfera's navigation menu names only 8 of its 19 showcase entries.
// So the Partners tab was showing an em dash for every Brazilian route AND
// missing four Esfera partners outright, while both facts were published one
// click deeper the whole time.
//
// It matters because the rates are NOT all 1:1: Livelo sends 1:1 to Smiles and
// Azul but 3.5:1 to Iberia, Flying Blue and Accor. The same 100k points buy
// 100k Smiles miles or 28k Iberia Avios. Comparing that IS the Partners tab.
//
// Fail-safe throughout: an unreachable page, an unparseable rate, or a listing
// that comes back empty leaves the existing curated data alone. This script can
// add and correct, never blank out.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePartnerRatio, liveloPartnerUrls, esferaPartnerUrls, esferaPartnerName } from '../src/sources/br-ratios.mjs';
import { canonical } from '../src/sources/partner-directory.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARTNERS = path.join(ROOT, 'sample', 'partners.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const DRY = process.argv.includes('--dry');

// Same buckets the directory uses, so a hotel discovered here lands under
// `hotel` rather than becoming a phantom airline route.
const HOTELISH = /hyatt|accor|hilton|ihg|marriott|wyndham|choice|preferred hotels|leading hotels|radisson/i;
const NOT_TRAVEL = /shop your way|dotz|seedz/i;

const BANKS = [
  {
    bank: 'LIV',
    listing: 'https://www.livelo.com.br/livelo-para-parceiros',
    // Livelo's listing already carries both name and url, so no name lookup.
    extract: (html) => liveloPartnerUrls(html).map((p) => ({ ...p, id: p.url })),
  },
  {
    bank: 'ESF',
    listing: 'https://www.esfera.com.vc/programas-parceiros',
    extract: esferaPartnerUrls,
    nameFrom: esferaPartnerName,
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Esfera's listing is genuinely flaky -- measured 2026-07-25: three requests a
// second apart returned 200-with-19-ids, timeout, timeout. `ok` lets the caller
// reject a 200 that parsed to nothing so a truncated body retries instead of
// being read as "this programme has no partners".
async function get(url, { tries = 3, ok = () => true } = {}) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    if (i) await sleep(1500 * i);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.text();
      if (ok(body)) return body;
      last = new Error('response did not parse');
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

const doc = JSON.parse(readFileSync(PARTNERS, 'utf8'));
let added = 0, updated = 0, husks = 0, noRate = 0, healed = 0;

// Fold every directory row onto its canonical name first, merging any pair that
// collides. Without this the script can CREATE the duplicate it is meant to
// avoid: an alias fix (accent stripping made "Aeroméxico Rewards" resolve to
// AM) changes what canonical() returns, and the old spelling sitting in the
// file no longer matches the new one, so the partner gets appended twice.
// Ratio wins over an em dash when two rows merge.
for (const [bank, entry] of Object.entries(doc.directory)) {
  for (const bucket of ['air', 'hotel']) {
    if (!Array.isArray(entry[bucket])) continue;
    const merged = new Map();
    for (const [name, ratio] of entry[bucket]) {
      const key = canonical(name);
      if (key !== name) healed += 1;
      const prev = merged.get(key);
      merged.set(key, prev && prev !== '—' ? prev : ratio);
      if (prev !== undefined) console.log(`  [heal] ${bank}/${bucket}: merged "${name}" into "${key}"`);
    }
    entry[bucket] = [...merged].sort((a, b) => a[0].localeCompare(b[0]));
  }
}
if (healed) console.log(`[br] ${healed} row(s) folded onto canonical names`);

for (const { bank, listing, extract, nameFrom } of BANKS) {
  let partners = [];
  try {
    partners = extract(await get(listing, { ok: (html) => extract(html).length > 0 }));
  } catch (e) {
    console.warn(`[br] ${bank}: listing unusable after retries (${e.message}) — nothing touched`);
    continue;
  }
  if (!partners.length) {
    console.warn(`[br] ${bank}: listing parsed to 0 partners — broken parser, not an empty programme; nothing touched`);
    continue;
  }
  console.log(`[br] ${bank}: ${partners.length} candidate page(s)`);

  const seen = new Map(); // canonical name -> ratio or null
  for (const p of partners) {
    await sleep(400); // deliberate: a polite guest on someone else's site
    let html;
    try {
      html = await get(p.url);
    } catch (e) {
      console.warn(`  ${p.name ?? p.id}: fetch failed (${e.message}) — keeping whatever is on file`);
      continue;
    }
    const rawName = p.name ?? nameFrom?.(html);
    if (!rawName) { husks += 1; continue; } // unpublished id renders the site shell
    if (NOT_TRAVEL.test(rawName)) continue;
    const ratio = parsePartnerRatio(html, bank);
    if (!ratio) noRate += 1;
    seen.set(canonical(rawName), ratio);
  }
  if (!seen.size) {
    console.warn(`  ${bank}: every page failed — leaving the curated directory alone`);
    continue;
  }

  const entry = doc.directory[bank] ?? { air: [], hotel: [] };
  const existing = new Map();
  for (const bucket of ['air', 'hotel']) for (const row of entry[bucket] ?? []) existing.set(row[0], { bucket, row });

  for (const [name, ratio] of seen) {
    const found = existing.get(name);
    if (found) {
      if (ratio && found.row[1] !== ratio) {
        console.log(`  ${name}: ${found.row[1]} -> ${ratio}`);
        found.row[1] = ratio;
        updated += 1;
      }
    } else {
      const bucket = HOTELISH.test(name) ? 'hotel' : 'air';
      entry[bucket] = entry[bucket] ?? [];
      entry[bucket].push([name, ratio ?? '—']);
      console.log(`  + ${name} (${bucket}) ${ratio ?? '—'}`);
      added += 1;
    }
  }
  // Partners that vanished from the source are NOT removed here: one flaky
  // fetch would silently delete a real partner. The 30-minute directory
  // scrape owns removals for Livelo; Esfera's are an operator decision.
  for (const bucket of ['air', 'hotel']) entry[bucket]?.sort((a, b) => a[0].localeCompare(b[0]));
  doc.directory[bank] = entry;
}

console.log(`[br] ${added} partner(s) added, ${updated} rate(s) corrected, ${noRate} page(s) publish no rate, ${husks} unpublished id(s) skipped`);
if ((added || updated) && !DRY) {
  writeFileSync(PARTNERS, JSON.stringify(doc, null, 2) + '\n');
  console.log(`[br] wrote ${path.relative(ROOT, PARTNERS)}`);
} else if (DRY) {
  console.log('[br] --dry: nothing written');
}
