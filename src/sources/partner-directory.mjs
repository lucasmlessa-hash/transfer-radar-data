// Dynamic partner directory: who each bank can transfer to, scraped from the
// horse's mouth on every build instead of hand-curated — partners join and
// leave (Esfera dropped American AAdvantage; Livelo added United and Etihad),
// and a stale directory misleads exactly the way stale bonuses would.
//
// Three sources cover all nine banks:
//   - Frequent Miler's transfer-partner master list -> the 7 US banks, with
//     ratios ("1 to 1", "1000 to 500") straight from the table cells
//   - livelo.com.br/livelo-para-parceiros -> Livelo (embedded __NEXT_DATA__,
//     same shape the livelo bonus source already parses)
//   - esfera.com.vc/programas-parceiros -> Esfera (menu columns "Parceiros
//     Nacionais" / "Parceiros Internacionais" in __NEXT_DATA__)
//
// The curated directory in sample/partners.json is the FALLBACK, not the
// truth: any bank whose scrape fails or comes back empty keeps its curated
// list, so a page redesign degrades to yesterday's data instead of an empty
// Partners tab.

import * as cheerio from 'cheerio';
import { resolveBank, resolvePartner, partnerDisplayName } from '../aliases.mjs';

// Neither airline nor hotel: coalition/shopping programmes the product's
// air/hotel directory model deliberately does not carry.
const NOT_TRAVEL = /shop your way|dotz|seedz/i;
const HOTELISH = /hyatt|accor|hilton|ihg|marriott|wyndham|choice|preferred hotels|leading hotels|radisson/i;

// "1 to 1 (Instant)" / "1000 to 500 (Instant)" / "3 to 2 (Unknown)" -> "1:1" etc.
function parseRatio(cell) {
  const m = /([\d.,]+)\s*to\s*([\d.,]+)/i.exec(cell);
  if (!m) return '—';
  const clean = (s) => s.replace(/,/g, '');
  return `${clean(m[1])}:${clean(m[2])}`;
}

// Hotels carry no partner codes, so alias resolution can't canonicalize them
// — but every source spells them differently ("ALL Accor" / "Accor Live
// Limitless" / "ALL: Accor Live Limitless"), and the Partners tab's reverse
// lookup matches by string, splitting one programme into three cards.
const HOTEL_CANON = [
  [/accor/i, 'ALL Accor Live Limitless'],
  [/hilton/i, 'Hilton Honors'],
  [/ihg/i, 'IHG One Rewards'],
  [/marriott/i, 'Marriott Bonvoy'],
  [/hyatt/i, 'World of Hyatt'],
  [/wyndham/i, 'Wyndham Rewards'],
  [/choice/i, 'Choice Privileges'],
  [/preferred hotels/i, 'Preferred Hotels I Prefer'],
  [/leading hotels/i, 'Leading Hotels Leaders Club'],
];

// A scraped name resolves to its canonical display name when we track the
// programme, and stays as scraped otherwise (Finnair, Delta, SAS… are real
// partners the directory should show even though no valuation tracks them).
// This is also what retired the duplicate-spelling bugs: every source's
// spelling of the same programme lands on one canonical string.
export const canonical = (name) => {
  const code = resolvePartner(name);
  if (code) return partnerDisplayName(code);
  const hotel = HOTEL_CANON.find(([re]) => re.test(name));
  return hotel ? hotel[1] : name.trim();
};

/**
 * FM master list -> { AMEX: {air:[[name,ratio]],hotel:[...]}, CHASE: ..., ... }
 * Direct-transfer tables only (header "Rewards Program" + "... Transfer
 * Ratio", never "Indirect"); table ids drift, content shape doesn't.
 */
export function parseFmDirectory(html) {
  const $ = cheerio.load(html);
  const BANKS = ['AMEX', 'CHASE', 'CITI', 'C1', 'BILT', 'WF', 'USB', 'ROVE'];
  const byBank = Object.fromEntries(BANKS.map((b) => [b, { air: new Map(), hotel: new Map() }]));
  $('table.tablepress').each((_, el) => {
    const head = $(el).find('thead th').map((__, e) => $(e).text().trim()).get();
    if (!/Rewards Program/i.test(head[0] ?? '') || head.some((h) => /Indirect/i.test(h))) return;
    if (!/Transfer Ratio/i.test(head[1] ?? '')) return;
    // Columns mapped by HEADER, never by position. The old positional map
    // assumed the 2026-07 column order; when FM inserted "US Bank" between
    // Wells Fargo and Rove, every Rove cell silently became a US Bank cell and
    // the published Partners tab showed Rove with US Bank's 2-partner list
    // instead of its real 9 (caught 2026-08-28). Header-driven mapping makes
    // any future insertion a no-op here.
    const colBank = head.map((h) => resolveBank(h.replace(/transfer ratio[\s\S]*$/i, '').trim()));
    $(el).find('tbody tr').each((__, tr) => {
      const tds = $(tr).find('td').map((___, e) => $(e).text().trim()).get();
      const prog = tds[0];
      if (!prog || NOT_TRAVEL.test(prog)) return;
      const bucket = HOTELISH.test(prog) ? 'hotel' : 'air';
      const name = canonical(prog);
      colBank.forEach((bank, i) => {
        if (!bank || !byBank[bank]) return;
        const cell = tds[i] ?? '';
        if (!cell) return;
        if (!byBank[bank][bucket].has(name)) byBank[bank][bucket].set(name, parseRatio(cell));
      });
    });
  });
  return byBank;
}

function nextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  return m ? JSON.parse(m[1]) : null;
}

/** Livelo's listPartners (status "Ativo") -> { air: Map, hotel: Map }. */
export function parseLiveloDirectory(html) {
  const doc = nextData(html);
  if (!doc) return null;
  let lp = null;
  (function walk(o) {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o && typeof o === 'object') {
      if (!lp && Array.isArray(o.listPartners)) lp = o.listPartners;
      Object.values(o).forEach(walk);
    }
  })(doc);
  if (!lp) return null;
  const out = { air: new Map(), hotel: new Map() };
  for (const p of lp) {
    const name = p.nomeParceiro;
    if (typeof name !== 'string' || !name || NOT_TRAVEL.test(name)) continue;
    if (p.status && p.status !== 'Ativo') continue;
    const bucket = HOTELISH.test(name) ? 'hotel' : 'air';
    out[bucket].set(canonical(name), '—'); // Livelo publishes no ratios on this page
  }
  return out;
}

/** Esfera's transfer-partner menu columns -> { air: Map, hotel: Map }. */
export function parseEsferaDirectory(html) {
  const doc = nextData(html);
  if (!doc) return null;
  const out = { air: new Map(), hotel: new Map() };
  (function walk(o) {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o && typeof o === 'object') {
      const label = o.mainItemLabel?.title ?? '';
      if (/Parceiros (Nacionais|Internacionais)/i.test(label) && Array.isArray(o.groupMenuItemsLinks)) {
        for (const g of o.groupMenuItemsLinks) {
          const l = g?.menuLink;
          if (!l?.title || !l?.href || !/^\/p\//.test(l.href)) continue; // "Ver mais" etc. link elsewhere
          if (NOT_TRAVEL.test(l.title)) continue;
          const bucket = HOTELISH.test(l.title) ? 'hotel' : 'air';
          out[bucket].set(canonical(l.title), '—');
        }
      }
      Object.values(o).forEach(walk);
    }
  })(doc);
  return out;
}

const sortPairs = (m) => [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));

/**
 * Merges scraped per-bank lists over the curated directory. Per bank: a
 * non-empty scrape replaces the curated lists wholesale (partners that left
 * really do disappear); ratios the scrape couldn't see are inherited from
 * the curated entry for the same canonical name; an empty or failed scrape
 * keeps the curated lists untouched (degraded beats wrong).
 */
export function mergeDirectory(curated, scrapedByBank) {
  const out = {};
  for (const bank of Object.keys(curated)) {
    const scraped = scrapedByBank[bank];
    if (!scraped || (scraped.air.size === 0 && scraped.hotel.size === 0)) {
      out[bank] = curated[bank];
      continue;
    }
    const inherit = (bucket) => {
      const curatedRatio = new Map((curated[bank]?.[bucket] ?? []).map(([n, r]) => [canonical(n), r]));
      return sortPairs(scraped[bucket]).map(([name, ratio]) => [name, ratio !== '—' ? ratio : (curatedRatio.get(name) ?? '—')]);
    };
    out[bank] = { air: inherit('air'), hotel: inherit('hotel') };
  }
  return out;
}

// Esfera is deliberately absent from this list. Its listing page carries only
// product ids, and resolving them to names needs one fetch per partner — too
// much for a 30-minute build. Reading the navigation menu instead is what this
// source used to do, and it silently missed four real partners (Aeromexico,
// Etihad, IHG, Turkish) because the menu shows 8 of 19. Esfera's directory is
// now owned by scripts/refresh-br-ratios.mjs on a weekly schedule, which walks
// every showcase id properly. Livelo stays here: its listing already carries
// both name and status, so it costs one request.
export const DIRECTORY_SOURCES = [
  { id: 'fm-directory', url: 'https://frequentmiler.com/transfer-partner-master-list/', fixture: 'partner-fm.html', parse: parseFmDirectory, banks: ['AMEX', 'CHASE', 'CITI', 'C1', 'BILT', 'WF', 'ROVE'] },
  { id: 'livelo-directory', url: 'https://www.livelo.com.br/livelo-para-parceiros', fixture: 'partner-livelo.html', parse: (html) => ({ LIV: parseLiveloDirectory(html) }), banks: ['LIV'] },
];
